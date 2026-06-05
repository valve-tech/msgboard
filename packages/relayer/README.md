# @msgboard/relayer

A controllable, safe-by-default pool-watcher engine for the msgboard board. Runs a heartbeat: poll a **Source**, record every item to an always-on **Sink**, filter by a **Condition**, dedup via a **Store**, then gate the **Action** based on mode.

## Safe by default

The engine has two modes:

- **`observe`** (default): polls, records to the sink, and logs what it *would* do. No outbound side effect. A relayer constructed without an explicit `mode` never writes on chain.
- **`live`**: executes the action when all conditions are met. Use `BRIDGE_LIVE=1`, `SPAM_OBSERVE=1` etc. to flip the mode from environment variables — never hardcode `live`.

## The four contracts

| Contract | Role | Retention |
|---|---|---|
| `RelayerSource<T>` | Reads the current batch of candidates from the watched pool | — |
| `RelayerAction<T>` | Describes (observe) or executes (live) the outbound effect | — |
| `RelayerStore<T>` | Action-level dedup: "have I already acted on this?" | Short (minutes–hours) |
| `RelayerSink<T>` | Unconditional history/observability recording | Long (months–years) |

Sink and Store are intentionally separate: the sink runs in **both** modes; the store only advances in live mode after a successful execute.

## Minimal usage

```ts
import { Relayer, msgboardContentSource, noopAction } from '@msgboard/relayer'

const relayer = new Relayer({
  node: { rpcUrl: 'https://rpc.v4.testnet.pulsechain.com', chainId: 943 },
  // mode defaults to 'observe' — no on-chain writes
  source: msgboardContentSource({ category: 'myapp' }),
  key: (msg) => msg.hash,
  action: noopAction(),
})

relayer.start()
// later: await relayer.stop()
// or:    const report = await relayer.runOnce()
```

## Historical archive

`postgresArchiveSink` records every message the relayer sees to a `message_archive` table with a default 1-year retention window. Run a dedicated **archivist** relayer (see `examples/archivist.ts`) to populate the archive from all board traffic, then query it:

```ts
const archive = postgresArchiveSink({ pool, retention: { days: 365 } })
await archive.migrate()

const recent = await archive.query({ chainId: 943, category: 'lorem', limit: 20 })
```

`query()` filters by `chainId`, `category` (hex or decoded text), `since`/`until`, `contains` (substring match on decoded content), `limit`, and `offset`.

## Example relayers

| Relayer | source | store | sink | action (live only) | demonstrates |
|---|---|---|---|---|---|
| Gas sponsor (`index.ts`) | content `gasmoneyplease` + address check | postgres | archive | `sendValueAction` 10 coins | durable dedup, value transfer |
| Bridge watcher (`bridge.ts`) | `bridgeAffirmationSource` (per chain) | memory-ttl | — | `submitMessageAction` | finalized event source, multi-node |
| Spam writer (`spam.ts`) | `generatedSource(sentence)` | noop | — | `submitMessageAction` | producer source, noop dedup |
| Archivist | all content | — | `postgresArchiveSink` 1yr | `noopAction` | sink-only; records in observe mode |
| Cross-chain mirror | content on 369 | memory-ttl | — | `submitMessageAction` on 943 | source node ≠ action node |
| Moderation flagger | all content + blocklist predicate | — | `postgresSink('flagged')` | `noopAction` | condition + sink, no action |

See `examples/` for runnable code for the archivist, mirror, and flagger.

## Known limitations

- **Difficulty sync**: `submitMessageAction` uses the `MsgBoardClient` default difficulty factors (10 000 / 1 000 000). If a board deployment uses non-standard difficulty, pass `difficultyFactors` when constructing your own `MsgBoardClient` and supply it via a custom action rather than `submitMessageAction`.
- **Reorg handling**: sources read at the current head by default. The `bridgeAffirmationSource` reads at the finalized block, so it is reorg-safe. Other sources are best-effort; for strict reorg safety, build a checkpointed source using the `RelayerSource` contract.
- **Multi-node fan-out**: construct one `Relayer` per node and call `start()` on each — no special machinery needed.
