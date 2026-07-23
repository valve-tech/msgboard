/**
 * recompute-round.ts — prove the trustless `settleWithSeeds` path end-to-end on 943.
 *
 * NO board co-sign: the recompute settle needs no co-signed SessionState. The house signs OpenTerms
 * (now carrying clientSeedCommit + paramsHash), the player opens + escrows, the house reveals
 * serverSeed, then ANYONE calls `settleWithSeeds(tableId, serverSeed, clientSeed, params)`. The
 * contract re-derives the round randomness (single-draw nonce HARDCODED to 1 — NOT a caller input;
 * see the Security note in the recompute-settle plan) and the payout via GamePayouts, then pays the
 * conserved pot. No signature from either party is consulted.
 *
 *   Dry:  pnpm --filter @msgboard/games-house-service exec tsx scripts/recompute-round.ts
 *   Live: LIVE_EXECUTE=1 pnpm --filter @msgboard/games-house-service exec tsx scripts/recompute-round.ts
 *   (GAME=dice|limbo selects the game; default dice.)
 *
 * ┌─ LIVE GATE (USER-GATED) ─────────────────────────────────────────────────────────────────────┐
 * │ The OpenTerms EIP-712 shape CHANGED in Tasks 1-4 (it now appends clientSeedCommit + paramsHash │
 * │ and the contract gained settleWithSeeds). The currently-deployed 943 HouseChannel              │
 * │ (DEPLOYMENT_943.houseChannel) has the OLD ABI and would REJECT the new terms / lacks the new   │
 * │ selector. So LIVE_EXECUTE=1 REQUIRES a FRESH HouseChannel deploy first:                        │
 * │   cd packages/contracts && pnpm build               # refresh the HouseChannel.json artifact   │
 * │   MNEMONIC=… pnpm exec tsx scripts/deploy-house.ts   # dry-run plan (sends nothing)             │
 * │   DEPLOY_EXECUTE=1 MNEMONIC=… pnpm exec tsx scripts/deploy-house.ts   # broadcast (user-only)   │
 * │ then repoint DEPLOYMENT_943.houseChannel (liveConfig.ts), web config, ponder.config.ts, and    │
 * │ any settle verifyingContract. The DRY path below needs none of this — it proves the off-chain  │
 * │ recompute + terms build without touching the chain.                                            │
 * └───────────────────────────────────────────────────────────────────────────────────────────────┘
 */
import {
  createPublicClient, createWalletClient, http, keccak256, stringToHex, parseEther, formatUnits,
  encodeAbiParameters, decodeEventLog, type Hex, type Abi,
} from 'viem'
import { mnemonicToAccount, generatePrivateKey } from 'viem/accounts'
import {
  dice, limbo, roundRandom, commitSeed, escrowFor, makeDomain,
  type Game,
} from '@msgboard/games'
import { signOpenTerms, paramsHashOf, type OpenTerms } from '@msgboard/settle'
import {
  DEPLOYMENT_943, DEFAULT_LIMITS, pulsechainV4, readMnemonic, houseSignerFromMnemonic, redactRpc,
} from '../src/liveConfig'

const EXECUTE = process.env.LIVE_EXECUTE === '1'
const D = DEPLOYMENT_943
const GAME = (process.env.GAME ?? 'dice').toLowerCase()
// Poll cadence kept for parity with live-round.ts (used by the receipt wait below).
const POLL_MS = Number(process.env.POLL_MS ?? 1500)

/** Each entry carries a single-uint256-target bet (dice/limbo are params = uint256 targetX100). */
const GAMES: Record<string, { game: Game<{ targetX100: bigint }>; targetX100: bigint; label: string }> = {
  dice: { game: dice, targetX100: 5000n, label: 'dice · 50% roll-under' },
  limbo: { game: limbo, targetX100: 200n, label: 'limbo · 2.00x target' },
}

const erc20ApproveAbi = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }] },
] as const satisfies Abi

const houseChannelClockAbi = [
  { name: 'MIN_CLOCK_BLOCKS', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'MAX_CLOCK_BLOCKS', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const satisfies Abi

/** Minimal HouseChannel surface this driver touches. Declared inline (like live-round.ts's small
 *  ABIs) so the LIVE path does not depend on the package's re-exported `houseChannelAbi`, which is a
 *  build artifact that may predate the Tasks 1-4 ABI until `cd packages/contracts && pnpm build` is
 *  re-run as part of the user-gated redeploy. `open` takes the NEW OpenTerms tuple (11 fields). */
const houseChannelAbi = [
  { name: 'open', type: 'function', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { name: 'terms', type: 'tuple', components: [
        { name: 'tableId', type: 'bytes32' },
        { name: 'player', type: 'address' },
        { name: 'playerKey', type: 'address' },
        { name: 'escrowPlayer', type: 'uint256' },
        { name: 'escrowHouse', type: 'uint256' },
        { name: 'gameId', type: 'uint8' },
        { name: 'rngCommit', type: 'bytes32' },
        { name: 'clockBlocks', type: 'uint64' },
        { name: 'expiry', type: 'uint64' },
        { name: 'clientSeedCommit', type: 'bytes32' },
        { name: 'paramsHash', type: 'bytes32' },
      ] },
      { name: 'houseSig', type: 'bytes' },
    ] },
  { name: 'settleWithSeeds', type: 'function', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { name: 'tableId', type: 'bytes32' },
      { name: 'serverSeed', type: 'bytes32' },
      { name: 'clientSeed', type: 'bytes32' },
      { name: 'params', type: 'bytes' },
    ] },
  { type: 'event', name: 'Settled', inputs: [
    { name: 'tableId', type: 'bytes32', indexed: true },
    { name: 'payoutPlayer', type: 'uint256', indexed: false },
    { name: 'payoutHouse', type: 'uint256', indexed: false },
  ] },
] as const satisfies Abi

const clamp = (v: bigint, lo: bigint, hi: bigint) => (v < lo ? lo : v > hi ? hi : v)

async function main(): Promise<void> {
  const mnemonic = readMnemonic()
  const playerAcct = mnemonicToAccount(mnemonic, { addressIndex: 0 })
  const houseSigner = houseSignerFromMnemonic(mnemonic, 1)
  const publicClient = createPublicClient({ chain: pulsechainV4, transport: http(D.txRpcUrl) })
  const walletClient = createWalletClient({ account: playerAcct, chain: pulsechainV4, transport: http(D.txRpcUrl) })

  console.log(`== recompute-round on ${D.chainId} (${EXECUTE ? 'LIVE — will send txs' : 'DRY — off-chain recompute only, chain skipped'}) ==`)
  console.log(`player=${playerAcct.address}  house=${houseSigner.address}`)
  console.log(`channel=${D.houseChannel}  rpc=${redactRpc(D.txRpcUrl)}`)

  const cfg = GAMES[GAME]
  if (!cfg) throw new Error(`unknown GAME=${GAME}; pick one of ${Object.keys(GAMES).join(', ')}`)
  const { game, targetX100 } = cfg

  // ── params (single uint256 target) + its hash; both must match the contract exactly. ──
  const params = encodeAbiParameters([{ type: 'uint256' }], [targetX100])
  const paramsHash = paramsHashOf(targetX100)

  // ── seeds: house's length-1 server seed + commit, player's client seed + commit. ──
  const serverSeed = generatePrivateKey() // random bytes32 (single-draw "chain" of length 1)
  const rngCommit = commitSeed(serverSeed)
  const clientSeed = generatePrivateKey()
  const clientSeedCommit = commitSeed(clientSeed)

  // ── escrow sizing (params-only ceiling; identical to live-round.ts). ──
  const stake = parseEther('0.1')
  const mult = game.maxMultiplierX100({ targetX100 })
  const { escrowPlayer, escrowHouse } = escrowFor(stake, mult)
  const pot = escrowPlayer + escrowHouse

  // ── clamp clockBlocks into the contract's window so open() can't revert on it. ──
  let clockBlocks = DEFAULT_LIMITS.clockBlocks
  if (EXECUTE) {
    const [minClock, maxClock] = await Promise.all([
      publicClient.readContract({ address: D.houseChannel, abi: houseChannelClockAbi, functionName: 'MIN_CLOCK_BLOCKS' }),
      publicClient.readContract({ address: D.houseChannel, abi: houseChannelClockAbi, functionName: 'MAX_CLOCK_BLOCKS' }),
    ])
    clockBlocks = clamp(DEFAULT_LIMITS.clockBlocks, minClock, maxClock)
    console.log(`clockBlocks=${clockBlocks} (contract window ${minClock}..${maxClock})`)
  }

  // ── build the NEW OpenTerms + house signature. ──
  const tableId = keccak256(stringToHex(`recompute:${Date.now()}:${playerAcct.address}`))
  const headTs = BigInt(Math.floor(Date.now() / 1000))
  const domain = makeDomain(D.chainId, D.houseChannel)
  const terms: OpenTerms = {
    tableId, player: playerAcct.address, playerKey: playerAcct.address,
    escrowPlayer, escrowHouse, gameId: game.gameId, rngCommit,
    clockBlocks, expiry: headTs + DEFAULT_LIMITS.expiryBlocks,
    clientSeedCommit, paramsHash,
  }
  const houseSig = await signOpenTerms(houseSigner, domain, terms)
  console.log(`game=${cfg.label} (id ${game.gameId})  stake=${formatUnits(stake, 18)}` +
    ` → escrowPlayer=${formatUnits(escrowPlayer, 18)} escrowHouse=${formatUnits(escrowHouse, 18)} pot=${formatUnits(pot, 18)}`)
  console.log(`terms: rngCommit=${rngCommit.slice(0, 12)}… clientSeedCommit=${clientSeedCommit.slice(0, 12)}…` +
    ` paramsHash=${paramsHash.slice(0, 12)}… houseSig=${houseSig.slice(0, 12)}…`)

  // ── OFF-CHAIN RECOMPUTE PREVIEW (always — this is the heart of the dry verification). ──
  // nonce 1n MIRRORS the contract's hardcoded single-draw nonce (settleWithSeeds folds uint64(1)).
  const r = roundRandom(serverSeed, clientSeed, 1n)
  const outcome = game.settleRound(stake, { targetX100 }, r)
  const expectedPayout = outcome.win ? outcome.playerDelta + stake : 0n
  const expectedBalanceHouse = pot - expectedPayout
  console.log(`recompute @ nonce 1: r=${r}`)
  console.log(`  → ${outcome.win ? 'WIN' : 'LOSS'} (multX100=${outcome.multiplierX100})` +
    ` expected payoutPlayer=${formatUnits(expectedPayout, 18)} payoutHouse=${formatUnits(expectedBalanceHouse, 18)}`)

  // Conservation must hold for the off-chain expectation (the contract asserts payout<=pot too).
  if (expectedPayout > pot) throw new Error(`off-chain payout ${expectedPayout} exceeds pot ${pot}`)
  if (expectedPayout + expectedBalanceHouse !== pot) throw new Error('off-chain conservation broke')
  console.log(`  ✓ off-chain conservation: payoutPlayer + payoutHouse == pot (${formatUnits(pot, 18)})`)

  if (!EXECUTE) {
    console.log('\nDRY — chain skipped. Re-run with LIVE_EXECUTE=1 AFTER the user-gated HouseChannel redeploy (see header).')
    return
  }

  // ── LIVE: approve → open → settleWithSeeds, then assert on-chain conservation == off-chain. ──
  await send(publicClient, walletClient, '[1/3] approve',
    { address: D.chips, abi: erc20ApproveAbi, functionName: 'approve', args: [D.houseChannel, escrowPlayer] })
  await send(publicClient, walletClient, '[2/3] open',
    { address: D.houseChannel, abi: houseChannelAbi as Abi, functionName: 'open', args: [terms, houseSig] })
  const settleHash = await send(publicClient, walletClient, '[3/3] settleWithSeeds',
    { address: D.houseChannel, abi: houseChannelAbi as Abi, functionName: 'settleWithSeeds',
      args: [tableId, serverSeed, clientSeed, params] })

  // Decode the Settled event from the settle receipt and assert conservation + payout parity.
  const rcpt = await publicClient.getTransactionReceipt({ hash: settleHash })
  let onchainPlayer: bigint | null = null
  let onchainHouse: bigint | null = null
  for (const log of rcpt.logs) {
    try {
      const ev = decodeEventLog({ abi: houseChannelAbi as Abi, data: log.data, topics: log.topics })
      if (ev.eventName === 'Settled') {
        const a = ev.args as unknown as { tableId: Hex; payoutPlayer: bigint; payoutHouse: bigint }
        onchainPlayer = a.payoutPlayer
        onchainHouse = a.payoutHouse
        break
      }
    } catch { /* not a Settled log */ }
  }
  if (onchainPlayer === null || onchainHouse === null) throw new Error('no Settled event in settle receipt')
  console.log(`[settled] on-chain payoutPlayer=${formatUnits(onchainPlayer, 18)} payoutHouse=${formatUnits(onchainHouse, 18)}`)
  if (onchainPlayer + onchainHouse !== pot) {
    throw new Error(`on-chain conservation broke: ${onchainPlayer} + ${onchainHouse} != pot ${pot}`)
  }
  if (onchainPlayer !== expectedPayout) {
    throw new Error(`on-chain payoutPlayer ${onchainPlayer} != off-chain expected ${expectedPayout}`)
  }
  console.log(`  ✓ on-chain conservation holds AND payoutPlayer matches the off-chain recompute`)
  console.log(`\n✅ recompute-round SETTLED on-chain via settleWithSeeds. settle tx ${D.explorer}/tx/${settleHash}`)
}

/** Send (LIVE) a legacy type-0 tx with a live 2x-buffered gasPrice — verbatim from live-round.ts.
 *  Signs LOCALLY via the wallet client's bound account (eth_sendRawTransaction); passing an address
 *  string would make viem use eth_sendTransaction, which the keyed RPC rejects. PulseChain 943's
 *  eth_gasPrice ~5 gwei but baseFee ~7 wei, so 1559 estimation is unreliable — force legacy. */
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
  const rcpt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: POLL_MS })
  if (rcpt.status !== 'success') throw new Error(`${label} reverted in block ${rcpt.blockNumber}`)
  console.log(`${label}: confirmed block ${rcpt.blockNumber}`)
  return hash
}

main().catch((err) => {
  console.error('recompute-round failed:', err)
  process.exit(1)
})
