import { db } from 'ponder:api'
import schema from 'ponder:schema'
import { and, eq, graphql } from 'ponder'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { isAddress } from 'viem'
import { ownerSafesResponse } from '../safes'

// Ponder 0.16 no longer auto-serves the API. GraphQL is exposed at `/` and `/graphql` (mirrors
// games-indexer). The REST route below is the CONTRACT the cosign app uses: it mirrors the Safe
// Transaction Service endpoint `GET /api/v1/owners/{address}/safes/` so the app can keep ONE client
// for mainnet (real Safe service) and 369/943 (this indexer).
const app = new Hono()

app.use('/', graphql({ db, schema }))
app.use('/graphql', graphql({ db, schema }))

// GET /owners/:address/safes[?chainId=369]  →  { "safes": ["0x…", …] }  (checksummed, deduped)
// Same response shape as the Safe Tx Service. `chainId` is optional; omit it to search every indexed
// chain (369+943), pass it to scope to one. An invalid address is a 400, mirroring the upstream.
async function ownerSafesHandler(c: Context) {
  const address = c.req.param('address')
  if (!address || !isAddress(address)) return c.json({ error: 'invalid address' }, 400)

  const chainIdParam = c.req.query('chainId')
  const chainId = chainIdParam === undefined ? undefined : Number(chainIdParam)
  if (chainId !== undefined && !Number.isInteger(chainId)) {
    return c.json({ error: 'invalid chainId' }, 400)
  }

  // hex bytea equality is case-insensitive, so the lowercased address matches regardless of checksum.
  const owner = address.toLowerCase() as `0x${string}`
  const where =
    chainId === undefined
      ? eq(schema.safeOwner.owner, owner)
      : and(eq(schema.safeOwner.owner, owner), eq(schema.safeOwner.chainId, chainId))

  const rows = await db.select({ safe: schema.safeOwner.safe }).from(schema.safeOwner).where(where)
  return c.json(ownerSafesResponse(rows))
}

// Serve both with and without the trailing slash (the Safe Tx Service uses a trailing slash).
app.get('/owners/:address/safes', ownerSafesHandler)
app.get('/owners/:address/safes/', ownerSafesHandler)

// NOTE: do NOT register a `/health` route — Ponder 0.16 reserves `/health` (and `/ready`) for its own
// liveness/readiness endpoints and refuses to build if the app defines it (BuildError: "API route
// '/health' is reserved for internal use"). The reserved `/health` is what the deploy smoke-tests.

export default app
