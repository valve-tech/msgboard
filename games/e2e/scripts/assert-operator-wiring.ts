/**
 * Deploy-time WIRING READ-BACK ASSERTION for the operator bonus economy (pre-369 gate item G2).
 *
 * Both reviews flagged the same gap. The bonus-economy governance links are set by independent
 * owner-only setters with NO cross-assertion, so a deploy can point one of them at a wrong or stale
 * address and the sale still runs — but holder protection (O4/L3/NF-2) voids in silence. This script
 * reads the LIVE on-chain wiring and asserts it matches the intended addresses. It fails loudly, and
 * it exits non-zero on ANY mismatch, so it works as a hard gate before the bonus economy is enabled
 * on 369.
 *
 * READ-ONLY. It signs nothing and sends nothing. It only reads getters and scans one event log.
 *
 * Source of truth for the intended addresses: games/contracts/deployments/943-operator-substrate.json,
 * `contracts` object. The substrate keys (OperatorCoinFlip, GameEscrow) are recorded there today. The
 * bonus keys (BonusChips1155, BackingPool, MintSale, BurnFeePolicy) MUST be added by the bonus deploy
 * script before this gate can pass; each is also overridable by an env var (see below). If a bonus
 * address is missing, the script fails with a clear message instead of asserting against a zero value.
 *
 *   # run against the valve RPC (default endpoint below)
 *   npx tsx scripts/assert-operator-wiring.ts
 *   # override the endpoint or any address
 *   RPC_URL=... GAME=0x... POOL=0x... CHIPS=0x... MINTSALE=0x... BURNFEEPOLICY=0x... ESCROW=0x... \
 *     npx tsx scripts/assert-operator-wiring.ts
 *
 * Env (all optional; each falls back to the substrate deployment file):
 *   RPC_URL        — the JSON-RPC endpoint. Default: the valve RPC for 943.
 *   GAME           — OperatorCoinFlip (the boosted game + forfeit router).
 *   ESCROW         — GameEscrow (holds the pool's bet-B authorization).
 *   POOL           — BackingPool (the collateral co-operator).
 *   CHIPS          — BonusChips1155 (the bonus-charge token).
 *   MINTSALE       — MintSale (the price ledger: creator + minter + priceLedger).
 *   BURNFEEPOLICY  — BurnFeePolicy (the neutral forfeit sink).
 *   FROM_BLOCK     — origin block for the burner-set event scan. Default: the substrate deployBlock.
 *   OWNER          — expected owner of every bonus contract. Default: the substrate `deployer`.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import * as viem from 'viem'
import { makePublicClient } from '@msgboard/games-core'
import { chunkedEvents } from './actor-common'

const __dirname = dirname(fileURLToPath(import.meta.url))

// The valve RPC for 943, per the ops-script convention. Override with RPC_URL.
const RPC = process.env.RPC_URL ?? 'https://games.msgboard.xyz/rpc/evm/943'
const CHAIN = 943 as const

// ── minimal read-only ABIs ────────────────────────────────────────────────────────────────────────
// Defined inline (not loaded from the forge/hardhat artifacts) on purpose: a second process may be
// rebuilding those artifacts, so this script never reads them. Every entry is `view`; nothing mutates.
const gameAbi = [
  { type: 'function', name: 'backingPool', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'bonusChips', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'forfeitPolicy', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'allowedFeePolicy', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'escrow', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'registry', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const satisfies viem.Abi

const poolAbi = [
  { type: 'function', name: 'game', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'chips', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'minter', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'escrow', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const satisfies viem.Abi

const chipsAbi = [
  { type: 'function', name: 'creator', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'minter', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'priceLedger', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'isBurner', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const satisfies viem.Abi

const mintSaleAbi = [
  { type: 'function', name: 'pool', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'game', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'chips', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'policy', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const satisfies viem.Abi

const escrowAbi = [
  { type: 'function', name: 'authorizedGame', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
] as const satisfies viem.Abi

const burnerSetEventAbi = [
  { type: 'event', name: 'BurnerSet', inputs: [{ name: 'account', type: 'address', indexed: true }, { name: 'allowed', type: 'bool', indexed: false }] },
] as const satisfies viem.Abi

// ── deployment record ───────────────────────────────────────────────────────────────────────────
type Substrate = {
  deployBlock?: string
  deployer?: viem.Hex
  contracts: Record<string, viem.Hex | undefined>
}

function loadSubstrate(): Substrate {
  const p = resolve(__dirname, '../../contracts/deployments/943-operator-substrate.json')
  return JSON.parse(readFileSync(p, 'utf8')) as Substrate
}

/** Resolve an address from an env override first, then the substrate `contracts` record. */
function resolveAddr(sub: Substrate, envKey: string, contractKey: string): viem.Hex | undefined {
  const raw = process.env[envKey] ?? sub.contracts[contractKey]
  if (!raw) return undefined
  return viem.getAddress(raw)
}

// ── assertion harness ─────────────────────────────────────────────────────────────────────────────
type Assertion = { name: string; expected: string; actual: string; pass: boolean }
const results: Assertion[] = []

/** Compare two addresses case-insensitively; either side may be a `<...>` note string. */
function sameAddr(a: string, b: string): boolean {
  const isHex = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s)
  if (!isHex(a) || !isHex(b)) return false
  return a.toLowerCase() === b.toLowerCase()
}

const pc = makePublicClient(CHAIN, RPC)

/** Read one getter; return the checksummed address, or a `<read reverted>` note the assertion fails on.
 *  A revert here is the expected signal that a getter is absent (an older game build) or the target is
 *  not a contract yet — both are real wiring faults the gate must catch, not crash on. */
async function readAddr(address: viem.Hex, abi: viem.Abi, fn: string, args: readonly unknown[] = []): Promise<string> {
  try {
    const v = (await pc.readContract({ address, abi, functionName: fn, args })) as viem.Hex
    return viem.getAddress(v)
  } catch (e) {
    return `<read reverted: ${fn}() — ${(e as Error).message.split('\n')[0]}>`
  }
}

async function readBool(address: viem.Hex, abi: viem.Abi, fn: string, args: readonly unknown[] = []): Promise<string> {
  try {
    return String((await pc.readContract({ address, abi, functionName: fn, args })) as boolean)
  } catch (e) {
    return `<read reverted: ${fn}() — ${(e as Error).message.split('\n')[0]}>`
  }
}

/** An address-vs-address assertion. */
function assertAddr(name: string, expected: string, actual: string): void {
  results.push({ name, expected, actual, pass: sameAddr(expected, actual) })
}

/** A boolean assertion (expected is always "true" for the wiring facts here). */
function assertTrue(name: string, actual: string): void {
  results.push({ name, expected: 'true', actual, pass: actual === 'true' })
}

async function main(): Promise<void> {
  /* eslint-disable no-console */
  const sub = loadSubstrate()

  const game = resolveAddr(sub, 'GAME', 'OperatorCoinFlip')
  const escrow = resolveAddr(sub, 'ESCROW', 'GameEscrow')
  const pool = resolveAddr(sub, 'POOL', 'BackingPool')
  const chips = resolveAddr(sub, 'CHIPS', 'BonusChips1155')
  const mintSale = resolveAddr(sub, 'MINTSALE', 'MintSale')
  const burnFeePolicy = resolveAddr(sub, 'BURNFEEPOLICY', 'BurnFeePolicy')

  // Fail loudly if a required address is not recorded yet. This is the honest pre-deploy state today:
  // the bonus economy is NOT on 943, so the bonus keys are absent from the substrate file. The gate
  // cannot pass without them — do not fall back to a zero address and assert against it.
  const missing: string[] = []
  if (!game) missing.push('OperatorCoinFlip (GAME)')
  if (!escrow) missing.push('GameEscrow (ESCROW)')
  if (!pool) missing.push('BackingPool (POOL)')
  if (!chips) missing.push('BonusChips1155 (CHIPS)')
  if (!mintSale) missing.push('MintSale (MINTSALE)')
  if (!burnFeePolicy) missing.push('BurnFeePolicy (BURNFEEPOLICY)')
  if (missing.length > 0) {
    console.error('FATAL: intended addresses are not recorded. The bonus economy is not wired yet, or the')
    console.error('deployment file is incomplete. Add these to 943-operator-substrate.json `contracts`,')
    console.error('or pass them as env vars, then re-run this gate:')
    for (const m of missing) console.error(`  - ${m}`)
    process.exit(2)
  }
  // Non-null after the guard above (process.exit does not narrow the optional types for tsc).
  const GAME = game!
  const ESCROW = escrow!
  const POOL = pool!
  const CHIPS = chips!
  const MINTSALE = mintSale!
  const BURNFEEPOLICY = burnFeePolicy!

  console.log('=== operator bonus-economy wiring read-back (pre-369 gate G2) ===')
  console.log(` rpc            ${RPC}`)
  console.log(` OperatorCoinFlip ${GAME}`)
  console.log(` GameEscrow       ${ESCROW}`)
  console.log(` BackingPool      ${POOL}`)
  console.log(` BonusChips1155   ${CHIPS}`)
  console.log(` MintSale         ${MINTSALE}`)
  console.log(` BurnFeePolicy    ${BURNFEEPOLICY}\n`)

  // ── A. OperatorCoinFlip (game) bonus wiring ────────────────────────────────────────────────────
  // NF-2 / setBonusInfra: the game must point at the exact pool + chips, and its forfeit sink must be
  // the neutral BurnFeePolicy AND on the game's fixed fee-policy menu (else the chop forfeit cannot
  // route, or could route to a non-neutral sink).
  assertAddr('game.backingPool == BackingPool', POOL, await readAddr(GAME, gameAbi, 'backingPool'))
  assertAddr('game.bonusChips == BonusChips1155', CHIPS, await readAddr(GAME, gameAbi, 'bonusChips'))
  assertAddr('game.forfeitPolicy == BurnFeePolicy', BURNFEEPOLICY, await readAddr(GAME, gameAbi, 'forfeitPolicy'))
  assertTrue('game.allowedFeePolicy[forfeitPolicy] == true (sink on the fixed menu)', await readBool(GAME, gameAbi, 'allowedFeePolicy', [BURNFEEPOLICY]))

  // ── B. BackingPool (collateral co-operator) ────────────────────────────────────────────────────
  // O4/L3: a wrong minter lets under-backed supply exist; a wrong game/chips breaks the paired-bet
  // authorization. escrow.authorizedGame[pool][game] is the bet-B authorization the boost rides on.
  assertAddr('pool.game == OperatorCoinFlip', GAME, await readAddr(POOL, poolAbi, 'game'))
  assertAddr('pool.chips == BonusChips1155', CHIPS, await readAddr(POOL, poolAbi, 'chips'))
  assertAddr('pool.minter == MintSale', MINTSALE, await readAddr(POOL, poolAbi, 'minter'))
  assertAddr('pool.escrow == GameEscrow', ESCROW, await readAddr(POOL, poolAbi, 'escrow'))
  assertTrue('escrow.authorizedGame[pool][game] == true (bet-B authorization)', await readBool(ESCROW, escrowAbi, 'authorizedGame', [POOL, GAME]))

  // ── C. BonusChips1155 (the bonus-charge token) ─────────────────────────────────────────────────
  // L3 role wiring: creator + minter + priceLedger are the O4 holder-protection triad. A loose
  // priceLedger silently voids every price refund; a wrong minter breaks the mint/backing lockstep.
  assertAddr('chips.creator == MintSale', MINTSALE, await readAddr(CHIPS, chipsAbi, 'creator'))
  assertAddr('chips.minter == BackingPool', POOL, await readAddr(CHIPS, chipsAbi, 'minter'))
  assertAddr('chips.priceLedger == MintSale', MINTSALE, await readAddr(CHIPS, chipsAbi, 'priceLedger'))
  assertTrue('chips.isBurner[game] == true (chop/settle burn path)', await readBool(CHIPS, chipsAbi, 'isBurner', [GAME]))
  assertTrue('chips.isBurner[pool] == true (expiry burn path)', await readBool(CHIPS, chipsAbi, 'isBurner', [POOL]))

  // ── D. MintSale (the price ledger) ─────────────────────────────────────────────────────────────
  // The price side must point back at the same pool/game/chips, and its fee policy must be set (else
  // createSeries reverts and no series can ever be priced).
  assertAddr('mintSale.pool == BackingPool', POOL, await readAddr(MINTSALE, mintSaleAbi, 'pool'))
  assertAddr('mintSale.game == OperatorCoinFlip', GAME, await readAddr(MINTSALE, mintSaleAbi, 'game'))
  assertAddr('mintSale.chips == BonusChips1155', CHIPS, await readAddr(MINTSALE, mintSaleAbi, 'chips'))
  const salePolicy = await readAddr(MINTSALE, mintSaleAbi, 'policy')
  results.push({
    name: 'mintSale.policy != address(0) (fee policy wired)',
    expected: '!= 0x0000…0000',
    actual: salePolicy,
    pass: /^0x[0-9a-fA-F]{40}$/.test(salePolicy) && salePolicy.toLowerCase() !== viem.zeroAddress,
  })

  // ── E. burner set is EXACTLY {game, pool} ──────────────────────────────────────────────────────
  // The reviews rate an EXTRA burner as high impact: any burner can call burnWithBeneficiary and
  // redirect a price refund to itself. A single isBurner read cannot prove the set has no extras, so
  // reconstruct the live allowlist from the BurnerSet event log (last write per account wins).
  const fromBlock = BigInt(process.env.FROM_BLOCK ?? sub.deployBlock ?? '0')
  try {
    const logs = (await chunkedEvents(pc, { address: CHIPS, abi: burnerSetEventAbi as viem.Abi, eventName: 'BurnerSet', fromBlock })) as {
      args: { account: viem.Hex; allowed: boolean }
      blockNumber: bigint
      logIndex: number
    }[]
    logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))
    const state = new Map<string, boolean>()
    for (const log of logs) state.set(viem.getAddress(log.args.account), log.args.allowed)
    const allowed = [...state.entries()].filter(([, ok]) => ok).map(([a]) => a).sort()
    const expected = [GAME, POOL].map((a) => viem.getAddress(a)).sort()
    const extras = allowed.filter((a) => !sameAddr(a, GAME) && !sameAddr(a, POOL))
    results.push({
      name: 'chips burner set == exactly {game, pool} (no extra burner)',
      expected: `[${expected.join(', ')}]`,
      actual: extras.length > 0 ? `[${allowed.join(', ')}]  EXTRA: ${extras.join(', ')}` : `[${allowed.join(', ')}]`,
      pass: allowed.length === 2 && expected.every((e) => allowed.some((a) => sameAddr(a, e))),
    })
  } catch (e) {
    results.push({
      name: 'chips burner set == exactly {game, pool} (no extra burner)',
      expected: `[${[GAME, POOL].join(', ')}]`,
      actual: `<event scan failed: ${(e as Error).message.split('\n')[0]}>`,
      pass: false,
    })
  }

  // ── F. owner consistency (governance) ──────────────────────────────────────────────────────────
  // A wrong owner on any bonus contract is a governance risk: it can re-point the very roles above.
  // Assert every owner equals the expected owner (OWNER env, else the substrate deployer).
  const expectedOwner = process.env.OWNER ? viem.getAddress(process.env.OWNER) : sub.deployer ? viem.getAddress(sub.deployer) : undefined
  if (expectedOwner) {
    assertAddr('chips.owner == deployer', expectedOwner, await readAddr(CHIPS, chipsAbi, 'owner'))
    assertAddr('pool.owner == deployer', expectedOwner, await readAddr(POOL, poolAbi, 'owner'))
    assertAddr('mintSale.owner == deployer', expectedOwner, await readAddr(MINTSALE, mintSaleAbi, 'owner'))
    assertAddr('game.owner == deployer', expectedOwner, await readAddr(GAME, gameAbi, 'owner'))
  } else {
    console.log('INFO: no expected owner (set OWNER env or `deployer` in the deployment file) — owner checks skipped.\n')
  }

  // ── report ─────────────────────────────────────────────────────────────────────────────────────
  let failed = 0
  for (const r of results) {
    const tag = r.pass ? 'PASS' : 'FAIL'
    if (!r.pass) failed++
    console.log(`[${tag}] ${r.name}`)
    if (!r.pass) {
      console.log(`        expected: ${r.expected}`)
      console.log(`        actual:   ${r.actual}`)
    }
  }
  console.log(`\n${results.length - failed}/${results.length} assertions passed.`)
  if (failed > 0) {
    console.error(`\nGATE FAILED: ${failed} wiring assertion(s) mismatched. Do NOT enable the bonus economy.`)
    process.exit(1)
  }
  console.log('\nGATE PASSED: the bonus-economy wiring matches the intended configuration.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
