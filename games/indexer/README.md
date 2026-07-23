# @msgboard/games-indexer

A Ponder indexer for the **CoinFlip** + **Raffle** game contracts on PulseChain testnet v4 (943), so
`games.msgboard.xyz` can read rounds from a database/GraphQL instead of scraping `eth_getLogs` from
every browser (which was flooding the RPC into 429s).

Separate from the entropy indexer (`packages/indexer` / the box's `random-indexer-943`), which indexes
the `Random`/`Reader`/`Consumer` beacon — this one indexes only the game contracts.

## What it indexes

Every CoinFlip + Raffle log lands in a single `game_event` table (`ponder.schema.ts`):
`{ id, game, name, args (json), blockNumber, blockTimestamp, txHash, logIndex }`. The handlers
(`src/index.ts`) store events verbatim; bigints in `args` are serialised to strings (JSON/GraphQL has
no bigint). The frontend queries these and runs its **existing** `deriveCoinFlipLobby` /
`deriveRaffleRounds` over them, so the round logic stays in one place.

## Run / deploy

Needs Postgres and an RPC whose node serves 943 (the valve fleet):

```sh
DATABASE_URL=postgres://…           # the indexer's own DB/schema
PONDER_RPC_URL_943=https://one.valve.city/rpc/<key>/evm/943
pnpm install
pnpm codegen        # generates ponder-env.d.ts + the ponder:* virtual modules
pnpm start          # backfill from startBlock (24,645,214) + serve GraphQL
```

Ponder serves GraphQL at `/` (and `/graphql`). Deploy as a long-running service on the box with a
Caddy block that sets CORS for `https://games.msgboard.xyz`, e.g. `games-943.msgboard.xyz`.

## Frontend integration (next step)

Add the GraphQL URL to `examples/games/web/src/config.ts` (`gamesIndexer?: string`) and have
`useChainData` query `gameEvent` (grouped by `game`/`name`, ordered by `blockNumber`) instead of
`getLogs`, re-hydrating the bigint fields and feeding the same derive functions. Fall back to the
(efficient) `getLogs` path when no indexer URL is configured.
