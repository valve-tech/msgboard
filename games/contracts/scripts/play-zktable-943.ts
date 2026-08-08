/**
 * play-zktable-943.ts — full on-chain HiLoWar hand, two automated players, against the LIVE
 * ZkTable deployment on 943 (or an anvil FORK of it — see "FORK VALIDATION" below).
 *
 * Mirrors three proven patterns already in this repo:
 *   - test/HoldemSettleE2E.test.ts's shape: run an off-chain co-signed session to a SETTLED
 *     ChannelState, then submit it to the on-chain `settle()` and assert payouts + zero residue.
 *   - test/x402.ts's DepositAuth builders (buildCreateAuth/buildJoinAuth) — reimplemented here
 *     (not imported) so this script never pulls in `hardhat` (test/x402.ts's deploy* helpers use
 *     `hre.viem`, which requires a Hardhat Runtime Environment this standalone script doesn't
 *     have) — but the EIP-712 domain/types/nonce plumbing is byte-for-byte the same, now signed
 *     against the REAL x402PLS wrapper's own domain instead of MockX402's.
 *   - hilo-war/src/session.ts's Player/openSession/DeckKeyReader driving two seats through the
 *     ZypherDeckProvider (EdOnBN254) path to a co-signed SETTLED ChannelState — the ONLY curve
 *     ZkTable's on-chain verify52/showdown machinery understands (deckkey-binding-spec §C3
 *     struck the secp256k1/AttestedElGamalDeck path for real disputes).
 *
 * ── THE DECK-KEY CHICKEN-AND-EGG (why FixedKeygenDeck exists) ──────────────────────────────────
 * ZkTable's `create`/`join` require each seat's on-chain deck pubkey (`deckKey`) as a call
 * argument — a seat can never be seated without one, no separate registration step. But
 * `Player.setup()` (session.ts) generates its OWN deck keypair internally via
 * `this.cfg.deck.keygen()`, and `ZypherDeckProvider.keygen()` calls the WASM engine's
 * `generate_key()` fresh every call — there is no hook to inject a pre-made keypair. So the
 * naive order (register on-chain, then run setup()) would register one key and gossip/aggregate
 * a DIFFERENT one, and the validate-before-sign guard (deckKeyBinding H-2) would rightly refuse
 * to co-sign ("jointKeyCommit mismatch").
 *
 * `FixedKeygenDeck` below is a same-file subclass (this script owns games/contracts/scripts/**,
 * not zk-core/hilo-war — no library edits) that overrides ONLY `keygen()` to return a
 * pre-generated `{secret, pub}` instead of calling the engine. Every other method (aggregate,
 * initialDeck, shuffle, share, verifyShare, unmask) is untouched and proxies to the same
 * module-level WASM engine singleton `ZypherDeckProvider` already uses internally — so two
 * separate `FixedKeygenDeck` instances (one per seat) behave identically to sharing one instance
 * (the "one deck per channel" global-state caveat in zypherDeck.ts's header is about concurrent
 * TABLES clashing on the global prover-key/joint-key state, not about instance identity). This
 * lets us: (1) call `.keygen()` once per seat up front, (2) register those exact pubkeys
 * on-chain via create()/join(), (3) hand each seat a `FixedKeygenDeck` that replays that same
 * keypair when `Player.setup()` asks for one — so the on-chain-registered key and the
 * off-chain-aggregated key are provably the same key, and the DeckKeyReader (which reads
 * `ZkTable.deckKeys(tableId, seat)` from the chain) validates cleanly.
 *
 * ── LIVE usage (the main session runs this — NOT this task) ────────────────────────────────────
 *   PRIVATE_KEY=<funded 943 deployer/funder key> npx tsx scripts/play-zktable-943.ts
 *
 * ── FORK VALIDATION (this task — never broadcasts live) ────────────────────────────────────────
 *   ~/.foundry/bin/anvil --fork-url https://rpc.v4.testnet.pulsechain.com --port 8546 &
 *   FORK=1 PRIVATE_KEY=<any anvil default account key> npx tsx scripts/play-zktable-943.ts
 *   FORK=1 PRIVATE_KEY=<...> ATTEMPT_DISPUTE=1 npx tsx scripts/play-zktable-943.ts   # + a dispute round
 *
 * Env:
 *   FORK=1                    — points RPC_URL at the local anvil fork (http://127.0.0.1:8546)
 *                                and, since anvil auto-mines, uses `anvil_setBalance` for funding
 *                                instead of a real funding transaction (faster, no gas needed).
 *   RPC_URL                   — override the endpoint outright.
 *   CHAIN_ID                  (default 943)
 *   ZKTABLE / X402PLS / WRAPPER_FACTORY / HILOWAR_RULES — 943 defaults baked in (see below).
 *   PRIVATE_KEY                — the FUNDER. REQUIRED. Funds the two player wallets with native
 *                                gas and enough native PLS to `wrap()` into x402PLS buy-in.
 *   PLAYER1_KEY / PLAYER2_KEY  — optional; else derived deterministically (keccak256 of a fixed
 *                                label) so repeat runs reuse the same two wallets and their
 *                                already-wrapped x402PLS balance (wrap-if-short, not wrap-fresh).
 *   ROUNDS                     (default 1) — number of full hands to play, each its own table.
 *   BUY_IN_ETHER               (default "0.01") — escrow per seat, in x402PLS (18dp, 1:1 with PLS).
 *   ANTE_ETHER                 (default "0.0005")
 *   CLOCK_BLOCKS               (default 30 — ZkTable's MIN_CLOCK_BLOCKS)
 *   ATTEMPT_DISPUTE=1          — also run a best-effort on-chain dispute round (disputeSetup ->
 *                                mine past the clock -> resolveTimeout -> full refund). Runs
 *                                automatically under FORK=1 unless ATTEMPT_DISPUTE=0.
 */
import * as viem from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  Channel,
  LocalTransport,
  ZypherDeckProvider,
  makeDomain,
  uncompressPoint,
  type ChannelDomain,
} from '@msgboard/zk-cards-core'
import { Player, openSession, type DeckKeyReader } from '@msgboard/hilo-war'
import { resolveLegacyFee } from './gas'

// silence unused-import: Channel/ChannelDomain types are referenced only in type positions below
void (Channel as unknown)

// ── artifact loading (same recipe as deploy-zkcards.ts — no hardhat runtime needed) ────────────

function loadArtifactAbi(relPath: string): viem.Abi {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('node:path') as typeof import('node:path')
  const p = path.resolve(__dirname, '../artifacts', relPath)
  if (!fs.existsSync(p)) {
    throw new Error(`play-zktable-943: missing artifact ${relPath} — run \`hardhat compile\` first`)
  }
  return (JSON.parse(fs.readFileSync(p, 'utf8')).abi) as viem.Abi
}

const ZK_TABLE_ABI = () => loadArtifactAbi('contracts/zk/ZkTable.sol/ZkTable.json')

// Minimal ABI slice of ValveWrapperImpl (monorepo/packages/contracts/contracts/ValveWrapperImpl.sol)
// this script actually calls — `wrap()` (payable, native-PLS -> x402PLS 1:1) + `balanceOf`.
const WRAPPER_ABI = [
  { type: 'function', name: 'wrap', stateMutability: 'payable', inputs: [], outputs: [] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

// ── x402 DepositAuth builder — real wrapper domain, ZkTable's own nonce formulas ───────────────
// Mirrors test/x402.ts's buildCreateAuth/buildJoinAuth exactly, minus the `hre.viem` plumbing
// (this script drives its own viem clients against a live/forked RPC, not a Hardhat network).

const X402_DOMAIN_NAME = 'x402 PLS' // ValveWrapperImpl.initialize(): underlying==0 => name "x402 PLS"
const X402_DOMAIN_VERSION = '1' // OZ ERC20PermitUpgradeable's default EIP-712 version

const RECEIVE_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

type DepositAuth = { from: viem.Hex; validBefore: bigint; salt: viem.Hex; sig: viem.Hex }

async function signDepositAuth(
  account: ReturnType<typeof privateKeyToAccount>,
  domain: { name: string; version: string; chainId: number; verifyingContract: viem.Hex },
  message: { from: viem.Hex; to: viem.Hex; value: bigint; validAfter: bigint; validBefore: bigint; nonce: viem.Hex },
  salt: viem.Hex,
): Promise<DepositAuth> {
  const sig = await account.signTypedData({
    domain, types: RECEIVE_TYPES, primaryType: 'ReceiveWithAuthorization', message,
  })
  return { from: message.from, validBefore: message.validBefore, salt, sig }
}

const validBeforeIn = (secs: number) => BigInt(Math.floor(Date.now() / 1000) + secs)

// ── deck-key chicken-and-egg fix (see file header) ──────────────────────────────────────────────

class FixedKeygenDeck extends ZypherDeckProvider {
  constructor(private readonly fixed: { secret: viem.Hex; pub: viem.Hex }) {
    super()
  }
  override async keygen(): Promise<{ secret: viem.Hex; pub: viem.Hex }> {
    return this.fixed
  }
}

function deckKeyOf(pub: viem.Hex): readonly [bigint, bigint] {
  const { x, y } = uncompressPoint(pub)
  return [x, y]
}

// ── env / config ─────────────────────────────────────────────────────────────────────────────

const FORK = process.env.FORK === '1'
const RPC = process.env.RPC_URL ?? (FORK ? 'http://127.0.0.1:8546' : 'https://rpc.v4.testnet.pulsechain.com')
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 943)
const ROUNDS = Number(process.env.ROUNDS ?? 1)
const BUY_IN = viem.parseEther(process.env.BUY_IN_ETHER ?? '0.01')
const ANTE = viem.parseEther(process.env.ANTE_ETHER ?? '0.0005')
const CLOCK_BLOCKS = BigInt(process.env.CLOCK_BLOCKS ?? 30)
const ATTEMPT_DISPUTE = process.env.ATTEMPT_DISPUTE ? process.env.ATTEMPT_DISPUTE === '1' : FORK

// 943 defaults — see games/contracts/deployments/943-zkcards.json (block 25074838) + the real
// ValveWrapperFactory/x402PLS wrapper (memory: zk-x402-escrow-conversion).
const ZKTABLE = viem.getAddress(process.env.ZKTABLE ?? '0x8c31a72709b030574c4d8f4142abdd504912442d')
const X402PLS = viem.getAddress(process.env.X402PLS ?? '0xeb274050cb029288B8A4F232Da8d23F393d54A1E')
const WRAPPER_FACTORY = viem.getAddress(process.env.WRAPPER_FACTORY ?? '0xB10A088ea04B261371Edc9Fe9e6121B8355aDe70')
const HILOWAR_RULES = viem.getAddress(process.env.HILOWAR_RULES ?? '0x0e383ad7efe7d8f4f0be0768126b9c7922cabc8e')

function requiredPk(name: string): viem.Hex {
  const v = process.env[name]
  if (!v) throw new Error(`play-zktable-943: set ${name} in the environment`)
  return (v.startsWith('0x') ? v : `0x${v}`) as viem.Hex
}

function derivedPk(label: string): viem.Hex {
  return viem.keccak256(viem.stringToHex(`play-zktable-943/v1/${label}`))
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  /* eslint-disable no-console */
  const funder = privateKeyToAccount(requiredPk('PRIVATE_KEY'))
  const player1 = privateKeyToAccount(process.env.PLAYER1_KEY ? requiredPk('PLAYER1_KEY') : derivedPk('player-1'))
  const player2 = privateKeyToAccount(process.env.PLAYER2_KEY ? requiredPk('PLAYER2_KEY') : derivedPk('player-2'))

  const chain = {
    id: CHAIN_ID,
    name: `chain-${CHAIN_ID}`,
    nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  } as const

  const publicClient = viem.createPublicClient({ chain, transport: viem.http(RPC) })
  const funderClient = viem.createWalletClient({ account: funder, chain, transport: viem.http(RPC) })
  const p1Client = viem.createWalletClient({ account: player1, chain, transport: viem.http(RPC) })
  const p2Client = viem.createWalletClient({ account: player2, chain, transport: viem.http(RPC) })

  const zkAbi = ZK_TABLE_ABI()
  const domain: ChannelDomain = makeDomain(CHAIN_ID, ZKTABLE) as ChannelDomain

  console.log('── play-zktable-943 ──')
  console.log('mode:', FORK ? 'ANVIL FORK (no live broadcast)' : 'LIVE 943')
  console.log('rpc:', RPC, '| chainId:', CHAIN_ID)
  console.log('zkTable:', ZKTABLE, '| x402PLS:', X402PLS, '| hiLoWarRules:', HILOWAR_RULES)
  console.log('funder:', funder.address)
  console.log('player1 (seat A):', player1.address)
  console.log('player2 (seat B):', player2.address)
  console.log('buyIn:', viem.formatEther(BUY_IN), 'x402PLS/seat | ante:', viem.formatEther(ANTE), '| clockBlocks:', CLOCK_BLOCKS)

  const fee = await resolveLegacyFee(publicClient)
  console.log('gas: legacy', viem.formatGwei(fee.gasPrice), 'gwei\n')

  // ── funding ──────────────────────────────────────────────────────────────────────────────
  const GAS_FLOOR = viem.parseEther('0.02') // headroom for several legacy-gas txs per player
  const wrapAmountPerPlayer = BUY_IN * BigInt(Math.max(ROUNDS, 1) + 1) // buffer so re-runs don't need a re-wrap

  async function ensureNativeBalance(who: viem.Hex, minWei: bigint, label: string): Promise<void> {
    const bal = await publicClient.getBalance({ address: who })
    if (bal >= minWei) {
      console.log(`  ${label}: native balance ${viem.formatEther(bal)} PLS — sufficient`)
      return
    }
    const topUp = minWei - bal + viem.parseEther('0.005')
    if (FORK) {
      await publicClient.request({
        method: 'anvil_setBalance' as any,
        params: [who, viem.numberToHex(bal + topUp)] as any,
      })
      console.log(`  ${label}: anvil_setBalance +${viem.formatEther(topUp)} PLS`)
    } else {
      const hash = await funderClient.sendTransaction({ to: who, value: topUp, gasPrice: fee.gasPrice, type: 'legacy' })
      await publicClient.waitForTransactionReceipt({ hash })
      console.log(`  ${label}: funded +${viem.formatEther(topUp)} PLS (tx ${hash})`)
    }
  }

  async function ensureX402Balance(client: typeof p1Client, who: viem.Hex, minWei: bigint, label: string): Promise<void> {
    const bal = (await publicClient.readContract({ address: X402PLS, abi: WRAPPER_ABI, functionName: 'balanceOf', args: [who] })) as bigint
    if (bal >= minWei) {
      console.log(`  ${label}: x402PLS balance ${viem.formatEther(bal)} — sufficient`)
      return
    }
    const shortfall = minWei - bal
    // native PLS to cover the wrap must already be funded by ensureNativeBalance (called first).
    const hash = await client.writeContract({
      address: X402PLS, abi: WRAPPER_ABI, functionName: 'wrap', args: [], value: shortfall,
      account: client.account!, chain, gasPrice: fee.gasPrice, type: 'legacy',
    })
    await publicClient.waitForTransactionReceipt({ hash })
    console.log(`  ${label}: wrapped +${viem.formatEther(shortfall)} PLS -> x402PLS (tx ${hash})`)
  }

  console.log('funding + wrapping players:')
  await ensureNativeBalance(player1.address, GAS_FLOOR + wrapAmountPerPlayer, 'player1')
  await ensureNativeBalance(player2.address, GAS_FLOOR + wrapAmountPerPlayer, 'player2')
  await ensureX402Balance(p1Client, player1.address, wrapAmountPerPlayer, 'player1')
  await ensureX402Balance(p2Client, player2.address, wrapAmountPerPlayer, 'player2')
  console.log()

  // ── on-chain deck-key reader (deckKeys(tableId, seat, idx) — a scalar getter per index) ────
  const deckKeyReader: DeckKeyReader = async (tableId, seat) => {
    const x = (await publicClient.readContract({ address: ZKTABLE, abi: zkAbi, functionName: 'deckKeys', args: [tableId, seat, 0n] })) as bigint
    const y = (await publicClient.readContract({ address: ZKTABLE, abi: zkAbi, functionName: 'deckKeys', args: [tableId, seat, 1n] })) as bigint
    return [x, y]
  }

  async function tableStatus(tableId: viem.Hex): Promise<number> {
    const t = (await publicClient.readContract({ address: ZKTABLE, abi: zkAbi, functionName: 'tables', args: [tableId] })) as unknown as any[]
    return Number(t[9]) // Table.status is the 10th field — see the struct layout in ZkTable.sol
  }

  // ── one full happy-path HiLoWar hand: create -> join -> off-chain session -> settle ────────
  async function playHappyRound(idx: number): Promise<void> {
    console.log(`══ round ${idx}: happy path ══`)

    // Captured BEFORE create() escrows anything, so the "zero residue" check below reflects
    // this round's own full create->join->settle cycle, independent of any other table's
    // escrow already sitting in the (shared, persistent) ZkTable contract.
    const contractTokenBeforeRound = (await publicClient.readContract({ address: X402PLS, abi: WRAPPER_ABI, functionName: 'balanceOf', args: [ZKTABLE] })) as bigint

    // 1. pre-generate BOTH seats' deck keypairs off-chain FIRST (see file header) so create()/
    //    join() can register the exact keys the session will later replay via FixedKeygenDeck.
    const throwaway = new ZypherDeckProvider()
    const keyA = await throwaway.keygen()
    const keyB = await throwaway.keygen()
    const deckKeyA = deckKeyOf(keyA.pub)
    const deckKeyB = deckKeyOf(keyB.pub)

    // 2. create() — seat A (player1), channelKey == its own wallet.
    const createSalt = viem.keccak256(viem.stringToHex(`round-${idx}-create-${Date.now()}`))
    const createValidBefore = validBeforeIn(3600)
    const createNonce = (await publicClient.readContract({
      address: ZKTABLE, abi: zkAbi, functionName: 'createNonce',
      args: [player1.address, X402PLS, HILOWAR_RULES, BUY_IN, BUY_IN, CLOCK_BLOCKS, player1.address, deckKeyA, createSalt],
    })) as viem.Hex
    const createAuth = await signDepositAuth(
      player1,
      { name: X402_DOMAIN_NAME, version: X402_DOMAIN_VERSION, chainId: CHAIN_ID, verifyingContract: X402PLS },
      { from: player1.address, to: ZKTABLE, value: BUY_IN, validAfter: 0n, validBefore: createValidBefore, nonce: createNonce },
      createSalt,
    )
    const createHash = await p1Client.writeContract({
      address: ZKTABLE, abi: zkAbi, functionName: 'create',
      args: [X402PLS, BUY_IN, HILOWAR_RULES, BUY_IN, CLOCK_BLOCKS, player1.address, deckKeyA, createAuth],
      account: player1, chain, gasPrice: fee.gasPrice, type: 'legacy',
    })
    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash })
    console.log(`  create() tx: ${createHash} (status ${createReceipt.status})`)
    const createdLogs = (await publicClient.getContractEvents({
      address: ZKTABLE, abi: zkAbi, eventName: 'TableCreated', fromBlock: createReceipt.blockNumber, toBlock: createReceipt.blockNumber,
    })) as unknown as Array<{ args: { tableId: viem.Hex }; transactionHash: viem.Hex }>
    const tableId = createdLogs.find((l) => l.transactionHash === createHash)!.args.tableId
    console.log(`  tableId: ${tableId}`)

    // 3. join() — seat B (player2).
    const joinValidBefore = validBeforeIn(3600)
    const joinNonce = (await publicClient.readContract({
      address: ZKTABLE, abi: zkAbi, functionName: 'joinNonce', args: [tableId, player2.address, player2.address, deckKeyB],
    })) as viem.Hex
    const joinAuth = await signDepositAuth(
      player2,
      { name: X402_DOMAIN_NAME, version: X402_DOMAIN_VERSION, chainId: CHAIN_ID, verifyingContract: X402PLS },
      { from: player2.address, to: ZKTABLE, value: BUY_IN, validAfter: 0n, validBefore: joinValidBefore, nonce: joinNonce },
      viem.zeroHash,
    )
    const joinHash = await p2Client.writeContract({
      address: ZKTABLE, abi: zkAbi, functionName: 'join', args: [tableId, player2.address, deckKeyB, joinAuth],
      account: player2, chain, gasPrice: fee.gasPrice, type: 'legacy',
    })
    const joinReceipt = await publicClient.waitForTransactionReceipt({ hash: joinHash })
    console.log(`  join() tx: ${joinHash} (status ${joinReceipt.status})`)
    console.log(`  table status after join: ${await tableStatus(tableId)} (expect 2 = Live)`)

    // 4. off-chain session: two Players, ZypherDeckProvider (fixed-keygen), on-chain deckKeyReader.
    const [ta, tb] = LocalTransport.pair()
    const deckA = new FixedKeygenDeck(keyA)
    const deckB = new FixedKeygenDeck(keyB)
    const a = new Player({
      role: 'A', wallet: player1, peer: player2.address, transport: ta, deck: deckA, domain, tableId,
      ante: ANTE, escrowEach: BUY_IN, deckKeyReader,
    })
    const b = new Player({
      role: 'B', wallet: player2, peer: player1.address, transport: tb, deck: deckB, domain, tableId,
      ante: ANTE, escrowEach: BUY_IN, deckKeyReader,
    })
    console.log('  running off-chain session: setup (deck keygen/shuffle + deal-binding validate)…')
    await openSession(a, b)
    console.log('  setup co-signed. genesis nonce:', a.channel.latest!.state.nonce.toString())

    console.log('  playing one flip (HOLD/HOLD to a decisive showdown)…')
    const [ra, rb] = await Promise.all([
      a.playFlip({ bet: 'HOLD', onRaise: 'CALL' }),
      b.playFlip({ bet: 'HOLD', onRaise: 'CALL' }),
    ])
    console.log(`  flip done: A card=${ra.myCard} B card=${rb.myCard} winner=${ra.flip.result?.winner ?? 'tie/war-carry'}`)

    const [fa, fb] = await Promise.all([a.requestSettle(), b.acceptSettle()])
    const bigintSafe = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)
    if (JSON.stringify(fa.state, bigintSafe) !== JSON.stringify(fb.state, bigintSafe)) {
      throw new Error('round: A and B settle states diverge')
    }
    console.log(`  co-signed SETTLED state: balanceA=${fa.state.balanceA} balanceB=${fa.state.balanceB} pot=${fa.state.pot}`)

    // 5. submit settle() on-chain (permissionless — submitted by player1's client here).
    const p1Before = (await publicClient.readContract({ address: X402PLS, abi: WRAPPER_ABI, functionName: 'balanceOf', args: [player1.address] })) as bigint
    const p2Before = (await publicClient.readContract({ address: X402PLS, abi: WRAPPER_ABI, functionName: 'balanceOf', args: [player2.address] })) as bigint

    const settleHash = await p1Client.writeContract({
      address: ZKTABLE, abi: zkAbi, functionName: 'settle',
      args: [tableId, fa.state, fa.sigA!, fa.sigB!],
      account: player1, chain, gasPrice: fee.gasPrice, type: 'legacy',
    })
    const settleReceipt = await publicClient.waitForTransactionReceipt({ hash: settleHash })
    console.log(`  settle() tx: ${settleHash} (status ${settleReceipt.status})`)

    const status = await tableStatus(tableId)
    const contractTokenAfterRound = (await publicClient.readContract({ address: X402PLS, abi: WRAPPER_ABI, functionName: 'balanceOf', args: [ZKTABLE] })) as bigint
    const p1After = (await publicClient.readContract({ address: X402PLS, abi: WRAPPER_ABI, functionName: 'balanceOf', args: [player1.address] })) as bigint
    const p2After = (await publicClient.readContract({ address: X402PLS, abi: WRAPPER_ABI, functionName: 'balanceOf', args: [player2.address] })) as bigint

    console.log(`  table status: ${status} (expect 4 = Settled)`)
    console.log(`  ZkTable x402PLS balance: before-round=${contractTokenBeforeRound} after-round=${contractTokenAfterRound} (delta must be 0 — zero residue from this round's own create->join->settle cycle)`)
    console.log(`  player1 payout: ${p1After - p1Before} (expect ${fa.state.balanceA})`)
    console.log(`  player2 payout: ${p2After - p2Before} (expect ${fa.state.balanceB})`)

    if (status !== 4) throw new Error(`round ${idx}: table did not reach Settled (status ${status})`)
    if (contractTokenAfterRound !== contractTokenBeforeRound) throw new Error(`round ${idx}: non-zero residue left on ZkTable (${contractTokenAfterRound - contractTokenBeforeRound})`)
    if (p1After - p1Before !== fa.state.balanceA) throw new Error(`round ${idx}: player1 payout mismatch`)
    if (p2After - p2Before !== fa.state.balanceB) throw new Error(`round ${idx}: player2 payout mismatch`)
    console.log(`  ✓ round ${idx} PASSED\n`)
  }

  // ── best-effort dispute round: disputeSetup -> mine past clock -> resolveTimeout ────────────
  // Uses the PRE-first-move liveness path (ChannelTableBase/ZkTable disputeSetup, demandKind=0):
  // requires NO off-chain session, NO gameState, NO snark proof — just create+join, then either
  // seat calls disputeSetup() and, if the counterparty produces no co-signed state before the
  // clock, resolveTimeout() force-refunds both escrows in full. Exercises a REAL on-chain
  // dispute -> resolve cycle end to end; the richer mid-hand DEMAND_MOVE/SHARE/SHOWDOWN paths
  // need a co-signed off-chain checkpoint that session.ts's Player API does not expose
  // mid-flip (playFlip() only returns after the whole flip completes) — flagged as a follow-up
  // rather than forced through a hacky Player-internals reach-in.
  async function playDisputeRound(): Promise<void> {
    console.log('══ best-effort dispute round: disputeSetup -> resolveTimeout (full refund) ══')
    const throwaway = new ZypherDeckProvider()
    const keyA = await throwaway.keygen()
    const keyB = await throwaway.keygen()
    const deckKeyA = deckKeyOf(keyA.pub)
    const deckKeyB = deckKeyOf(keyB.pub)

    const createSalt = viem.keccak256(viem.stringToHex(`dispute-create-${Date.now()}`))
    const createValidBefore = validBeforeIn(3600)
    const createNonce = (await publicClient.readContract({
      address: ZKTABLE, abi: zkAbi, functionName: 'createNonce',
      args: [player1.address, X402PLS, HILOWAR_RULES, BUY_IN, BUY_IN, CLOCK_BLOCKS, player1.address, deckKeyA, createSalt],
    })) as viem.Hex
    const createAuth = await signDepositAuth(
      player1,
      { name: X402_DOMAIN_NAME, version: X402_DOMAIN_VERSION, chainId: CHAIN_ID, verifyingContract: X402PLS },
      { from: player1.address, to: ZKTABLE, value: BUY_IN, validAfter: 0n, validBefore: createValidBefore, nonce: createNonce },
      createSalt,
    )
    const createHash = await p1Client.writeContract({
      address: ZKTABLE, abi: zkAbi, functionName: 'create',
      args: [X402PLS, BUY_IN, HILOWAR_RULES, BUY_IN, CLOCK_BLOCKS, player1.address, deckKeyA, createAuth],
      account: player1, chain, gasPrice: fee.gasPrice, type: 'legacy',
    })
    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash })
    const createdLogs = (await publicClient.getContractEvents({
      address: ZKTABLE, abi: zkAbi, eventName: 'TableCreated', fromBlock: createReceipt.blockNumber, toBlock: createReceipt.blockNumber,
    })) as unknown as Array<{ args: { tableId: viem.Hex }; transactionHash: viem.Hex }>
    const tableId = createdLogs.find((l) => l.transactionHash === createHash)!.args.tableId
    console.log(`  tableId: ${tableId} (create tx ${createHash})`)

    const joinValidBefore = validBeforeIn(3600)
    const joinNonce = (await publicClient.readContract({
      address: ZKTABLE, abi: zkAbi, functionName: 'joinNonce', args: [tableId, player2.address, player2.address, deckKeyB],
    })) as viem.Hex
    const joinAuth = await signDepositAuth(
      player2,
      { name: X402_DOMAIN_NAME, version: X402_DOMAIN_VERSION, chainId: CHAIN_ID, verifyingContract: X402PLS },
      { from: player2.address, to: ZKTABLE, value: BUY_IN, validAfter: 0n, validBefore: joinValidBefore, nonce: joinNonce },
      viem.zeroHash,
    )
    const joinHash = await p2Client.writeContract({
      address: ZKTABLE, abi: zkAbi, functionName: 'join', args: [tableId, player2.address, deckKeyB, joinAuth],
      account: player2, chain, gasPrice: fee.gasPrice, type: 'legacy',
    })
    await publicClient.waitForTransactionReceipt({ hash: joinHash })
    console.log(`  join tx ${joinHash}; table Live, no co-signed state ever submitted on-chain`)

    const disputeHash = await p1Client.writeContract({
      address: ZKTABLE, abi: zkAbi, functionName: 'disputeSetup', args: [tableId],
      account: player1, chain, gasPrice: fee.gasPrice, type: 'legacy',
    })
    await publicClient.waitForTransactionReceipt({ hash: disputeHash })
    console.log(`  disputeSetup() tx: ${disputeHash}; table status: ${await tableStatus(tableId)} (expect 3 = Disputed)`)

    if (FORK) {
      // anvil auto-mines; force CLOCK_BLOCKS+1 empty blocks past the deadline.
      await publicClient.request({ method: 'anvil_mine' as any, params: [viem.numberToHex(CLOCK_BLOCKS + 1n)] as any })
    } else {
      console.log(`  waiting for ${CLOCK_BLOCKS + 1n} real blocks to pass on live 943…`)
      const start = await publicClient.getBlockNumber()
      while ((await publicClient.getBlockNumber()) < start + CLOCK_BLOCKS + 1n) {
        await new Promise((r) => setTimeout(r, 5000))
      }
    }

    const p1Before = (await publicClient.readContract({ address: X402PLS, abi: WRAPPER_ABI, functionName: 'balanceOf', args: [player1.address] })) as bigint
    const p2Before = (await publicClient.readContract({ address: X402PLS, abi: WRAPPER_ABI, functionName: 'balanceOf', args: [player2.address] })) as bigint

    const resolveHash = await p1Client.writeContract({
      address: ZKTABLE, abi: zkAbi, functionName: 'resolveTimeout', args: [tableId],
      account: player1, chain, gasPrice: fee.gasPrice, type: 'legacy',
    })
    await publicClient.waitForTransactionReceipt({ hash: resolveHash })
    const status = await tableStatus(tableId)
    const p1After = (await publicClient.readContract({ address: X402PLS, abi: WRAPPER_ABI, functionName: 'balanceOf', args: [player1.address] })) as bigint
    const p2After = (await publicClient.readContract({ address: X402PLS, abi: WRAPPER_ABI, functionName: 'balanceOf', args: [player2.address] })) as bigint

    console.log(`  resolveTimeout() tx: ${resolveHash}; table status: ${status} (expect 4 = Settled)`)
    console.log(`  player1 refund: ${p1After - p1Before} (expect ${BUY_IN}) | player2 refund: ${p2After - p2Before} (expect ${BUY_IN})`)
    if (status !== 4) throw new Error('dispute round: table did not reach Settled')
    if (p1After - p1Before !== BUY_IN || p2After - p2Before !== BUY_IN) throw new Error('dispute round: refund mismatch')
    console.log('  ✓ dispute round PASSED (full refund via disputeSetup -> resolveTimeout)\n')
  }

  for (let i = 1; i <= ROUNDS; i++) {
    await playHappyRound(i)
  }

  if (ATTEMPT_DISPUTE) {
    await playDisputeRound()
  } else {
    console.log('(dispute round skipped — set ATTEMPT_DISPUTE=1 to run it; auto-on under FORK=1)')
  }

  console.log('ALL ROUNDS PASSED.')
  /* eslint-enable no-console */
}

const invokedDirectly = typeof require !== 'undefined' && require.main === module
if (invokedDirectly) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e)
    process.exit(1)
  })
}

export { main }
