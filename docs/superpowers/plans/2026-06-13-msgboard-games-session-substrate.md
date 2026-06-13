# MsgBoard Games — Session + Broadcast Substrate (Dice + Limbo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the off-chain substrate for instant, broadcast-driven house games — a co-signed `SessionState` (EIP-712), a participant commit-reveal RNG (server-seed hash chain), a pluggable broadcast `Transport` (in-memory + a thin MsgBoard adapter), a locally-retained hash-chained transcript, and the two trivial games **Dice** and **Limbo** — proven end-to-end with a two-party (player ↔ house) session driver that plays many rounds at network speed with full local verification. **No on-chain settlement in this plan** (that is the next plan); this is the layer everything else sits on.

**Architecture:** Plan 1 of the `2026-06-13-msgboard-games-design.md` spec (§13 plan 1). One new pnpm package `@gibs/msgboard-games` under `examples/games/`. Play is a sequence of co-signed `SessionState`s: the house pre-commits a server-seed hash chain in the opening state; each round the player contributes a client seed + nonce, the house reveals the next chain seed, both sides compute the result from a pure game-rules module and co-sign the new balances, and every step is appended to a local hash-chained transcript and broadcast over the `Transport`. Because the seed chain is pre-committed and the result is a pure function of (serverSeed, clientSeed, nonce), neither party can grind, and anyone holding the transcript can re-verify every round — exactly the off-chain half of the design, with settlement deferred.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), viem ^2.25 (EIP-712 typed data, abi encoding, keccak), `@msgboard/sdk` ^0.0.31 (published; the MsgBoard JSON-RPC client) for the board transport, vitest ^2.1 for tests, TypeScript ~5.8. Matches the surrounding `examples/games/*` packages exactly.

**Where the code lives / git:** `~/Documents/gibs-finance/random`, branch `games-platform`. Commits are unsigned in this repo (`commit.gpgsign false` already set locally). NO Co-Authored-By trailers. Push with `git push ssh://git@ssh.github.com:443/gibsfinance/random.git games-platform` (do this only when asked; a concurrent session may push, so `git fetch && git rebase origin/games-platform` on rejection). The plan + progress records live in the msgboard repo (`progress.txt` is the shared worklog for both repos).

**Conventions that bite:**
- pnpm workspace. Run package scripts from the package dir: `cd examples/games/msgboard-games && pnpm test` and `pnpm typecheck`. After creating the package, run `pnpm install` from the repo root once so the workspace links it.
- viem is the only crypto/eth dependency for state work (mirror `@gibs/zk-cards-core`). No floats in any consensus path — all game math is integer/bigint fixed-point (see Task 4).
- ESM only, `src/index.ts` is the package entry; tests live in `test/` and import from `../src/...`.
- Mirror the existing patterns verbatim where noted: `examples/games/zk-core/src/stateSig.ts` (EIP-712), `transport.ts` (Transport + LocalTransport), `transcript.ts` (hash-chained Transcript), `examples/games/hilo-war/src/encoding.ts` (abi tuple encoding). Read each before the task that mirrors it.

## File structure

```
examples/games/msgboard-games/
  package.json                 @gibs/msgboard-games; deps viem, @msgboard/sdk
  tsconfig.json                copy of zk-core/tsconfig.json
  src/
    index.ts                   public surface (re-exports)
    sessionState.ts            SessionState struct + EIP-712 typing + hash/sign/verify
    rng.ts                     server-seed hash chain (commit/reveal/verify) + round reduction
    game.ts                    the Game interface (rules seam) + shared types
    games/dice.ts              Dice rules module (roll-under)
    games/limbo.ts             Limbo rules module (target multiplier)
    transport.ts               Transport interface + in-memory LocalTransport
    msgboardTransport.ts       thin Transport over @msgboard/sdk (per-table category)
    transcript.ts              hash-chained retained transcript (envelopes)
    session.ts                 two-party player↔house session driver
  test/
    sessionState.test.ts
    rng.test.ts
    dice.test.ts
    limbo.test.ts
    transport.test.ts
    msgboardTransport.test.ts
    transcript.test.ts
    session.test.ts
  scripts/
    demo.ts                    plays a Dice + a Limbo session, prints results, verifies
  README.md
```

Canonical encodings pinned by this plan (later plans' Solidity mirrors MUST match; parity tests in the settlement plan enforce):
- **SessionState EIP-712 tuple** (order is law): `(bytes32 tableId, uint64 nonce, uint256 balancePlayer, uint256 balanceHouse, uint8 settlementMode, uint8 gameId, bytes32 gameStateHash, bytes32 rngCommit)`.
- **settlementMode:** `0 = optimistic, 1 = escrowed, 2 = zk`. **gameId:** `1 = dice, 2 = limbo` (cards reserve 0x10+; coin-flip/raffle live in the other family).
- **Server-seed chain:** `seed[L] = random 32B; seed[i] = keccak256(seed[i+1])` for `i = L-1 … 0`; published head `rngCommit = seed[0]`. Round `k` (1-indexed) uses `seed[k]`; a reveal of `seed[k]` verifies iff `keccak256(seed[k]) == seed[k-1]` (the previously-known link, `seed[0]` for `k = 1`).
- **Round randomness:** `raw = uint256(keccak256(abi.encode(bytes32 serverSeed, bytes32 clientSeed, uint64 nonce)))`.
- **Fixed-point:** percentages/multipliers in **hundredths** (54.50% → `5450`, 1.81× → `181`). House edge `EDGE_BPS = 100` (1%). Stakes/balances in chip base units (bigint).

---

### Task 1: Scaffold the `@gibs/msgboard-games` package

**Files:**
- Create: `examples/games/msgboard-games/package.json`
- Create: `examples/games/msgboard-games/tsconfig.json`
- Create: `examples/games/msgboard-games/src/index.ts`
- Create: `examples/games/msgboard-games/test/smoke.test.ts`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "@gibs/msgboard-games",
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
    "@msgboard/sdk": "^0.0.31",
    "viem": "^2.25.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "~5.8.3",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`** (identical to `examples/games/zk-core/tsconfig.json`)

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

- [ ] **Step 3: Write a placeholder `src/index.ts`**

```ts
export const PACKAGE = '@gibs/msgboard-games'
```

- [ ] **Step 4: Write a smoke test** `test/smoke.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { PACKAGE } from '../src/index'

describe('package', () => {
  it('loads', () => {
    expect(PACKAGE).toBe('@gibs/msgboard-games')
  })
})
```

- [ ] **Step 5: Install + run**

Run: `cd ~/Documents/gibs-finance/random && pnpm install`
Then: `cd examples/games/msgboard-games && pnpm test && pnpm typecheck`
Expected: 1 test passes; typecheck clean. (If `pnpm install` does not pick up the package, check the repo `pnpm-workspace.yaml` glob covers `examples/games/*` — the sibling packages prove it does.)

- [ ] **Step 6: Commit**

```bash
cd ~/Documents/gibs-finance/random
git add examples/games/msgboard-games pnpm-lock.yaml
git commit -m "feat(msgboard-games): scaffold @gibs/msgboard-games package"
```

---

### Task 2: `SessionState` — EIP-712 typing, hash, sign, verify

**Read first:** `examples/games/zk-core/src/stateSig.ts` — this task is the same shape with the new fields.

**Files:**
- Create: `examples/games/msgboard-games/src/sessionState.ts`
- Test: `examples/games/msgboard-games/test/sessionState.test.ts`

- [ ] **Step 1: Write the failing test** `test/sessionState.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import {
  type SessionState, TEST_DOMAIN, SESSION_STATE_TYPES,
  hashSessionState, signSessionState, verifySessionStateSig,
} from '../src/sessionState'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)

const base: SessionState = {
  tableId: `0x${'ab'.repeat(32)}`,
  nonce: 0n,
  balancePlayer: 1000n,
  balanceHouse: 1000n,
  settlementMode: 0,
  gameId: 1,
  gameStateHash: `0x${'00'.repeat(32)}`,
  rngCommit: `0x${'cd'.repeat(32)}`,
}

describe('SessionState EIP-712', () => {
  it('hash is deterministic', () => {
    expect(hashSessionState(TEST_DOMAIN, base)).toBe(hashSessionState(TEST_DOMAIN, base))
  })

  it('hash is sensitive to every field', () => {
    const h = hashSessionState(TEST_DOMAIN, base)
    expect(hashSessionState(TEST_DOMAIN, { ...base, nonce: 1n })).not.toBe(h)
    expect(hashSessionState(TEST_DOMAIN, { ...base, balancePlayer: 999n })).not.toBe(h)
    expect(hashSessionState(TEST_DOMAIN, { ...base, settlementMode: 1 })).not.toBe(h)
    expect(hashSessionState(TEST_DOMAIN, { ...base, gameId: 2 })).not.toBe(h)
  })

  it('round-trips a signature and rejects the wrong signer', async () => {
    const sig = await signSessionState(player, TEST_DOMAIN, base)
    expect(await verifySessionStateSig(player.address, TEST_DOMAIN, base, sig)).toBe(true)
    expect(await verifySessionStateSig(house.address, TEST_DOMAIN, base, sig)).toBe(false)
  })

  it('exposes the canonical type tuple in order', () => {
    expect(SESSION_STATE_TYPES.SessionState.map((f) => f.name)).toEqual([
      'tableId', 'nonce', 'balancePlayer', 'balanceHouse',
      'settlementMode', 'gameId', 'gameStateHash', 'rngCommit',
    ])
  })
})
```

- [ ] **Step 2: Run to verify failure** — `cd examples/games/msgboard-games && pnpm test test/sessionState.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/sessionState.ts`**

```ts
import { hashTypedData, recoverTypedDataAddress, type Hex } from 'viem'

/** Co-signed running state of one house-game session. Order of fields is consensus —
 *  the settlement-plan Solidity mirror MUST match this tuple exactly. */
export interface SessionState {
  tableId: Hex          // bytes32 session id
  nonce: bigint         // uint64, strictly increasing
  balancePlayer: bigint // uint256 chip base units
  balanceHouse: bigint
  settlementMode: number // uint8: 0 optimistic, 1 escrowed, 2 zk
  gameId: number         // uint8: 1 dice, 2 limbo
  gameStateHash: Hex     // bytes32, game module owns the preimage
  rngCommit: Hex         // bytes32, server-seed hash-chain head for this session
}

export interface GameDomain {
  name: 'MsgBoardGames'; version: '1'; chainId: number; verifyingContract: Hex
}

/** anvil chainId + placeholder address; the settlement plan pins the real HouseChannel domain. */
export const TEST_DOMAIN: GameDomain = {
  name: 'MsgBoardGames', version: '1', chainId: 31337,
  verifyingContract: '0x00000000000000000000000000000000000a3eb1',
}

export function makeDomain(chainId: number, verifyingContract: Hex): GameDomain {
  return { name: 'MsgBoardGames', version: '1', chainId, verifyingContract }
}

export const SESSION_STATE_TYPES = {
  SessionState: [
    { name: 'tableId', type: 'bytes32' },
    { name: 'nonce', type: 'uint64' },
    { name: 'balancePlayer', type: 'uint256' },
    { name: 'balanceHouse', type: 'uint256' },
    { name: 'settlementMode', type: 'uint8' },
    { name: 'gameId', type: 'uint8' },
    { name: 'gameStateHash', type: 'bytes32' },
    { name: 'rngCommit', type: 'bytes32' },
  ],
} as const

export interface StateSigner {
  address: Hex
  signTypedData(args: any): Promise<Hex>
}

export function hashSessionState(domain: GameDomain, s: SessionState): Hex {
  return hashTypedData({ domain, types: SESSION_STATE_TYPES, primaryType: 'SessionState', message: s as any })
}

export async function signSessionState(signer: StateSigner, domain: GameDomain, s: SessionState): Promise<Hex> {
  return signer.signTypedData({ domain, types: SESSION_STATE_TYPES, primaryType: 'SessionState', message: s })
}

export async function verifySessionStateSig(expected: Hex, domain: GameDomain, s: SessionState, sig: Hex): Promise<boolean> {
  try {
    const rec = await recoverTypedDataAddress({
      domain, types: SESSION_STATE_TYPES, primaryType: 'SessionState', message: s as any, signature: sig,
    })
    return rec.toLowerCase() === expected.toLowerCase()
  } catch { return false }
}
```

- [ ] **Step 4: Re-export from `src/index.ts`**

```ts
export const PACKAGE = '@gibs/msgboard-games'
export * from './sessionState'
```

- [ ] **Step 5: Run** — `pnpm test test/sessionState.test.ts && pnpm typecheck` → all pass.

- [ ] **Step 6: Commit**

```bash
git add examples/games/msgboard-games/src examples/games/msgboard-games/test
git commit -m "feat(msgboard-games): EIP-712 SessionState (hash/sign/verify)"
```

---

### Task 3: `rng.ts` — server-seed hash chain + round reduction

**Files:**
- Create: `examples/games/msgboard-games/src/rng.ts`
- Test: `examples/games/msgboard-games/test/rng.test.ts`

- [ ] **Step 1: Write the failing test** `test/rng.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { keccak256, type Hex } from 'viem'
import { buildSeedChain, verifyReveal, roundRandom } from '../src/rng'

describe('server-seed hash chain', () => {
  const tip = `0x${'77'.repeat(32)}` as Hex

  it('head is keccak applied length times to the tip', () => {
    const chain = buildSeedChain(tip, 4)
    expect(chain.commit).toBe(chain.seeds[0])
    // seeds[i-1] == keccak256(seeds[i])
    for (let i = 1; i < chain.seeds.length; i++) {
      expect(keccak256(chain.seeds[i])).toBe(chain.seeds[i - 1])
    }
  })

  it('a correct reveal verifies against the prior link; a wrong one fails', () => {
    const chain = buildSeedChain(tip, 4)
    // round 1 reveals seeds[1], verified against commit (seeds[0])
    expect(verifyReveal(chain.commit, chain.seeds[1])).toBe(true)
    expect(verifyReveal(chain.seeds[1], chain.seeds[2])).toBe(true)
    expect(verifyReveal(chain.commit, chain.seeds[2])).toBe(false) // skips a link
    expect(verifyReveal(chain.commit, `0x${'00'.repeat(32)}`)).toBe(false)
  })

  it('roundRandom is deterministic and changes with each input', () => {
    const s = `0x${'12'.repeat(32)}` as Hex
    const c = `0x${'34'.repeat(32)}` as Hex
    const a = roundRandom(s, c, 0n)
    expect(roundRandom(s, c, 0n)).toBe(a)
    expect(roundRandom(s, c, 1n)).not.toBe(a)
    expect(roundRandom(s, `0x${'35'.repeat(32)}`, 0n)).not.toBe(a)
    expect(roundRandom(`0x${'13'.repeat(32)}`, c, 0n)).not.toBe(a)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm test test/rng.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/rng.ts`**

```ts
import { keccak256, encodeAbiParameters, hexToBigInt, type Hex } from 'viem'

export interface SeedChain {
  /** seeds[0] is the published commit; seeds[k] is round k's server seed (1-indexed). */
  seeds: Hex[]
  commit: Hex
  length: number
}

/** Build a hash chain from a secret tip: seed[L]=tip, seed[i]=keccak256(seed[i+1]).
 *  The house keeps the whole array, publishes only `commit = seed[0]`. Round k uses seed[k];
 *  there are `length` playable rounds (k = 1..length). */
export function buildSeedChain(tip: Hex, length: number): SeedChain {
  if (length < 1) throw new Error('rng: chain length must be >= 1')
  const seeds: Hex[] = new Array(length + 1)
  seeds[length] = tip
  for (let i = length - 1; i >= 0; i--) seeds[i] = keccak256(seeds[i + 1])
  return { seeds, commit: seeds[0]!, length }
}

/** A revealed seed is valid iff hashing it yields the previously-known (prior) link. */
export function verifyReveal(priorLink: Hex, revealed: Hex): boolean {
  return keccak256(revealed) === priorLink
}

/** Round randomness: uint256(keccak256(abi.encode(serverSeed, clientSeed, nonce))). */
export function roundRandom(serverSeed: Hex, clientSeed: Hex, nonce: bigint): bigint {
  const packed = encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint64' }],
    [serverSeed, clientSeed, nonce],
  )
  return hexToBigInt(keccak256(packed))
}
```

- [ ] **Step 4: Re-export** — add `export * from './rng'` to `src/index.ts`.

- [ ] **Step 5: Run** — `pnpm test test/rng.test.ts && pnpm typecheck` → pass.

- [ ] **Step 6: Commit**

```bash
git add examples/games/msgboard-games/src examples/games/msgboard-games/test
git commit -m "feat(msgboard-games): server-seed hash chain + round randomness"
```

---

### Task 4: `game.ts` seam + Dice rules

**Read first:** `examples/games/hilo-war/src/encoding.ts` for the abi-tuple encoding idiom (the `as any` note and `encodeAbiParameters` shape).

The `Game` seam is intentionally tiny: a pure `settleRound` that maps `(stake, params, raw)` to a signed balance delta for the player (positive = player wins from house, negative = player loses to house), plus an abi encoding of the per-round game state for the future on-chain mirror.

**Files:**
- Create: `examples/games/msgboard-games/src/game.ts`
- Create: `examples/games/msgboard-games/src/games/dice.ts`
- Test: `examples/games/msgboard-games/test/dice.test.ts`

- [ ] **Step 1: Write `src/game.ts`** (no test of its own; exercised via Dice/Limbo)

```ts
import type { Hex } from 'viem'

export const EDGE_BPS = 100n // 1% house edge, in basis points
export const HUNDREDTHS = 100n // fixed-point scale: 1.00x or 100.00% == 100

export interface RoundOutcome {
  /** signed player delta in chip base units: >0 player wins from house, <0 player loses. */
  playerDelta: bigint
  win: boolean
  /** multiplier applied, in hundredths (181 == 1.81x); 0 on a loss. */
  multiplierX100: bigint
}

/** A house game is a pure pair: settle a round from randomness, and abi-encode its
 *  per-round state for the on-chain mirror (settlement plan). TParams is the bet config. */
export interface Game<TParams> {
  gameId: number
  /** settle one round. `raw` is roundRandom(...). `stake` is the chip wager. */
  settleRound(stake: bigint, params: TParams, raw: bigint): RoundOutcome
  /** canonical abi encoding of (params, raw, outcome) — preimage of gameStateHash. */
  encodeRound(stake: bigint, params: TParams, raw: bigint): Hex
}
```

- [ ] **Step 2: Write the failing test** `test/dice.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { dice, diceRoll, diceMultiplierX100 } from '../src/games/dice'

describe('dice (roll-under)', () => {
  it('reproduces the morbius reference: target 54.50% -> 1.81x', () => {
    // target is in hundredths of a percent: 54.50% == 5450
    expect(diceMultiplierX100(5450n)).toBe(181n) // floor(99_000_000 / 5450) = 18165 -> /100 = 181
  })

  it('roll is in [0, 9999] (hundredths of a percent)', () => {
    expect(diceRoll(0n)).toBe(0n)
    expect(diceRoll(10000n)).toBe(0n)
    expect(diceRoll(9999n)).toBe(9999n)
  })

  it('wins when roll < target and pays stake*(mult-1); loses stake otherwise', () => {
    // pick raw so roll = raw % 10000. target 5000 (50.00%).
    const win = dice.settleRound(100n, { targetX100: 5000n }, 1234n) // roll 1234 < 5000 -> win
    expect(win.win).toBe(true)
    // mult = floor(99_000_000/5000)=19800 -> x100 198 -> payout profit = 100*198/100 - 100 = 98
    expect(win.multiplierX100).toBe(198n)
    expect(win.playerDelta).toBe(98n)

    const lose = dice.settleRound(100n, { targetX100: 5000n }, 7000n) // roll 7000 >= 5000 -> lose
    expect(lose.win).toBe(false)
    expect(lose.playerDelta).toBe(-100n)
    expect(lose.multiplierX100).toBe(0n)
  })

  it('encodeRound is deterministic and hex', () => {
    const e = dice.encodeRound(100n, { targetX100: 5000n }, 1234n)
    expect(e).toMatch(/^0x/)
    expect(dice.encodeRound(100n, { targetX100: 5000n }, 1234n)).toBe(e)
  })

  it('rejects an out-of-range target', () => {
    expect(() => dice.settleRound(100n, { targetX100: 0n }, 1n)).toThrow()
    expect(() => dice.settleRound(100n, { targetX100: 9999n }, 1n)).toThrow()
  })
})
```

- [ ] **Step 3: Run to verify failure** — `pnpm test test/dice.test.ts` → FAIL.

- [ ] **Step 4: Implement `src/games/dice.ts`**

```ts
import { encodeAbiParameters, type Hex } from 'viem'
import { EDGE_BPS, HUNDREDTHS, type Game, type RoundOutcome } from '../game'

export interface DiceParams {
  /** roll-under target in hundredths of a percent: 54.50% == 5450. Range [1, 9899]. */
  targetX100: bigint
}

const ROLL_SPACE = 10_000n // rolls are 0..9999, i.e. 0.00%..99.99%
const MIN_TARGET = 1n
const MAX_TARGET = 9899n // keep multiplier finite and below the 100x display ceiling

/** roll in [0, 9999], representing 0.00%..99.99%. */
export function diceRoll(raw: bigint): bigint {
  return raw % ROLL_SPACE
}

/** multiplier in hundredths: floor((100% - edge) / winChance). 99_000_000 = (10000-100)*10000. */
export function diceMultiplierX100(targetX100: bigint): bigint {
  return (ROLL_SPACE - EDGE_BPS) * ROLL_SPACE / targetX100 / HUNDREDTHS
}

export const dice: Game<DiceParams> = {
  gameId: 1,
  settleRound(stake, params, raw): RoundOutcome {
    if (params.targetX100 < MIN_TARGET || params.targetX100 > MAX_TARGET) throw new Error('dice: target out of range')
    const roll = diceRoll(raw)
    const win = roll < params.targetX100
    if (!win) return { win: false, playerDelta: -stake, multiplierX100: 0n }
    const multiplierX100 = diceMultiplierX100(params.targetX100)
    const playerDelta = (stake * multiplierX100) / HUNDREDTHS - stake
    return { win: true, playerDelta, multiplierX100 }
  },
  encodeRound(stake, params, raw): Hex {
    return encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [this.gameId, stake, params.targetX100, raw],
    )
  },
}
```

- [ ] **Step 5: Re-export** — add `export * from './game'` and `export * from './games/dice'` to `src/index.ts`.

- [ ] **Step 6: Run** — `pnpm test test/dice.test.ts && pnpm typecheck` → pass.

- [ ] **Step 7: Commit**

```bash
git add examples/games/msgboard-games/src examples/games/msgboard-games/test
git commit -m "feat(msgboard-games): Game seam + Dice rules (roll-under, morbius-matched)"
```

---

### Task 5: Limbo rules

**Files:**
- Create: `examples/games/msgboard-games/src/games/limbo.ts`
- Test: `examples/games/msgboard-games/test/limbo.test.ts`

- [ ] **Step 1: Write the failing test** `test/limbo.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { limbo, limboResultX100, limboWinChanceX100 } from '../src/games/limbo'

describe('limbo (target multiplier)', () => {
  it('reproduces the morbius reference: target 5x -> 19.80% win chance', () => {
    // target 5x == 500 (hundredths). winChance = (10000-100)/5 = 1980 -> 19.80%
    expect(limboWinChanceX100(500n)).toBe(1980n)
  })

  it('result is 99_000_000 / (1_000_000 - u), in hundredths', () => {
    expect(limboResultX100(0n)).toBe(99n) // u=0 -> 0.99x
    expect(limboResultX100(999_999n)).toBe(99_000_000n) // u max -> huge
  })

  it('wins when result >= target and pays stake*(target-1); loses stake otherwise', () => {
    // choose raw so u = raw % 1_000_000. Need result >= 500 (5.00x): 99_000_000/(1e6-u) >= 500
    // => 1e6-u <= 198000 => u >= 802000. pick u = 900000 -> result 99_000_000/100000 = 990 (9.90x) >= 500 win
    const win = limbo.settleRound(10n, { targetX100: 500n }, 900_000n)
    expect(win.win).toBe(true)
    expect(win.multiplierX100).toBe(500n)         // pays the target multiplier
    expect(win.playerDelta).toBe(40n)             // 10*500/100 - 10 = 40

    const lose = limbo.settleRound(10n, { targetX100: 500n }, 100_000n) // result small -> lose
    expect(lose.win).toBe(false)
    expect(lose.playerDelta).toBe(-10n)
    expect(lose.multiplierX100).toBe(0n)
  })

  it('rejects a target below 1.00x', () => {
    expect(() => limbo.settleRound(10n, { targetX100: 99n }, 1n)).toThrow()
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm test test/limbo.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/games/limbo.ts`**

```ts
import { encodeAbiParameters, type Hex } from 'viem'
import { EDGE_BPS, HUNDREDTHS, type Game, type RoundOutcome } from '../game'

export interface LimboParams {
  /** target multiplier in hundredths: 5.00x == 500. Min 100 (1.00x). */
  targetX100: bigint
}

const U_SPACE = 1_000_000n // u in [0, 999_999] models U in [0,1) at 1e-6 resolution
// (1 - edge) expressed in hundredths: (10000 - 100)/100 = 99  (i.e. 0.99x == 99).
const ONE_MINUS_EDGE_X100 = (10_000n - EDGE_BPS) / HUNDREDTHS // 99n
const MIN_TARGET = 100n    // 1.00x

/** result multiplier in hundredths: (1-edge)/(1-U) == 99_000_000 / (1e6 - u). */
export function limboResultX100(u: bigint): bigint {
  return (ONE_MINUS_EDGE_X100 * U_SPACE) / (U_SPACE - u)
}

/** win chance in hundredths of a percent: (1-edge)/target == 990000 / targetX100. */
export function limboWinChanceX100(targetX100: bigint): bigint {
  // P(result >= target) = (1-edge)/target ; as hundredths-of-a-percent (100% == 10000):
  // ONE_MINUS_EDGE_X100 * 10000 / targetX100  ==  99 * 10000 / 500 == 1980 for a 5x target.
  return (ONE_MINUS_EDGE_X100 * 10_000n) / targetX100
}

export const limbo: Game<LimboParams> = {
  gameId: 2,
  settleRound(stake, params, raw): RoundOutcome {
    if (params.targetX100 < MIN_TARGET) throw new Error('limbo: target below 1.00x')
    const u = raw % U_SPACE
    const resultX100 = limboResultX100(u)
    const win = resultX100 >= params.targetX100
    if (!win) return { win: false, playerDelta: -stake, multiplierX100: 0n }
    const playerDelta = (stake * params.targetX100) / HUNDREDTHS - stake
    return { win: true, playerDelta, multiplierX100: params.targetX100 }
  },
  encodeRound(stake, params, raw): Hex {
    return encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [this.gameId, stake, params.targetX100, raw],
    )
  },
}
```

- [ ] **Step 4: Re-export** — add `export * from './games/limbo'` to `src/index.ts`.

- [ ] **Step 5: Run** — `pnpm test test/limbo.test.ts && pnpm typecheck` → pass.

- [ ] **Step 6: Commit**

```bash
git add examples/games/msgboard-games/src examples/games/msgboard-games/test
git commit -m "feat(msgboard-games): Limbo rules (target multiplier, morbius-matched)"
```

---

### Task 6: `transport.ts` — interface + in-memory `LocalTransport`

**Read first:** `examples/games/zk-core/src/transport.ts`. This is the same file; copy it verbatim into the new package (it has no zk-core-specific imports).

**Files:**
- Create: `examples/games/msgboard-games/src/transport.ts`
- Test: `examples/games/msgboard-games/test/transport.test.ts`

- [ ] **Step 1: Write the failing test** `test/transport.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { LocalTransport } from '../src/transport'

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('LocalTransport', () => {
  it('delivers a message to the peer', async () => {
    const [a, b] = LocalTransport.pair()
    const got: unknown[] = []
    b.onMessage((m) => got.push(m))
    await a.send({ hello: 1 })
    await tick()
    expect(got).toEqual([{ hello: 1 }])
  })

  it('drops the next message when told', async () => {
    const [a, b] = LocalTransport.pair()
    const got: unknown[] = []
    b.onMessage((m) => got.push(m))
    a.dropNext()
    await a.send({ x: 1 })
    await a.send({ x: 2 })
    await tick()
    expect(got).toEqual([{ x: 2 }])
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm test test/transport.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/transport.ts`** — copy `examples/games/zk-core/src/transport.ts` verbatim (the `Transport` interface, `MessageHandler`, and `LocalTransport` with `pair`/`dropNext`/`delayMs`/`send`/`onMessage`).

- [ ] **Step 4: Re-export** — add `export * from './transport'` to `src/index.ts`.

- [ ] **Step 5: Run** — `pnpm test test/transport.test.ts && pnpm typecheck` → pass.

- [ ] **Step 6: Commit**

```bash
git add examples/games/msgboard-games/src examples/games/msgboard-games/test
git commit -m "feat(msgboard-games): Transport interface + in-memory LocalTransport"
```

---

### Task 7: `transcript.ts` — locally-retained hash-chained transcript

**Read first:** `examples/games/zk-core/src/transcript.ts`. Reuse it nearly verbatim; the only change is the `verify` parties shape (`{ player, house }` instead of `{ A, B }`) to match this package's vocabulary.

**Files:**
- Create: `examples/games/msgboard-games/src/transcript.ts`
- Test: `examples/games/msgboard-games/test/transcript.test.ts`

- [ ] **Step 1: Write the failing test** `test/transcript.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { makeEnvelope, Transcript } from '../src/transcript'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const tableId = `0x${'ab'.repeat(32)}` as const

async function build(): Promise<Transcript> {
  const t = new Transcript(tableId)
  const e0 = await makeEnvelope(player, tableId, 0, t.head, 'OPEN', { stake: 100 })
  t.append(e0)
  const e1 = await makeEnvelope(house, tableId, 1, t.head, 'ROUND', { round: 1 })
  t.append(e1)
  return t
}

describe('Transcript', () => {
  it('verifies a well-formed transcript', async () => {
    const t = await build()
    expect(await t.verify({ player: player.address, house: house.address })).toBe(true)
  })

  it('survives a board outage: toJSON -> fromJSON re-derives the head', async () => {
    const t = await build()
    const restored = Transcript.fromJSON(t.toJSON())
    expect(restored.head).toBe(t.head)
    expect(await restored.verify({ player: player.address, house: house.address })).toBe(true)
  })

  it('rejects a chain break', async () => {
    const t = new Transcript(tableId)
    const e0 = await makeEnvelope(player, tableId, 0, t.head, 'OPEN', {})
    t.append(e0)
    const bad = await makeEnvelope(house, tableId, 1, `0x${'99'.repeat(32)}`, 'ROUND', {})
    expect(() => t.append(bad)).toThrow()
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm test test/transcript.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/transcript.ts`** — copy `examples/games/zk-core/src/transcript.ts` verbatim, then change only the `verify` signature and body:

```ts
  /** Full re-verification: chain links, seqs, signatures, signer membership. */
  async verify(parties: { player: Hex; house: Hex }): Promise<boolean> {
    let head: Hex = GENESIS
    const ok = new Set([parties.player.toLowerCase(), parties.house.toLowerCase()])
    for (const [i, e] of this._entries.entries()) {
      if (e.seq !== i || e.prev !== head || e.tableId !== this.tableId) return false
      if (!ok.has(e.from.toLowerCase())) return false
      if (!(await verifyEnvelope(e))) return false
      head = keccak256(concat([head, entryDigest(e)]))
    }
    return head === this.head
  }
```

(Keep `Envelope`, `EnvelopeSigner`, `entryDigest`, `makeEnvelope`, `verifyEnvelope`, `append`, `toJSON`, `fromJSON` exactly as in zk-core.)

- [ ] **Step 4: Re-export** — add `export * from './transcript'` to `src/index.ts`.

- [ ] **Step 5: Run** — `pnpm test test/transcript.test.ts && pnpm typecheck` → pass.

- [ ] **Step 6: Commit**

```bash
git add examples/games/msgboard-games/src examples/games/msgboard-games/test
git commit -m "feat(msgboard-games): locally-retained hash-chained transcript"
```

---

### Task 8: `msgboardTransport.ts` — thin `Transport` over `@msgboard/sdk`

The MsgBoard adapter implements the same `Transport` interface, posting each broadcast as a PoW-stamped message under a per-table category and polling `content` for inbound. Plan 1 proves it against a **fake provider** (no live board); the live multi-machine run lands in a later plan. Keep it thin.

**Files:**
- Create: `examples/games/msgboard-games/src/msgboardTransport.ts`
- Test: `examples/games/msgboard-games/test/msgboardTransport.test.ts`

- [ ] **Step 0: Inspect the installed SDK surface** so the adapter calls real methods.

Run: `cd examples/games/msgboard-games && node -e "const s=require('@msgboard/sdk'); console.log(Object.keys(s))"`
Then read the client type: `sed -n '1,60p' ../../../node_modules/@msgboard/sdk/dist/index.d.ts` (confirm `MsgBoardClient`, `addMessage(input)`, `content(filter)`, `categoryHash`, and the `MessageSeed`/`Content` shapes). The adapter below uses only `addMessage`, `content`, and `categoryHash`; if `addMessage` requires a pre-`work()`ed seed in the installed version, call the client's work method first inside `send` (the `.d.ts` names it — wire it in Step 3).

- [ ] **Step 1: Write the failing test** `test/msgboardTransport.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest'
import { MsgBoardTransport } from '../src/msgboardTransport'

// Minimal fake of the MsgBoardClient surface the adapter uses.
function fakeClient() {
  const posted: any[] = []
  return {
    posted,
    addMessage: vi.fn(async (seed: any) => { posted.push(seed); return '0xhash' }),
    content: vi.fn(async (_filter: any) => ({})),
  }
}

const tableId = `0x${'ab'.repeat(32)}` as const

describe('MsgBoardTransport', () => {
  it('posts a broadcast under the table category', async () => {
    const client = fakeClient()
    const t = new MsgBoardTransport(client as any, tableId)
    await t.send({ kind: 'ROUND', round: 1 })
    expect(client.addMessage).toHaveBeenCalledOnce()
    // the posted seed carries our table category and the serialized payload
    expect(client.posted[0].category).toBe(t.category)
  })

  it('decodes polled content into messages for the handler', async () => {
    const client = fakeClient()
    const t = new MsgBoardTransport(client as any, tableId)
    const got: unknown[] = []
    t.onMessage((m) => got.push(m))
    // simulate one inbound message in the board content shape the adapter expects
    client.content = vi.fn(async () => ({
      [t.category]: [{ data: t.encode({ kind: 'ROUND', round: 2 }) }],
    })) as any
    await t.poll()
    expect(got).toEqual([{ kind: 'ROUND', round: 2 }])
  })

  it('does not re-deliver a message already seen', async () => {
    const client = fakeClient()
    const t = new MsgBoardTransport(client as any, tableId)
    const got: unknown[] = []
    t.onMessage((m) => got.push(m))
    const msg = { data: t.encode({ kind: 'X' }) }
    client.content = vi.fn(async () => ({ [t.category]: [msg] })) as any
    await t.poll()
    await t.poll()
    expect(got).toEqual([{ kind: 'X' }])
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm test test/msgboardTransport.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/msgboardTransport.ts`**

```ts
import { stringToHex, hexToString, type Hex } from 'viem'
import { categoryHash } from '@msgboard/sdk'
import type { MessageHandler, Transport } from './transport'

/** The subset of @msgboard/sdk's MsgBoardClient this adapter needs. Keeps the adapter
 *  testable with a fake and decoupled from the full client type. */
export interface BoardClient {
  addMessage(seed: { category: Hex; data: Hex }): Promise<unknown>
  content(filter: { category?: Hex }): Promise<Record<string, Array<{ data: Hex }>>>
}

/** Broadcasts/reads session messages over MsgBoard under a per-table category.
 *  Ephemeral by design (spec §2): callers retain their own transcript; this is transport only. */
export class MsgBoardTransport implements Transport {
  readonly category: Hex
  private handler: MessageHandler = () => {}
  private seen = new Set<string>()

  constructor(private client: BoardClient, tableId: Hex) {
    this.category = categoryHash(`mbg:${tableId}`)
  }

  encode(msg: unknown): Hex {
    return stringToHex(JSON.stringify(msg))
  }

  async send(msg: unknown): Promise<void> {
    await this.client.addMessage({ category: this.category, data: this.encode(msg) })
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler
  }

  /** Pull inbound messages once; new (unseen) ones are delivered to the handler. */
  async poll(): Promise<void> {
    const content = await this.client.content({ category: this.category })
    const entries = content[this.category] ?? []
    for (const e of entries) {
      if (this.seen.has(e.data)) continue
      this.seen.add(e.data)
      this.handler(JSON.parse(hexToString(e.data)))
    }
  }
}
```

(If Step 0 showed `addMessage` needs a PoW'd seed, do the client's `work`/`doPoW` on `{ category, data }` before `addMessage` inside `send`, and widen `BoardClient` to include that method. The fake in the test only needs `addMessage`/`content`, so the test is unaffected.)

- [ ] **Step 4: Re-export** — add `export * from './msgboardTransport'` to `src/index.ts`.

- [ ] **Step 5: Run** — `pnpm test test/msgboardTransport.test.ts && pnpm typecheck` → pass.

- [ ] **Step 6: Commit**

```bash
git add examples/games/msgboard-games/src examples/games/msgboard-games/test
git commit -m "feat(msgboard-games): thin MsgBoard Transport adapter (per-table category)"
```

---

### Task 9: `session.ts` — two-party player↔house session driver

This is the payoff: a driver that opens a session (house commits the seed-chain head into co-signed state 0), plays rounds at network speed (player picks client seed + nonce, house reveals the next chain seed, both compute the identical outcome from the game module and co-sign the new balances), records every step in the retained transcript, and verifies a finished session from the transcript alone — proving the §2 ephemerality property (settlement deferred to the next plan).

**Files:**
- Create: `examples/games/msgboard-games/src/session.ts`
- Test: `examples/games/msgboard-games/test/session.test.ts`

- [ ] **Step 1: Write the failing test** `test/session.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { HouseSession, verifyFinishedSession } from '../src/session'
import { dice } from '../src/games/dice'
import { limbo } from '../src/games/limbo'
import { TEST_DOMAIN } from '../src/sessionState'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const tableId = `0x${'ab'.repeat(32)}` as Hex
const tip = `0x${'77'.repeat(32)}` as Hex

function newSession(game: any) {
  return new HouseSession({
    domain: TEST_DOMAIN, tableId, game,
    player, house, seedTip: tip, chainLength: 8,
    openBalances: { player: 1000n, house: 1000n }, settlementMode: 0,
  })
}

describe('HouseSession', () => {
  it('opens with a both-signed state 0 carrying the seed-chain commit', async () => {
    const s = newSession(dice)
    await s.open()
    expect(s.state.nonce).toBe(0n)
    expect(s.state.rngCommit).toBe(s.chain.commit)
    expect(await s.bothSigned(s.state)).toBe(true)
  })

  it('plays dice rounds, conserves chips, and advances the nonce', async () => {
    const s = newSession(dice)
    await s.open()
    const before = s.state.balancePlayer + s.state.balanceHouse
    for (let i = 0; i < 5; i++) {
      await s.playRound({ stake: 100n, params: { targetX100: 5000n }, clientSeed: `0x${'33'.repeat(32)}` })
    }
    expect(s.state.nonce).toBe(5n)
    expect(s.state.balancePlayer + s.state.balanceHouse).toBe(before) // conservation
    expect(await s.bothSigned(s.state)).toBe(true)
  })

  it('plays limbo rounds too (same driver, different game)', async () => {
    const s = newSession(limbo)
    await s.open()
    await s.playRound({ stake: 10n, params: { targetX100: 200n }, clientSeed: `0x${'44'.repeat(32)}` })
    expect(s.state.nonce).toBe(1n)
  })

  it('verifies a finished session from the transcript ALONE (board outage)', async () => {
    const s = newSession(dice)
    await s.open()
    for (let i = 0; i < 3; i++) {
      await s.playRound({ stake: 50n, params: { targetX100: 4000n }, clientSeed: `0x${'55'.repeat(32)}` })
    }
    // Drop everything except the retained transcript JSON + the public commit.
    const json = s.transcript.toJSON()
    const ok = await verifyFinishedSession(json, {
      parties: { player: player.address, house: house.address },
      commit: s.chain.commit, game: dice,
    })
    expect(ok).toBe(true)
  })

  it('a tampered round result fails transcript re-verification', async () => {
    const s = newSession(dice)
    await s.open()
    await s.playRound({ stake: 50n, params: { targetX100: 4000n }, clientSeed: `0x${'55'.repeat(32)}` })
    const obj = JSON.parse(s.transcript.toJSON())
    // corrupt the recorded playerDelta of the round envelope
    const round = obj.entries.find((e: any) => e.kind === 'ROUND')
    round.body.outcome.playerDelta = '999999'
    const ok = await verifyFinishedSession(JSON.stringify(obj), {
      parties: { player: player.address, house: house.address },
      commit: s.chain.commit, game: dice,
    }).catch(() => false)
    expect(ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm test test/session.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/session.ts`**

```ts
import { type Hex } from 'viem'
import {
  type SessionState, type GameDomain, type StateSigner,
  hashSessionState, signSessionState, verifySessionStateSig,
} from './sessionState'
import { buildSeedChain, verifyReveal, roundRandom, type SeedChain } from './rng'
import { Transcript, makeEnvelope, type EnvelopeSigner } from './transcript'
import type { Game } from './game'

const ZERO32 = `0x${'00'.repeat(32)}` as Hex

export interface Signer extends StateSigner, EnvelopeSigner {}

export interface SessionConfig<TParams> {
  domain: GameDomain
  tableId: Hex
  game: Game<TParams>
  player: Signer
  house: Signer
  seedTip: Hex
  chainLength: number
  openBalances: { player: bigint; house: bigint }
  settlementMode: number
}

export interface PlayInput<TParams> {
  stake: bigint
  params: TParams
  clientSeed: Hex
}

/** Drives a player↔house session in-process (both signers local). A real deployment
 *  splits player and house across machines over a Transport; the co-sign logic is identical. */
export class HouseSession<TParams> {
  state!: SessionState
  readonly chain: SeedChain
  readonly transcript: Transcript
  private sigs = new Map<bigint, { player: Hex; house: Hex }>()

  constructor(private cfg: SessionConfig<TParams>) {
    this.chain = buildSeedChain(cfg.seedTip, cfg.chainLength)
    this.transcript = new Transcript(cfg.tableId)
  }

  async bothSigned(s: SessionState): Promise<boolean> {
    const pair = this.sigs.get(s.nonce)
    if (!pair) return false
    return (
      (await verifySessionStateSig(this.cfg.player.address, this.cfg.domain, s, pair.player)) &&
      (await verifySessionStateSig(this.cfg.house.address, this.cfg.domain, s, pair.house))
    )
  }

  private async coSign(s: SessionState): Promise<void> {
    const player = await signSessionState(this.cfg.player, this.cfg.domain, s)
    const house = await signSessionState(this.cfg.house, this.cfg.domain, s)
    this.sigs.set(s.nonce, { player, house })
  }

  async open(): Promise<void> {
    this.state = {
      tableId: this.cfg.tableId,
      nonce: 0n,
      balancePlayer: this.cfg.openBalances.player,
      balanceHouse: this.cfg.openBalances.house,
      settlementMode: this.cfg.settlementMode,
      gameId: this.cfg.game.gameId,
      gameStateHash: ZERO32,
      rngCommit: this.chain.commit,
    }
    await this.coSign(this.state)
    const env = await makeEnvelope(this.cfg.house, this.cfg.tableId, 0, this.transcript.head, 'OPEN', {
      rngCommit: this.chain.commit, balances: { player: this.state.balancePlayer.toString(), house: this.state.balanceHouse.toString() },
    })
    this.transcript.append(env)
  }

  async playRound(input: PlayInput<TParams>): Promise<void> {
    const roundIndex = this.state.nonce + 1n // 1-indexed into the seed chain
    const serverSeed = this.chain.seeds[Number(roundIndex)]
    if (!serverSeed) throw new Error('session: seed chain exhausted')
    const priorLink = this.chain.seeds[Number(roundIndex) - 1]!
    if (!verifyReveal(priorLink, serverSeed)) throw new Error('session: bad seed reveal')

    const raw = roundRandom(serverSeed, input.clientSeed, roundIndex)
    const outcome = this.cfg.game.settleRound(input.stake, input.params, raw)
    const gameStateHash = this.cfg.game.encodeRound(input.stake, input.params, raw) as Hex

    const next: SessionState = {
      ...this.state,
      nonce: roundIndex,
      balancePlayer: this.state.balancePlayer + outcome.playerDelta,
      balanceHouse: this.state.balanceHouse - outcome.playerDelta,
      gameStateHash,
    }
    if (next.balancePlayer < 0n || next.balanceHouse < 0n) throw new Error('session: balance underflow')

    await this.coSign(next)
    const env = await makeEnvelope(this.cfg.player, this.cfg.tableId, this.transcript.entries.length, this.transcript.head, 'ROUND', {
      round: Number(roundIndex),
      stake: input.stake.toString(),
      clientSeed: input.clientSeed,
      serverSeed,
      params: serializeParams(input.params),
      outcome: { win: outcome.win, playerDelta: outcome.playerDelta.toString(), multiplierX100: outcome.multiplierX100.toString() },
      stateHash: hashSessionState(this.cfg.domain, next),
    })
    this.transcript.append(env)
    this.state = next
  }
}

function serializeParams(p: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) out[k] = String(v)
  return out
}

export interface VerifyContext<TParams> {
  parties: { player: Hex; house: Hex }
  commit: Hex
  game: Game<TParams>
}

/** Re-verify a finished session from the retained transcript alone (spec §2): chain links +
 *  signatures (Transcript.verify), every server-seed reveal against the committed chain, and
 *  every recorded outcome recomputed from (serverSeed, clientSeed, round). Throws/returns false on any mismatch. */
export async function verifyFinishedSession<TParams>(transcriptJson: string, ctx: VerifyContext<TParams>): Promise<boolean> {
  const t = Transcript.fromJSON(transcriptJson)
  if (!(await t.verify(ctx.parties))) return false

  let priorLink = ctx.commit
  for (const e of t.entries) {
    if (e.kind !== 'ROUND') continue
    const b = e.body as any
    const serverSeed = b.serverSeed as Hex
    if (!verifyReveal(priorLink, serverSeed)) return false
    priorLink = serverSeed
    const raw = roundRandom(serverSeed, b.clientSeed as Hex, BigInt(b.round))
    const params = deserializeParams<TParams>(b.params)
    const outcome = ctx.game.settleRound(BigInt(b.stake), params, raw)
    if (
      outcome.win !== b.outcome.win ||
      outcome.playerDelta.toString() !== b.outcome.playerDelta ||
      outcome.multiplierX100.toString() !== b.outcome.multiplierX100
    ) return false
  }
  return true
}

function deserializeParams<TParams>(raw: Record<string, string>): TParams {
  const out: Record<string, bigint> = {}
  for (const [k, v] of Object.entries(raw)) out[k] = BigInt(v)
  return out as unknown as TParams
}
```

- [ ] **Step 4: Re-export** — add `export * from './session'` to `src/index.ts`.

- [ ] **Step 5: Run** — `pnpm test test/session.test.ts && pnpm typecheck` → all pass. Then run the whole suite: `pnpm test` → all green.

- [ ] **Step 6: Commit**

```bash
git add examples/games/msgboard-games/src examples/games/msgboard-games/test
git commit -m "feat(msgboard-games): two-party house session driver + transcript-only verification"
```

---

### Task 10: Demo script + README + full verification

**Files:**
- Create: `examples/games/msgboard-games/scripts/demo.ts`
- Create: `examples/games/msgboard-games/README.md`
- Modify: `examples/games/msgboard-games/package.json` (add a `demo` script)

- [ ] **Step 1: Write `scripts/demo.ts`** — plays both games end-to-end and verifies from the transcript.

```ts
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { HouseSession, verifyFinishedSession, dice, limbo, TEST_DOMAIN } from '../src/index'

async function run(name: string, game: any, params: any, stake: bigint) {
  const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
  const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
  const s = new HouseSession({
    domain: TEST_DOMAIN, tableId: `0x${'ab'.repeat(32)}` as Hex, game,
    player, house, seedTip: `0x${'77'.repeat(32)}` as Hex, chainLength: 16,
    openBalances: { player: 1000n, house: 1000n }, settlementMode: 0,
  })
  await s.open()
  console.log(`\n== ${name} ==`)
  for (let i = 0; i < 10; i++) {
    await s.playRound({ stake, params, clientSeed: `0x${(i + 1).toString(16).padStart(64, '0')}` as Hex })
    console.log(`round ${s.state.nonce}: player=${s.state.balancePlayer} house=${s.state.balanceHouse}`)
  }
  const ok = await verifyFinishedSession(s.transcript.toJSON(), {
    parties: { player: player.address, house: house.address }, commit: s.chain.commit, game,
  })
  console.log(`${name} transcript verifies from scratch: ${ok}`)
}

await run('DICE 50.00% target', dice, { targetX100: 5000n }, 100n)
await run('LIMBO 2.00x target', limbo, { targetX100: 200n }, 100n)
```

- [ ] **Step 2: Add the `demo` script** to `package.json` scripts:

```json
    "demo": "tsx scripts/demo.ts"
```

and add `"tsx": "^4.19.0"` to `devDependencies`. Run `pnpm install` from the repo root.

- [ ] **Step 3: Run the demo**

Run: `cd examples/games/msgboard-games && pnpm demo`
Expected: two sessions print 10 rounds each with running balances, and each ends `transcript verifies from scratch: true`.

- [ ] **Step 4: Write `README.md`** — document: what the package is (the off-chain broadcast/session substrate, settlement deferred per spec §13 plan 1), the `SessionState` tuple + numeric codes, the server-seed hash-chain provably-fair scheme (with the stake.com reveal-on-rotation note from spec §14), the `Game` seam + Dice/Limbo formulas (and that they match morbius's `mult=99/target` / `winChance=99/target`), the Transport interface (in-memory + MsgBoard), the ephemerality property (transcript is retained locally; MsgBoard is transport only — spec §2), and how to run the tests + demo. Point to `docs/superpowers/specs/2026-06-13-msgboard-games-design.md` in the msgboard repo.

- [ ] **Step 5: Full sweep** — `cd examples/games/msgboard-games && pnpm test && pnpm typecheck` → all green.

- [ ] **Step 6: Commit**

```bash
git add examples/games/msgboard-games
git commit -m "feat(msgboard-games): demo script + README; substrate complete (dice + limbo, off-chain)"
```

- [ ] **Step 7: Record progress** (msgboard repo `progress.txt`, newest-first section at top): substrate plan executed — `@gibs/msgboard-games` with SessionState (EIP-712), server-seed hash-chain RNG, Dice + Limbo (morbius-matched), Transport (in-memory + MsgBoard adapter), retained transcript, two-party session driver, transcript-only verification; test counts; the commit range; note settlement is the next plan. Commit + push msgboard (`master`, signed, HTTPS origin).

---

## Self-review notes (already applied)

- **Spec coverage (§13 plan 1):** SessionState model + EIP-712 (Task 2) ✓; commit-reveal server-seed chain (Task 3) ✓; MsgBoard broadcast/read helpers (Tasks 6 + 8: interface, in-memory, and board adapter) ✓; retained-transcript persistence (Task 7) ✓; Dice + Limbo end-to-end off-chain with instant play + local verification (Tasks 4, 5, 9) ✓; no settlement (deferred — no contract or escrow touched anywhere) ✓.
- **No on-chain hash parity test here:** the spec calls for "EIP-712 typing + on-chain hash parity," but the contract does not exist until the settlement plan. The EIP-712 tuple + numeric codes are pinned in this plan's header and `sessionState.ts`; the TS↔Solidity `stateDigest` parity test lands in the settlement plan (mirroring how the zk-cards plan pinned `ChannelState` in TS first, then parity-tested against `ZkTable`). Called out so it is not mistaken for a gap.
- **Type consistency:** `SessionState` field names/order match between the header tuple, `SESSION_STATE_TYPES`, `sessionState.ts`, and `session.ts`. `Game.settleRound` returns `RoundOutcome { playerDelta, win, multiplierX100 }` and is consumed with those exact names in `session.ts` and the verifier. `gameId` 1=dice / 2=limbo consistent across `dice.ts`, `limbo.ts`, and the header. `Transport` interface identical across `transport.ts`, `LocalTransport`, and `MsgBoardTransport`.
- **MsgBoard SDK risk isolated to Task 8** with an explicit inspect-first step; the rest of the package has no `@msgboard/sdk` dependency, so the substrate and games are fully testable regardless of the live board.
- **Fixed-point/no-floats:** all Dice/Limbo math is bigint in hundredths; reference values (`181`, `198`, `1980`) are hand-checked against the morbius screenshots in the test assertions.

## Execution corrections (applied during build, 2026-06-13)

Three fixes were applied while executing this plan; the committed code (random `45e0121..6c0447a`) is correct, and this section records the deltas vs the task code above so a re-run matches:

1. **Task 3 — `noUncheckedIndexedAccess`.** The package `tsconfig.json` keeps `"noUncheckedIndexedAccess": true` (as Task 1 sets it). Under it, variable array indexing yields `T | undefined`, so `rng.ts` line `seeds[i] = keccak256(seeds[i + 1])` needs `seeds[i + 1]!`, and `rng.test.ts` needs `!` on `chain.seeds[i]`, `chain.seeds[i - 1]`, `chain.seeds[1]`, `chain.seeds[2]`. (The flag must NOT be dropped.)
2. **Task 9 — `gameStateHash`.** `encodeRound(...)` returns a multi-word ABI encoding (128 bytes), not a `bytes32`. `playRound` must set `gameStateHash = keccak256(this.cfg.game.encodeRound(...))`. Additionally, the per-round co-signatures are embedded in the OPEN/ROUND envelope bodies (`sigs: { player, house }`), and `verifyFinishedSession` takes `domain` in its `VerifyContext`, cross-checks `rngCommit` against the OPEN body, reconstructs each `SessionState`, and verifies both EIP-712 co-signatures — so the retained transcript alone proves mutual consent (spec §2). The `stateHash` body field from the task code is replaced by the embedded `sigs`.
3. **Limbo upper bound.** `limbo.settleRound` also rejects `targetX100 > 99_000_000n` (`MAX_TARGET = ONE_MINUS_EDGE_X100 * U_SPACE`), symmetric with Dice's `MAX_TARGET`.

Non-blocking follow-ups (final review): constrain `Game<TParams extends Record<string, bigint>>` for type-safe param (de)serialization before adding a non-bigint-param game; wire the SDK PoW (`doPoW`) step into the live MsgBoard posting path when a multi-machine run is built.
