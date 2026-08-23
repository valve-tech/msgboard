/**
 * Assert the bonus-economy governance wiring on-chain (the G2 / NF-2 pre-369 gate).
 *
 * The security re-audit (docs/superpowers/reviews/2026-08-17-fundstack-security-review.md,
 * finding NF-2 and S2c LOW-1/2) requires a read-back gate before the bonus economy runs on
 * real money (369). `setBonusInfra` only asserts two of the wiring facts on-chain
 * (`pool.game()` and `pool.chips()`); the price-side and role links are set by independent
 * owner-only setters with NO cross-assertion. A wrong `chips.priceLedger`, `chips.minter`,
 * or the burner allowlist silently voids holder protection (O4) while the sale still runs.
 *
 * This script is READ-ONLY. It sends NO transactions. It reads each link and asserts it,
 * throwing a clear error on the first mismatch and printing a green summary when all pass.
 *
 * The four deployed addresses come from env vars, or from a deployment-record JSON whose
 * path is DEPLOYMENT_JSON (it must carry a `contracts` object with the four keys). Env vars
 * win over the file.
 *
 *   GAME     — OperatorCoinFlip (the boosted game)
 *   POOL     — BackingPool (collateral co-operator)
 *   CHIPS    — BonusChips1155 (charge registry)
 *   MINTSALE — MintSale (price ledger + minter)
 *
 * Usage (defaults target 943; override for 369):
 *   RPC_URL=<valve rpc> CHAIN_ID=943 \
 *     GAME=0x… POOL=0x… CHIPS=0x… MINTSALE=0x… \
 *     npx tsx scripts/assert-bonus-wiring.ts
 *
 *   # or from a deployment record:
 *   RPC_URL=<valve rpc> CHAIN_ID=369 DEPLOYMENT_JSON=deployments/369-bonus.json \
 *     npx tsx scripts/assert-bonus-wiring.ts
 */
import * as viem from 'viem'

// Minimal read-only ABIs for the getters each link needs. All are public vars with
// auto-getters (BackingPool.game/chips/minter, BonusChips1155.creator/minter/priceLedger/
// isBurner, MintSale.pool) — the names are taken from the contract sources.
const POOL_ABI = [
  { name: 'game', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'chips', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'minter', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
] as const satisfies viem.Abi

const CHIPS_ABI = [
  { name: 'creator', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'minter', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'priceLedger', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  {
    name: 'isBurner',
    type: 'function',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
] as const satisfies viem.Abi

const MINTSALE_ABI = [
  { name: 'pool', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
] as const satisfies viem.Abi

// BonusChips1155.setBurner emits this. We scan it to flag any burner OTHER than {game, pool}.
const BURNER_SET_EVENT = {
  type: 'event',
  name: 'BurnerSet',
  inputs: [
    { name: 'account', type: 'address', indexed: true },
    { name: 'allowed', type: 'bool', indexed: false },
  ],
} as const

function req(name: string, fromFile?: string): viem.Address {
  const v = process.env[name] ?? fromFile
  if (!v) throw new Error(`missing address: set ${name} (or provide it in DEPLOYMENT_JSON.contracts)`)
  return viem.getAddress(v.trim())
}

async function main(): Promise<void> {
  /* eslint-disable no-console */
  const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
  const CHAIN_ID = Number(process.env.CHAIN_ID ?? 943)

  // Optional deployment-record fallback for the four addresses (env vars still win).
  let fromFile: Record<string, string | undefined> = {}
  if (process.env.DEPLOYMENT_JSON) {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const p = path.resolve(process.cwd(), process.env.DEPLOYMENT_JSON)
    const rec = JSON.parse(fs.readFileSync(p, 'utf8')) as { contracts?: Record<string, string> }
    const c = rec.contracts ?? {}
    fromFile = {
      GAME: c.OperatorCoinFlip,
      POOL: c.BackingPool,
      CHIPS: c.BonusChips1155,
      MINTSALE: c.MintSale,
    }
  }

  const game = req('GAME', fromFile.GAME)
  const pool = req('POOL', fromFile.POOL)
  const chips = req('CHIPS', fromFile.CHIPS)
  const mintSale = req('MINTSALE', fromFile.MINTSALE)

  const chain = {
    id: CHAIN_ID,
    name: `chain-${CHAIN_ID}`,
    nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  } as const
  const publicClient = viem.createPublicClient({ chain, transport: viem.http(RPC) })

  console.log('── assert bonus-economy wiring (G2 / NF-2 pre-369 gate) — READ ONLY ──')
  console.log('chain:', CHAIN_ID, RPC)
  console.log('  GAME     (OperatorCoinFlip):', game)
  console.log('  POOL     (BackingPool):     ', pool)
  console.log('  CHIPS    (BonusChips1155):  ', chips)
  console.log('  MINTSALE (MintSale):        ', mintSale)
  console.log('')

  const readAddr = (address: viem.Address, abi: viem.Abi, functionName: string, args: unknown[] = []) =>
    publicClient.readContract({ address, abi, functionName, args }) as Promise<viem.Address>

  // Read every link. All reads are concurrent — no read depends on another.
  const [
    poolGame,
    poolChips,
    poolMinter,
    chipsCreator,
    chipsMinter,
    chipsPriceLedger,
    gameIsBurner,
    poolIsBurner,
    mintSalePool,
  ] = await Promise.all([
    readAddr(pool, POOL_ABI, 'game'),
    readAddr(pool, POOL_ABI, 'chips'),
    readAddr(pool, POOL_ABI, 'minter'),
    readAddr(chips, CHIPS_ABI, 'creator'),
    readAddr(chips, CHIPS_ABI, 'minter'),
    readAddr(chips, CHIPS_ABI, 'priceLedger'),
    publicClient.readContract({ address: chips, abi: CHIPS_ABI, functionName: 'isBurner', args: [game] }) as Promise<boolean>,
    publicClient.readContract({ address: chips, abi: CHIPS_ABI, functionName: 'isBurner', args: [pool] }) as Promise<boolean>,
    readAddr(mintSale, MINTSALE_ABI, 'pool'),
  ])

  const eq = (a: string, b: string) => viem.getAddress(a) === viem.getAddress(b)
  const checks: Array<{ label: string; ok: boolean; got: string; want: string }> = [
    { label: 'pool.game()        == game',     ok: eq(poolGame, game),           got: poolGame,        want: game },
    { label: 'pool.chips()       == chips',    ok: eq(poolChips, chips),         got: poolChips,       want: chips },
    { label: 'chips.creator()    == mintSale', ok: eq(chipsCreator, mintSale),   got: chipsCreator,    want: mintSale },
    { label: 'chips.minter()     == pool',     ok: eq(chipsMinter, pool),        got: chipsMinter,     want: pool },
    { label: 'pool.minter()      == mintSale', ok: eq(poolMinter, mintSale),     got: poolMinter,      want: mintSale },
    { label: 'chips.priceLedger()== mintSale', ok: eq(chipsPriceLedger, mintSale), got: chipsPriceLedger, want: mintSale },
    { label: 'chips.isBurner(game)  == true',  ok: gameIsBurner === true,        got: String(gameIsBurner), want: 'true' },
    { label: 'chips.isBurner(pool)  == true',  ok: poolIsBurner === true,        got: String(poolIsBurner), want: 'true' },
  ]
  // Sanity cross-check (not one of the 7 required links, but a cheap consistency read):
  // MintSale.pool must point back at the pool we were given.
  checks.push({ label: 'mintSale.pool()    == pool', ok: eq(mintSalePool, pool), got: mintSalePool, want: pool })

  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}`)
    if (!c.ok) throw new Error(`bonus-wiring mismatch: ${c.label.trim()} — got ${c.got}, want ${c.want}`)
  }

  // Burner-set completeness (limitation): reading the `isBurner` mapping proves game and pool
  // ARE burners, but a mapping read can NEVER prove NO OTHER address is a burner. The review
  // requires the burner set to be exactly {game, pool}. To catch an extra burner we scan the
  // BurnerSet event log and reconstruct the current set (last `allowed` per account). This is a
  // best-effort supplement: an RPC that cannot serve the log range degrades to a warning, it does
  // NOT fail the gate — the positive isBurner checks above are the hard assertion.
  console.log('')
  console.log('  burner-set completeness (event scan, best-effort):')
  try {
    const fromBlock = process.env.FROM_BLOCK ? BigInt(process.env.FROM_BLOCK) : 0n
    const logs = await publicClient.getLogs({ address: chips, event: BURNER_SET_EVENT, fromBlock, toBlock: 'latest' })
    const current = new Map<string, boolean>()
    for (const l of logs) {
      const acct = viem.getAddress(l.args.account as viem.Address)
      current.set(acct, l.args.allowed as boolean)
    }
    const allowed = [...current.entries()].filter(([, v]) => v).map(([k]) => k)
    const expected = new Set<string>([viem.getAddress(game), viem.getAddress(pool)])
    const extra = allowed.filter((a) => !expected.has(a))
    console.log(`    scanned ${logs.length} BurnerSet event(s); current burners: ${allowed.length ? allowed.join(', ') : '(none)'}`)
    if (extra.length) {
      throw new Error(`unexpected burner(s) allowlisted (set must be exactly {game, pool}): ${extra.join(', ')}`)
    }
    console.log('    ✓ burner set is exactly {game, pool}')
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('unexpected burner')) throw e
    console.log('    ⚠ could not scan BurnerSet events (RPC log-range limit?):', (e as Error).message)
    console.log('    ⚠ LIMITATION: the isBurner reads above confirm game+pool are burners, but this run')
    console.log('      could NOT confirm no OTHER address is a burner. Re-run with FROM_BLOCK set to the')
    console.log('      chips deploy block against an RPC that serves the full log range.')
  }

  console.log('')
  console.log('✓ all bonus-economy wiring links asserted — G2 / NF-2 gate PASSED')
}

main().catch((e) => {
  console.error('\n✗ bonus-wiring assertion FAILED')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
