# @msgboard/history

A durable historical archive for the msgboard board. The board itself is **ephemeral** — it retains
only roughly the last 120 blocks of messages — so anything that needs durable history has to record
messages as they flow by. This package is the storage core for that: a Postgres-backed archive plus a
read-only HTTP query API.

```sh
npm i @msgboard/history
```

`pg` is an optional peer dependency — bring your own `Pool` (or any `{ query(text, params) }`).

## What's in the box

- **`createArchive({ pool, retention })`** — the storage core: `migrate()`, `record(message, chainId)`,
  `prune()`, and `query(filter)` over a `message_archive` table.
- **`archiveServer({ archive, port, host, token })`** — a read-only HTTP API over `query`.

The same `createArchive` backs `@msgboard/relayer`'s `postgresArchiveSink`, which adapts it to the
relayer's sink interface so an **archivist** relayer can populate the archive from live board traffic.

## Recording history

Run an archivist relayer (see `@msgboard/relayer` and `packages/examples/src/archivist.ts`) to write
every message into the archive, or record directly:

```ts
import pg from 'pg'
import { createArchive } from '@msgboard/history'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const archive = createArchive({ pool, retention: { days: 365 } })
await archive.migrate() // once at startup

await archive.record(message, 943) // message: RPCMessage, 943: chainId
```

`record` is idempotent on `(hash, chain_id)`. The archive grows forever until `prune()` deletes rows
older than the retention window.

## Querying history

```ts
const recent = await archive.query({
  chainId: 943,
  category: 'lorem', // bytes32 hex or its decoded text
  contains: 'hello', // substring match on the decoded data text
  since: new Date('2026-01-01'),
  limit: 20,
})
```

`limit` is clamped to at most 1000; results come back newest-first. `since`/`until` filter on
`first_seen_at`.

## Serving history over HTTP

```ts
import { createArchive, archiveServer } from '@msgboard/history'

const archive = createArchive({ pool, retention: { days: 365 } })
await archive.migrate()
const server = archiveServer({ archive, port: 4040 }) // loopback by default
```

- `GET /health` → `{ ok: true }`
- `GET /messages?chainId=943&category=lorem&contains=hello&since=2026-01-01&limit=20&offset=0` →
  `{ messages: [...] }`

```sh
curl 'http://localhost:4040/messages?chainId=943&category=lorem&limit=20'
```

### Security

The server binds to `127.0.0.1` by default. To expose it on a public interface, set `host` **and** a
`token` — a non-loopback bind without a token throws at startup. When `token` is set, `/messages`
requires `Authorization: Bearer <token>` (`/health` stays open). Slow connections are bounded by 10 s
header/request timeouts. `limit`/`offset` are coerced to bounded integers before they reach SQL.

## A full example

`packages/examples/src/history-server.ts` wires the whole flow end to end: an archivist relayer writes
live board traffic into Postgres while `archiveServer` serves queries over it.
