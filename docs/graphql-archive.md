# GraphQL historical archive

A read-only GraphQL API over the board's historical messages, served by Hasura at
**`https://archive.msgboard.xyz/v1/graphql`**.

The board itself is ephemeral (it keeps only ~120 blocks of messages), so history is captured by a
dedicated indexer and stored in Postgres; Hasura exposes that table as GraphQL.

## Architecture

```
board nodes (1/369/943) ──content──▶ indexer (msgboard-indexer) ──▶ Postgres: message_archive
                                                                              ▲
client ─GraphQL─▶ Cloudflare (archive.msgboard.xyz) ─▶ Caddy ─▶ Hasura ───────┘  [anonymous, read-only]
```

- **Write side** — `packages/indexer` runs one relayer per chain, watching every category and
  recording messages into `message_archive` (`postgresArchiveSink`, backed by `@msgboard/history`).
- **Read side** — Hasura auto-generates GraphQL over `message_archive`. The unauthenticated
  `anonymous` role gets `SELECT`-only on that one table (max 1000 rows per query, aggregations on).
- **Edge** — Caddy proxies only `/v1/graphql` and `/healthz` on `archive.msgboard.xyz`. The Hasura
  admin API, metadata, raw SQL, and console are not exposed publicly; reach them via an SSH tunnel to
  `127.0.0.1:8081` on the box. The **admin secret is the authentication boundary**, not the loopback
  binding or the tunnel — those are defense-in-depth. Anyone who can reach the admin endpoints still
  needs the secret.

## Schema

The `message_archive` table is exposed as the `message_archive` GraphQL type:

| Field | Type | Notes |
|---|---|---|
| `hash` | String | message hash |
| `chain_id` | Int | 1, 369, or 943 |
| `category` | String | bytes32 category hex |
| `category_text` | String | decoded category, or null if not printable |
| `data` | String | raw message data (hex) |
| `data_text` | String | the decoded message data, or null if not printable |
| `block_number` | bigint | block the message was rooted to |
| `block_hash` | String | |
| `first_seen_at` | timestamptz | when the indexer first recorded it |

## Example queries

Recent messages on PulseChain v4 (943) mentioning "lorem":

```graphql
query RecentLorem {
  message_archive(
    where: { chain_id: { _eq: 943 }, data_text: { _ilike: "%lorem%" } }
    order_by: { first_seen_at: desc }
    limit: 20
  ) {
    hash
    chain_id
    category_text
    data_text
    block_number
    first_seen_at
  }
}
```

Count messages per chain (aggregation):

```graphql
query CountByChain {
  message_archive_aggregate {
    aggregate { count }
  }
}
```

Over HTTP:

```sh
curl https://archive.msgboard.xyz/v1/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ message_archive(limit: 5, order_by: {first_seen_at: desc}) { hash chain_id data_text first_seen_at } }"}'
```

## Deploying it (human-gated steps)

Everything below the application code lives in the gitignored `deploy/` tree. To bring the archive
online:

1. **DNS** — in Cloudflare, add an **orange-clouded** record `archive.msgboard.xyz` → the origin box
   IP (see `deploy/ansible/inventory.ini`), with SSL/TLS mode **Full (Strict)**. The existing
   `*.msgboard.xyz` Cloudflare Origin Certificate already covers this subdomain — no new cert.

2. **Vault** — add a strong `vault_hasura_admin_secret` to the encrypted vault:
   ```sh
   cd deploy/ansible && ansible-vault edit group_vars/vault.yml
   # set: vault_hasura_admin_secret: "<strong secret>"
   ```

3. **Deploy** — run the playbook (it adds the `indexer` and `hasura` services, applies the Hasura
   metadata, and probes the endpoint):
   ```sh
   cd deploy/ansible
   ansible-playbook site.yml -e ansible_host=<box-ip> \
     --vault-password-file <(op read op://valve/msgboard_vault/password)
   ```
   The metadata step is idempotent (track + anonymous permission accept "already applied"), so reruns
   are safe.

4. **Admin access (optional)** — the Hasura console is disabled in production and the admin API binds
   to loopback only. To use the console or run admin operations, tunnel in:
   ```sh
   ssh -L 8081:127.0.0.1:8081 root@<box-ip>
   # then run the Hasura CLI/console against http://127.0.0.1:8081 with the admin secret
   ```

## Notes

- The indexer reuses the same server-side `RPC_1` / `RPC_369` / `RPC_943` as the spam/bridge writers
  (rendered from the vault). A chain with no RPC set is skipped.
- `INDEXER_CHAINS` (default `1,369,943`), `INDEXER_INTERVAL_MS`, and `RETENTION_DAYS` are tunable via
  the environment / compose.
- The archive shares the existing `msgboard-postgres` database; Hasura also stores its own metadata
  there (in the `hdb_catalog` schema).
- **The Hasura admin secret is mandatory.** An empty secret disables Hasura's role enforcement, which
  would give every request full admin access (all tables, mutations, raw SQL) — so the compose file
  fails fast (`HASURA_ADMIN_SECRET` uses `:?`) and `docker compose up` refuses to start until a real
  secret is set. The read-only `anonymous` role is only enforced because the admin secret is present.
