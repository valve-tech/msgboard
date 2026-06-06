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
| `RPC_<chainId>` | — | msgboard-serving RPC per chain (`RPC_1`, `RPC_369`, `RPC_943`) |
| `INDEXER_INTERVAL_MS` | `20000` | poll cadence per chain |
| `RETENTION_DAYS` | `365` | prune archive rows older than this |

A chain listed in `INDEXER_CHAINS` with no `RPC_<chainId>` is skipped with a warning. Rows are keyed
`(hash, chain_id)`, so the same hash on different chains is stored separately and re-runs are idempotent.
