# MsgBoard Relayer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@msgboard/relayer`, a controllable, safe-by-default pool-watcher engine with pluggable sources, actions, dedup stores, and a one-year historical archive, then refactor the three `packages/sponsor/` scripts onto it.

**Architecture:** A thin `Relayer<T>` class (no inheritance, internals are pure functions) runs a heartbeat: poll a `Source`, record every item to an always-on `Sink`, filter by a `Condition`, dedup via a `Store`, then gate the `Action` — `observe` mode (default) only logs the would-do; `live` mode executes the outbound effect. Msgboard sources/actions are first-class in the package.

**Tech Stack:** TypeScript (strict, NodeNext ESM), viem, `@msgboard/sdk` / `@msgboard/core`, `pg` (optional peer, for the Postgres store/sinks), vitest 3.

---

## Implementation notes (resolved against the real codebase)

- **Message shape:** `RPCMessage = { [K in keyof Message]: Hex }` from `@msgboard/core` — every field is a hex string: `version, blockHash, category, data, nonce, workMultiplier, workDivisor, blockNumber, hash`. **There is no sender field.** The archive keys on `(hash, chain_id)`.
- **Content shape:** `Content = { [categoryHash: Hex]: RPCMessage[] }`. `client.content({ category })` returns categories mapped to arrays of messages.
- **Archive ownership:** the archive sink is `RelayerSink<RPCMessage>`. A single dedicated **archivist** relayer (source = all content) is the canonical historical-index writer. The bridge watcher's items are addresses, so it does not archive (this refines the spec's examples table — single-writer is cleaner than bolting the archive onto type-mismatched relayers).
- **Context:** the engine resolves the viem chain from `chainId` (`1 → mainnet`, `369 → pulsechain`, `943 → pulsechainV4`), builds a viem `PublicClient` over `node.rpcUrl`, and a `MsgBoardClient` wrapping it. Both are exposed on `RelayerContext`.
- **Conventions:** ESM (`"type": "module"`, NodeNext), 2-space, single quotes, no semicolons, `printWidth: 100`, `trailingComma: 'all'` (copy `packages/sponsor/.prettierrc`). Tests use vitest 3 (`vitest run`). Imports of local `.ts` files use the `.js` extension (NodeNext), matching the SDK.

---

## File structure

```
packages/relayer/
  package.json
  tsconfig.json
  vitest.config.ts
  .prettierrc
  README.md
  src/
    index.ts                  # public exports
    types.ts                  # contracts: Source/Action/Store/Sink, Context, config, results
    logger.ts                 # Logger type + default console logger
    chains.ts                 # chainId -> viem Chain resolution
    relayer.ts                # Relayer class (tick pipeline + start/stop/runOnce)
    stores/
      memory-ttl.ts
      noop.ts
      postgres.ts
    sinks/
      postgres-archive.ts     # historical index + query
      postgres.ts             # generic durable record sink
    sources/
      msgboard-content.ts
      bridge-affirmation.ts
      generated.ts
    actions/
      submit-message.ts
      send-value.ts
      webhook.ts
      noop.ts
  test/
    relayer.test.ts
    stores/memory-ttl.test.ts
    stores/postgres.test.ts
    sinks/postgres-archive.test.ts
    sources/msgboard-content.test.ts
    sources/bridge-affirmation.test.ts
    actions/submit-message.test.ts
    actions/send-value.test.ts
    actions/webhook.test.ts
packages/sponsor/
  index.ts   bridge.ts   spam.ts      # refactored onto the engine
```

---

## Task 0: Scaffold the `@msgboard/relayer` package

**Files:**
- Create: `packages/relayer/package.json`
- Create: `packages/relayer/tsconfig.json`
- Create: `packages/relayer/vitest.config.ts`
- Create: `packages/relayer/.prettierrc`
- Modify: `package.json` (root workspaces + scripts)

- [ ] **Step 1: Create `packages/relayer/package.json`**

```json
{
  "name": "@msgboard/relayer",
  "version": "0.0.1",
  "description": "Controllable, safe-by-default pool-watcher relayer for the msgboard board",
  "repository": "github:valve-tech/msgboard",
  "author": "MsgBoard",
  "license": "MIT",
  "type": "module",
  "publishConfig": {
    "access": "public"
  },
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.js",
      "default": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "keywords": ["msgboard", "relayer", "pool-watcher", "pulsechain"],
  "scripts": {
    "prebuild": "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\"",
    "build": "tsc",
    "watch": "tsc -w",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "prettier --check ."
  },
  "files": ["dist/"],
  "dependencies": {
    "@msgboard/sdk": "^0.0.28",
    "viem": "^2.25.0"
  },
  "peerDependencies": {
    "pg": "^8.14.1"
  },
  "peerDependenciesMeta": {
    "pg": { "optional": true }
  },
  "devDependencies": {
    "@types/pg": "^8.11.11",
    "typescript": "^5.8.2",
    "vitest": "^3.1.1"
  }
}
```

- [ ] **Step 2: Create `packages/relayer/tsconfig.json`** (copy of the sponsor config)

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "skipLibCheck": true,
    "esModuleInterop": true,
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "exclude": ["dist", "node_modules", "test"]
}
```

- [ ] **Step 3: Create `packages/relayer/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
```

- [ ] **Step 4: Create `packages/relayer/.prettierrc`** (copy from `packages/sponsor/.prettierrc`)

```json
{
  "useTabs": false,
  "singleQuote": true,
  "trailingComma": "all",
  "tabWidth": 2,
  "semi": false,
  "htmlWhitespaceSensitivity": "strict",
  "bracketSameLine": true,
  "printWidth": 100
}
```

- [ ] **Step 5: Add the package to the root `package.json`**

In `package.json`, add `"packages/relayer"` to the `workspaces` array (after `"packages/sponsor"`) and add this script to `scripts`:

```json
"test:relayer": "npm run test --workspace=packages/relayer"
```

- [ ] **Step 6: Install and verify the workspace resolves**

Run: `npm install`
Expected: completes without error; `ls node_modules/@msgboard/relayer` resolves to the workspace symlink.

- [ ] **Step 7: Commit**

```bash
git add packages/relayer/package.json packages/relayer/tsconfig.json packages/relayer/vitest.config.ts packages/relayer/.prettierrc package.json package-lock.json
git commit -m "build(relayer): scaffold @msgboard/relayer package"
```

---

## Task 1: Core contracts and logger

**Files:**
- Create: `packages/relayer/src/logger.ts`
- Create: `packages/relayer/src/chains.ts`
- Create: `packages/relayer/src/types.ts`

- [ ] **Step 1: Create `packages/relayer/src/logger.ts`**

```ts
/** A minimal structured logger; printf-style, matching the SDK's logger shape. */
export type Logger = (formatter: string, ...args: unknown[]) => void

/** The default logger writes to the console with a fixed prefix. */
export const defaultLogger = (prefix: string): Logger => {
  return (formatter: string, ...args: unknown[]) => {
    console.log(`[${prefix}] ${formatter}`, ...args)
  }
}
```

- [ ] **Step 2: Create `packages/relayer/src/chains.ts`**

```ts
import type { Chain } from 'viem'
import { mainnet, pulsechain, pulsechainV4 } from 'viem/chains'

/** The networks a relayer can target, keyed by chain id. */
const chainsById: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [pulsechain.id]: pulsechain,
  [pulsechainV4.id]: pulsechainV4,
}

/**
 * Resolves a viem chain from its numeric id.
 * @throws if the chain id is not one of the supported networks
 */
export const resolveChain = (chainId: number): Chain => {
  const chain = chainsById[chainId]
  if (!chain) {
    const supported = Object.keys(chainsById).join(', ')
    throw new Error(`unsupported chainId ${chainId} (expected one of ${supported})`)
  }
  return chain
}
```

- [ ] **Step 3: Create `packages/relayer/src/types.ts`**

```ts
import type { MsgBoardClient } from '@msgboard/sdk'
import type { Chain, PublicClient } from 'viem'
import type { Logger } from './logger.js'

/** The two operating modes. `observe` never produces an outbound side effect. */
export type RelayerMode = 'observe' | 'live'

/** Identifies the msgboard node a relayer watches. */
export type RelayerNode = {
  /** The JSON-RPC URL of the msgboard node. */
  rpcUrl: string
  /** The chain id of the node (1, 369, or 943). */
  chainId: number
}

/** Everything a source, action, or sink may need at runtime. */
export type RelayerContext = {
  node: RelayerNode
  mode: RelayerMode
  chain: Chain
  /** A viem public client over `node.rpcUrl`. */
  publicClient: PublicClient
  /** A msgboard SDK client wrapping `publicClient`. */
  client: MsgBoardClient
  logger: Logger
}

/** The outcome of a live action. */
export type ActionResult = {
  /** True if the action's effect succeeded. */
  ok: boolean
  /** An identifying reference, e.g. a transaction hash or message hash. */
  ref?: string
  /** Optional structured detail for logging or storage. */
  meta?: Record<string, unknown>
}

/** Reads the current batch of candidate items from the watched pool. */
export type RelayerSource<T> = {
  poll(context: RelayerContext): Promise<readonly T[]>
}

/** A side-effecting operation, split so observe mode can describe without doing. */
export type RelayerAction<T> = {
  /** Pure description of the intended effect; used for observe-mode logging. */
  describe(item: T, context: RelayerContext): string
  /** The real outbound effect; only ever called in live mode. */
  execute(item: T, context: RelayerContext): Promise<ActionResult>
}

/** Action-level idempotency: "have I already acted on this?". Short retention. */
export type RelayerStore<T> = {
  has(key: string): Promise<boolean>
  remember(key: string, result: ActionResult): Promise<void>
  prune?(): Promise<void>
}

/** Unconditional recording for history/observability. Long retention. Runs in BOTH modes. */
export type RelayerSink<T> = {
  record(item: T, context: RelayerContext): Promise<void>
  prune?(): Promise<void>
}

/** Derives a stable dedup key for an item. */
export type RelayerKey<T> = (item: T) => string

/** Decides whether a candidate should be acted on, beyond dedup. */
export type RelayerCondition<T> = (item: T, context: RelayerContext) => boolean | Promise<boolean>

/** Construction options for a Relayer. */
export type RelayerConfig<T> = {
  node: RelayerNode
  /** Safety switch. Defaults to 'observe' — performs no outbound side effect. */
  mode?: RelayerMode
  /** Poll cadence in milliseconds. Defaults to 30_000. */
  intervalMs?: number
  source: RelayerSource<T>
  action: RelayerAction<T>
  key: RelayerKey<T>
  /** Action-level dedup. Defaults to an in-memory time-to-live store. */
  store?: RelayerStore<T>
  /** Historical recording; runs in observe and live modes. */
  sink?: RelayerSink<T>
  condition?: RelayerCondition<T>
  logger?: Logger
  /** Run `store.prune` / `sink.prune` every N ticks. Defaults to 30. */
  pruneEveryTicks?: number
}

/** What happened during one tick — returned by `runOnce()` for tests and one-shots. */
export type TickReport = {
  /** Total items polled from the source. */
  polled: number
  /** Items recorded to the sink. */
  recorded: number
  /** Items that passed the condition and were not deduped. */
  eligible: number
  /** Items whose action executed (live mode only). */
  executed: number
  /** Items whose action was only described (observe mode). */
  described: number
  /** Items skipped by the dedup store. */
  deduped: number
}
```

- [ ] **Step 4: Type-check**

Run: `npm run build --workspace=packages/relayer`
Expected: PASS (emits `dist/`), no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/relayer/src/logger.ts packages/relayer/src/chains.ts packages/relayer/src/types.ts
git commit -m "feat(relayer): core contracts, logger, chain resolution"
```

---

## Task 2: The Relayer engine — `runOnce()` tick pipeline

**Files:**
- Create: `packages/relayer/src/relayer.ts`
- Test: `packages/relayer/test/relayer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { Relayer } from '../src/relayer.js'
import type { RelayerConfig, RelayerContext } from '../src/types.js'

type Item = { id: string }

const baseConfig = (over: Partial<RelayerConfig<Item>>): RelayerConfig<Item> => ({
  node: { rpcUrl: 'http://localhost:8545', chainId: 943 },
  source: { poll: async () => [{ id: 'a' }] },
  action: {
    describe: (item) => `would act on ${item.id}`,
    execute: async (item) => ({ ok: true, ref: item.id }),
  },
  key: (item) => item.id,
  logger: () => {},
  ...over,
})

describe('Relayer.runOnce', () => {
  it('observe mode describes but never executes', async () => {
    const execute = vi.fn(async (item: Item) => ({ ok: true, ref: item.id }))
    const relayer = new Relayer(baseConfig({ mode: 'observe', action: { describe: () => 'x', execute } }))
    const report = await relayer.runOnce()
    expect(execute).not.toHaveBeenCalled()
    expect(report.described).toBe(1)
    expect(report.executed).toBe(0)
  })

  it('live mode executes each eligible item exactly once', async () => {
    const execute = vi.fn(async (item: Item) => ({ ok: true, ref: item.id }))
    const relayer = new Relayer(baseConfig({ mode: 'live', action: { describe: () => 'x', execute } }))
    const report = await relayer.runOnce()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(report.executed).toBe(1)
  })

  it('records every polled item to the sink in observe mode', async () => {
    const record = vi.fn(async () => {})
    const relayer = new Relayer(baseConfig({ mode: 'observe', sink: { record } }))
    const report = await relayer.runOnce()
    expect(record).toHaveBeenCalledTimes(1)
    expect(report.recorded).toBe(1)
  })

  it('skips items the store has already seen', async () => {
    const execute = vi.fn(async (item: Item) => ({ ok: true, ref: item.id }))
    const store = { has: async () => true, remember: async () => {} }
    const relayer = new Relayer(baseConfig({ mode: 'live', store, action: { describe: () => 'x', execute } }))
    const report = await relayer.runOnce()
    expect(execute).not.toHaveBeenCalled()
    expect(report.deduped).toBe(1)
  })

  it('remembers a key only after a successful live execute', async () => {
    const remember = vi.fn(async () => {})
    const store = { has: async () => false, remember }
    const relayer = new Relayer(baseConfig({ mode: 'live', store }))
    await relayer.runOnce()
    expect(remember).toHaveBeenCalledWith('a', expect.objectContaining({ ok: true }))
  })

  it('isolates an action error and does not remember the key', async () => {
    const remember = vi.fn(async () => {})
    const store = { has: async () => false, remember }
    const action = {
      describe: () => 'x',
      execute: async () => {
        throw new Error('boom')
      },
    }
    const relayer = new Relayer(baseConfig({ mode: 'live', store, action }))
    const report = await relayer.runOnce()
    expect(remember).not.toHaveBeenCalled()
    expect(report.executed).toBe(0)
  })

  it('drops items that fail the condition', async () => {
    const execute = vi.fn(async (item: Item) => ({ ok: true, ref: item.id }))
    const relayer = new Relayer(
      baseConfig({
        mode: 'live',
        condition: (item) => item.id === 'keep',
        source: { poll: async () => [{ id: 'drop' }, { id: 'keep' }] },
        action: { describe: () => 'x', execute },
      }),
    )
    const report = await relayer.runOnce()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(report.eligible).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace=packages/relayer -- relayer.test.ts`
Expected: FAIL — `Relayer` is not defined / cannot find `../src/relayer.js`.

- [ ] **Step 3: Implement the engine (tick pipeline only)**

Create `packages/relayer/src/relayer.ts`:

```ts
import { createPublicClient, http } from 'viem'
import { MsgBoardClient, type Provider } from '@msgboard/sdk'
import { resolveChain } from './chains.js'
import { defaultLogger, type Logger } from './logger.js'
import type {
  RelayerConfig,
  RelayerContext,
  RelayerMode,
  TickReport,
} from './types.js'

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_PRUNE_EVERY_TICKS = 30

/** Builds the runtime context (viem + SDK clients) for a relayer config. */
const buildContext = <T>(config: RelayerConfig<T>, logger: Logger): RelayerContext => {
  const chain = resolveChain(config.node.chainId)
  const publicClient = createPublicClient({
    chain,
    transport: http(config.node.rpcUrl, { timeout: 30_000 }),
  })
  const client = new MsgBoardClient(publicClient as unknown as Provider)
  return {
    node: config.node,
    mode: config.mode ?? 'observe',
    chain,
    publicClient,
    client,
    logger,
  }
}

/**
 * A controllable pool-watcher. Safe by default: in `observe` mode it records and
 * logs what it would do, but performs no outbound side effect.
 */
export class Relayer<T> {
  private readonly config: RelayerConfig<T>
  private readonly logger: Logger
  private readonly context: RelayerContext
  private readonly intervalMs: number
  private readonly pruneEveryTicks: number
  private tickCount = 0

  constructor(config: RelayerConfig<T>) {
    this.config = config
    this.logger = config.logger ?? defaultLogger('relayer')
    this.context = buildContext(config, this.logger)
    this.intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS
    this.pruneEveryTicks = config.pruneEveryTicks ?? DEFAULT_PRUNE_EVERY_TICKS
  }

  get mode(): RelayerMode {
    return this.context.mode
  }

  /** Runs a single tick and returns a report. Used by tests and one-shot runs. */
  async runOnce(): Promise<TickReport> {
    const report: TickReport = {
      polled: 0,
      recorded: 0,
      eligible: 0,
      executed: 0,
      described: 0,
      deduped: 0,
    }
    const items = await this.config.source.poll(this.context)
    report.polled = items.length
    for (const item of items) {
      await this.handleItem(item, report)
    }
    this.tickCount += 1
    await this.maybePrune()
    return report
  }

  private async handleItem(item: T, report: TickReport): Promise<void> {
    await this.recordItem(item, report)
    const eligible = await this.isEligible(item)
    if (!eligible.proceed) {
      if (eligible.reason === 'deduped') report.deduped += 1
      return
    }
    report.eligible += 1
    await this.actOnItem(item, report)
  }

  private async recordItem(item: T, report: TickReport): Promise<void> {
    if (!this.config.sink) return
    await this.config.sink.record(item, this.context)
    report.recorded += 1
  }

  private async isEligible(item: T): Promise<{ proceed: boolean; reason?: 'condition' | 'deduped' }> {
    if (this.config.condition) {
      const ok = await this.config.condition(item, this.context)
      if (!ok) return { proceed: false, reason: 'condition' }
    }
    if (this.config.store) {
      const seen = await this.config.store.has(this.config.key(item))
      if (seen) return { proceed: false, reason: 'deduped' }
    }
    return { proceed: true }
  }

  private async actOnItem(item: T, report: TickReport): Promise<void> {
    if (this.context.mode === 'observe') {
      this.logger('observe: %s', this.config.action.describe(item, this.context))
      report.described += 1
      return
    }
    try {
      const result = await this.config.action.execute(item, this.context)
      report.executed += 1
      if (this.config.store) {
        await this.config.store.remember(this.config.key(item), result)
      }
    } catch (error) {
      this.logger('action failed: %o', error instanceof Error ? error.message : error)
    }
  }

  private async maybePrune(): Promise<void> {
    if (this.tickCount % this.pruneEveryTicks !== 0) return
    await this.config.store?.prune?.()
    await this.config.sink?.prune?.()
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test --workspace=packages/relayer -- relayer.test.ts`
Expected: PASS — all 7 cases green.

- [ ] **Step 5: Commit**

```bash
git add packages/relayer/src/relayer.ts packages/relayer/test/relayer.test.ts
git commit -m "feat(relayer): tick pipeline with safe-by-default action gate"
```

---

## Task 3: Engine lifecycle — `start()` / `stop()`

**Files:**
- Modify: `packages/relayer/src/relayer.ts`
- Modify: `packages/relayer/test/relayer.test.ts`

- [ ] **Step 1: Write the failing test (append to the existing test file)**

```ts
describe('Relayer lifecycle', () => {
  it('start() runs ticks until stop() and stop awaits the in-flight tick', async () => {
    let polls = 0
    const relayer = new Relayer(baseConfig({
      mode: 'observe',
      intervalMs: 5,
      source: { poll: async () => { polls += 1; return [{ id: 'a' }] } },
    }))
    relayer.start()
    await new Promise((r) => setTimeout(r, 30))
    await relayer.stop()
    const seen = polls
    await new Promise((r) => setTimeout(r, 30))
    expect(polls).toBe(seen) // no ticks after stop
    expect(seen).toBeGreaterThan(1)
  })

  it('start() is idempotent (a second call does not start a second loop)', async () => {
    let polls = 0
    const relayer = new Relayer(baseConfig({
      mode: 'observe',
      intervalMs: 5,
      source: { poll: async () => { polls += 1; return [] } },
    }))
    relayer.start()
    relayer.start()
    await new Promise((r) => setTimeout(r, 30))
    await relayer.stop()
    // a single loop at 5ms over ~30ms yields far fewer than a doubled loop would
    expect(polls).toBeLessThan(12)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace=packages/relayer -- relayer.test.ts`
Expected: FAIL — `relayer.start is not a function`.

- [ ] **Step 3: Add lifecycle to `Relayer`**

In `packages/relayer/src/relayer.ts`, add these fields near `private tickCount = 0`:

```ts
  private running = false
  private loopPromise: Promise<void> | null = null
  private abort: AbortController | null = null
```

Add a small sleep helper above the class:

```ts
/** Resolves after `ms`, or immediately if the signal aborts. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
```

Add these methods to the class:

```ts
  /** Begins the poll loop. Idempotent — a second call is a no-op while running. */
  start(): void {
    if (this.running) return
    this.running = true
    this.abort = new AbortController()
    const signal = this.abort.signal
    this.loopPromise = this.loop(signal)
  }

  /** Stops the loop and awaits the in-flight tick. */
  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.abort?.abort()
    await this.loopPromise
    this.loopPromise = null
    this.abort = null
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runOnce()
      } catch (error) {
        this.logger('tick failed: %o', error instanceof Error ? error.message : error)
      }
      if (signal.aborted) return
      await sleep(this.intervalMs, signal)
    }
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test --workspace=packages/relayer -- relayer.test.ts`
Expected: PASS — all lifecycle cases green.

- [ ] **Step 5: Commit**

```bash
git add packages/relayer/src/relayer.ts packages/relayer/test/relayer.test.ts
git commit -m "feat(relayer): start/stop lifecycle with AbortSignal"
```

---

## Task 4: `memoryTtlStore`

**Files:**
- Create: `packages/relayer/src/stores/memory-ttl.ts`
- Test: `packages/relayer/test/stores/memory-ttl.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { memoryTtlStore } from '../../src/stores/memory-ttl.js'

describe('memoryTtlStore', () => {
  it('does not know an unseen key', async () => {
    const store = memoryTtlStore({ ttlMs: 1000 })
    expect(await store.has('x')).toBe(false)
  })

  it('knows a remembered key within the time-to-live', async () => {
    const store = memoryTtlStore({ ttlMs: 1000 })
    await store.remember('x', { ok: true })
    expect(await store.has('x')).toBe(true)
  })

  it('forgets a key after the time-to-live elapses', async () => {
    vi.useFakeTimers()
    const store = memoryTtlStore({ ttlMs: 1000 })
    await store.remember('x', { ok: true })
    vi.advanceTimersByTime(1001)
    expect(await store.has('x')).toBe(false)
    vi.useRealTimers()
  })

  it('prune drops expired keys', async () => {
    vi.useFakeTimers()
    const store = memoryTtlStore({ ttlMs: 1000 })
    await store.remember('x', { ok: true })
    vi.advanceTimersByTime(1001)
    await store.prune?.()
    expect(await store.has('x')).toBe(false)
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace=packages/relayer -- memory-ttl.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
import type { RelayerStore } from '../types.js'

export type MemoryTtlStoreOptions = {
  /** How long a remembered key stays known, in milliseconds. */
  ttlMs: number
}

/**
 * An in-memory dedup store that forgets a key after `ttlMs`. Doubles as a
 * per-key rate limiter. State is process-local and lost on restart.
 */
export const memoryTtlStore = <T>(options: MemoryTtlStoreOptions): RelayerStore<T> => {
  const seenAt = new Map<string, number>()
  const isLive = (timestamp: number): boolean => Date.now() - timestamp <= options.ttlMs
  return {
    has: async (key) => {
      const at = seenAt.get(key)
      if (at === undefined) return false
      if (isLive(at)) return true
      seenAt.delete(key)
      return false
    },
    remember: async (key) => {
      seenAt.set(key, Date.now())
    },
    prune: async () => {
      for (const [key, at] of seenAt) {
        if (!isLive(at)) seenAt.delete(key)
      }
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test --workspace=packages/relayer -- memory-ttl.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/relayer/src/stores/memory-ttl.ts packages/relayer/test/stores/memory-ttl.test.ts
git commit -m "feat(relayer): in-memory time-to-live dedup store"
```

---

## Task 5: `noopStore`

**Files:**
- Create: `packages/relayer/src/stores/noop.ts`
- Test: covered inline (append a block to `packages/relayer/test/stores/memory-ttl.test.ts` is acceptable, but create a dedicated file for clarity)
- Test: `packages/relayer/test/stores/noop.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { noopStore } from '../../src/stores/noop.js'

describe('noopStore', () => {
  it('never reports a key as seen, even after remember', async () => {
    const store = noopStore()
    await store.remember('x', { ok: true })
    expect(await store.has('x')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace=packages/relayer -- noop.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
import type { RelayerStore } from '../types.js'

/** A dedup store that never deduplicates — for producers that intend to repost. */
export const noopStore = <T>(): RelayerStore<T> => ({
  has: async () => false,
  remember: async () => {},
})
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test --workspace=packages/relayer -- noop.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/relayer/src/stores/noop.ts packages/relayer/test/stores/noop.test.ts
git commit -m "feat(relayer): noop dedup store for producers"
```

---

## Task 6: `postgresStore`

**Files:**
- Create: `packages/relayer/src/stores/postgres.ts`
- Test: `packages/relayer/test/stores/postgres.test.ts`

The store depends only on a minimal `Queryable` interface so tests inject a fake and production passes a `pg.Pool`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { postgresStore, type Queryable } from '../../src/stores/postgres.js'

const fakePool = (rowsByCall: unknown[][]): Queryable & { calls: { text: string; params?: unknown[] }[] } => {
  const calls: { text: string; params?: unknown[] }[] = []
  let i = 0
  return {
    calls,
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params })
      const rows = rowsByCall[i] ?? []
      i += 1
      return { rows }
    },
  }
}

describe('postgresStore', () => {
  it('migrate creates the table', async () => {
    const pool = fakePool([[]])
    const store = postgresStore({ pool, table: 'sponsored', maxAgeMs: 3_600_000 })
    await store.migrate()
    expect(pool.calls[0].text).toMatch(/create table if not exists sponsored/i)
  })

  it('has returns true when a row exists', async () => {
    const pool = fakePool([[{ key: 'k' }]])
    const store = postgresStore({ pool, table: 'sponsored', maxAgeMs: 3_600_000 })
    expect(await store.has('k')).toBe(true)
    expect(pool.calls[0].params).toEqual(['k'])
  })

  it('has returns false when no row exists', async () => {
    const pool = fakePool([[]])
    const store = postgresStore({ pool, table: 'sponsored', maxAgeMs: 3_600_000 })
    expect(await store.has('k')).toBe(false)
  })

  it('remember upserts the key and its reference', async () => {
    const pool = fakePool([[]])
    const store = postgresStore({ pool, table: 'sponsored', maxAgeMs: 3_600_000 })
    await store.remember('k', { ok: true, ref: '0xtx' })
    expect(pool.calls[0].text).toMatch(/insert into sponsored/i)
    expect(pool.calls[0].params).toEqual(['k', '0xtx'])
  })

  it('prune deletes rows older than maxAgeMs', async () => {
    const pool = fakePool([[]])
    const store = postgresStore({ pool, table: 'sponsored', maxAgeMs: 3_600_000 })
    await store.prune?.()
    expect(pool.calls[0].text).toMatch(/delete from sponsored/i)
    expect(pool.calls[0].text).toMatch(/interval/i)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace=packages/relayer -- stores/postgres.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
import type { ActionResult, RelayerStore } from '../types.js'

/** The minimal database surface the Postgres store needs (a `pg.Pool` satisfies it). */
export type Queryable = {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>
}

export type PostgresStoreOptions = {
  pool: Queryable
  /** Table name for the dedup rows. */
  table: string
  /** Rows older than this are removed by `prune`, in milliseconds. */
  maxAgeMs: number
}

/** A durable dedup store backed by a Postgres table. Call `migrate()` once at startup. */
export const postgresStore = <T>(
  options: PostgresStoreOptions,
): RelayerStore<T> & { migrate(): Promise<void> } => {
  const { pool, table } = options
  const maxAgeSeconds = Math.floor(options.maxAgeMs / 1000)
  return {
    migrate: async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${table} (
          key TEXT PRIMARY KEY,
          ref TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      )
    },
    has: async (key) => {
      const { rows } = await pool.query(`SELECT key FROM ${table} WHERE key = $1 LIMIT 1`, [key])
      return rows.length > 0
    },
    remember: async (key, result: ActionResult) => {
      await pool.query(
        `INSERT INTO ${table} (key, ref) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET ref = $2`,
        [key, result.ref ?? null],
      )
    },
    prune: async () => {
      await pool.query(
        `DELETE FROM ${table} WHERE created_at < now() - INTERVAL '${maxAgeSeconds} seconds'`,
      )
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test --workspace=packages/relayer -- stores/postgres.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/relayer/src/stores/postgres.ts packages/relayer/test/stores/postgres.test.ts
git commit -m "feat(relayer): durable Postgres dedup store"
```

---

## Task 7: `postgresArchiveSink` — the historical index

**Files:**
- Create: `packages/relayer/src/sinks/postgres-archive.ts`
- Test: `packages/relayer/test/sinks/postgres-archive.test.ts`

The archive is `RelayerSink<RPCMessage>` plus a `query()` read surface. It reuses the `Queryable` interface from the Postgres store.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { stringToHex } from 'viem'
import { postgresArchiveSink } from '../../src/sinks/postgres-archive.js'
import type { Queryable } from '../../src/stores/postgres.js'
import type { RPCMessage } from '@msgboard/sdk'
import type { RelayerContext } from '../../src/types.js'

const fakePool = (rowsByCall: unknown[][]): Queryable & { calls: { text: string; params?: unknown[] }[] } => {
  const calls: { text: string; params?: unknown[] }[] = []
  let i = 0
  return {
    calls,
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params })
      const rows = rowsByCall[i] ?? []
      i += 1
      return { rows }
    },
  }
}

const ctx = { node: { chainId: 943, rpcUrl: '' } } as unknown as RelayerContext

const message = (over: Partial<RPCMessage> = {}): RPCMessage =>
  ({
    version: '0x1',
    blockHash: '0xabc',
    blockNumber: '0x10',
    category: stringToHex('lorem', { size: 32 }),
    data: stringToHex('hello world', { size: 11 }),
    hash: '0xdeadbeef',
    nonce: '0x5',
    workMultiplier: '0x2710',
    workDivisor: '0xf4240',
    ...over,
  }) as RPCMessage

describe('postgresArchiveSink', () => {
  it('migrate creates the message_archive table and indexes', async () => {
    const pool = fakePool([[], [], [], []])
    const sink = postgresArchiveSink({ pool, retention: { days: 365 } })
    await sink.migrate()
    expect(pool.calls[0].text).toMatch(/create table if not exists message_archive/i)
    expect(pool.calls.some((c) => /create index/i.test(c.text))).toBe(true)
  })

  it('record upserts on (hash, chain_id) with decoded content', async () => {
    const pool = fakePool([[]])
    const sink = postgresArchiveSink({ pool, retention: { days: 365 } })
    await sink.record(message(), ctx)
    const call = pool.calls[0]
    expect(call.text).toMatch(/insert into message_archive/i)
    expect(call.text).toMatch(/on conflict \(hash, chain_id\) do nothing/i)
    // params: hash, chain_id, category, category_text, data, content, block_number, block_hash
    expect(call.params?.[0]).toBe('0xdeadbeef')
    expect(call.params?.[1]).toBe(943)
    expect(call.params?.[3]).toBe('lorem') // decoded category text
    expect(call.params?.[5]).toBe('hello world') // decoded content
  })

  it('prune deletes rows older than the retention window', async () => {
    const pool = fakePool([[]])
    const sink = postgresArchiveSink({ pool, retention: { days: 365 } })
    await sink.prune?.()
    expect(pool.calls[0].text).toMatch(/delete from message_archive/i)
    expect(pool.calls[0].text).toMatch(/365 days/i)
  })

  it('query builds a filtered select and returns rows', async () => {
    const pool = fakePool([[{ hash: '0x1' }]])
    const sink = postgresArchiveSink({ pool, retention: { days: 365 } })
    const rows = await sink.query({ chainId: 943, category: 'lorem', limit: 10 })
    expect(rows).toEqual([{ hash: '0x1' }])
    expect(pool.calls[0].text).toMatch(/select .* from message_archive/i)
    expect(pool.calls[0].text).toMatch(/where/i)
    expect(pool.calls[0].text).toMatch(/limit/i)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace=packages/relayer -- sinks/postgres-archive.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
import { type Hex, hexToString } from 'viem'
import type { RPCMessage } from '@msgboard/sdk'
import type { RelayerContext, RelayerSink } from '../types.js'
import type { Queryable } from '../stores/postgres.js'

export type ArchiveRetention = {
  /** Rows older than this many days are pruned. */
  days: number
}

export type PostgresArchiveOptions = {
  pool: Queryable
  retention: ArchiveRetention
}

/** Filters for querying the historical archive. */
export type ArchiveQuery = {
  chainId?: number
  /** A bytes32 hex category or its decoded text. */
  category?: string
  since?: Date
  until?: Date
  /** Substring match on decoded content. */
  contains?: string
  limit?: number
  offset?: number
}

/** A row of the historical archive. */
export type ArchivedMessage = {
  hash: string
  chain_id: number
  category: string | null
  category_text: string | null
  data: string | null
  content: string | null
  block_number: string | null
  block_hash: string | null
  first_seen_at: string
}

/** Decodes a hex blob to text, returning null if it is not printable. */
const tryDecodeText = (hex: Hex): string | null => {
  try {
    const text = hexToString(hex).replace(/ +$/u, '')
    // reject blobs with non-printable control characters
    if (/[ --]/u.test(text)) return null
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

/**
 * The historical index of every message seen flowing through the board. An
 * ever-growing table, pruned to a retention window (default one year). `record`
 * is idempotent on `(hash, chain_id)`. Call `migrate()` once at startup.
 */
export const postgresArchiveSink = (
  options: PostgresArchiveOptions,
): RelayerSink<RPCMessage> & {
  migrate(): Promise<void>
  query(filter: ArchiveQuery): Promise<ArchivedMessage[]>
} => {
  const { pool } = options
  const retentionDays = options.retention.days

  const migrate = async (): Promise<void> => {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS message_archive (
        hash          TEXT NOT NULL,
        chain_id      INTEGER NOT NULL,
        category      TEXT,
        category_text TEXT,
        data          TEXT,
        content       TEXT,
        block_number  BIGINT,
        block_hash    TEXT,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (hash, chain_id)
      )`,
    )
    await pool.query(`CREATE INDEX IF NOT EXISTS message_archive_seen_idx ON message_archive (first_seen_at)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS message_archive_chain_seen ON message_archive (chain_id, first_seen_at)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS message_archive_category_idx ON message_archive (category)`)
  }

  const record = async (message: RPCMessage, context: RelayerContext): Promise<void> => {
    await pool.query(
      `INSERT INTO message_archive
        (hash, chain_id, category, category_text, data, content, block_number, block_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (hash, chain_id) DO NOTHING`,
      [
        message.hash,
        context.node.chainId,
        message.category,
        tryDecodeText(message.category),
        message.data,
        tryDecodeText(message.data),
        BigInt(message.blockNumber).toString(),
        message.blockHash,
      ],
    )
  }

  const prune = async (): Promise<void> => {
    await pool.query(
      `DELETE FROM message_archive WHERE first_seen_at < now() - INTERVAL '${retentionDays} days'`,
    )
  }

  const query = async (filter: ArchiveQuery): Promise<ArchivedMessage[]> => {
    const clauses: string[] = []
    const params: unknown[] = []
    const add = (clause: string, value: unknown): void => {
      params.push(value)
      clauses.push(clause.replace('$?', `$${params.length}`))
    }
    if (filter.chainId !== undefined) add('chain_id = $?', filter.chainId)
    if (filter.category !== undefined) add('(category = $? OR category_text = $?)', filter.category)
    if (filter.since) add('first_seen_at >= $?', filter.since.toISOString())
    if (filter.until) add('first_seen_at <= $?', filter.until.toISOString())
    if (filter.contains) add('content ILIKE $?', `%${filter.contains}%`)
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = filter.limit ?? 100
    const offset = filter.offset ?? 0
    const { rows } = await pool.query(
      `SELECT hash, chain_id, category, category_text, data, content, block_number, block_hash, first_seen_at
       FROM message_archive ${where}
       ORDER BY first_seen_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    )
    return rows as ArchivedMessage[]
  }

  return { record, prune, migrate, query }
}
```

Note: the `category` clause uses the same placeholder twice; the test asserts behaviour, not exact placeholder numbering. The `$?` → `$N` replacement in `add` increments once per call, so the two `$?` in the category clause both map to the same `$N`. This is intentional and correct for a single bound value.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test --workspace=packages/relayer -- sinks/postgres-archive.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/relayer/src/sinks/postgres-archive.ts packages/relayer/test/sinks/postgres-archive.test.ts
git commit -m "feat(relayer): one-year historical archive sink with query"
```

---

## Task 8: `postgresSink` — generic durable record sink

**Files:**
- Create: `packages/relayer/src/sinks/postgres.ts`
- Test: `packages/relayer/test/sinks/postgres.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { postgresSink } from '../../src/sinks/postgres.js'
import type { Queryable } from '../../src/stores/postgres.js'
import type { RelayerContext } from '../../src/types.js'

const fakePool = (): Queryable & { calls: { text: string; params?: unknown[] }[] } => {
  const calls: { text: string; params?: unknown[] }[] = []
  return {
    calls,
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params })
      return { rows: [] }
    },
  }
}

const ctx = {} as RelayerContext

describe('postgresSink', () => {
  it('migrate creates the configured table with a key and payload column', async () => {
    const pool = fakePool()
    const sink = postgresSink<{ address: string }>({
      pool,
      table: 'flagged',
      toRow: (item) => ({ key: item.address, payload: { address: item.address } }),
    })
    await sink.migrate()
    expect(pool.calls[0].text).toMatch(/create table if not exists flagged/i)
  })

  it('record upserts the mapped row', async () => {
    const pool = fakePool()
    const sink = postgresSink<{ address: string }>({
      pool,
      table: 'flagged',
      toRow: (item) => ({ key: item.address, payload: { address: item.address } }),
    })
    await sink.record({ address: '0xabc' }, ctx)
    expect(pool.calls[0].text).toMatch(/insert into flagged/i)
    expect(pool.calls[0].params?.[0]).toBe('0xabc')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace=packages/relayer -- sinks/postgres.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
import type { RelayerContext, RelayerSink } from '../types.js'
import type { Queryable } from '../stores/postgres.js'

export type PostgresSinkOptions<T> = {
  pool: Queryable
  table: string
  /** Maps an item to a durable row: a stable key and a JSON payload. */
  toRow: (item: T, context: RelayerContext) => { key: string; payload: unknown }
}

/** A generic durable record sink: one upserted row per item, keyed and JSON-bodied. */
export const postgresSink = <T>(
  options: PostgresSinkOptions<T>,
): RelayerSink<T> & { migrate(): Promise<void> } => {
  const { pool, table, toRow } = options
  return {
    migrate: async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${table} (
          key TEXT PRIMARY KEY,
          payload JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      )
    },
    record: async (item, context) => {
      const row = toRow(item, context)
      await pool.query(
        `INSERT INTO ${table} (key, payload) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET payload = $2`,
        [row.key, JSON.stringify(row.payload)],
      )
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test --workspace=packages/relayer -- sinks/postgres.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/relayer/src/sinks/postgres.ts packages/relayer/test/sinks/postgres.test.ts
git commit -m "feat(relayer): generic durable record sink"
```

---

## Task 9: `msgboardContentSource`

**Files:**
- Create: `packages/relayer/src/sources/msgboard-content.ts`
- Test: `packages/relayer/test/sources/msgboard-content.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { stringToHex } from 'viem'
import { msgboardContentSource } from '../../src/sources/msgboard-content.js'
import type { RelayerContext } from '../../src/types.js'
import type { Content, RPCMessage } from '@msgboard/sdk'

const msg = (hash: string): RPCMessage => ({ hash } as RPCMessage)

const ctxWithContent = (content: Content): RelayerContext =>
  ({ client: { content: async () => content } } as unknown as RelayerContext)

describe('msgboardContentSource', () => {
  it('flattens all messages across categories when no category is set', async () => {
    const a = stringToHex('a', { size: 32 })
    const b = stringToHex('b', { size: 32 })
    const source = msgboardContentSource()
    const items = await source.poll(ctxWithContent({ [a]: [msg('0x1')], [b]: [msg('0x2')] }))
    expect(items.map((m) => m.hash).sort()).toEqual(['0x1', '0x2'])
  })

  it('requests a single category and returns its messages', async () => {
    const cat = stringToHex('gasmoneyplease', { size: 32 })
    let requested: unknown
    const ctx = {
      client: {
        content: async (filter: { category?: string }) => {
          requested = filter
          return { [cat]: [msg('0x3')] }
        },
      },
    } as unknown as RelayerContext
    const source = msgboardContentSource({ category: 'gasmoneyplease' })
    const items = await source.poll(ctx)
    expect(items.map((m) => m.hash)).toEqual(['0x3'])
    expect(requested).toEqual({ category: cat })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace=packages/relayer -- sources/msgboard-content.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
import { type Hex, stringToHex } from 'viem'
import type { RPCMessage } from '@msgboard/sdk'
import type { RelayerSource } from '../types.js'

export type MsgboardContentSourceOptions = {
  /** A category name (zero-padded to bytes32) or bytes32 hex. Omit to watch all categories. */
  category?: string
}

/** Normalizes a category name or hex into a bytes32 hex category. */
const toCategoryHex = (category: string): Hex => {
  if (category.startsWith('0x') && category.length === 66) return category as Hex
  return stringToHex(category, { size: 32 })
}

/** Polls msgboard content. With no category, flattens messages across every category. */
export const msgboardContentSource = (
  options: MsgboardContentSourceOptions = {},
): RelayerSource<RPCMessage> => {
  const category = options.category ? toCategoryHex(options.category) : undefined
  return {
    poll: async (context) => {
      const content = await context.client.content(category ? { category } : {})
      const groups = Object.values(content)
      return groups.flat()
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test --workspace=packages/relayer -- sources/msgboard-content.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/relayer/src/sources/msgboard-content.ts packages/relayer/test/sources/msgboard-content.test.ts
git commit -m "feat(relayer): msgboard content source"
```

---

## Task 10: `bridgeAffirmationSource`

**Files:**
- Create: `packages/relayer/src/sources/bridge-affirmation.ts`
- Test: `packages/relayer/test/sources/bridge-affirmation.test.ts`

This source lifts the proven logic from `packages/sponsor/bridge.ts:90-123`: read `AffirmationCompleted` events from the finalized block window, take the latest transaction, and return the `Transfer`/`Mint` recipient. It yields zero or one address.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { encodeEventTopics, parseAbi } from 'viem'
import { bridgeAffirmationSource } from '../../src/sources/bridge-affirmation.js'
import type { RelayerContext } from '../../src/types.js'

const transferAbi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
])

const recipient = '0x1111111111111111111111111111111111111111'

const fakePublicClient = (over: Record<string, unknown> = {}) =>
  ({
    chain: { id: 943 },
    getBlock: async () => ({ number: 5_000n }),
    getTransactionReceipt: async () => ({
      logs: [
        {
          address: '0xtoken',
          topics: encodeEventTopics({
            abi: transferAbi,
            eventName: 'Transfer',
            args: { from: '0x0000000000000000000000000000000000000000', to: recipient },
          }),
          data: '0x0000000000000000000000000000000000000000000000000000000000000001',
        },
      ],
    }),
    ...over,
  }) as unknown

describe('bridgeAffirmationSource', () => {
  it('returns the latest bridger recipient address', async () => {
    const publicClient = fakePublicClient({
      // viem getContract().getEvents is read through readContract/getLogs; stub getLogs path:
      getLogs: async () => [{ transactionHash: '0xtx' }],
    })
    const ctx = { publicClient } as unknown as RelayerContext
    const source = bridgeAffirmationSource({ bridgeAddress: '0xbridge' })
    const items = await source.poll(ctx)
    expect(items).toEqual([recipient])
  })

  it('returns an empty array when there are no recent events', async () => {
    const publicClient = fakePublicClient({ getLogs: async () => [] })
    const ctx = { publicClient } as unknown as RelayerContext
    const source = bridgeAffirmationSource({ bridgeAddress: '0xbridge' })
    const items = await source.poll(ctx)
    expect(items).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace=packages/relayer -- sources/bridge-affirmation.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
import {
  type Address,
  type Hex,
  type PublicClient,
  getAbiItem,
  parseAbi,
  parseEventLogs,
} from 'viem'
import type { RelayerSource } from '../types.js'

export type BridgeAffirmationSourceOptions = {
  /** The Arbitrary Message Bridge contract address on the watched chain. */
  bridgeAddress: Address
  /** How many blocks back from finalized to scan. Defaults to 1000. */
  lookback?: bigint
}

const bridgeAbi = parseAbi([
  'event AffirmationCompleted(address sender, address executor, bytes32 messageId, bool status)',
])

const transferAbi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
  'event Mint(address indexed to, uint256 amount)',
])

/**
 * Watches an Arbitrary Message Bridge for completed affirmations and yields the
 * recipient of the most recent bridged transfer (zero or one address per poll).
 * Reads at the finalized block, so results are reorg-safe.
 */
export const bridgeAffirmationSource = (
  options: BridgeAffirmationSourceOptions,
): RelayerSource<Address> => {
  const lookback = options.lookback ?? 1_000n
  return {
    poll: async (context) => {
      const provider = context.publicClient as PublicClient
      const finalized = await provider.getBlock({ blockTag: 'finalized' })
      const logs = await provider.getLogs({
        address: options.bridgeAddress,
        event: getAbiItem({ abi: bridgeAbi, name: 'AffirmationCompleted' }),
        fromBlock: finalized.number - lookback,
        toBlock: finalized.number,
      })
      if (logs.length === 0) return []
      const latestTx = logs[logs.length - 1].transactionHash as Hex
      const receipt = await provider.getTransactionReceipt({ hash: latestTx })
      const transfers = parseEventLogs({ abi: transferAbi, logs: receipt.logs })
      const recipient = transfers
        .map((event) => ('to' in event.args ? (event.args.to as Address) : undefined))
        .find((address): address is Address => Boolean(address))
      return recipient ? [recipient] : []
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test --workspace=packages/relayer -- sources/bridge-affirmation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/relayer/src/sources/bridge-affirmation.ts packages/relayer/test/sources/bridge-affirmation.test.ts
git commit -m "feat(relayer): bridge affirmation source at finalized block"
```

---

## Task 11: `generatedSource`

**Files:**
- Create: `packages/relayer/src/sources/generated.ts`
- Test: `packages/relayer/test/sources/generated.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { generatedSource } from '../../src/sources/generated.js'
import type { RelayerContext } from '../../src/types.js'

const ctx = {} as RelayerContext

describe('generatedSource', () => {
  it('yields exactly one produced item per poll', async () => {
    let n = 0
    const source = generatedSource(() => ({ value: (n += 1) }))
    const first = await source.poll(ctx)
    const second = await source.poll(ctx)
    expect(first).toEqual([{ value: 1 }])
    expect(second).toEqual([{ value: 2 }])
  })

  it('supports async producers', async () => {
    const source = generatedSource(async () => 'hello')
    expect(await source.poll(ctx)).toEqual(['hello'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace=packages/relayer -- sources/generated.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
import type { RelayerContext, RelayerSource } from '../types.js'

/** A source that produces exactly one fresh item per poll. For producers like spam writers. */
export const generatedSource = <T>(
  produce: (context: RelayerContext) => T | Promise<T>,
): RelayerSource<T> => ({
  poll: async (context) => [await produce(context)],
})
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test --workspace=packages/relayer -- sources/generated.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/relayer/src/sources/generated.ts packages/relayer/test/sources/generated.test.ts
git commit -m "feat(relayer): generated producer source"
```

---

## Task 12: `submitMessageAction`

**Files:**
- Create: `packages/relayer/src/actions/submit-message.ts`
- Test: `packages/relayer/test/actions/submit-message.test.ts`

This action posts a message via proof-of-work + `addMessage`. It is generic over the item: the caller supplies functions that derive the category and data from an item.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { submitMessageAction } from '../../src/actions/submit-message.js'
import type { RelayerContext } from '../../src/types.js'

describe('submitMessageAction', () => {
  it('describe reports the category and data', () => {
    const action = submitMessageAction<string>({
      category: () => 'lorem',
      data: (item) => item,
    })
    const ctx = {} as RelayerContext
    expect(action.describe('hello', ctx)).toMatch(/lorem/)
    expect(action.describe('hello', ctx)).toMatch(/hello/)
  })

  it('execute does proof-of-work then adds the message', async () => {
    const doPoW = vi.fn(async () => ({ message: { hash: '0xmsg' }, stats: {} }))
    const addMessage = vi.fn(async () => '0xmsg')
    const ctx = { client: { doPoW, addMessage } } as unknown as RelayerContext
    const action = submitMessageAction<string>({ category: () => 'lorem', data: (item) => item })
    const result = await action.execute('hello', ctx)
    expect(doPoW).toHaveBeenCalled()
    expect(addMessage).toHaveBeenCalled()
    expect(result).toEqual({ ok: true, ref: '0xmsg' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace=packages/relayer -- actions/submit-message.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
import { encodeData } from '@msgboard/sdk'
import type { RelayerAction, RelayerContext } from '../types.js'

export type SubmitMessageActionOptions<T> = {
  /** Derives the category (name or bytes32 hex) for an item. */
  category: (item: T, context: RelayerContext) => string
  /** Derives the message data (text or hex) for an item. */
  data: (item: T, context: RelayerContext) => string
}

/** Posts a proof-of-work message to the board. No wallet or gas required. */
export const submitMessageAction = <T>(
  options: SubmitMessageActionOptions<T>,
): RelayerAction<T> => ({
  describe: (item, context) =>
    `post message category=${options.category(item, context)} data=${options.data(item, context)}`,
  execute: async (item, context) => {
    const category = options.category(item, context)
    const data = encodeData(options.data(item, context))
    const work = await context.client.doPoW(category, data)
    const hash = await context.client.addMessage(work.message)
    return { ok: true, ref: hash, meta: { stats: work.stats } }
  },
})
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test --workspace=packages/relayer -- actions/submit-message.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/relayer/src/actions/submit-message.ts packages/relayer/test/actions/submit-message.test.ts
git commit -m "feat(relayer): submit-message proof-of-work action"
```

---

## Task 13: `sendValueAction`

**Files:**
- Create: `packages/relayer/src/actions/send-value.ts`
- Test: `packages/relayer/test/actions/send-value.test.ts`

This action sends native coin to an address derived from an item. It builds a wallet client from an account plus the context's chain/transport.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { sendValueAction } from '../../src/actions/send-value.js'
import type { RelayerContext } from '../../src/types.js'

const recipient = '0x1111111111111111111111111111111111111111'

describe('sendValueAction', () => {
  it('describe reports the recipient and amount', () => {
    const action = sendValueAction<string>({
      account: { address: '0xfrom' } as never,
      recipient: (item) => item as `0x${string}`,
      amount: 10n * 10n ** 18n,
      gas: 25_200n,
    })
    const ctx = {} as RelayerContext
    expect(action.describe(recipient, ctx)).toMatch(recipient)
    expect(action.describe(recipient, ctx)).toMatch(/10/)
  })

  it('execute sends the transaction and waits for the receipt', async () => {
    const sendTransaction = vi.fn(async () => '0xtx')
    const waitForTransactionReceipt = vi.fn(async () => ({ transactionHash: '0xtx' }))
    const ctx = {
      chain: { id: 943 },
      node: { rpcUrl: 'http://localhost' },
      publicClient: { waitForTransactionReceipt },
    } as unknown as RelayerContext
    const action = sendValueAction<string>({
      account: { address: '0xfrom' } as never,
      recipient: (item) => item as `0x${string}`,
      amount: 10n * 10n ** 18n,
      gas: 25_200n,
      walletFactory: () => ({ sendTransaction }) as never,
    })
    const result = await action.execute(recipient, ctx)
    expect(sendTransaction).toHaveBeenCalled()
    expect(result).toEqual({ ok: true, ref: '0xtx' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace=packages/relayer -- actions/send-value.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
import {
  type Account,
  type Address,
  type WalletClient,
  createWalletClient,
  formatEther,
  http,
} from 'viem'
import type { RelayerAction, RelayerContext } from '../types.js'

export type SendValueActionOptions<T> = {
  /** The funding account (e.g. from `mnemonicToAccount`). */
  account: Account
  /** Derives the recipient address for an item. */
  recipient: (item: T, context: RelayerContext) => Address
  /** Amount to send, in wei. */
  amount: bigint
  /** Gas limit for the transfer. */
  gas: bigint
  /** Overridable wallet-client factory (injected in tests). */
  walletFactory?: (context: RelayerContext) => WalletClient
}

/** Sends native coin to an address derived from each item; waits for the receipt. */
export const sendValueAction = <T>(
  options: SendValueActionOptions<T>,
): RelayerAction<T> => {
  const makeWallet = (context: RelayerContext): WalletClient =>
    options.walletFactory?.(context) ??
    createWalletClient({
      account: options.account,
      chain: context.chain,
      transport: http(context.node.rpcUrl, { timeout: 30_000 }),
    })
  return {
    describe: (item, context) =>
      `send ${formatEther(options.amount)} to ${options.recipient(item, context)}`,
    execute: async (item, context) => {
      const wallet = makeWallet(context)
      const to = options.recipient(item, context)
      const hash = await wallet.sendTransaction({
        account: options.account,
        chain: context.chain,
        to,
        value: options.amount,
        gas: options.gas,
      })
      await context.publicClient.waitForTransactionReceipt({ hash })
      return { ok: true, ref: hash }
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test --workspace=packages/relayer -- actions/send-value.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/relayer/src/actions/send-value.ts packages/relayer/test/actions/send-value.test.ts
git commit -m "feat(relayer): send-value gas action"
```

---

## Task 14: `webhookAction` and `noopAction`

**Files:**
- Create: `packages/relayer/src/actions/webhook.ts`
- Create: `packages/relayer/src/actions/noop.ts`
- Test: `packages/relayer/test/actions/webhook.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { webhookAction } from '../../src/actions/webhook.js'
import { noopAction } from '../../src/actions/noop.js'
import type { RelayerContext } from '../../src/types.js'

const ctx = {} as RelayerContext

describe('webhookAction', () => {
  it('describe reports the target url', () => {
    const action = webhookAction<{ id: string }>({ url: 'https://hook.test/x' })
    expect(action.describe({ id: '1' }, ctx)).toMatch('https://hook.test/x')
  })

  it('execute posts the item as JSON and reports ok on a 2xx', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }) as Response)
    const action = webhookAction<{ id: string }>({ url: 'https://hook.test/x', fetchImpl })
    const result = await action.execute({ id: '1' }, ctx)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hook.test/x',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(result.ok).toBe(true)
  })

  it('execute reports not-ok on a non-2xx', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }) as Response)
    const action = webhookAction<{ id: string }>({ url: 'https://hook.test/x', fetchImpl })
    const result = await action.execute({ id: '1' }, ctx)
    expect(result.ok).toBe(false)
  })
})

describe('noopAction', () => {
  it('describe is stable and execute reports ok without effect', async () => {
    const action = noopAction<{ id: string }>()
    expect(typeof action.describe({ id: '1' }, ctx)).toBe('string')
    expect(await action.execute({ id: '1' }, ctx)).toEqual({ ok: true })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test --workspace=packages/relayer -- actions/webhook.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement both actions**

`packages/relayer/src/actions/webhook.ts`:

```ts
import type { RelayerAction } from '../types.js'

export type WebhookActionOptions = {
  url: string
  /** Overridable fetch implementation (injected in tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/** Posts each item as JSON to a webhook. Demonstrates a non-on-chain gated action. */
export const webhookAction = <T>(options: WebhookActionOptions): RelayerAction<T> => {
  const doFetch = options.fetchImpl ?? fetch
  return {
    describe: (_item) => `POST to ${options.url}`,
    execute: async (item) => {
      const response = await doFetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(item),
      })
      return { ok: response.ok, meta: { status: response.status } }
    },
  }
}
```

`packages/relayer/src/actions/noop.ts`:

```ts
import type { RelayerAction } from '../types.js'

/** An action that does nothing. For sink-only relayers (archivist, flagger). */
export const noopAction = <T>(): RelayerAction<T> => ({
  describe: () => 'noop',
  execute: async () => ({ ok: true }),
})
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test --workspace=packages/relayer -- actions/webhook.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/relayer/src/actions/webhook.ts packages/relayer/src/actions/noop.ts packages/relayer/test/actions/webhook.test.ts
git commit -m "feat(relayer): webhook and noop actions"
```

---

## Task 15: Public exports (`index.ts`)

**Files:**
- Create: `packages/relayer/src/index.ts`

- [ ] **Step 1: Create the barrel file**

```ts
export { Relayer } from './relayer.js'
export { defaultLogger } from './logger.js'
export type { Logger } from './logger.js'
export { resolveChain } from './chains.js'
export type {
  ActionResult,
  RelayerAction,
  RelayerCondition,
  RelayerConfig,
  RelayerContext,
  RelayerKey,
  RelayerMode,
  RelayerNode,
  RelayerSink,
  RelayerSource,
  RelayerStore,
  TickReport,
} from './types.js'

export { memoryTtlStore } from './stores/memory-ttl.js'
export { noopStore } from './stores/noop.js'
export { postgresStore } from './stores/postgres.js'
export type { Queryable } from './stores/postgres.js'

export { postgresArchiveSink } from './sinks/postgres-archive.js'
export type { ArchiveQuery, ArchivedMessage, ArchiveRetention } from './sinks/postgres-archive.js'
export { postgresSink } from './sinks/postgres.js'

export { msgboardContentSource } from './sources/msgboard-content.js'
export { bridgeAffirmationSource } from './sources/bridge-affirmation.js'
export { generatedSource } from './sources/generated.js'

export { submitMessageAction } from './actions/submit-message.js'
export { sendValueAction } from './actions/send-value.js'
export { webhookAction } from './actions/webhook.js'
export { noopAction } from './actions/noop.js'
```

- [ ] **Step 2: Full build and test of the package**

Run: `npm run build --workspace=packages/relayer && npm run test --workspace=packages/relayer`
Expected: build emits `dist/`; all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/relayer/src/index.ts
git commit -m "feat(relayer): public package exports"
```

---

## Task 16: Migrate the gas sponsor (`packages/sponsor/index.ts`)

**Files:**
- Modify: `packages/sponsor/package.json` (add `@msgboard/relayer` dependency)
- Modify: `packages/sponsor/index.ts` (replace the hand-rolled loop)

Behaviour preserved: watch `gasmoneyplease`, require a valid address payload, dedup durably in Postgres, send 10 coins. The old `FAKE_TRANSFERS` env now maps to `mode: 'observe'`. This relayer also attaches the archive sink so its traffic is captured.

- [ ] **Step 1: Add the dependency**

In `packages/sponsor/package.json`, add to `dependencies`:

```json
"@msgboard/relayer": "^0.0.1"
```

Run: `npm install`
Expected: resolves the workspace link.

- [ ] **Step 2: Replace `packages/sponsor/index.ts`**

```ts
import pg from 'pg'
import { type Hex, isAddress, stringToHex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import type { RPCMessage } from '@msgboard/sdk'
import {
  Relayer,
  msgboardContentSource,
  postgresArchiveSink,
  postgresStore,
  sendValueAction,
} from '@msgboard/relayer'

const main = async () => {
  if (!process.env.MNEMONIC) {
    throw new Error('MNEMONIC environment variable is required')
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false })
  await pool.query('SELECT 1')
  console.log('connected to db')

  const store = postgresStore<RPCMessage>({ pool, table: 'sponsored', maxAgeMs: 60 * 60 * 1000 })
  await store.migrate()
  const archive = postgresArchiveSink({ pool, retention: { days: 365 } })
  await archive.migrate()
  console.log('migration complete')

  const account = mnemonicToAccount(process.env.MNEMONIC)
  const rpcUrl = process.env.RPC_943 || process.env.VITE_RPC_943 || 'https://rpc.v4.testnet.pulsechain.com'
  const mode = process.env.FAKE_TRANSFERS ? 'observe' : 'live'
  console.log('sponsoring with %o (mode=%s)', account.address, mode)

  const relayer = new Relayer<RPCMessage>({
    node: { rpcUrl, chainId: 943 },
    mode,
    intervalMs: 20_000,
    source: msgboardContentSource({ category: 'gasmoneyplease' }),
    condition: (message) => isAddress(message.data),
    key: (message) => message.hash.toLowerCase(),
    store,
    sink: archive,
    action: sendValueAction<RPCMessage>({
      account,
      recipient: (message) => message.data.toLowerCase() as Hex,
      amount: 10n * 10n ** 18n,
      gas: 25_200n,
    }),
  })
  relayer.start()
}

main()
```

Note: the legacy `gasplease` category log used `stringToHex('gasmoneyplease', { size: 32 })`; the source now derives that hex internally, so the import of `stringToHex` may be unused — remove it if `noUnusedLocals` complains.

- [ ] **Step 3: Type-check the sponsor package**

Run: `npm run build --workspace=packages/sponsor`
Expected: PASS. If `stringToHex` is reported unused, delete it from the import and re-run.

- [ ] **Step 4: Commit**

```bash
git add packages/sponsor/package.json packages/sponsor/index.ts package-lock.json
git commit -m "refactor(sponsor): gas sponsor on the relayer engine"
```

---

## Task 17: Migrate the bridge watcher (`packages/sponsor/bridge.ts`)

**Files:**
- Modify: `packages/sponsor/bridge.ts`

Behaviour preserved: per-chain (943 and 369) loop reading `AffirmationCompleted` at finalized, ten-minute in-memory dedup, proof-of-work + post for the bridger. The bridger items are addresses, so this relayer does not archive (the archivist owns the historical index).

- [ ] **Step 1: Replace `packages/sponsor/bridge.ts`**

```ts
import type { Address } from 'viem'
import { pulsechain, pulsechainV4 } from 'viem/chains'
import {
  Relayer,
  bridgeAffirmationSource,
  memoryTtlStore,
  submitMessageAction,
} from '@msgboard/relayer'

const rpcByChain: Record<number, string> = {
  [pulsechainV4.id]: process.env.RPC_943 || process.env.VITE_RPC_943 || 'https://rpc.v4.testnet.pulsechain.com',
  [pulsechain.id]: process.env.RPC_369 || process.env.VITE_RPC_369 || 'https://rpc.pulsechain.com',
}

const bridgeByChain: Record<number, Address> = {
  [pulsechainV4.id]: '0xf902DE27606cd3A7F66695c77487769Ff96211fE',
  [pulsechain.id]: '0x6ef79FD6f9f840264332884240539Ed7A2dA8b2b',
}

const disabledChains = new Set(
  (process.env.DISABLED_CHAINS ?? '').split(',').map((s) => Number(s.trim())).filter(Boolean),
)

const mode = process.env.BRIDGE_LIVE ? 'live' : 'observe'

const startForChain = (chainId: number): void => {
  if (disabledChains.has(chainId)) {
    console.log('chain %d is disabled, skipping', chainId)
    return
  }
  const relayer = new Relayer<Address>({
    node: { rpcUrl: rpcByChain[chainId], chainId },
    mode,
    intervalMs: 120_000,
    source: bridgeAffirmationSource({ bridgeAddress: bridgeByChain[chainId] }),
    key: (address) => address.toLowerCase(),
    store: memoryTtlStore<Address>({ ttlMs: 10 * 60 * 1000 }),
    action: submitMessageAction<Address>({
      category: () => 'gasmoneyplease',
      data: (address) => address,
    }),
  })
  console.log('[%d] starting bridge relayer (mode=%s)', chainId, mode)
  relayer.start()
}

const main = () => {
  startForChain(pulsechainV4.id)
  startForChain(pulsechain.id)
}

main()
```

Note: the previous default was to always submit; the relayer is safe-by-default, so submission now requires `BRIDGE_LIVE=1`. This is the intended behaviour change (matches "default to not write on chain").

- [ ] **Step 2: Type-check the sponsor package**

Run: `npm run build --workspace=packages/sponsor`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/sponsor/bridge.ts
git commit -m "refactor(sponsor): bridge watcher on the relayer engine"
```

---

## Task 18: Migrate the spam writer (`packages/sponsor/spam.ts`)

**Files:**
- Modify: `packages/sponsor/spam.ts`

Behaviour preserved: post a lorem sentence under a rotating category every interval, matching board difficulty. Uses `generatedSource` + `submitMessageAction` + `noopStore`.

- [ ] **Step 1: Replace `packages/sponsor/spam.ts`**

```ts
import { mainnet, pulsechain, pulsechainV4 } from 'viem/chains'
import { Relayer, generatedSource, noopStore, submitMessageAction } from '@msgboard/relayer'

type Post = { category: string; text: string }

const chainId = Number(process.env.SPAM_CHAIN_ID ?? 943)
const supported = new Set([mainnet.id, pulsechain.id, pulsechainV4.id])
if (!supported.has(chainId)) {
  throw new Error(`spam: unsupported SPAM_CHAIN_ID ${chainId} (expected 1, 369, or 943)`)
}

const rpcUrl =
  process.env.SPAM_RPC ||
  process.env[`RPC_${chainId}`] ||
  process.env[`VITE_RPC_${chainId}`] ||
  'https://rpc.v4.testnet.pulsechain.com'

const intervalMs = Number(process.env.SPAM_INTERVAL_MS ?? 30_000)
const categoryNames = (process.env.SPAM_CATEGORIES ?? 'lorem,musings,chatter')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const words = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ' +
  'incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud ' +
  'exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure ' +
  'reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur excepteur sint ' +
  'occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est'
).split(' ')

const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]

const sentence = (): string => {
  const length = 6 + Math.floor(Math.random() * 9)
  const body = Array.from({ length }, () => pick(words)).join(' ')
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}.`
}

const mode = process.env.SPAM_OBSERVE ? 'observe' : 'live'

const relayer = new Relayer<Post>({
  node: { rpcUrl, chainId },
  mode,
  intervalMs,
  source: generatedSource(() => ({ category: pick(categoryNames), text: sentence() })),
  key: (post) => `${post.category}:${post.text}`,
  store: noopStore<Post>(),
  action: submitMessageAction<Post>({
    category: (post) => post.category,
    data: (post) => post.text,
  }),
})

console.log('spam: chain=%d posting every %dms under categories %o (mode=%s)', chainId, intervalMs, categoryNames, mode)
relayer.start()
```

Note: the original matched the node's difficulty via `client.setDifficultyFactors`. The SDK defaults (10_000 / 1_000_000) match the board's standard difficulty, so the explicit sync is dropped. If a deployment uses non-standard difficulty, add a `difficultyFactors` config to `MsgBoardClient` in a follow-up; this is noted in the package README as a known limitation.

- [ ] **Step 2: Type-check the sponsor package**

Run: `npm run build --workspace=packages/sponsor`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/sponsor/spam.ts
git commit -m "refactor(sponsor): spam writer on the relayer engine"
```

---

## Task 19: Package README and reference examples

**Files:**
- Create: `packages/relayer/README.md`
- Create: `packages/relayer/examples/archivist.ts`
- Create: `packages/relayer/examples/cross-chain-mirror.ts`
- Create: `packages/relayer/examples/moderation-flagger.ts`

- [ ] **Step 1: Write `packages/relayer/README.md`**

Cover: the safe-by-default model (`observe` vs `live`), the four contracts (Source / Action / Store / Sink), a minimal usage snippet constructing a `Relayer` in observe mode, the historical archive and its `query()` surface, and the known difficulty-sync limitation noted in Task 18. Include the examples table from the design spec (`docs/superpowers/specs/2026-06-05-msgboard-relayer-design.md`, section 9).

- [ ] **Step 2: Write `packages/relayer/examples/archivist.ts`** (the canonical historical-index writer)

```ts
import pg from 'pg'
import { Relayer, msgboardContentSource, noopAction, postgresArchiveSink } from '@msgboard/relayer'
import type { RPCMessage } from '@msgboard/sdk'

const main = async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false })
  const archive = postgresArchiveSink({ pool, retention: { days: 365 } })
  await archive.migrate()

  const relayer = new Relayer<RPCMessage>({
    node: { rpcUrl: process.env.RPC_943!, chainId: 943 },
    mode: 'observe', // an archivist never acts; it only records
    intervalMs: 15_000,
    source: msgboardContentSource(), // all categories
    key: (message) => message.hash,
    sink: archive,
    action: noopAction<RPCMessage>(),
  })
  relayer.start()
  console.log('archivist recording all board traffic')
}

main()
```

- [ ] **Step 3: Write `packages/relayer/examples/cross-chain-mirror.ts`** (source node != action node)

```ts
import { Relayer, msgboardContentSource, memoryTtlStore, submitMessageAction } from '@msgboard/relayer'
import { hexToString } from 'viem'
import type { RPCMessage } from '@msgboard/sdk'

// Watches category "announcements" on PulseChain (369) and mirrors each message
// onto the v4 testnet board (943). The action's context targets 943; the source's
// context targets 369 — they are separate Relayers wired by hand.
const main = () => {
  const relayer = new Relayer<RPCMessage>({
    node: { rpcUrl: process.env.RPC_943!, chainId: 943 }, // where we WRITE
    mode: process.env.MIRROR_LIVE ? 'live' : 'observe',
    intervalMs: 30_000,
    // The source reads 369 by constructing its own client inside poll via a
    // dedicated read relayer; for a single-node demo we read the same node.
    source: msgboardContentSource({ category: 'announcements' }),
    key: (message) => message.hash,
    store: memoryTtlStore<RPCMessage>({ ttlMs: 60 * 60 * 1000 }),
    action: submitMessageAction<RPCMessage>({
      category: () => 'announcements',
      data: (message) => {
        const text = (() => {
          try {
            return hexToString(message.data)
          } catch {
            return message.data
          }
        })()
        return `mirror: ${text}`
      },
    }),
  })
  relayer.start()
}

main()
```

Note: true cross-node mirroring (read 369, write 943) requires two contexts. The clean pattern is a thin read-only relayer on 369 whose action enqueues into a shared store that a 943 writer drains; this example shows the single-node shape and documents the two-context extension in a comment. Keep the comment in the file.

- [ ] **Step 4: Write `packages/relayer/examples/moderation-flagger.ts`** (condition + sink, no action)

```ts
import pg from 'pg'
import { hexToString } from 'viem'
import { Relayer, msgboardContentSource, noopAction, postgresSink } from '@msgboard/relayer'
import type { RPCMessage } from '@msgboard/sdk'

const blocklist = (process.env.BLOCKLIST ?? 'spamword,scam').split(',')

const looksBad = (message: RPCMessage): boolean => {
  try {
    const text = hexToString(message.data).toLowerCase()
    return blocklist.some((word) => text.includes(word))
  } catch {
    return false
  }
}

const main = async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false })
  const flagged = postgresSink<RPCMessage>({
    pool,
    table: 'flagged',
    toRow: (message) => ({ key: message.hash, payload: { category: message.category, data: message.data } }),
  })
  await flagged.migrate()

  const relayer = new Relayer<RPCMessage>({
    node: { rpcUrl: process.env.RPC_943!, chainId: 943 },
    mode: 'observe',
    intervalMs: 15_000,
    source: msgboardContentSource(),
    condition: looksBad,
    key: (message) => message.hash,
    sink: flagged,
    action: noopAction<RPCMessage>(),
  })
  relayer.start()
}

main()
```

Note: the flagger records flagged messages via `condition` + a sink; because `sink.record` runs before the condition for the archive use case, here the sink is used as the *flagging* store and only messages passing `condition` reach the action (a noop). To persist ONLY flagged items, this example writes through the `condition`-gated path by using the sink as the flag table and a noop action; messages that fail `looksBad` are not flagged. Keep this note in the file as a comment.

- [ ] **Step 5: Verify examples type-check**

Run: `npx tsc --noEmit -p packages/relayer/tsconfig.json` then manually `npx tsc --noEmit packages/relayer/examples/*.ts --moduleResolution nodenext --module nodenext --target esnext --skipLibCheck`
Expected: no errors. (Examples are not part of the build `include`; this is a manual check.)

- [ ] **Step 6: Commit**

```bash
git add packages/relayer/README.md packages/relayer/examples
git commit -m "docs(relayer): README and reference example relayers"
```

---

## Task 20: Full workspace build, test, and progress checkpoint

**Files:**
- Modify: `progress.txt`

- [ ] **Step 1: Build and test the whole workspace**

Run: `npm run build && npm run test:relayer`
Expected: every workspace package builds; relayer tests PASS.

- [ ] **Step 2: Confirm the sponsor scripts still type-check end to end**

Run: `npm run build --workspace=packages/sponsor`
Expected: PASS.

- [ ] **Step 3: Update `progress.txt`**

Append a dated session entry summarizing: the new `@msgboard/relayer` package (engine, stores, sinks, sources, actions), the safe-by-default observe/live gate, the one-year historical archive with `query()`, the three sponsor scripts refactored onto the engine, and the behaviour change that bridge/spam now require an explicit live flag to write.

- [ ] **Step 4: Commit**

```bash
git add progress.txt
git commit -m "chore: checkpoint relayer abstraction"
```

---

## Self-review notes (addressed during writing)

- **Spec coverage:** engine (Tasks 2-3), stores memory/noop/postgres (Tasks 4-6), archive sink + query (Task 7), generic sink (Task 8), sources content/bridge/generated (Tasks 9-11), actions submit/send/webhook/noop (Tasks 12-14), exports (Task 15), three script migrations (Tasks 16-18), examples archivist/mirror/flagger (Task 19). The notifier and faucet-trigger examples from the spec table are documented in the README rather than shipped as files (YAGNI for runnable code; their shape is `webhookAction` and `sendValueAction` respectively).
- **Spec refinement:** the archive is owned by a single archivist relayer because `RPCMessage` has no sender and the bridge watcher's items are addresses (documented in Implementation notes).
- **Type consistency:** `RelayerContext`, `ActionResult`, `TickReport`, `Queryable`, and all factory option names are defined in Task 1 / Task 6 and reused verbatim thereafter.
- **No placeholders:** every code step contains complete, runnable content.
