import { db } from 'ponder:api'
import schema from 'ponder:schema'
import { graphql } from 'ponder'
import { Hono } from 'hono'

// Ponder 0.16 no longer auto-serves the API — the GraphQL endpoint must be declared here. The frontend
// (useChainData.fetchViaIndexer) POSTs GraphQL against games-943.msgboard.xyz; serve at both `/` and
// `/graphql` so either base URL works.
const app = new Hono()

app.use('/', graphql({ db, schema }))
app.use('/graphql', graphql({ db, schema }))

export default app
