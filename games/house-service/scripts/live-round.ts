/**
 * live-round.ts — prove one full Dice round end to end against REAL 943 infrastructure.
 *
 * Runs the house loop in-process (runBoardHouse) and a player flow that talks to it over the REAL
 * MsgBoard on 943 (PoW-stamped messages, real RPC). Two phases:
 *
 *   BOARD + OFF-CHAIN (always live): requestOpen → co-sign one round over the board → verify the
 *     transcript → EscrowedSettlement.buildSettle yields the nonce-1 settle args. This proves the
 *     split-key protocol works on real infrastructure (not the in-memory E2E).
 *
 *   ON-CHAIN (only when LIVE_EXECUTE=1): approve → open(terms,houseSig) before the round, settle()
 *     after, then poll the indexer for the settlement row. These are skipped in a dry run because
 *     open/settle can't be simulated without the real prior state (allowance / open table).
 *
 * PulseChain gas trap: 943's eth_gasPrice ~5 gwei but baseFee ~7 wei; viem's 1559 estimation is
 * unreliable, so every write uses a legacy type-0 tx with a live, 2x-buffered gasPrice.
 *
 * Player = mnemonic index 0 (the owner — it already holds chips + PLS). House = index 1.
 *   Dry:  pnpm --filter @msgboard/games-house-service exec tsx scripts/live-round.ts
 *   Live: LIVE_EXECUTE=1 pnpm --filter @msgboard/games-house-service exec tsx scripts/live-round.ts
 */
import {
  createPublicClient, createWalletClient, http, keccak256, stringToHex, parseEther, formatUnits,
  type Hex, type Abi,
} from 'viem'
import { mnemonicToAccount, generatePrivateKey } from 'viem/accounts'
import {
  dice, limbo, plinko, keno, makeDomain, createBoardClient, runPlayerSide, verifyFinishedSession,
  commitSeed, escrowFor,
  type Game, type Signer, type VerifyContext,
} from '@msgboard/games'
import { makeBoardPlayerSession, EscrowedSettlement } from '@msgboard/settle'
import { runBoardHouse } from '../src/runHouse'
import {
  DEPLOYMENT_943, DEFAULT_LIMITS, pulsechainV4, readMnemonic, houseSignerFromMnemonic, redactRpc,
} from '../src/liveConfig'

const EXECUTE = process.env.LIVE_EXECUTE === '1'
const D = DEPLOYMENT_943

/** Pick the game with GAME=dice|limbo|plinko|keno (default dice). Each carries a representative bet. */
const GAME_CONFIGS: Record<string, { game: Game<unknown>; params: unknown; label: string }> = {
  dice: { game: dice as Game<unknown>, params: { targetX100: 5000n }, label: 'dice · 50% roll-under' },
  limbo: { game: limbo as Game<unknown>, params: { targetX100: 200n }, label: 'limbo · 2.00x target' },
  plinko: { game: plinko as Game<unknown>, params: { rows: 16, risk: 'low' }, label: 'plinko · low risk, 16 rows' },
  keno: { game: keno as Game<unknown>, params: { picks: [1, 2, 3] }, label: 'keno · 3 picks' },
}
const GAME = (process.env.GAME ?? 'dice').toLowerCase()
// Poll cadence for the board co-sign. Higher = fewer RPC calls (more headroom under a rate-limited
// key for the final settle tx), at the cost of a slower round. Override with POLL_MS.
const POLL_MS = Number(process.env.POLL_MS ?? 1500)

const erc20ApproveAbi = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }] },
] as const satisfies Abi

const houseChannelClockAbi = [
  { name: 'MIN_CLOCK_BLOCKS', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'MAX_CLOCK_BLOCKS', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const satisfies Abi

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const clamp = (v: bigint, lo: bigint, hi: bigint) => (v < lo ? lo : v > hi ? hi : v)

async function main(): Promise<void> {
  const mnemonic = readMnemonic()
  const playerAcct = mnemonicToAccount(mnemonic, { addressIndex: 0 })
  const houseSigner = houseSignerFromMnemonic(mnemonic, 1)
  // Reads + writes + board all run through the valve.city vk_demo endpoint (its allowlist now permits
  // eth_sendRawTransaction).
  const publicClient = createPublicClient({ chain: pulsechainV4, transport: http(D.txRpcUrl) })
  const walletClient = createWalletClient({ account: playerAcct, chain: pulsechainV4, transport: http(D.txRpcUrl) })

  console.log(`== live-round on ${D.chainId} (${EXECUTE ? 'LIVE — will send txs' : 'DRY — board live, chain skipped'}) ==`)
  console.log(`player=${playerAcct.address}  house=${houseSigner.address}`)
  console.log(`channel=${D.houseChannel}  board=${redactRpc(D.boardRpc)}`)

  // Clamp clockBlocks into the contract's allowed window so open() can't revert on it.
  const [minClock, maxClock] = await Promise.all([
    publicClient.readContract({ address: D.houseChannel, abi: houseChannelClockAbi, functionName: 'MIN_CLOCK_BLOCKS' }),
    publicClient.readContract({ address: D.houseChannel, abi: houseChannelClockAbi, functionName: 'MAX_CLOCK_BLOCKS' }),
  ])
  const limits = { ...DEFAULT_LIMITS, clockBlocks: clamp(DEFAULT_LIMITS.clockBlocks, minClock, maxClock) }
  console.log(`clockBlocks=${limits.clockBlocks} (contract window ${minClock}..${maxClock})`)

  // Round parameters (game-routed).
  const cfg = GAME_CONFIGS[GAME]
  if (!cfg) throw new Error(`unknown GAME=${GAME}; pick one of ${Object.keys(GAME_CONFIGS).join(', ')}`)
  const { game, params } = cfg
  const stake = parseEther('0.1') // 0.1 chip
  const mult = game.maxMultiplierX100(params) // the escrow ceiling for these params
  const escrow = escrowFor(stake, mult)
  const clientSeed = generatePrivateKey()
  const tableId = keccak256(stringToHex(`live:${Date.now()}:${playerAcct.address}`))
  const domain = makeDomain(D.chainId, D.houseChannel)
  console.log(`game=${cfg.label} (id ${game.gameId})  stake=${formatUnits(stake, 18)} → escrowPlayer=${formatUnits(escrow.escrowPlayer, 18)} escrowHouse=${formatUnits(escrow.escrowHouse, 18)}`)

  // ── start the house in-process (off-chain: co-signs + posts board messages) ──
  const house = runBoardHouse({
    rpcUrl: D.rpcUrl, boardRpc: D.boardRpc, chainId: D.chainId,
    houseChannel: D.houseChannel, houseSigner, limits, pollMs: POLL_MS, timeoutMs: 240_000,
  })
  console.log('[house] started, watching the board')

  // ── player board session ─────────────────────────────────────────────────
  const playerBoard = createBoardClient(D.boardRpc)
  const accepted: Array<{ nonce: bigint }> = []
  const session = makeBoardPlayerSession({
    board: playerBoard, chainId: D.chainId, tableId, pollMs: POLL_MS, timeoutMs: 240_000,
    onAccept: (s) => accepted.push(s as { nonce: bigint }),
  })

  let settleHash: Hex | null = null
  try {
    // 1. OPEN HANDSHAKE (board): post clientSeedCommit only, receive house-signed OpenTerms.
    console.log('[1/5] requestOpen → awaiting house grant (PoW posts, may take ~10-30s)…')
    const { terms, houseSig } = await session.requestOpen({
      tableId, player: playerAcct.address, playerKey: playerAcct.address,
      gameId: game.gameId, params, stake, clientSeedCommit: commitSeed(clientSeed),
    })
    if (terms.escrowPlayer !== escrow.escrowPlayer || terms.escrowHouse !== escrow.escrowHouse) {
      throw new Error(`grant escrow ${terms.escrowPlayer}/${terms.escrowHouse} != expected ${escrow.escrowPlayer}/${escrow.escrowHouse}`)
    }
    console.log(`[1/5] grant OK: rngCommit=${terms.rngCommit.slice(0, 12)}… expiry=${terms.expiry} houseSig=${houseSig.slice(0, 12)}…`)

    // 2. ON-CHAIN OPEN (escrow funds) — LIVE only.
    const esc = new EscrowedSettlement<unknown>({
      parties: { player: playerAcct.address, house: houseSigner.address },
      commit: terms.rngCommit, game, domain, settlementMode: 1, channel: D.houseChannel,
    })
    if (EXECUTE) {
      await send(publicClient, walletClient, '[2/5] approve',
        { address: D.chips, abi: erc20ApproveAbi, functionName: 'approve', args: [D.houseChannel, escrow.escrowPlayer] })
      const openTx = esc.buildOpen(terms, houseSig)
      await send(publicClient, walletClient, '[2/5] open',
        { address: openTx.address, abi: openTx.abi as Abi, functionName: openTx.functionName, args: openTx.args })
    } else {
      console.log('[2/5] DRY: skipping on-chain approve + open (they need real prior state to simulate)')
    }

    // 3. CO-SIGN ONE ROUND (board): launch player side, then drive the round (reveals clientSeed).
    const playerSigner: Signer = {
      address: playerAcct.address,
      signTypedData: (a) => playerAcct.signTypedData(a as Parameters<typeof playerAcct.signTypedData>[0]),
      signMessage: (a: { message: { raw: Hex } }) => playerAcct.signMessage(a),
    }
    runPlayerSide(
      { domain, tableId, game, player: playerSigner, houseRemote: true as const,
        clientSeed, seedTip: `0x${'00'.repeat(32)}` as Hex, chainLength: 1 as const,
        openBalances: { player: terms.escrowPlayer, house: terms.escrowHouse }, settlementMode: 1 },
      session.playerT,
    ).catch((e) => console.error('[player] runPlayerSide rejected:', e instanceof Error ? e.message : e))
    const stopServing = session.startServing()
    console.log('[3/5] houseDriver → co-signing OPEN(0)+ROUND(1) over the board…')
    const transcriptJson = await session.houseDriver<unknown>({ stake, params, clientSeed, playerAddress: playerAcct.address })
    stopServing()
    console.log(`[3/5] round co-signed; accepted nonces=[${accepted.map((s) => s.nonce).join(',')}]`)

    // 4. VERIFY + BUILD SETTLE (off-chain, always).
    const ctx: VerifyContext<unknown> = { parties: { player: playerAcct.address, house: houseSigner.address }, commit: terms.rngCommit, game, domain }
    const ok = await verifyFinishedSession(transcriptJson, ctx)
    if (!ok) throw new Error('verifyFinishedSession returned false')
    const settleTx = await esc.buildSettle(transcriptJson)
    const finalState = settleTx.args[0] as { nonce: bigint; balancePlayer: bigint; balanceHouse: bigint }
    if (finalState.nonce !== 1n) throw new Error(`final state nonce ${finalState.nonce} != 1`)
    const won = finalState.balancePlayer > terms.escrowPlayer
    console.log(`[4/5] transcript verified; settle nonce=1 balancePlayer=${formatUnits(finalState.balancePlayer, 18)} → player ${won ? 'WON' : 'lost'}`)

    // 5. ON-CHAIN SETTLE + indexer — LIVE only.
    if (EXECUTE) {
      settleHash = await send(publicClient, walletClient, '[5/5] settle',
        { address: settleTx.address, abi: settleTx.abi as Abi, functionName: settleTx.functionName, args: settleTx.args })
      await pollIndexer(tableId)
    } else {
      console.log('[5/5] DRY: skipping on-chain settle + indexer poll. Re-run with LIVE_EXECUTE=1 for the funds path.')
    }

    console.log(`\n✅ live-round ${EXECUTE ? 'SETTLED on-chain' : 'BOARD+OFF-CHAIN proof'} complete.${settleHash ? ` settle tx ${D.explorer}/tx/${settleHash}` : ''}`)
  } finally {
    house.stop()
  }
}

/** Send (LIVE) a legacy type-0 tx with a live 2x-buffered gasPrice. Signs LOCALLY via the wallet
 *  client's bound account (eth_sendRawTransaction) — passing an address string instead would make
 *  viem use eth_sendTransaction, which the keyed RPC rejects. */
async function send(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  label: string,
  tx: { address: Hex; abi: Abi; functionName: string; args: readonly unknown[] },
): Promise<Hex> {
  const live = await publicClient.getGasPrice()
  const gasPrice = live * 2n > 1_000_000_000n ? live * 2n : 1_000_000_000n
  const hash = await walletClient.writeContract({
    address: tx.address, abi: tx.abi, functionName: tx.functionName, args: tx.args,
    chain: pulsechainV4, type: 'legacy', gasPrice,
  } as Parameters<typeof walletClient.writeContract>[0])
  console.log(`${label}: ${hash} (gasPrice=${gasPrice})`)
  const rcpt = await publicClient.waitForTransactionReceipt({ hash })
  if (rcpt.status !== 'success') throw new Error(`${label} reverted in block ${rcpt.blockNumber}`)
  console.log(`${label}: confirmed block ${rcpt.blockNumber}`)
  return hash
}

/** Poll the games indexer for the settlement row keyed by tableId. */
async function pollIndexer(tableId: Hex): Promise<void> {
  const query = `query($id:String!){ settlements(where:{tableId:$id}){ items{ id tableId game player escrowPlayer payoutPlayer net blockNumber txHash } } }`
  for (let i = 0; i < 12; i++) {
    await sleep(5000)
    try {
      const res = await fetch(DEPLOYMENT_943.gamesIndexer, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables: { id: tableId } }),
      })
      const json = (await res.json()) as { data?: { settlements?: { items?: unknown[] } } }
      const items = json.data?.settlements?.items ?? []
      if (items.length > 0) { console.log(`[indexer] settlement row indexed:`, items[0]); return }
      console.log(`[indexer] not yet indexed (attempt ${i + 1}/12)…`)
    } catch (e) {
      console.log(`[indexer] poll error (attempt ${i + 1}/12):`, e instanceof Error ? e.message : e)
    }
  }
  console.log('[indexer] no settlement row after 60s — the indexer may lag or need the new HouseChannel address deployed.')
}

main().catch((err) => {
  console.error('live-round failed:', err)
  process.exit(1)
})
