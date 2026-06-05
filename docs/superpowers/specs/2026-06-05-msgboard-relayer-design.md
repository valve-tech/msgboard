# MsgBoard Relayer — Design Spec

Date: 2026-06-05
Status: Approved design, pending spec review
Package: `@msgboard/relayer` (new public package)

## 1. Summary

A **relayer** here is a *pool watcher that performs operations once conditions are
met*. This spec abstracts the pattern that already appears three times in
`packages/sponsor/` (gas sponsor, bridge watcher, spam writer), plus richer
versions recovered from sibling repositories, into one small controllable engine
with a safe-by-default posture and pluggable parts.

The engine is exported as a controllable `Relayer` class (`start()` / `stop()` /
`runOnce()`). It is **safe by default**: in `observe` mode it watches the board,
records everything it sees to a historical archive, and logs what it *would* do —
but performs no outbound side effect. Only in `live` mode does the gated action
fire (on-chain submit, value transfer, external call).

## 2. Goals and non-goals

### Goals
- One reusable loop engine, decoupled from any specific source or action.
- Safe by default: no on-chain or external side effect unless explicitly `live`.
- Configurable target node (which msgboard node to watch) and mode per relayer.
- First-class msgboard sources and actions in the package.
- A durable, queryable **historical index** of every message seen, with a
  retention window (default one year).
- All three existing `packages/sponsor/` scripts refactored onto the engine.
- Fully unit-testable via `runOnce()` against fakes.

### Non-goals (deliberately deferred — YAGNI for the current msgboard cases)
- Nonce windows, replace-by-fee repricing, multi-attempt transaction state
  machines (present in `gibsfinance/validator`, not needed here).
- Deep reorganization rewind / crash-recovery tables.
- A distributed work queue or horizontal scaling story.

These are left reachable through the `Source` / `Store` extension points without
changing the engine.

## 3. Recovered prior art (informing the design)

- **`packages/sponsor/` (this repo)** — three concrete instances of the pattern:
  - `index.ts`: polls msgboard content under category `gasmoneyplease`, dedupes
    via a Postgres `sponsored` table, sends 10 native coins to new valid-address
    messages.
  - `bridge.ts`: per-chain loop polling an Arbitrary Message Bridge contract's
    `AffirmationCompleted` event at the finalized block, dedupes via an in-memory
    time-to-live map, does proof-of-work and posts a message for the bridger.
  - `spam.ts`: interval writer posting lorem messages (no source, no dedup).
- **`gibsfinance/validator` (executor)** — the most sophisticated example: a
  `PendingMessageSource` interface, a `FinalizedBlockWaiter` heartbeat, reorg
  detection, database-backed dedup, nonce windows, repricing, startup recovery,
  `dryRun()` before broadcast, `AbortSignal` shutdown. Source of the structural
  ideas (source/heartbeat/execute/reconcile separation, dry-run gate); too heavy
  to lift wholesale.
- **`gibsfinance/message` (this board's ancestor)** — `collectDataForChain()`
  loop, `delayedRetry()` / `continuousRetry()` combinators, per-network block
  ratchet, reorg rewind.
- **`pimlico/alto`** — adaptive poll interval, overlap mutex, status monitor.
- **`valve-tech/trace` monitor** — alert-matcher, cooldown map, `isProcessing`
  overlap guard.
- **`3commascapital/mempool-resolve`** — minimal poll loop with added/removed
  delta tracking.

Common skeleton across all of them: **heartbeat → read source → filter by
condition → dedupe → act (or not) → isolate errors → repeat**, with optional
multi-node fan-out.

## 4. Architecture

A thin `Relayer<T>` (no inheritance, internals composed from pure functions)
drives four small contracts. The write-gate lives in the engine — in exactly one
place — so no adapter can accidentally produce a side effect.

### 4.1 Contracts

```ts
/** Reads the current batch of candidate items from the watched pool. */
interface RelayerSource<T> {
  poll(context: RelayerContext): Promise<readonly T[]>
}

/** A side-effecting operation, split so observe mode can describe without doing. */
interface RelayerAction<T> {
  /** Pure description of the intended effect; used for observe-mode logging. */
  describe(item: T, context: RelayerContext): string
  /** The real outbound effect; only ever called in live mode. */
  execute(item: T, context: RelayerContext): Promise<ActionResult>
}

/** Action-level idempotency: "did I already act on this?" Short retention. */
interface RelayerStore<T> {
  has(key: string): Promise<boolean>
  remember(key: string, result: ActionResult): Promise<void>
  prune?(): Promise<void>
}

/** Unconditional recording for history/observability. Long retention. */
interface RelayerSink<T> {
  record(item: T, context: RelayerContext): Promise<void>
  prune?(): Promise<void>
}

type RelayerKey<T> = (item: T) => string
type RelayerCondition<T> = (item: T, context: RelayerContext) => boolean | Promise<boolean>
```

`Store` and `Sink` are intentionally separate: dedup is short-lived and keyed on
"have I acted", while the sink is the ever-growing historical index keyed on the
full message. A relayer may have either, both, or neither.

### 4.2 Configuration

```ts
interface RelayerConfig<T> {
  /** Which msgboard node this relayer watches. */
  node: { rpcUrl: string; chainId: number }
  /** Safety switch. 'observe' (default) performs NO outbound side effect. */
  mode?: 'observe' | 'live'
  /** Poll cadence. */
  intervalMs?: number
  source: RelayerSource<T>
  action: RelayerAction<T>
  key: RelayerKey<T>
  /** Action-level dedup. Default: in-memory time-to-live store. */
  store?: RelayerStore<T>
  /** Historical recording. Runs in BOTH observe and live modes. */
  sink?: RelayerSink<T>
  condition?: RelayerCondition<T>
  logger?: Logger
}
```

`mode` is a self-documenting union rather than a bare boolean. Default is
`'observe'` — a relayer constructed with no `mode` never writes on chain.

### 4.3 The controllable engine

```ts
class Relayer<T> {
  constructor(config: RelayerConfig<T>)
  start(): void              // idempotent; begins the loop
  stop(): Promise<void>      // aborts and awaits the in-flight tick
  runOnce(): Promise<TickReport>  // a single tick; for tests and one-shots
  get mode(): 'observe' | 'live'
}
```

### 4.4 Tick pipeline

For each tick (wrapped in `try/catch` so one failure never kills the loop):

1. `items = source.poll(context)`
2. For each item: **`sink?.record(item)`** — unconditional, runs in observe mode
   too. Idempotent via the sink's primary key.
3. `condition?(item)` — skip if false.
4. `store?.has(key(item))` — skip if already acted.
5. **Gate:**
   - `observe`: log `action.describe(item)` (the "would-do"). No effect.
   - `live`: `result = await action.execute(item)`, then
     `store?.remember(key(item), result)`.
6. Periodically (not every tick): `sink?.prune()` and `store?.prune()`.
7. Sleep `intervalMs`; repeat until `stop()`.

Multi-node fan-out is simply constructing one `Relayer` per node and calling
`start()` on each — no special machinery.

## 5. Stores (`src/stores/`)

- `memoryTtlStore({ ttlMs })` — default; the bridge watcher's ten-minute window;
  also doubles as a per-key rate limiter.
- `postgresStore({ pool, table, maxAgeMs })` — the existing `sponsored` table
  pattern with periodic cleanup; durable across restarts.
- `noopStore()` — never dedupes; for producers (spam) that intend to repost.

## 6. Sinks (`src/sinks/`)

- `postgresArchiveSink({ pool, retention })` — the **historical index**. An
  ever-growing `message_archive` table, default retention one year, pruned
  periodically.

  ```sql
  CREATE TABLE IF NOT EXISTS message_archive (
    hash          TEXT NOT NULL,
    chain_id      INTEGER NOT NULL,
    category      TEXT,
    category_text TEXT,
    sender        TEXT,
    data          TEXT,
    content       TEXT,
    block_number  BIGINT,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (hash, chain_id)
  );
  CREATE INDEX IF NOT EXISTS message_archive_seen_idx     ON message_archive (first_seen_at);
  CREATE INDEX IF NOT EXISTS message_archive_chain_seen   ON message_archive (chain_id, first_seen_at);
  CREATE INDEX IF NOT EXISTS message_archive_category_idx ON message_archive (category);
  -- prune: DELETE FROM message_archive WHERE first_seen_at < now() - $retention
  ```

  `record()` upserts on `(hash, chain_id)` so re-seeing a message is a no-op.

- `postgresSink({ pool, table })` — a generic durable record sink (used by the
  moderation flagger to write to a `flagged` table).

### 6.1 Archive query surface

The archive is exported as a small read API so it is a useful module, not only a
write sink:

```ts
interface ArchiveQuery {
  chainId?: number
  category?: string     // bytes32 hex or decoded text
  sender?: string
  since?: Date
  until?: Date
  contains?: string     // substring match on decoded content
  limit?: number        // default 100
  offset?: number
}
archive.query(q: ArchiveQuery): Promise<ArchivedMessage[]>
```

The exact `ArchivedMessage` field set is confirmed against the SDK content shape
during implementation (the SDK exposes message hash and data today; sender and
block may require an additional read and are nullable in the schema).

## 7. Sources (`src/sources/`)

- `msgboardContentSource({ category? })` — polls `client.content({ category })`;
  with no category, watches all content (used by the archivist and flagger).
- `bridgeAffirmationSource({ bridgeAddress })` — reads `AffirmationCompleted` at
  the finalized block (owns its finalized-block read; no engine reorg logic).
- `generatedSource(produce)` — yields a freshly produced item each tick (the
  lorem producer for spam).

## 8. Actions (`src/actions/`)

- `sendValueAction({ wallet, amount, gas })` — gas sponsor; sends native coin and
  waits for the receipt. `describe` reports recipient and amount.
- `submitMessageAction({ category })` — proof-of-work then `addMessage`.
  `describe` reports the category and content that would be posted.
- `webhookAction({ url })` — HTTP POST; demonstrates that the gated action need
  not be on-chain. Confirms `mode` gates *any* outbound effect, not only chain
  writes.
- `noopAction()` — does nothing; for sink-only relayers (archivist, flagger).

## 9. Example relayers (compositions)

Each is a config over the engine. The first three replace the existing scripts;
the rest are reference examples shipped as documented recipes.

| Relayer | source | store | sink | action (live only) | demonstrates |
|---|---|---|---|---|---|
| Gas sponsor (`index.ts`) | content `gasmoneyplease` + address check | postgres | archive | `sendValueAction` 10 coins | durable dedup, value transfer |
| Bridge watcher (`bridge.ts`) | `bridgeAffirmationSource` (per chain) | memory-ttl | archive | `submitMessageAction` | finalized event source, multi-node fan-out |
| Spam writer (`spam.ts`) | `generatedSource(sentence)` | noop | archive | `submitMessageAction` | producer source, noop dedup |
| Archivist | all content | — | `postgresArchiveSink(1yr)` | `noopAction` | sink-only; records in observe mode |
| Cross-chain mirror | content on 369 | memory-ttl | archive | `submitMessageAction` on 943 | source node != action node |
| Notifier / webhook | content `alerts` | memory-ttl | archive | `webhookAction` | off-chain gated action |
| Faucet trigger | content `faucetplease` + address check | memory-ttl as rate limit | archive | faucet / `sendValueAction` | store time-to-live as rate limiter |
| Moderation flagger | all content + spam/blocklist predicate | — | `postgresSink('flagged')` | `noopAction` | condition + sink, no action |

## 10. Migration of the three sponsor scripts

Each script in `packages/sponsor/` collapses to: build a `RelayerConfig`, then
`new Relayer(config).start()`. Behaviour is preserved:

- `index.ts`: same Postgres dedup, same 10-coin transfer, now with `mode` honored
  (the old `FAKE_TRANSFERS` env maps to `mode: 'observe'`).
- `bridge.ts`: two `Relayer` instances (chains 943 and 369), same finalized event
  read, same ten-minute memory dedup.
- `spam.ts`: a `generatedSource` plus `submitMessageAction`, `noopStore`.

All three additionally gain the archive sink, so the historical index is
populated from existing traffic with no extra process.

## 11. Package layout

```
packages/relayer/
  package.json            # @msgboard/relayer; deps @msgboard/sdk, viem; pg optional peer
  src/
    index.ts              # public exports
    relayer.ts            # Relayer class, contracts, RelayerContext, types
    logger.ts             # Logger interface + default console logger
    stores/ { memory-ttl.ts, postgres.ts, noop.ts }
    sinks/  { postgres-archive.ts, postgres.ts }
    sources/{ msgboard-content.ts, bridge-affirmation.ts, generated.ts }
    actions/{ send-value.ts, submit-message.ts, webhook.ts, noop.ts }
  test/
    relayer.test.ts       # runOnce: observe vs live, dedup, error isolation, sink always-on
    stores/*.test.ts
    sinks/postgres-archive.test.ts  # record upsert + prune by retention + query
  README.md
```

`pg` is an optional peer dependency — only the Postgres store and sinks need it;
the in-memory store and the engine have no database dependency.

## 12. Testing

- Engine via `runOnce()` against fakes:
  - observe mode never calls `action.execute`; logs the `describe`.
  - live mode calls `execute` exactly once per fresh item.
  - `store.has` true skips the action.
  - `sink.record` runs in BOTH modes (the always-on history guarantee).
  - a throw inside `execute` is isolated and does not stop the loop.
  - `store.remember` fires only after a successful live `execute`.
- Stores: memory time-to-live expiry; Postgres dedup upsert and cleanup.
- Archive sink: upsert idempotency, prune by retention, and `query` filters.

Tests encode intent (the safety default, the always-on history) rather than
snapshotting current output.

## 13. Future extension points

- A reorg-aware / checkpointed `Source` (lift `FinalizedBlockWaiter` and the
  finalized-hash checkpoint from `gibsfinance/validator`).
- A nonce-window / repricing `Action` wrapper for high-throughput live relayers.
- Additional sinks (metrics aggregation, message-queue fan-out).

None of these require changes to the engine.
