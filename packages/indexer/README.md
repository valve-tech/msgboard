# msgboard-indexer

A dedicated, multichain archivist process. It runs one relayer per configured chain, watches every
category on each board, and records what it sees into a shared Postgres `message_archive` table
(`@msgboard/relayer`'s `postgresArchiveSink`, backed by `@msgboard/history`). Because the board only
retains ~120 blocks, this is what turns the live boards into durable, queryable history.

It is intentionally a standalone process — not part of the sponsor scripts — so indexing can be run,
scaled, and restarted on its own. A GraphQL layer (Hasura) reads the resulting table; see
`deploy/` and `docs/graphql-archive.md`.

## Run

```sh
DATABASE_URL=postgres://user:pass@localhost:5432/msgboard \
RPC_369=https://one.valve.city/rpc/vk_demo/evm/369 \
RPC_943=https://one.valve.city/rpc/vk_demo/evm/943 \
  npm run indexer:start            # from the repo root
```

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — (required) | Postgres connection string |
| `INDEXER_CHAINS` | `1,369,943` | comma-separated chain ids to index |
| `RPC_<chainId>` | — | msgboard-serving RPC(s) per chain. **Comma-separated for several replicas** |
| `INDEXER_INTERVAL_MS` | `20000` | poll cadence per chain |
| `RETENTION_DAYS` | `365` | prune archive rows older than this |

A chain listed in `INDEXER_CHAINS` with no `RPC_<chainId>` is skipped with a warning. Rows are keyed
`(hash, chain_id)`, so the same hash on different chains is stored separately and re-runs are idempotent.

## Read every replica

`RPC_<chainId>` takes a comma-separated list, and each endpoint gets its own relayer. All of them
write to the same archive, which is idempotent on `(hash, chain_id)`, so the archive holds the
**union** of what the replicas saw.

This is not a nicety. Replicas do not always agree. On 2026-09-08 the two mainnet nodes held
completely disjoint boards — 33 messages against 0, not one hash in common — for weeks, because a
devp2p capability race left their link unable to carry board traffic. A gateway pins each API key to
one replica, so reading through a single URL had been recording one node's view and silently missing
everything posted to the other. The board keeps a message for only about twenty minutes, so anything
the archive misses is gone for good.

Point it at per-replica endpoints wherever they exist. One URL still works and behaves exactly as
before.

This indexer archives **off-chain board messages only**. It reads no contract. The on-chain indexers
are separate Ponder processes: `deploy/random-indexer` (the entropy beacon) and `games/indexer`
(the CoinFlip and Raffle contracts).

## Is it alive?

Every relayer writes one `indexer_heartbeat` row per tick. That table exists to separate two states
that used to look identical in the logs:

| What you see | What it means |
|---|---|
| `last_tick_at` older than a few minutes | the indexer is not running — alarm |
| `last_tick_at` fresh, `polled` = 0 | the indexer is fine; the board is empty |
| `last_message_at` days old | nobody is writing to that board — look at the writers, not at this |
| two rows for one chain, one with `polled` = 0 | the replicas are not gossiping — a board split |

Rows are keyed `(chain_id, source)` — one per endpoint — so a replica split shows up as two rows
for one chain that disagree.

```sql
SELECT chain_id, source, last_tick_at, last_message_at, polled, head_block FROM indexer_heartbeat;

-- the indexer is dead:
SELECT chain_id, source FROM indexer_heartbeat WHERE last_tick_at < now() - interval '5 minutes';

-- the replicas of a chain are not gossiping:
SELECT chain_id FROM indexer_heartbeat GROUP BY chain_id
 HAVING count(*) > 1 AND max(polled) > 0 AND min(polled) = 0;
```

`@msgboard/node-check`'s `checkConvergence` is the standalone version of that second query: it
compares replica boards by message hash and fails when they share too little.

Hasura already serves this database, so the alert is one GraphQL query.

Chain 1 stopped receiving messages on 2026-08-21 and nobody noticed for 17 days. The indexer was
working the whole time; its writers had broken on the proof-of-work cutover. The logs could not tell
anyone that, because a healthy quiet chain and a dead one both printed nothing.
