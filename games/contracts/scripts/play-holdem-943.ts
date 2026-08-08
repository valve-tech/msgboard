/**
 * play-holdem-943.ts — a full N-party Texas Hold'em hand, played off-chain to a co-signed
 * SHOWDOWN `ChannelStateN`, then driven through the CONTESTED on-chain adjudication path
 * (C2: `openShowdownDispute` -> `postShowdownReveals` (real secp256k1 shares + Chaum-Pedersen
 * DLEQ proofs) -> `finalizeShowdownN`) against the hardened `HoldemTableN` deployment on 943 —
 * or an anvil FORK of it (see "FORK VALIDATION" below). Also exercises a best-effort
 * withhold-then-`resolveShowdownTimeout` variant.
 *
 * Mirrors three proven patterns already in this repo:
 *   - scripts/play-zktable-943.ts's shape: fund players from PRIVATE_KEY, wrap x402PLS,
 *     resolveLegacyFee for every tx, FORK=1 anvil_setBalance vs live broadcast.
 *   - test/HoldemSettleE2E.test.ts's session pattern: `@msgboard/holdem`'s `runHand` drives
 *     `AttestedElGamalDeck` (secp256k1 — the ONLY curve HoldemTableN's on-chain showdown
 *     decode understands) through deck -> deal -> betting -> showdown to a co-signed final
 *     state, and `test/x402.ts`'s `buildCreateAuthN`/`buildJoinAuthN` (reimplemented here,
 *     without the `hre.viem` plumbing, exactly as play-zktable-943.ts reimplements ZkTable's).
 *   - test/foundry/HoldemTableNShowdownC2.t.sol's on-chain call sequence for the C2 contested
 *     path: `openShowdownDispute` -> every seat's `postShowdownReveals` -> `finalizeShowdownN`
 *     (or, for the withhold variant, `resolveShowdownTimeout` after the clock).
 *
 * ── THE co-signed SHOWDOWN CHECKPOINT (why we don't just call `settle()`) ──────────────────────
 * `runHand` drives betting all the way to a SETTLED state (it also resolves the showdown
 * off-chain and calls `HoldemTableN.settle` in the happy-path E2E test). This script instead
 * wants the CONTESTED path: the co-signed state at `phase == SHOWDOWN` — the moment the last
 * bet/check closes the river with nobody having folded down to one seat — is captured in
 * `res.coSigned`/`res.gameStates` (1:1 aligned, per `HandResult`'s own doc) BEFORE the SHOWDOWN
 * move is applied. We locate that entry (`gameStates[i].phase === Phase.SHOWDOWN`) and use ITS
 * `.state`/`.sigs` as the disputed state for `openShowdownDispute`, instead of ever calling
 * `settle()` with the final SETTLED state. This is exactly the "forced-reveal" moment the C2
 * hardening exists for: a counterparty could refuse to co-sign SETTLED past this point, and the
 * only way to get paid is the on-chain reveal-then-finalize path we drive below.
 *
 * ── RECOVERING THE FULL MASKED DECK (why we read the transcript, not `HandResult`) ─────────────
 * `HandResult` deliberately does not expose the post-shuffle `finalDeck` array (only `initial`
 * and `deckCommitment` — see session.ts). But the masked deck is PUBLIC (ciphertext, not a
 * secret) and is posted to the in-memory transcript's SHUFFLE steps by `runDeal` — the LAST
 * seat's SHUFFLE post (`body.round.deck`) is exactly `finalDeck` (`runShuffleChain`'s own
 * definition: seat i shuffles seat i-1's output, so the final round IS the final deck). We
 * extract it from `res.transcript.entries` and assert `deckCommitment(finalDeck) ===
 * res.deckCommitment` as a sanity check — this never re-derives or mutates the deck, only reads
 * back what `runHand` already produced and committed to on every co-signed state. This is
 * exactly the 208-word (52-card) array `postShowdownReveals`/`finalizeShowdownN`/
 * `resolveShowdownTimeout` hash-check (`_deckHash`) against `state.deckCommitment` — NOT the
 * smaller "sized exactly to the required slots" convention `HoldemTableNShowdownC2.t.sol`'s
 * synthetic ChannelStateN fixtures use (those tests hand-build both sides of the commitment
 * from scratch; a REAL session's deckCommitment is over the FULL 52-card deck, and
 * `HoldemShowdownLib.deckHash` accepts any `deck.length % 4 == 0`, so passing the full deck here
 * is both correct and required for the hash to match).
 *
 * ── THE OFF-CHAIN ORACLE (why we deploy our own `HoldemRules`) ─────────────────────────────────
 * `HoldemTableN.create()` takes a `rules` address per table — it is not baked into the
 * deployment. This script deploys a fresh `HoldemRules` instance per run (stateless, no
 * constructor args, safe to redeploy — mirrors `HoldemTableNShowdownC2.t.sol`'s `new
 * HoldemRules()`) and uses it BOTH as the table's rules contract AND as the off-chain oracle:
 * `rules.settleShowdown(gameStateBytes, holes, board, extraFoldMask)` is the EXACT same
 * function `HoldemShowdownLib.settleOrFail` calls on-chain, so calling it directly (a free view
 * call) gives the ground-truth payout vector to assert the on-chain result against — for BOTH
 * the happy path (`extraFoldMask=0`) and the withhold-timeout variant (`extraFoldMask` = the
 * withholding seat's bit, exactly what `resolveShowdownTimeout`'s rankable branch passes).
 *
 * ── C3 HOOK (skipped, matches session.ts's own header) ──────────────────────────────────────────
 * A real client sitting at ONE seat must call `dealBindingN.ts#verifyDealBinding` before
 * co-signing the genesis state. This harness drives every seat itself (no adversarial peer to
 * distrust), so — exactly like `runHand`'s own header and `HoldemSettleE2E.test.ts` — it skips
 * the call.
 *
 * ── LIVE usage (the main session runs this — NOT this task) ────────────────────────────────────
 *   PRIVATE_KEY=<funded 943 deployer/funder key> npx tsx scripts/play-holdem-943.ts
 *   PRIVATE_KEY=<...> SEATS=3 npx tsx scripts/play-holdem-943.ts
 *
 * ── FORK VALIDATION (this task — never broadcasts live) ────────────────────────────────────────
 *   ~/.foundry/bin/anvil --fork-url https://rpc.v4.testnet.pulsechain.com --port 8547 &
 *   FORK=1 PRIVATE_KEY=<any anvil default account key> npx tsx scripts/play-holdem-943.ts
 *   FORK=1 PRIVATE_KEY=<...> SEATS=3 npx tsx scripts/play-holdem-943.ts
 *   FORK=1 PRIVATE_KEY=<...> ATTEMPT_TIMEOUT=0 npx tsx scripts/play-holdem-943.ts   # skip variant
 *
 * Env:
 *   FORK=1                    — points RPC_URL at the local anvil fork (http://127.0.0.1:8547)
 *                                and, since anvil auto-mines, uses `anvil_setBalance`/
 *                                `anvil_mine` instead of real funding txs / real block waits.
 *   RPC_URL                   — override the endpoint outright.
 *   CHAIN_ID                  (default 943)
 *   HOLDEM_TABLE_N / X402PLS / WRAPPER_FACTORY — 943 hardened-redeploy defaults baked in (see
 *                                deployments/943-zkcards.json, block 25082049).
 *   HOLDEM_RULES               — reuse an already-deployed HoldemRules instead of deploying a
 *                                fresh one this run.
 *   PRIVATE_KEY                — the FUNDER. REQUIRED. Funds every seat wallet with native gas
 *                                and enough native PLS to `wrap()` into x402PLS buy-in.
 *   PLAYER<i>_KEY               — optional per-seat override (i = 0..SEATS-1); else derived
 *                                deterministically so repeat runs reuse the same wallets.
 *   SEATS                      (default 2) — table size (N).
 *   ROUNDS                     (default 1) — number of happy-path contested-showdown hands.
 *   BUY_IN_ETHER               (default "0.01") — escrow per seat, in x402PLS.
 *   SB_ETHER / BB_ETHER         (default buyIn/100, buyIn/50)
 *   RAKE_BPS / RAKE_CAP_ETHER   (default 0 / 0)
 *   CLOCK_BLOCKS               (default 30 — HoldemTableN's MIN_CLOCK_BLOCKS)
 *   ATTEMPT_TIMEOUT=1|0         — also run the withhold -> `resolveShowdownTimeout` variant.
 *                                Defaults to 1 under FORK, 0 live (real-block wait is slow).
 */
import * as viem from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  AttestedElGamalDeck,
  deserializePoint,
  type WireMasked,
} from '@msgboard/zk-cards-core'
import {
  runHand,
  makeDomainN,
  encodeGameState,
  deckCommitment as computeDeckCommitment,
  generateShowdownReveals,
  encodeDeckForShowdown,
  requiredShowdownSlots,
  Phase,
  type SeatScript,
  type SessionSeat,
} from '@msgboard/holdem'
import { resolveLegacyFee } from './gas'

// ── artifact loading (same recipe as deploy-zkcards.ts/play-zktable-943.ts — no hardhat runtime) ─

function loadArtifact(relPath: string): { abi: viem.Abi; bytecode: viem.Hex } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('node:path') as typeof import('node:path')
  const p = path.resolve(__dirname, '../artifacts', relPath)
  if (!fs.existsSync(p)) {
    throw new Error(`play-holdem-943: missing artifact ${relPath} — run \`hardhat compile\` first`)
  }
  const a = JSON.parse(fs.readFileSync(p, 'utf8'))
  return { abi: a.abi as viem.Abi, bytecode: a.bytecode as viem.Hex }
}

const HOLDEM_TABLE_N_ABI = () => loadArtifact('contracts/zk/HoldemTableN.sol/HoldemTableN.json').abi
const HOLDEM_RULES_ARTIFACT = () => loadArtifact('contracts/zk/HoldemRules.sol/HoldemRules.json')

const WRAPPER_ABI = [
  { type: 'function', name: 'wrap', stateMutability: 'payable', inputs: [], outputs: [] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

// ── x402 DepositAuth builder — mirrors test/x402.ts's buildCreateAuthN/buildJoinAuthN, minus the
// `hre.viem` plumbing (this script drives its own viem clients against a live/forked RPC).

const X402_DOMAIN_NAME = 'x402 PLS'
const X402_DOMAIN_VERSION = '1'

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

function deckKeyOf(pub: viem.Hex): readonly [bigint, bigint] {
  const a = deserializePoint(pub).toAffine()
  return [a.x, a.y]
}

// ── env / config ─────────────────────────────────────────────────────────────────────────────

const FORK = process.env.FORK === '1'
const RPC = process.env.RPC_URL ?? (FORK ? 'http://127.0.0.1:8547' : 'https://rpc.v4.testnet.pulsechain.com')
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 943)
const SEATS = Number(process.env.SEATS ?? 2)
const ROUNDS = Number(process.env.ROUNDS ?? 1)
const BUY_IN = viem.parseEther(process.env.BUY_IN_ETHER ?? '0.01')
const SB = process.env.SB_ETHER ? viem.parseEther(process.env.SB_ETHER) : BUY_IN / 100n
const BB = process.env.BB_ETHER ? viem.parseEther(process.env.BB_ETHER) : BUY_IN / 50n
const RAKE_BPS = Number(process.env.RAKE_BPS ?? 0)
const RAKE_CAP = viem.parseEther(process.env.RAKE_CAP_ETHER ?? '0')
const CLOCK_BLOCKS = BigInt(process.env.CLOCK_BLOCKS ?? 30)
const ATTEMPT_TIMEOUT = process.env.ATTEMPT_TIMEOUT ? process.env.ATTEMPT_TIMEOUT === '1' : FORK

// 943 hardened-redeploy defaults — deployments/943-zkcards.json, block 25082049.
const HOLDEM_TABLE_N = viem.getAddress(process.env.HOLDEM_TABLE_N ?? '0x096679394ec698550efdda42b64f5c90a8a39882')
const X402PLS = viem.getAddress(process.env.X402PLS ?? '0xeb274050cb029288B8A4F232Da8d23F393d54A1E')
const WRAPPER_FACTORY = viem.getAddress(process.env.WRAPPER_FACTORY ?? '0xB10A088ea04B261371Edc9Fe9e6121B8355aDe70')

function requiredPk(name: string): viem.Hex {
  const v = process.env[name]
  if (!v) throw new Error(`play-holdem-943: set ${name} in the environment`)
  return (v.startsWith('0x') ? v : `0x${v}`) as viem.Hex
}

function derivedPk(label: string): viem.Hex {
  return viem.keccak256(viem.stringToHex(`play-holdem-943/v1/${label}`))
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  /* eslint-disable no-console */
  const funder = privateKeyToAccount(requiredPk('PRIVATE_KEY'))
  const players = Array.from({ length: SEATS }, (_, i) =>
    privateKeyToAccount(process.env[`PLAYER${i}_KEY`] ? requiredPk(`PLAYER${i}_KEY`) : derivedPk(`player-${i}`)),
  )

  const chain = {
    id: CHAIN_ID,
    name: `chain-${CHAIN_ID}`,
    nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  } as const

  const publicClient = viem.createPublicClient({ chain, transport: viem.http(RPC) })
  const funderClient = viem.createWalletClient({ account: funder, chain, transport: viem.http(RPC) })
  const playerClients = players.map((acct) => viem.createWalletClient({ account: acct, chain, transport: viem.http(RPC) }))

  const zkAbi = HOLDEM_TABLE_N_ABI()
  const domain = makeDomainN(CHAIN_ID, HOLDEM_TABLE_N)

  console.log('── play-holdem-943 ──')
  console.log('mode:', FORK ? 'ANVIL FORK (no live broadcast)' : 'LIVE 943')
  console.log('rpc:', RPC, '| chainId:', CHAIN_ID, '| seats:', SEATS)
  console.log('holdemTableN:', HOLDEM_TABLE_N, '| x402PLS:', X402PLS)
  console.log('funder:', funder.address)
  players.forEach((p, i) => console.log(`  seat ${i}:`, p.address))
  console.log('buyIn:', viem.formatEther(BUY_IN), 'x402PLS/seat | sb:', viem.formatEther(SB), '| bb:', viem.formatEther(BB), '| clockBlocks:', CLOCK_BLOCKS)

  const fee = await resolveLegacyFee(publicClient)
  console.log('gas: legacy', viem.formatGwei(fee.gasPrice), 'gwei\n')

  // ── deploy (or reuse) HoldemRules — a stateless rules oracle; not part of the fixed deployment,
  // each table picks its own `rules` address at create() time (see file header). ────────────────
  let holdemRules: viem.Hex
  if (process.env.HOLDEM_RULES) {
    holdemRules = viem.getAddress(process.env.HOLDEM_RULES)
    console.log('holdemRules: reusing', holdemRules)
  } else {
    const art = HOLDEM_RULES_ARTIFACT()
    const hash = await funderClient.deployContract({
      abi: art.abi, bytecode: art.bytecode, args: [],
      account: funder, chain, gas: 20_000_000n, gasPrice: fee.gasPrice, type: 'legacy',
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`play-holdem-943: HoldemRules deploy failed (tx ${hash})`)
    holdemRules = receipt.contractAddress
    console.log('holdemRules: deployed fresh', holdemRules, `(tx ${hash})`)
  }
  console.log()

  async function x402BalanceOf(who: viem.Hex): Promise<bigint> {
    return (await publicClient.readContract({ address: X402PLS, abi: WRAPPER_ABI, functionName: 'balanceOf', args: [who] })) as bigint
  }

  // ── funding ──────────────────────────────────────────────────────────────────────────────
  const GAS_FLOOR = viem.parseEther('0.02')
  const wrapAmountPerPlayer = BUY_IN * BigInt(Math.max(ROUNDS, 1) * 2 + 2) // buffer: happy round + timeout round per pass

  async function ensureNativeBalance(who: viem.Hex, minWei: bigint, label: string): Promise<void> {
    const bal = await publicClient.getBalance({ address: who })
    if (bal >= minWei) {
      console.log(`  ${label}: native balance ${viem.formatEther(bal)} PLS — sufficient`)
      return
    }
    const topUp = minWei - bal + viem.parseEther('0.005')
    if (FORK) {
      await publicClient.request({ method: 'anvil_setBalance' as any, params: [who, viem.numberToHex(bal + topUp)] as any })
      console.log(`  ${label}: anvil_setBalance +${viem.formatEther(topUp)} PLS`)
    } else {
      const hash = await funderClient.sendTransaction({ to: who, value: topUp, gasPrice: fee.gasPrice, type: 'legacy' })
      await publicClient.waitForTransactionReceipt({ hash })
      console.log(`  ${label}: funded +${viem.formatEther(topUp)} PLS (tx ${hash})`)
    }
  }

  async function ensureX402Balance(client: (typeof playerClients)[number], who: viem.Hex, minWei: bigint, label: string): Promise<void> {
    const bal = (await publicClient.readContract({ address: X402PLS, abi: WRAPPER_ABI, functionName: 'balanceOf', args: [who] })) as bigint
    if (bal >= minWei) {
      console.log(`  ${label}: x402PLS balance ${viem.formatEther(bal)} — sufficient`)
      return
    }
    const shortfall = minWei - bal
    const hash = await client.writeContract({
      address: X402PLS, abi: WRAPPER_ABI, functionName: 'wrap', args: [], value: shortfall,
      account: client.account!, chain, gas: 20_000_000n, gasPrice: fee.gasPrice, type: 'legacy',
    })
    await publicClient.waitForTransactionReceipt({ hash })
    console.log(`  ${label}: wrapped +${viem.formatEther(shortfall)} PLS -> x402PLS (tx ${hash})`)
  }

  console.log('funding + wrapping players:')
  for (let i = 0; i < SEATS; i++) {
    await ensureNativeBalance(players[i]!.address, GAS_FLOOR + wrapAmountPerPlayer, `seat ${i}`)
  }
  for (let i = 0; i < SEATS; i++) {
    await ensureX402Balance(playerClients[i]!, players[i]!.address, wrapAmountPerPlayer, `seat ${i}`)
  }
  console.log()

  async function tableStatus(tableId: viem.Hex): Promise<number> {
    return Number(await publicClient.readContract({ address: HOLDEM_TABLE_N, abi: zkAbi, functionName: 'status', args: [tableId] }))
  }

  // ── build N session seats: one secp256k1 deck keypair each (AttestedElGamalDeck — the ONLY
  // curve HoldemTableN's on-chain showdown decode understands), wallet == channel key. ─────────
  const provider = new AttestedElGamalDeck()
  async function makeSeats(): Promise<SessionSeat[]> {
    const seats: SessionSeat[] = []
    for (let i = 0; i < SEATS; i++) {
      const k = await provider.keygen()
      seats.push({ ...k, addr: players[i]!.address, signer: players[i]!, channel: players[i]! })
    }
    return seats
  }

  // ── create -> join(*) -> start ───────────────────────────────────────────────────────────────
  async function createJoinStart(seats: SessionSeat[]): Promise<viem.Hex> {
    const n = seats.length
    const createSalt = viem.keccak256(viem.stringToHex(`create-${Date.now()}-${Math.random()}`))
    const createValidBefore = validBeforeIn(3600)
    const dk0 = deckKeyOf(seats[0]!.pub)
    const createNonce = (await publicClient.readContract({
      address: HOLDEM_TABLE_N, abi: zkAbi, functionName: 'createNonce',
      args: [players[0]!.address, X402PLS, holdemRules, BUY_IN, BigInt(n), RAKE_BPS, RAKE_CAP, CLOCK_BLOCKS, seats[0]!.channel.address, dk0, createSalt],
    })) as viem.Hex
    const createAuth = await signDepositAuth(
      players[0]!,
      { name: X402_DOMAIN_NAME, version: X402_DOMAIN_VERSION, chainId: CHAIN_ID, verifyingContract: X402PLS },
      { from: players[0]!.address, to: HOLDEM_TABLE_N, value: BUY_IN, validAfter: 0n, validBefore: createValidBefore, nonce: createNonce },
      createSalt,
    )
    const createHash = await playerClients[0]!.writeContract({
      address: HOLDEM_TABLE_N, abi: zkAbi, functionName: 'create',
      args: [X402PLS, holdemRules, BUY_IN, BigInt(n), RAKE_BPS, RAKE_CAP, CLOCK_BLOCKS, seats[0]!.channel.address, dk0, createAuth],
      account: players[0]!, chain, gas: 20_000_000n, gasPrice: fee.gasPrice, type: 'legacy',
    })
    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash })
    const createdLogs = (await publicClient.getContractEvents({
      address: HOLDEM_TABLE_N, abi: zkAbi, eventName: 'TableCreated', fromBlock: createReceipt.blockNumber, toBlock: createReceipt.blockNumber,
    })) as unknown as Array<{ args: { tableId: viem.Hex }; transactionHash: viem.Hex }>
    const tableId = createdLogs.find((l) => l.transactionHash === createHash)!.args.tableId
    console.log(`  create() tx: ${createHash} (status ${createReceipt.status}) tableId: ${tableId}`)

    for (let i = 1; i < n; i++) {
      const joinValidBefore = validBeforeIn(3600)
      const dki = deckKeyOf(seats[i]!.pub)
      const joinNonce = (await publicClient.readContract({
        address: HOLDEM_TABLE_N, abi: zkAbi, functionName: 'joinNonce',
        args: [tableId, players[i]!.address, seats[i]!.channel.address, dki, viem.zeroHash],
      })) as viem.Hex
      const joinAuth = await signDepositAuth(
        players[i]!,
        { name: X402_DOMAIN_NAME, version: X402_DOMAIN_VERSION, chainId: CHAIN_ID, verifyingContract: X402PLS },
        { from: players[i]!.address, to: HOLDEM_TABLE_N, value: BUY_IN, validAfter: 0n, validBefore: joinValidBefore, nonce: joinNonce },
        viem.zeroHash,
      )
      const joinHash = await playerClients[i]!.writeContract({
        address: HOLDEM_TABLE_N, abi: zkAbi, functionName: 'join',
        args: [tableId, seats[i]!.channel.address, dki, joinAuth],
        account: players[i]!, chain, gas: 20_000_000n, gasPrice: fee.gasPrice, type: 'legacy',
      })
      await publicClient.waitForTransactionReceipt({ hash: joinHash })
      console.log(`  join() tx (seat ${i}): ${joinHash}`)
    }

    const startHash = await playerClients[0]!.writeContract({
      address: HOLDEM_TABLE_N, abi: zkAbi, functionName: 'start', args: [tableId],
      account: players[0]!, chain, gas: 20_000_000n, gasPrice: fee.gasPrice, type: 'legacy',
    })
    await publicClient.waitForTransactionReceipt({ hash: startHash })
    console.log(`  start() tx: ${startHash}; table status: ${await tableStatus(tableId)} (expect 2 = Live)`)
    return tableId
  }

  /** Every seat except the last CALLs preflop (closing the blind), everyone CHECKs every street
   *  thereafter — a contested run to a real river showdown, nobody folds (mirrors
   *  HoldemSettleE2E.test.ts's N=2/N=3 contested scripts, generalized to N). */
  function contestedScript(n: number): SeatScript[] {
    return Array.from({ length: n }, (_, i) => ({
      preflop: [i < n - 1 ? 'CALL' : 'CHECK'],
      flop: ['CHECK'],
      turn: ['CHECK'],
      river: ['CHECK'],
    }))
  }

  /** Extract the REAL post-shuffle 52-card masked deck from the in-memory transcript (see file
   *  header: HandResult deliberately doesn't expose it) — the last SHUFFLE post's `round.deck`
   *  IS `finalDeck` by `runShuffleChain`'s own definition. Sanity-checked against
   *  `res.deckCommitment`. */
  function extractFinalDeck(transcriptEntries: readonly { kind: string; body: unknown }[], n: number): WireMasked[] {
    const shuffles = transcriptEntries.filter((e) => e.kind === 'SHUFFLE') as unknown as Array<{
      kind: 'SHUFFLE'
      body: { kind: 'SHUFFLE'; seat: number; round: { deck: WireMasked[] } }
    }>
    if (shuffles.length !== n) throw new Error(`play-holdem-943: expected ${n} SHUFFLE posts, got ${shuffles.length}`)
    const last = shuffles.find((s) => s.body.seat === n - 1)
    if (!last) throw new Error('play-holdem-943: could not find the final seat\'s SHUFFLE post')
    return last.body.round.deck
  }

  // ── one full happy-path contested-showdown hand: create->join->start->session->dispute->
  // reveal->finalize, asserting the on-chain payout matches the off-chain HoldemRules oracle. ───
  async function playHappyRound(idx: number): Promise<void> {
    console.log(`══ round ${idx}: happy contested showdown (N=${SEATS}) ══`)
    const contractTokenBefore = await x402BalanceOf(HOLDEM_TABLE_N)

    const seats = await makeSeats()
    const tableId = await createJoinStart(seats)

    console.log('  running off-chain session to a co-signed SHOWDOWN checkpoint…')
    const res = await runHand({
      provider, seats, tableId, buyIn: BUY_IN, button: 0, sb: SB, bb: BB,
      rakeBps: RAKE_BPS, rakeCap: RAKE_CAP, scripts: contestedScript(SEATS), domain,
    })

    const showdownIdx = res.gameStates.findIndex((g) => g.phase === Phase.SHOWDOWN)
    if (showdownIdx < 0) throw new Error('round: session never reached a co-signed SHOWDOWN checkpoint (someone folded out?)')
    const showdownCheckpoint = res.coSigned[showdownIdx]!
    const showdownGame = res.gameStates[showdownIdx]!
    const showdownGameStateBytes = encodeGameState(showdownGame)
    if (viem.keccak256(showdownGameStateBytes) !== showdownCheckpoint.state.gameStateHash) {
      throw new Error('round: encoded gameState does not hash to the co-signed gameStateHash')
    }
    if (showdownCheckpoint.sigs.some((s) => s === undefined)) throw new Error('round: SHOWDOWN checkpoint is not fully co-signed')
    console.log(`  SHOWDOWN checkpoint: nonce=${showdownCheckpoint.state.nonce} pot=${showdownCheckpoint.state.pot} sidePots=${showdownCheckpoint.state.sidePots.length}`)

    const finalDeck = extractFinalDeck(res.transcript.entries, SEATS)
    if (computeDeckCommitment(finalDeck) !== res.deckCommitment) throw new Error('round: extracted finalDeck does not match res.deckCommitment')
    if (showdownCheckpoint.state.deckCommitment !== res.deckCommitment) throw new Error('round: SHOWDOWN checkpoint deckCommitment mismatch')
    const deckWords = encodeDeckForShowdown(finalDeck)
    console.log(`  extracted+verified finalDeck (${finalDeck.length} cards, deckCommitment ${res.deckCommitment})`)

    const fullMask = (1n << BigInt(SEATS)) - 1n
    const slots = requiredShowdownSlots(SEATS, fullMask)

    // 1. openShowdownDispute — permissionless; the funder opens it (models a watchtower/relayer,
    //    not necessarily a seat).
    const openHash = await funderClient.writeContract({
      address: HOLDEM_TABLE_N, abi: zkAbi, functionName: 'openShowdownDispute',
      args: [tableId, showdownCheckpoint.state, showdownCheckpoint.sigs as viem.Hex[], showdownGameStateBytes],
      account: funder, chain, gas: 20_000_000n, gasPrice: fee.gasPrice, type: 'legacy',
    })
    await publicClient.waitForTransactionReceipt({ hash: openHash })
    console.log(`  openShowdownDispute() tx: ${openHash}; status: ${await tableStatus(tableId)} (expect 3 = Disputed)`)

    // 2. every seat posts its FULL reveal batch (one call each).
    for (let s = 0; s < SEATS; s++) {
      const batch = generateShowdownReveals({ tableId, secret: seats[s]!.secret, deck: finalDeck, slots })
      const postHash = await playerClients[s]!.writeContract({
        address: HOLDEM_TABLE_N, abi: zkAbi, functionName: 'postShowdownReveals',
        args: [tableId, s, deckWords, batch.slots, batch.shares, batch.proofs],
        account: players[s]!, chain, gas: 20_000_000n, gasPrice: fee.gasPrice, type: 'legacy',
      })
      await publicClient.waitForTransactionReceipt({ hash: postHash })
      console.log(`  postShowdownReveals() tx (seat ${s}, ${batch.slots.length} slots): ${postHash}`)
    }

    // 3. the off-chain oracle: the SAME rules contract's settleShowdown, called directly.
    const holes: readonly [number, number][] = Object.keys(res.holeCards)
      .map(Number)
      .sort((a, b) => a - b)
      .map((s) => [res.holeCards[s]![0]!, res.holeCards[s]![1]!] as [number, number])
    const board = res.community as [number, number, number, number, number]
    const [oraclePayouts, oracleRake] = (await publicClient.readContract({
      address: holdemRules, abi: HOLDEM_RULES_ARTIFACT().abi, functionName: 'settleShowdown',
      args: [showdownGameStateBytes, holes, board, 0n],
    })) as [bigint[], bigint]
    console.log(`  oracle payouts: [${oraclePayouts.join(', ')}] rake: ${oracleRake}`)

    // 4. finalizeShowdownN — every seat answered, so this settles deterministically.
    const before = await Promise.all(players.map((p) => x402BalanceOf(p.address)))
    const treasury = (await publicClient.readContract({ address: HOLDEM_TABLE_N, abi: zkAbi, functionName: 'treasury', args: [] })) as viem.Hex
    const treBefore = await x402BalanceOf(treasury)

    const finalizeHash = await funderClient.writeContract({
      address: HOLDEM_TABLE_N, abi: zkAbi, functionName: 'finalizeShowdownN',
      args: [tableId, deckWords, showdownGameStateBytes],
      account: funder, chain, gas: 20_000_000n, gasPrice: fee.gasPrice, type: 'legacy',
    })
    const finalizeReceipt = await publicClient.waitForTransactionReceipt({ hash: finalizeHash })
    console.log(`  finalizeShowdownN() tx: ${finalizeHash} (status ${finalizeReceipt.status})`)

    const status = await tableStatus(tableId)
    const after = await Promise.all(players.map((p) => x402BalanceOf(p.address)))
    const treAfter = await x402BalanceOf(treasury)
    const contractTokenAfter = await x402BalanceOf(HOLDEM_TABLE_N)

    console.log(`  table status: ${status} (expect 4 = Settled)`)
    for (let i = 0; i < SEATS; i++) {
      console.log(`  seat ${i} payout: ${after[i]! - before[i]!} (expect ${oraclePayouts[i]})`)
      if (after[i]! - before[i]! !== oraclePayouts[i]) throw new Error(`round ${idx}: seat ${i} payout mismatch vs off-chain oracle`)
    }
    console.log(`  treasury rake: ${treAfter - treBefore} (expect ${oracleRake})`)
    if (treAfter - treBefore !== oracleRake) throw new Error(`round ${idx}: rake mismatch vs off-chain oracle`)
    if (status !== 4) throw new Error(`round ${idx}: table did not reach Settled (status ${status})`)
    if (contractTokenAfter !== contractTokenBefore) throw new Error(`round ${idx}: non-zero residue left on HoldemTableN`)
    console.log(`  ✓ round ${idx} PASSED (contested showdown settled on-chain, matches off-chain oracle, zero residue)\n`)
  }

  // ── best-effort variant: last seat withholds ONLY its own hole slots -> resolveShowdownTimeout
  // after the clock forfeits its pot eligibility; answerers settle among themselves. ────────────
  async function playWithholdTimeoutRound(): Promise<void> {
    console.log(`══ withhold -> resolveShowdownTimeout variant (N=${SEATS}) ══`)
    const withholder = SEATS - 1
    // Captured BEFORE create() escrows anything (mirrors playHappyRound) so the "zero residue"
    // check reflects this round's own full create->join->resolveShowdownTimeout cycle.
    const contractTokenBeforeRound = await x402BalanceOf(HOLDEM_TABLE_N)
    const seats = await makeSeats()
    const tableId = await createJoinStart(seats)

    const res = await runHand({
      provider, seats, tableId, buyIn: BUY_IN, button: 0, sb: SB, bb: BB,
      rakeBps: RAKE_BPS, rakeCap: RAKE_CAP, scripts: contestedScript(SEATS), domain,
    })
    const showdownIdx = res.gameStates.findIndex((g) => g.phase === Phase.SHOWDOWN)
    if (showdownIdx < 0) throw new Error('withhold round: session never reached SHOWDOWN')
    const showdownCheckpoint = res.coSigned[showdownIdx]!
    const showdownGame = res.gameStates[showdownIdx]!
    const showdownGameStateBytes = encodeGameState(showdownGame)

    const finalDeck = extractFinalDeck(res.transcript.entries, SEATS)
    const deckWords = encodeDeckForShowdown(finalDeck)
    const fullMask = (1n << BigInt(SEATS)) - 1n
    const slots = requiredShowdownSlots(SEATS, fullMask)
    const withholderHoleSlots = new Set([withholder, SEATS + withholder])

    const openHash = await funderClient.writeContract({
      address: HOLDEM_TABLE_N, abi: zkAbi, functionName: 'openShowdownDispute',
      args: [tableId, showdownCheckpoint.state, showdownCheckpoint.sigs as viem.Hex[], showdownGameStateBytes],
      account: funder, chain, gas: 20_000_000n, gasPrice: fee.gasPrice, type: 'legacy',
    })
    const openReceipt = await publicClient.waitForTransactionReceipt({ hash: openHash })
    console.log(`  openShowdownDispute() tx: ${openHash}`)

    for (let s = 0; s < SEATS; s++) {
      const mySlots = s === withholder ? slots.filter((sl) => !withholderHoleSlots.has(sl)) : slots
      const batch = generateShowdownReveals({ tableId, secret: seats[s]!.secret, deck: finalDeck, slots: mySlots })
      const postHash = await playerClients[s]!.writeContract({
        address: HOLDEM_TABLE_N, abi: zkAbi, functionName: 'postShowdownReveals',
        args: [tableId, s, deckWords, batch.slots, batch.shares, batch.proofs],
        account: players[s]!, chain, gas: 20_000_000n, gasPrice: fee.gasPrice, type: 'legacy',
      })
      await publicClient.waitForTransactionReceipt({ hash: postHash })
      console.log(`  postShowdownReveals() tx (seat ${s}${s === withholder ? ', WITHHOLDING own hole slots' : ''}): ${postHash}`)
    }

    // Wait past the worst-case deadlineCeil = openBlock + (nSeats+3)*clockBlocks (see
    // HoldemShowdownLib.computeCycle) — safe regardless of how many completions extended it.
    const target = openReceipt.blockNumber + (BigInt(SEATS) + 3n) * CLOCK_BLOCKS + 2n
    if (FORK) {
      const cur = await publicClient.getBlockNumber()
      const need = target > cur ? target - cur : 0n
      if (need > 0n) await publicClient.request({ method: 'anvil_mine' as any, params: [viem.numberToHex(need)] as any })
      console.log(`  anvil_mine +${need} blocks (target block ${target})`)
    } else {
      console.log(`  waiting for block ${target} on live 943…`)
      while ((await publicClient.getBlockNumber()) < target) {
        await new Promise((r) => setTimeout(r, 5000))
      }
    }

    const extraFoldMask = 1n << BigInt(withholder)
    const holes: readonly [number, number][] = Object.keys(res.holeCards)
      .map(Number)
      .sort((a, b) => a - b)
      .map((s) => [res.holeCards[s]![0]!, res.holeCards[s]![1]!] as [number, number])
    const board = res.community as [number, number, number, number, number]
    const [oraclePayouts, oracleRake] = (await publicClient.readContract({
      address: holdemRules, abi: HOLDEM_RULES_ARTIFACT().abi, functionName: 'settleShowdown',
      args: [showdownGameStateBytes, holes, board, extraFoldMask],
    })) as [bigint[], bigint]
    console.log(`  answer-aware oracle payouts (seat ${withholder} forfeits eligibility): [${oraclePayouts.join(', ')}] rake: ${oracleRake}`)

    const before = await Promise.all(players.map((p) => x402BalanceOf(p.address)))

    const resolveHash = await funderClient.writeContract({
      address: HOLDEM_TABLE_N, abi: zkAbi, functionName: 'resolveShowdownTimeout',
      args: [tableId, deckWords, showdownGameStateBytes],
      account: funder, chain, gas: 20_000_000n, gasPrice: fee.gasPrice, type: 'legacy',
    })
    const resolveReceipt = await publicClient.waitForTransactionReceipt({ hash: resolveHash })
    console.log(`  resolveShowdownTimeout() tx: ${resolveHash} (status ${resolveReceipt.status})`)

    const status = await tableStatus(tableId)
    const after = await Promise.all(players.map((p) => x402BalanceOf(p.address)))
    const contractTokenAfter = await x402BalanceOf(HOLDEM_TABLE_N)

    console.log(`  table status: ${status} (expect 4 = Settled)`)
    for (let i = 0; i < SEATS; i++) {
      console.log(`  seat ${i} payout: ${after[i]! - before[i]!} (expect ${oraclePayouts[i]})`)
      if (after[i]! - before[i]! !== oraclePayouts[i]) throw new Error(`withhold round: seat ${i} payout mismatch vs answer-aware oracle`)
    }
    if (status !== 4) throw new Error('withhold round: table did not reach Settled')
    if (contractTokenAfter !== contractTokenBeforeRound) throw new Error('withhold round: non-zero residue left on HoldemTableN')
    console.log('  ✓ withhold -> resolveShowdownTimeout variant PASSED (answerers settle, withholder forfeits eligibility, zero residue)\n')
  }

  for (let i = 1; i <= ROUNDS; i++) {
    await playHappyRound(i)
  }

  if (ATTEMPT_TIMEOUT) {
    await playWithholdTimeoutRound()
  } else {
    console.log('(withhold->timeout variant skipped — set ATTEMPT_TIMEOUT=1 to run it; auto-on under FORK=1)')
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
