# Games Platform — Off-Chain Core, Consumers, and End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the chain-agnostic `@gibs/games-core` substrate and the thin `@gibs/coinflip` and `@gibs/raffle` consumers over it, plus front-end scripts and the cross-layer parity test that proves the off-chain winner always equals the on-chain payout.

**Architecture:** A single viem-based core owns the chain registry, contract bindings, the shared secret/seed helpers, the lifecycle reader, the operator (ink, arm, cast, recovery), and a four-method `Game` interface. Each game is a tiny implementation of that interface plus its canonical presets. Every front end (scripts now, web/terminal later) is a thin shell over the core. The fairness-as-types guarantee: `settle(params, entries, seed)` takes the seed as an input only, so a game physically cannot route player data back into the seed.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), pnpm workspaces, viem ^2, vitest, tsx. Chains: anvil/local (31337) and PulseChain testnet version four (943). Depends on the on-chain contracts from the companion plan.

**Prerequisite:** The contracts plan `2026-06-09-games-platform-contracts.md` must be complete and its contracts compiled (`npx hardhat compile` in `packages/contracts`) so the artifacts exist for import. **`anvil` (Foundry) must be installed** for the local end-to-end task.

**Repository note:** Everything is in `~/Documents/gibsfinance/github/random` (NOT the msgboard repo this plan lives in). The new code lives under `examples/games/`. Run commands from the repo root unless stated otherwise.

**Spec:** `~/Documents/valve-tech/github/msgboard/docs/superpowers/specs/2026-06-09-games-platform-design.md`

---

## Pre-flight: read these before starting

- `packages/contracts/scripts/duel-943.ts` — the existing coin-flip end-to-end harness. The scripts in this plan are the refactor of this file onto the core; its funding, cast-ordering, and simulate-before-send patterns carry over verbatim.
- `packages/contracts/lib/utils.ts` — `toSeed` (`keccak256(concatHex(secrets))`) is the exact seed the core must reproduce; `createTestPreimages`, `defaultSection`.
- `packages/contracts/contracts/Raffle.sol`, `CoinFlip.sol`, `GameBase.sol` — the on-chain `settle` arithmetic the off-chain `settle` must match exactly (`seed & 1`; `1 + (seed % 256)`; closest distance, ties to earliest commit then ticket id).
- `pnpm-workspace.yaml` — must gain an `examples/**` glob.
- `packages/provider/package.json` and `packages/my-app/package.json` — the ESM + pnpm package conventions to mirror.

### The two arithmetic facts the whole plan hinges on

1. **Seed:** `seed = keccak256(concat(revealed 32-byte secrets))`. In TS: `viem.keccak256(viem.concatHex(secrets))` — identical to `toSeed`.
2. **Reduction:** coin flip outcome `= (seed & 1) == 0 ? 'heads' : 'tails'`; raffle draw `= 1 + (seed mod 256)` in `[1..256]`. The off-chain `settle` MUST use exactly these so the parity test passes.

---

## File structure

```
examples/games/
  core/                        @gibs/games-core
    package.json
    tsconfig.json
    vitest.config.ts
    src/
      chains.ts                chain registry: local (31337) + pulsechainV4 (943), addresses, accounts
      contracts.ts            Random + CoinFlip/Raffle/GameBase ABIs + address resolution + clients
      secrets.ts              validator secret/preimage helpers + the shared seed reduction
      game.ts                 the Game<TParams,TEntry,TOutcome> interface + Preset type
      lifecycle.ts            RoundState reader (events -> state, via game.decodeEntry)
      operator.ts             ink pool, arm (diversity-checked bound heat), cast, recovery
      index.ts                public surface
    test/
      secrets.test.ts
      lifecycle.test.ts
  coinflip/                     @gibs/coinflip
    package.json, tsconfig.json, vitest.config.ts
    src/index.ts               the Game implementation + presets
    test/coinflip.test.ts
  raffle/                       @gibs/raffle
    package.json, tsconfig.json, vitest.config.ts
    src/index.ts               the Game implementation + presets
    test/raffle.test.ts
  e2e/
    package.json, tsconfig.json, vitest.config.ts
    src/deploy.ts              deploy Random + games to a local node, allowlist + ink pools
    scripts/duel.ts            coin-flip run over the core (refactor of duel-943.ts)
    scripts/raffle.ts          raffle run over the core
    test/parity.test.ts        cross-layer parity (off-chain settle == on-chain payout)
```

Modify:
- `pnpm-workspace.yaml` — add `examples/**`.

---

### Task 1: Workspace glob and the games-core package skeleton

**Files:**
- Modify: `pnpm-workspace.yaml`
- Create: `examples/games/core/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`

- [ ] **Step 1: Add the examples glob to the workspace**

In `pnpm-workspace.yaml`, add the examples line:

```yaml
packages:
  # all packages in direct subdirs of packages/
  - 'packages/*'
  # all packages in subdirs of components/
  - 'components/**'
  # the games platform examples
  - 'examples/**'
  # exclude packages that are inside test directories
  - '!**/test/**'
```

- [ ] **Step 2: Create the core package.json**

`examples/games/core/package.json`:

```json
{
  "name": "@gibs/games-core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@gibs/random": "workspace:*",
    "viem": "^2.25.0"
  },
  "devDependencies": {
    "typescript": "~5.8.3",
    "vitest": "^2.1.0"
  }
}
```

> `@gibs/random` is `packages/contracts` (its `name` field). `workspace:*` resolves to it so the core can import its artifacts.

- [ ] **Step 3: Create tsconfig and vitest config**

`examples/games/core/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`examples/games/core/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
})
```

- [ ] **Step 4: Stub the public surface**

`examples/games/core/src/index.ts`:

```ts
export * from './chains'
export * from './contracts'
export * from './secrets'
export * from './game'
export * from './lifecycle'
export * from './operator'
```

(These modules are created in later tasks; the file will not typecheck until they exist. That is expected.)

- [ ] **Step 5: Install and confirm the workspace resolves**

Run: `pnpm install`
Expected: completes; `@gibs/games-core` appears in the workspace, `@gibs/random` linked.

- [ ] **Step 6: Commit**

```bash
git add pnpm-workspace.yaml examples/games/core/package.json examples/games/core/tsconfig.json examples/games/core/vitest.config.ts examples/games/core/src/index.ts
git commit -m "build: scaffold @gibs/games-core package"
```

---

### Task 2: secrets.ts — validator secrets and the seed reduction

This is the load-bearing module: the seed reduction here must match the contracts bit-for-bit.

**Files:**
- Create: `examples/games/core/src/secrets.ts`
- Create: `examples/games/core/test/secrets.test.ts`

- [ ] **Step 1: Write the failing test**

`examples/games/core/test/secrets.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import * as viem from 'viem'
import { makeSecret, seedFromSecrets, coinFlipOutcome, raffleDraw } from '../src/secrets'

describe('secrets', () => {
  it('derives a deterministic secret and its preimage', () => {
    const a = makeSecret('label', '0xdead')
    const b = makeSecret('label', '0xdead')
    expect(a.secret).to.equal(b.secret)
    expect(a.preimage).to.equal(viem.keccak256(a.secret))
  })

  it('reproduces the contract seed as keccak256(concat(secrets))', () => {
    const secrets = [viem.keccak256(viem.toHex('s0')), viem.keccak256(viem.toHex('s1'))]
    expect(seedFromSecrets(secrets)).to.equal(viem.keccak256(viem.concatHex(secrets)))
  })

  it('matches the on-chain coin-flip parity rule', () => {
    const evenSeed = viem.padHex('0x02', { size: 32 })
    const oddSeed = viem.padHex('0x03', { size: 32 })
    expect(coinFlipOutcome(evenSeed)).to.equal('heads')
    expect(coinFlipOutcome(oddSeed)).to.equal('tails')
  })

  it('matches the on-chain raffle draw reduction (1 + seed mod 256, in [1..256])', () => {
    // seed mod 256 == 0 -> draw 1; == 255 -> draw 256
    const seedMod0 = viem.padHex('0x0100', { size: 32 }) // 256 -> mod 256 == 0
    const seedMod255 = viem.padHex('0xff', { size: 32 }) // 255 -> mod 256 == 255
    expect(raffleDraw(seedMod0)).to.equal(1n)
    expect(raffleDraw(seedMod255)).to.equal(256n)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run (from `examples/games/core`): `pnpm test`
Expected: FAIL (module `../src/secrets` not found).

- [ ] **Step 3: Implement secrets.ts**

```ts
import * as viem from 'viem'

/** A validator secret and its on-chain preimage (the keccak of the secret). */
export type Secret = { secret: viem.Hex; preimage: viem.Hex }

/**
 * Derive a deterministic 32-byte secret bound to a label and a per-run salt, plus its preimage.
 * Mirrors duel-943.ts's makeSecret. A production validator never reuses a secret — vary the salt.
 */
export const makeSecret = (label: string, salt: viem.Hex): Secret => {
  const secret = viem.keccak256(viem.toHex(`${label}-${salt}`))
  return { secret, preimage: viem.keccak256(secret) }
}

/**
 * The seed core Random forms at cast: keccak256 over the concatenated revealed secrets, in heat
 * order. Identical to the contracts' `revealed.hash()` and to lib/utils.ts `toSeed`.
 */
export const seedFromSecrets = (secretsInHeatOrder: viem.Hex[]): viem.Hex =>
  viem.keccak256(viem.concatHex(secretsInHeatOrder))

/** The coin-flip outcome rule: even seed -> heads, odd -> tails (seed & 1). */
export const coinFlipOutcome = (seed: viem.Hex): 'heads' | 'tails' =>
  (BigInt(seed) & 1n) === 0n ? 'heads' : 'tails'

/** The raffle draw reduction: 1 + (seed mod 256), in [1..256]. */
export const raffleDraw = (seed: viem.Hex): bigint => 1n + (BigInt(seed) % 256n)
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test`
Expected: PASS for all secrets tests.

- [ ] **Step 5: Commit**

```bash
git add examples/games/core/src/secrets.ts examples/games/core/test/secrets.test.ts
git commit -m "feat: games-core seed reduction matching the contracts"
```

---

### Task 3: chains.ts and contracts.ts — registry and bindings

**Files:**
- Create: `examples/games/core/src/chains.ts`
- Create: `examples/games/core/src/contracts.ts`

- [ ] **Step 1: Write chains.ts**

```ts
import * as viem from 'viem'
import { pulsechainV4 } from 'viem/chains'

/** A local anvil/hardhat node; chainId 31337. */
export const local = {
  id: 31337,
  name: 'Local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
} as const satisfies viem.Chain

export type GamesChainId = 31337 | 943

export const chains: Record<GamesChainId, viem.Chain> = {
  31337: local,
  943: pulsechainV4,
}

/** Core Random's deployed address per chain. 943 is the live deployment; local is filled at deploy. */
export const randomAddress: Record<GamesChainId, viem.Hex | undefined> = {
  31337: undefined, // set by the e2e deploy step at runtime
  943: '0x775AF72d62c85d2F7f0Bcc05BAa4Be0830087217',
}

export const defaultRpc: Record<GamesChainId, string> = {
  31337: 'http://127.0.0.1:8545',
  943: 'https://rpc-testnet-pulsechain.g4mm4.io',
}
```

- [ ] **Step 2: Write contracts.ts**

```ts
import * as viem from 'viem'
import RandomArtifact from '@gibs/random/artifacts/contracts/Random.sol/Random.json'
import CoinFlipArtifact from '@gibs/random/artifacts/contracts/CoinFlip.sol/CoinFlip.json'
import RaffleArtifact from '@gibs/random/artifacts/contracts/Raffle.sol/Raffle.json'
import { chains, defaultRpc, type GamesChainId } from './chains'

export const randomAbi = RandomArtifact.abi as viem.Abi
export const coinFlipAbi = CoinFlipArtifact.abi as viem.Abi
export const raffleAbi = RaffleArtifact.abi as viem.Abi
export const coinFlipBytecode = CoinFlipArtifact.bytecode as viem.Hex
export const raffleBytecode = RaffleArtifact.bytecode as viem.Hex

/** The PreimageLocation.Info tuple the contracts expect. */
export type Info = {
  provider: viem.Hex
  callAtChange: boolean
  durationIsTimestamp: boolean
  duration: bigint
  token: viem.Hex
  price: bigint
  offset: bigint
  index: bigint
}

export type Clients = {
  chainId: GamesChainId
  publicClient: viem.PublicClient
  walletClient?: viem.WalletClient
}

/** Build a read-only public client for a chain (optionally overriding the RPC URL). */
export const makePublicClient = (chainId: GamesChainId, rpcUrl = defaultRpc[chainId]): viem.PublicClient =>
  viem.createPublicClient({ chain: chains[chainId], transport: viem.http(rpcUrl) })

/** Build a wallet client for an account on a chain. */
export const makeWalletClient = (
  chainId: GamesChainId,
  account: viem.Account,
  rpcUrl = defaultRpc[chainId],
): viem.WalletClient =>
  viem.createWalletClient({ account, chain: chains[chainId], transport: viem.http(rpcUrl) })
```

> The `@gibs/random/artifacts/...` import path requires `packages/contracts` to have been compiled (`npx hardhat compile`). If TypeScript cannot resolve the JSON import, confirm `resolveJsonModule: true` (set in Task 1's tsconfig) and that the artifact files exist on disk.

- [ ] **Step 3: Typecheck**

Run (from `examples/games/core`): `pnpm typecheck`
Expected: passes for `chains.ts` and `contracts.ts` (the other src modules are added next; `index.ts` may still reference missing modules — typecheck the two files directly with `npx tsc --noEmit src/chains.ts src/contracts.ts` if needed, or proceed since later tasks complete the set).

- [ ] **Step 4: Commit**

```bash
git add examples/games/core/src/chains.ts examples/games/core/src/contracts.ts
git commit -m "feat: games-core chain registry and contract bindings"
```

---

### Task 4: game.ts — the Game interface and Preset type

**Files:**
- Create: `examples/games/core/src/game.ts`

- [ ] **Step 1: Write the interface**

```ts
import type { Info } from './contracts'

/** A canonical parameter preset surfaced prominently so liquidity concentrates (anti-fragmentation). */
export type Preset<TParams> = {
  label: string
  params: TParams
}

/**
 * A game is four pure methods plus its canonical presets. settle takes the seed as an INPUT only —
 * a game cannot route player data back into the seed (fairness-as-types).
 *
 * @typeParam TParams  the instance parameters (e.g. coin-flip stake+subset; raffle tuple)
 * @typeParam TEntry   a decoded player entry (e.g. a side; a committed/revealed ticket)
 * @typeParam TOutcome the settlement result (e.g. the winning side; the winning ticket)
 */
export type Game<TParams, TEntry, TOutcome> = {
  /** Validate and normalise raw instance parameters; throw on invalid input (fail fast). */
  parseParams: (raw: unknown) => TParams
  /** Decode one on-chain entry record into the game's entry shape. */
  decodeEntry: (raw: unknown) => TEntry
  /** Whether an instance with these entries may be armed (the fill condition). */
  canArm: (params: TParams, entries: TEntry[]) => boolean
  /** Settle deterministically from params, entries, and the validator seed (seed is input-only). */
  settle: (params: TParams, entries: TEntry[], seed: `0x${string}`) => TOutcome
  /** The canonical presets the front end nudges toward. */
  presets: Preset<TParams>[]
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit` (from `examples/games/core`; will report missing `lifecycle`/`operator` referenced by index — acceptable until Task 7. To isolate: `npx tsc --noEmit src/game.ts`.)
Expected: `game.ts` typechecks.

- [ ] **Step 3: Commit**

```bash
git add examples/games/core/src/game.ts
git commit -m "feat: games-core Game interface and Preset type"
```

---

### Task 5: @gibs/coinflip — the Game implementation

**Files:**
- Create: `examples/games/coinflip/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `examples/games/coinflip/src/index.ts`
- Create: `examples/games/coinflip/test/coinflip.test.ts`

- [ ] **Step 1: Scaffold the package**

`examples/games/coinflip/package.json`:

```json
{
  "name": "@gibs/coinflip",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": { "@gibs/games-core": "workspace:*", "viem": "^2.25.0" },
  "devDependencies": { "typescript": "~5.8.3", "vitest": "^2.1.0" }
}
```

Copy `examples/games/core/tsconfig.json` and `vitest.config.ts` into `examples/games/coinflip/` unchanged.

- [ ] **Step 2: Write the failing test**

`examples/games/coinflip/test/coinflip.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import * as viem from 'viem'
import { coinflip } from '../src/index'

const params = { stake: viem.parseEther('1'), validatorSubset: ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333'] as viem.Hex[] }

describe('coinflip.settle', () => {
  it('returns heads on an even seed and tails on an odd seed', () => {
    const entries = [{ player: '0xaaa' as viem.Hex, side: 'heads' as const }, { player: '0xbbb' as viem.Hex, side: 'tails' as const }]
    expect(coinflip.settle(params, entries, viem.padHex('0x02', { size: 32 })).winner).to.equal('0xaaa')
    expect(coinflip.settle(params, entries, viem.padHex('0x03', { size: 32 })).winner).to.equal('0xbbb')
  })

  it('canArm only with one heads and one tails at equal stake', () => {
    expect(coinflip.canArm(params, [{ player: '0xaaa', side: 'heads' }])).to.equal(false)
    expect(coinflip.canArm(params, [{ player: '0xaaa', side: 'heads' }, { player: '0xbbb', side: 'tails' }])).to.equal(true)
    expect(coinflip.canArm(params, [{ player: '0xaaa', side: 'heads' }, { player: '0xbbb', side: 'heads' }])).to.equal(false)
  })

  it('parseParams rejects a subset below the minimum of three', () => {
    expect(() => coinflip.parseParams({ stake: 1n, validatorSubset: ['0x1', '0x2'] })).to.throw()
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run (from `examples/games/coinflip`): `pnpm test`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement the coin-flip Game**

`examples/games/coinflip/src/index.ts`:

```ts
import * as viem from 'viem'
import { type Game, coinFlipOutcome } from '@gibs/games-core'

export type CoinFlipParams = { stake: bigint; validatorSubset: viem.Hex[] }
export type CoinFlipEntry = { player: viem.Hex; side: 'heads' | 'tails' }
export type CoinFlipOutcome = { winner: viem.Hex; winningSide: 'heads' | 'tails' }

const MIN_SUBSET = 3

export const coinflip: Game<CoinFlipParams, CoinFlipEntry, CoinFlipOutcome> = {
  parseParams: (raw) => {
    const p = raw as Partial<CoinFlipParams>
    if (typeof p.stake !== 'bigint' || p.stake <= 0n) throw new Error('stake must be a positive bigint')
    if (!Array.isArray(p.validatorSubset) || p.validatorSubset.length < MIN_SUBSET) {
      throw new Error(`validatorSubset must have at least ${MIN_SUBSET} members`)
    }
    const distinct = new Set(p.validatorSubset.map((a) => a.toLowerCase()))
    if (distinct.size !== p.validatorSubset.length) throw new Error('validatorSubset must be distinct')
    return { stake: p.stake, validatorSubset: p.validatorSubset }
  },

  decodeEntry: (raw) => {
    const e = raw as { player: viem.Hex; side: number | 'heads' | 'tails' }
    const side = e.side === 0 || e.side === 'heads' ? 'heads' : 'tails'
    return { player: e.player, side }
  },

  canArm: (_params, entries) => {
    const heads = entries.filter((e) => e.side === 'heads').length
    const tails = entries.filter((e) => e.side === 'tails').length
    return heads === 1 && tails === 1
  },

  settle: (_params, entries, seed) => {
    const winningSide = coinFlipOutcome(seed)
    const winner = entries.find((e) => e.side === winningSide)
    if (!winner) throw new Error('no entry on the winning side')
    return { winner: winner.player, winningSide }
  },

  presets: [],
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add examples/games/coinflip
git commit -m "feat: @gibs/coinflip Game implementation"
```

---

### Task 6: @gibs/raffle — the Game implementation

**Files:**
- Create: `examples/games/raffle/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `examples/games/raffle/src/index.ts`
- Create: `examples/games/raffle/test/raffle.test.ts`

- [ ] **Step 1: Scaffold the package**

`examples/games/raffle/package.json` (same shape as coinflip, name `@gibs/raffle`). Copy the core tsconfig and vitest config in.

- [ ] **Step 2: Write the failing test (closest + tiebreak parity with the contract)**

`examples/games/raffle/test/raffle.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import * as viem from 'viem'
import { raffle } from '../src/index'
import { raffleDraw } from '@gibs/games-core'

const params = {
  stake: viem.parseEther('1'),
  threshold: 3n,
  period: 5n,
  validatorSubset: ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333'] as viem.Hex[],
}

const ticket = (ticketId: bigint, player: viem.Hex, guess: bigint, committedAtBlock: bigint, revealed = true) =>
  ({ ticketId, player, guess, committedAtBlock, revealed })

describe('raffle.settle', () => {
  it('picks the revealed guess closest to the draw', () => {
    const seed = viem.padHex('0x80', { size: 32 }) // draw = 1 + (128 mod 256) = 129
    const draw = raffleDraw(seed)
    expect(draw).to.equal(129n)
    const entries = [ticket(1n, '0xaaa', 10n, 1n), ticket(2n, '0xbbb', 130n, 1n), ticket(3n, '0xccc', 250n, 1n)]
    expect(raffle.settle(params, entries, seed)?.ticketId).to.equal(2n)
  })

  it('breaks an equidistant tie by earliest commit then ticket id', () => {
    const seed = viem.padHex('0x80', { size: 32 }) // draw 129
    // 128 and 130 are both distance 1; earliest committedAtBlock wins
    const entries = [ticket(5n, '0xaaa', 130n, 9n), ticket(6n, '0xbbb', 128n, 7n)]
    expect(raffle.settle(params, entries, seed)?.ticketId).to.equal(6n)
    // same block -> smallest ticket id wins
    const sameBlock = [ticket(9n, '0xaaa', 130n, 4n), ticket(8n, '0xbbb', 128n, 4n)]
    expect(raffle.settle(params, sameBlock, seed)?.ticketId).to.equal(8n)
  })

  it('ignores unrevealed entries and returns null on a no-contest', () => {
    const seed = viem.padHex('0x80', { size: 32 })
    const entries = [ticket(1n, '0xaaa', 10n, 1n, false)]
    expect(raffle.settle(params, entries, seed)).to.equal(null)
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run (from `examples/games/raffle`): `pnpm test`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement the raffle Game**

`examples/games/raffle/src/index.ts`:

```ts
import * as viem from 'viem'
import { type Game, raffleDraw } from '@gibs/games-core'

export type RaffleParams = {
  stake: bigint
  threshold: bigint
  period: bigint
  validatorSubset: viem.Hex[]
}
export type RaffleEntry = {
  ticketId: bigint
  player: viem.Hex
  guess: bigint
  committedAtBlock: bigint
  revealed: boolean
}
export type RaffleOutcome = { ticketId: bigint; player: viem.Hex; guess: bigint; distance: bigint }

const MIN_SUBSET = 3

const distance = (guess: bigint, draw: bigint): bigint => (guess > draw ? guess - draw : draw - guess)

export const raffle: Game<RaffleParams, RaffleEntry, RaffleOutcome | null> = {
  parseParams: (raw) => {
    const p = raw as Partial<RaffleParams>
    if (typeof p.stake !== 'bigint' || p.stake <= 0n) throw new Error('stake must be a positive bigint')
    if (typeof p.threshold !== 'bigint' || p.threshold <= 0n) throw new Error('threshold must be positive')
    if (typeof p.period !== 'bigint' || p.period <= 0n) throw new Error('period must be positive')
    if (!Array.isArray(p.validatorSubset) || p.validatorSubset.length < MIN_SUBSET) {
      throw new Error(`validatorSubset must have at least ${MIN_SUBSET} members`)
    }
    const distinct = new Set(p.validatorSubset.map((a) => a.toLowerCase()))
    if (distinct.size !== p.validatorSubset.length) throw new Error('validatorSubset must be distinct')
    return { stake: p.stake, threshold: p.threshold, period: p.period, validatorSubset: p.validatorSubset }
  },

  decodeEntry: (raw) => {
    const e = raw as RaffleEntry
    return {
      ticketId: BigInt(e.ticketId),
      player: e.player,
      guess: BigInt(e.guess),
      committedAtBlock: BigInt(e.committedAtBlock),
      revealed: Boolean(e.revealed),
    }
  },

  canArm: (params, entries) => BigInt(entries.length) >= params.threshold,

  /**
   * The closest revealed guess to the draw wins; ties broken by earliest commit block then smallest
   * ticket id — identical to the contract's reveal/overwrite comparison, so the off-chain winner
   * equals the on-chain payout. Returns null on a no-contest (no revealed entries).
   */
  settle: (_params, entries, seed) => {
    const draw = raffleDraw(seed)
    const revealed = entries.filter((e) => e.revealed)
    if (revealed.length === 0) return null
    let best = revealed[0]!
    let bestDistance = distance(best.guess, draw)
    for (const e of revealed.slice(1)) {
      const d = distance(e.guess, draw)
      const closer =
        d < bestDistance ||
        (d === bestDistance &&
          (e.committedAtBlock < best.committedAtBlock ||
            (e.committedAtBlock === best.committedAtBlock && e.ticketId < best.ticketId)))
      if (closer) {
        best = e
        bestDistance = d
      }
    }
    return { ticketId: best.ticketId, player: best.player, guess: best.guess, distance: bestDistance }
  },

  presets: [],
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add examples/games/raffle
git commit -m "feat: @gibs/raffle Game implementation with deterministic tiebreak"
```

---

### Task 7: lifecycle.ts and operator.ts — reader and operator

**Files:**
- Create: `examples/games/core/src/lifecycle.ts`
- Create: `examples/games/core/src/operator.ts`
- Create: `examples/games/core/test/lifecycle.test.ts`

- [ ] **Step 1: Write lifecycle.ts (the RoundState reader)**

```ts
import * as viem from 'viem'

/** The phases shared by both games (a superset; a game uses the subset it needs). */
export type Phase = 'open' | 'filling' | 'armed' | 'drawing' | 'settled' | 'paid' | 'refunded' | 'chopped'

/** A reconstructed instance state: its decoded entries plus the current phase and (if cast) seed. */
export type RoundState<TEntry> = {
  instanceId: viem.Hex
  phase: Phase
  entries: TEntry[]
  seed?: viem.Hex
  draw?: bigint
}

/**
 * Build a RoundState from raw entry records using a game's decodeEntry. The phase and seed are
 * supplied by the caller (read from contract events/state); this keeps the reader game-agnostic —
 * it only maps raw entries through the game's pure decoder.
 */
export const toRoundState = <TEntry>(
  instanceId: viem.Hex,
  phase: Phase,
  rawEntries: unknown[],
  decodeEntry: (raw: unknown) => TEntry,
  extras: { seed?: viem.Hex; draw?: bigint } = {},
): RoundState<TEntry> => ({
  instanceId,
  phase,
  entries: rawEntries.map(decodeEntry),
  ...extras,
})
```

- [ ] **Step 2: Write operator.ts (ink, arm, cast helpers)**

```ts
import * as viem from 'viem'
import { randomAbi, type Info } from './contracts'
import { type Secret } from './secrets'

/**
 * Build the heat selection for a declared validator subset: one location per subset member, in
 * subset order. This mirrors GameBase._heatBound's positional binding, so the contract accepts it.
 */
export const buildHeatLocations = (subset: viem.Hex[], poolOffsetByProvider: Record<string, bigint>): Info[] =>
  subset.map((provider) => ({
    provider,
    callAtChange: false,
    durationIsTimestamp: false,
    duration: 12n,
    token: viem.zeroAddress,
    price: 0n,
    offset: poolOffsetByProvider[provider.toLowerCase()] ?? 0n,
    index: 0n,
  }))

/**
 * Cast the revealed validator secrets in heat order to finalize the seed. Returns the cast tx hash.
 * The caller supplies locations and secrets in the SAME order used at heat (== subset order).
 */
export const castSeed = async (
  walletClient: viem.WalletClient,
  publicClient: viem.PublicClient,
  randomAddress: viem.Hex,
  key: viem.Hex,
  locations: Info[],
  secrets: viem.Hex[],
): Promise<viem.Hex> => {
  const { request } = await publicClient.simulateContract({
    address: randomAddress,
    abi: randomAbi,
    functionName: 'cast',
    args: [key, locations, secrets],
    account: walletClient.account!,
  })
  return walletClient.writeContract(request)
}

/** Ink a price-0 validator pool (one preimage) under the validator's own address. */
export const inkPool = async (
  walletClient: viem.WalletClient,
  publicClient: viem.PublicClient,
  randomAddress: viem.Hex,
  validator: viem.Hex,
  secret: Secret,
): Promise<viem.Hex> => {
  const section: Info = {
    provider: validator,
    callAtChange: false,
    durationIsTimestamp: false,
    duration: 12n,
    token: viem.zeroAddress,
    price: 0n,
    offset: 0n,
    index: 0n,
  }
  const { request } = await publicClient.simulateContract({
    address: randomAddress,
    abi: randomAbi,
    functionName: 'ink',
    args: [section, secret.preimage],
    account: walletClient.account!,
    value: 0n,
  })
  return walletClient.writeContract(request)
}
```

- [ ] **Step 3: Write the failing lifecycle test**

`examples/games/core/test/lifecycle.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { toRoundState } from '../src/lifecycle'

describe('toRoundState', () => {
  it('maps raw entries through the game decoder and carries phase + seed', () => {
    const state = toRoundState(
      '0xabc',
      'settled',
      [{ side: 0, player: '0xaaa' }, { side: 1, player: '0xbbb' }],
      (raw: any) => ({ player: raw.player, side: raw.side === 0 ? 'heads' : 'tails' }),
      { seed: '0x02' },
    )
    expect(state.phase).to.equal('settled')
    expect(state.entries.map((e) => e.side)).to.deep.equal(['heads', 'tails'])
    expect(state.seed).to.equal('0x02')
  })
})
```

- [ ] **Step 4: Run to verify pass and typecheck the full core**

Run (from `examples/games/core`): `pnpm test && pnpm typecheck`
Expected: PASS; `index.ts` now resolves all modules and typechecks.

- [ ] **Step 5: Commit**

```bash
git add examples/games/core/src/lifecycle.ts examples/games/core/src/operator.ts examples/games/core/test/lifecycle.test.ts
git commit -m "feat: games-core lifecycle reader and operator helpers"
```

---

### Task 8: The end-to-end deploy and cross-layer parity test (local anvil)

This is the spec's highest-value test: for a real on-chain round, the off-chain `settle` names the exact winner the contract pays.

**Files:**
- Create: `examples/games/e2e/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `examples/games/e2e/src/deploy.ts`
- Create: `examples/games/e2e/test/parity.test.ts`

- [ ] **Step 1: Scaffold the e2e package**

`examples/games/e2e/package.json`:

```json
{
  "name": "@gibs/games-e2e",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "duel": "tsx scripts/duel.ts",
    "raffle": "tsx scripts/raffle.ts"
  },
  "dependencies": {
    "@gibs/games-core": "workspace:*",
    "@gibs/coinflip": "workspace:*",
    "@gibs/raffle": "workspace:*",
    "@gibs/random": "workspace:*",
    "viem": "^2.25.0"
  },
  "devDependencies": { "tsx": "^4.19.3", "typescript": "~5.8.3", "vitest": "^2.1.0" }
}
```

Copy the core `tsconfig.json`. `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 120_000 } })
```

Run `pnpm install` from the repo root to link the new package.

- [ ] **Step 2: Write deploy.ts (deploy Random + Raffle to a local node, allowlist + ink pools)**

`examples/games/e2e/src/deploy.ts`:

```ts
import * as viem from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { local, makePublicClient, makeWalletClient, randomAbi, raffleAbi, raffleBytecode, coinFlipAbi, coinFlipBytecode, makeSecret, inkPool, type Info } from '@gibs/games-core'
import RandomArtifact from '@gibs/random/artifacts/contracts/Random.sol/Random.json'

const TEST_MNEMONIC = 'test test test test test test test test test test test junk'

export type Deployment = {
  publicClient: viem.PublicClient
  caster: viem.WalletClient
  random: viem.Hex
  raffle: viem.Hex
  coinFlip: viem.Hex
  validators: { address: viem.Hex; location: Info; secret: viem.Hex }[]
  salt: viem.Hex
}

/**
 * Deploy core Random and the games to a local anvil node (chainId 31337, RPC 127.0.0.1:8545), set
 * up `validatorCount` allowlisted validators with one inked price-0 preimage each, and return the
 * handles a test or script needs. Account 0 of the standard anvil mnemonic is deployer + caster;
 * validators are further accounts of the same funded mnemonic.
 */
export const deployLocal = async (validatorCount = 3): Promise<Deployment> => {
  const account = mnemonicToAccount(TEST_MNEMONIC)
  const publicClient = makePublicClient(31337)
  const caster = makeWalletClient(31337, account)

  const deploy = async (abi: viem.Abi, bytecode: viem.Hex, args: unknown[]): Promise<viem.Hex> => {
    const hash = await caster.deployContract({ abi, bytecode, args, account, chain: local })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (!receipt.contractAddress) throw new Error('deploy reverted')
    return receipt.contractAddress
  }

  const random = await deploy(RandomArtifact.abi as viem.Abi, RandomArtifact.bytecode as viem.Hex, [])
  const raffle = await deploy(raffleAbi, raffleBytecode, [random])
  const coinFlip = await deploy(coinFlipAbi, coinFlipBytecode, [random])

  const salt = viem.bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  const validators: Deployment['validators'] = []
  for (let i = 0; i < validatorCount; i++) {
    const v = mnemonicToAccount(TEST_MNEMONIC, { accountIndex: i + 1 })
    const vWallet = makeWalletClient(31337, v)
    const secret = makeSecret(`validator-${i}`, salt)
    // allowlist on both games (owner == account 0)
    for (const game of [raffle, coinFlip]) {
      const { request } = await publicClient.simulateContract({ address: game, abi: raffleAbi, functionName: 'addValidator', args: [v.address], account })
      await publicClient.waitForTransactionReceipt({ hash: await caster.writeContract(request) })
    }
    await publicClient.waitForTransactionReceipt({ hash: await inkPool(vWallet, publicClient, random, v.address, secret) })
    const location: Info = { provider: v.address, callAtChange: false, durationIsTimestamp: false, duration: 12n, token: viem.zeroAddress, price: 0n, offset: 0n, index: 0n }
    validators.push({ address: v.address, location, secret: secret.secret })
  }

  return { publicClient, caster, random, raffle, coinFlip, validators, salt }
}
```

> `addValidator` exists on both games via `GameBase`; using `raffleAbi` for the selector is fine since the signature is identical. The standard anvil mnemonic funds accounts 0..9 with 10000 ETH each.

- [ ] **Step 3: Write the parity test**

`examples/games/e2e/test/parity.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import * as viem from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { deployLocal, type Deployment } from '../src/deploy'
import { makeWalletClient, raffleAbi, randomAbi } from '@gibs/games-core'
import { raffle } from '@gibs/raffle'

const TEST_MNEMONIC = 'test test test test test test test test test test test junk'
const stake = viem.parseEther('1')
const threshold = 3n
const period = 2n

const commitmentFor = (guess: bigint, salt: viem.Hex, player: viem.Hex): viem.Hex =>
  viem.keccak256(viem.encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }, { type: 'address' }], [guess, salt, player]))

describe('cross-layer parity (raffle)', () => {
  let d: Deployment
  beforeAll(async () => {
    d = await deployLocal(3)
  }, 120_000)

  it('the off-chain settle names the same winner the contract pays', async () => {
    const subset = d.validators.map((v) => v.address)
    // three players (anvil accounts 4,5,6) commit hidden guesses
    const players = [4, 5, 6].map((i) => mnemonicToAccount(TEST_MNEMONIC, { accountIndex: i }))
    const guesses = [10n, 128n, 250n]
    const salts = guesses.map((_g, i) => viem.keccak256(viem.toHex(`psalt-${i}`)))
    const committedAtBlocks: bigint[] = []
    for (let i = 0; i < 3; i++) {
      const w = makeWalletClient(31337, players[i])
      const { request } = await d.publicClient.simulateContract({
        address: d.raffle, abi: raffleAbi, functionName: 'commit',
        args: [stake, threshold, period, subset, commitmentFor(guesses[i], salts[i], players[i].address)],
        account: players[i], value: stake,
      })
      const receipt = await d.publicClient.waitForTransactionReceipt({ hash: await w.writeContract(request) })
      committedAtBlocks.push(receipt.blockNumber)
    }
    const opened = await d.publicClient.getContractEvents({ address: d.raffle, abi: raffleAbi, eventName: 'RoundOpened', fromBlock: 0n })
    const roundId = (opened[0].args as any).roundId as viem.Hex

    // mine past the period, arm
    await d.publicClient.request({ method: 'anvil_mine' as any, params: ['0x3' as any] })
    const locations = d.validators.map((v) => v.location)
    const { request: armReq } = await d.publicClient.simulateContract({ address: d.raffle, abi: raffleAbi, functionName: 'arm', args: [roundId, locations], account: d.caster.account! })
    const armReceipt = await d.publicClient.waitForTransactionReceipt({ hash: await d.caster.writeContract(armReq) })
    const key = (await d.publicClient.getContractEvents({ address: d.raffle, abi: raffleAbi, eventName: 'Armed', blockHash: armReceipt.blockHash }))[0].args as any
    const requestKey = key.key as viem.Hex

    // cast the validator secrets in subset order
    const secrets = d.validators.map((v) => v.secret)
    const { request: castReq } = await d.publicClient.simulateContract({ address: d.random, abi: randomAbi, functionName: 'cast', args: [requestKey, locations, secrets], account: d.caster.account! })
    await d.publicClient.waitForTransactionReceipt({ hash: await d.caster.writeContract(castReq) })

    const seed = (await d.publicClient.readContract({ address: d.random, abi: randomAbi, functionName: 'randomness', args: [requestKey] })) as { seed: viem.Hex }

    // all three reveal
    for (let i = 0; i < 3; i++) {
      const w = makeWalletClient(31337, players[i])
      const { request } = await d.publicClient.simulateContract({ address: d.raffle, abi: raffleAbi, functionName: 'reveal', args: [BigInt(i + 1), guesses[i], salts[i]], account: players[i] })
      await d.publicClient.waitForTransactionReceipt({ hash: await w.writeContract(request) })
    }

    // on-chain provisional winner
    const round = (await d.publicClient.readContract({ address: d.raffle, abi: raffleAbi, functionName: 'rounds', args: [roundId] })) as any[]
    const onChainBestTicket = round[12] as bigint

    // off-chain settle over the same entries + seed
    const entries = guesses.map((g, i) => ({ ticketId: BigInt(i + 1), player: players[i].address as viem.Hex, guess: g, committedAtBlock: committedAtBlocks[i], revealed: true }))
    const offChain = raffle.settle({ stake, threshold, period, validatorSubset: subset }, entries, seed.seed)

    expect(offChain?.ticketId).to.equal(onChainBestTicket)
  })
})
```

- [ ] **Step 4: Run the parity test against a local node**

Start anvil in one terminal: `anvil` (serves chainId 31337 at 127.0.0.1:8545).
Then run (from `examples/games/e2e`): `pnpm test`
Expected: PASS — the off-chain `settle` winner equals `round.bestTicket`.

> If `anvil` is unavailable, a Hardhat node can substitute but its default chainId is configured to 1 in this repo's `hardhat.config.ts`; start it with `npx hardhat node` and override the core's `chains` id, OR install Foundry's anvil (recommended; the chain id matches `chains.local`).

- [ ] **Step 5: Commit**

```bash
git add examples/games/e2e
git commit -m "test: cross-layer parity — off-chain settle equals on-chain payout"
```

---

### Task 9: Front-end scripts over the core (coin-flip duel + raffle run)

**Files:**
- Create: `examples/games/e2e/scripts/duel.ts`
- Create: `examples/games/e2e/scripts/raffle.ts`

- [ ] **Step 1: Write the coin-flip duel script over the core**

`examples/games/e2e/scripts/duel.ts` is the refactor of `packages/contracts/scripts/duel-943.ts` onto `@gibs/games-core` + `@gibs/coinflip`. It must:

- read `MNEMONIC` via env (never log it), select chain by `CHAIN` env (`local` or `943`);
- on local, call `deployLocal` to get Random + CoinFlip + validators; on 943, use `randomAddress[943]` and an already-deployed CoinFlip (env `COINFLIP`), and ink/allowlist validators as the funded account;
- run: player 0 enters heads (queues, empty locations), player 1 enters tails with `subset` + `locations` (pairs + heats);
- cast the validator secrets in subset order;
- read the seed, compute `coinflip.settle` off-chain, print it beside the on-chain `Settled` winner, and assert they match.

Full script:

```ts
import * as viem from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { makePublicClient, makeWalletClient, coinFlipAbi, randomAbi, makeSecret, inkPool, castSeed, type Info, type GamesChainId, randomAddress } from '@gibs/games-core'
import { coinflip } from '@gibs/coinflip'
import { deployLocal } from '../src/deploy'

const env = process.env
const CHAIN: GamesChainId = env.CHAIN === '943' ? 943 : 31337
const STAKE = viem.parseEther(env.STAKE || '0.1')

const main = async () => {
  if (CHAIN === 943 && !env.MNEMONIC) throw new Error('MNEMONIC required for 943')

  if (CHAIN === 31337) {
    const d = await deployLocal(3)
    const subset = d.validators.map((v) => v.address)
    const locations = d.validators.map((v) => v.location)
    const secrets = d.validators.map((v) => v.secret)
    const mnemonic = 'test test test test test test test test test test test junk'
    const heads = mnemonicToAccount(mnemonic, { accountIndex: 7 })
    const tails = mnemonicToAccount(mnemonic, { accountIndex: 8 })

    const enter = async (acct: viem.Account, side: number, locs: Info[]) => {
      const w = makeWalletClient(31337, acct)
      const { request } = await d.publicClient.simulateContract({ address: d.coinFlip, abi: coinFlipAbi, functionName: 'enterAndMatch', args: [side, subset, locs], account: acct, value: STAKE })
      await d.publicClient.waitForTransactionReceipt({ hash: await w.writeContract(request) })
    }
    await enter(heads, 0, [])
    await enter(tails, 1, locations)
    const heated = (await d.publicClient.getContractEvents({ address: d.coinFlip, abi: coinFlipAbi, eventName: 'Heated', fromBlock: 0n }))[0].args as any
    const key = heated.key as viem.Hex
    await d.publicClient.waitForTransactionReceipt({ hash: await castSeed(d.caster, d.publicClient, d.random, key, locations, secrets) })
    const seed = (await d.publicClient.readContract({ address: d.random, abi: randomAbi, functionName: 'randomness', args: [key] })) as { seed: viem.Hex }
    const offChain = coinflip.settle({ stake: STAKE, validatorSubset: subset }, [{ player: heads.address, side: 'heads' }, { player: tails.address, side: 'tails' }], seed.seed)
    const settled = (await d.publicClient.getContractEvents({ address: d.coinFlip, abi: coinFlipAbi, eventName: 'Settled', fromBlock: 0n }))[0].args as any
    console.log('seed        :', seed.seed)
    console.log('off-chain   :', offChain.winner, offChain.winningSide)
    console.log('on-chain    :', settled.winner)
    if (viem.getAddress(offChain.winner) !== viem.getAddress(settled.winner)) throw new Error('PARITY MISMATCH')
    console.log('PARITY OK')
    return
  }

  throw new Error('943 path: supply COINFLIP and run with the funded MNEMONIC; mirror duel-943.ts funding')
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
```

> The 943 branch is intentionally a guarded stub: the live run is the manual gate (Task 10). The original `duel-943.ts` remains the reference for funding/gas on 943 and is not deleted by this plan.

- [ ] **Step 2: Run the local duel**

Start `anvil`, then run (from `examples/games/e2e`): `pnpm duel`
Expected: prints the seed, the off-chain and on-chain winners, and `PARITY OK`.

- [ ] **Step 3: Write the raffle run script**

`examples/games/e2e/scripts/raffle.ts` mirrors the duel: `deployLocal`, three players commit hidden guesses, mine past the period, arm, cast, reveal all, finalise, then print the off-chain `raffle.settle` winner beside the on-chain `Finalised` winner and assert equality. Reuse the structure from the parity test (Task 8 Step 3) plus a finalise call and the parity print. Full script:

```ts
import * as viem from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { makeWalletClient, raffleAbi, randomAbi } from '@gibs/games-core'
import { raffle } from '@gibs/raffle'
import { deployLocal } from '../src/deploy'

const TEST_MNEMONIC = 'test test test test test test test test test test test junk'
const stake = viem.parseEther('1')
const threshold = 3n
const period = 2n
const commitmentFor = (g: bigint, s: viem.Hex, p: viem.Hex) =>
  viem.keccak256(viem.encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }, { type: 'address' }], [g, s, p]))

const main = async () => {
  const d = await deployLocal(3)
  const subset = d.validators.map((v) => v.address)
  const locations = d.validators.map((v) => v.location)
  const secrets = d.validators.map((v) => v.secret)
  const players = [4, 5, 6].map((i) => mnemonicToAccount(TEST_MNEMONIC, { accountIndex: i }))
  const guesses = [10n, 128n, 250n]
  const salts = guesses.map((_g, i) => viem.keccak256(viem.toHex(`psalt-${i}`)))
  const committedAtBlocks: bigint[] = []
  for (let i = 0; i < 3; i++) {
    const w = makeWalletClient(31337, players[i])
    const { request } = await d.publicClient.simulateContract({ address: d.raffle, abi: raffleAbi, functionName: 'commit', args: [stake, threshold, period, subset, commitmentFor(guesses[i], salts[i], players[i].address)], account: players[i], value: stake })
    const r = await d.publicClient.waitForTransactionReceipt({ hash: await w.writeContract(request) })
    committedAtBlocks.push(r.blockNumber)
  }
  const roundId = ((await d.publicClient.getContractEvents({ address: d.raffle, abi: raffleAbi, eventName: 'RoundOpened', fromBlock: 0n }))[0].args as any).roundId as viem.Hex
  await d.publicClient.request({ method: 'anvil_mine' as any, params: ['0x3' as any] })
  const { request: armReq } = await d.publicClient.simulateContract({ address: d.raffle, abi: raffleAbi, functionName: 'arm', args: [roundId, locations], account: d.caster.account! })
  const armReceipt = await d.publicClient.waitForTransactionReceipt({ hash: await d.caster.writeContract(armReq) })
  const key = ((await d.publicClient.getContractEvents({ address: d.raffle, abi: raffleAbi, eventName: 'Armed', blockHash: armReceipt.blockHash }))[0].args as any).key as viem.Hex
  const { request: castReq } = await d.publicClient.simulateContract({ address: d.random, abi: randomAbi, functionName: 'cast', args: [key, locations, secrets], account: d.caster.account! })
  await d.publicClient.waitForTransactionReceipt({ hash: await d.caster.writeContract(castReq) })
  const seed = (await d.publicClient.readContract({ address: d.random, abi: randomAbi, functionName: 'randomness', args: [key] })) as { seed: viem.Hex }
  for (let i = 0; i < 3; i++) {
    const w = makeWalletClient(31337, players[i])
    const { request } = await d.publicClient.simulateContract({ address: d.raffle, abi: raffleAbi, functionName: 'reveal', args: [BigInt(i + 1), guesses[i], salts[i]], account: players[i] })
    await d.publicClient.waitForTransactionReceipt({ hash: await w.writeContract(request) })
  }
  await d.publicClient.request({ method: 'anvil_mine' as any, params: ['0x65' as any] }) // 101 blocks
  const { request: finReq } = await d.publicClient.simulateContract({ address: d.raffle, abi: raffleAbi, functionName: 'finalise', args: [roundId], account: d.caster.account! })
  await d.publicClient.waitForTransactionReceipt({ hash: await d.caster.writeContract(finReq) })
  const finalised = (await d.publicClient.getContractEvents({ address: d.raffle, abi: raffleAbi, eventName: 'Finalised', fromBlock: 0n }))[0].args as any
  const entries = guesses.map((g, i) => ({ ticketId: BigInt(i + 1), player: players[i].address as viem.Hex, guess: g, committedAtBlock: committedAtBlocks[i], revealed: true }))
  const offChain = raffle.settle({ stake, threshold, period, validatorSubset: subset }, entries, seed.seed)
  console.log('draw      :', 1n + (BigInt(seed.seed) % 256n))
  console.log('off-chain :', offChain?.player, 'ticket', offChain?.ticketId)
  console.log('on-chain  :', finalised.winner)
  if (viem.getAddress(offChain!.player) !== viem.getAddress(finalised.winner)) throw new Error('PARITY MISMATCH')
  console.log('PARITY OK')
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
```

- [ ] **Step 4: Run the local raffle**

Start `anvil`, then run: `pnpm raffle`
Expected: prints the draw, the off-chain and on-chain winners, and `PARITY OK`.

- [ ] **Step 5: Commit**

```bash
git add examples/games/e2e/scripts
git commit -m "feat: coin-flip duel and raffle run over the games core"
```

---

### Task 10: Live 943 run and the README runbook

**Files:**
- Create: `examples/games/README.md`

- [ ] **Step 1: Write the runbook**

`examples/games/README.md` documents, in full prose (no acronyms):

- the package layout (`core`, `coinflip`, `raffle`, `e2e`) and what each is responsible for;
- how to run the local end-to-end: install Foundry's anvil, `anvil` in one terminal, then `pnpm --filter @gibs/games-e2e duel` and `pnpm --filter @gibs/games-e2e raffle` and `pnpm --filter @gibs/games-e2e test`;
- the disclosed trust assumption players must be shown: the draw is safe as long as at least one of the chosen validators is honest (the "at least one of N validators honest" assumption from the spec);
- the live PulseChain testnet version four run: read `MNEMONIC` via `op read`, set `CHAIN=943`, deploy `Raffle`/`CoinFlip` against the live Random at `0x775AF72d62c85d2F7f0Bcc05BAa4Be0830087217`, allowlist the funded validator accounts, and run a single round inside the twelve-block heat window. Note that 943 is a manual gate, not part of continuous integration, and that `RPC_943` should be overridden to valve.city for reliability inside the window (see the original `duel-943.ts` header for the funding and gas-cap pattern).

- [ ] **Step 2: Perform the manual 943 run (operator action)**

This step is run by a human with the funded mnemonic; it is not automated. Deploy the games to 943, run one coin-flip duel and one raffle round end to end, and confirm the on-chain winner matches the off-chain `settle`. Record the deployed addresses and the run output in `examples/games/README.md` under a "943 run log" heading.

- [ ] **Step 3: Commit**

```bash
git add examples/games/README.md
git commit -m "docs: games platform runbook and 943 gate"
```

---

## Self-review notes

- **Spec coverage:** `@gibs/games-core` substrate (chains, contracts, secrets/seed, lifecycle, operator, Game interface) — Tasks 2–4, 7. `@gibs/coinflip` and `@gibs/raffle` consumers — Tasks 5–6. Front-end scripts over the core — Task 9. Cross-layer parity (the highest-value test) — Task 8. Off-chain unit tests for the pure methods and seed reduction — Tasks 2, 5, 6. End-to-end on a local chain plus the 943 manual gate — Tasks 8–10.
- **Naming reconciliation** (from the spec's supersede note): the Slice 1 `@gibs/coinflip-core` becomes `@gibs/games-core` + `@gibs/coinflip` + `@gibs/raffle`, as built here.
- **Fairness-as-types:** `Game.settle(params, entries, seed)` takes the seed as an input only — Task 4. Both `settle` bodies reduce the seed with the exact contract arithmetic — Tasks 5, 6 — which Task 8 proves equal to the on-chain payout.
- **Type consistency:** `Info` is defined once in `contracts.ts` and reused; `RaffleEntry`/`CoinFlipEntry` field names match what the scripts and parity test construct; `raffleDraw`/`coinFlipOutcome`/`seedFromSecrets` are the single source of the reduction used everywhere.
- **Placeholder scan:** the 943 script branch is a deliberate guarded stub with the manual procedure documented in Task 10, not a hidden TODO; every code step shows complete code.

## Open items carried from the spec (front-end concerns, not blocking)

- Canonical presets (`presets: []` today) are populated when the web/terminal front ends are built; the contract and core do not require them, and binding already constrains the validators.
- The disclosed trust assumption ("at least one of N validators honest") is documented in the README and must surface in any real player-facing UI.
