import { serve } from '@hono/node-server'
import { app } from './server.js'
import { enabledChains } from './submit.js'
import { POW_BITS } from './pow.js'

const port = Number(process.env.PORT ?? 8787)
const host = '0.0.0.0'

console.log('\nmsgboard cosign-relay — gasless Safe v1.4.1 deploy relay')
console.log('─────────────────────────────────────────')
console.log(`chains enabled: ${enabledChains().join(', ') || '(none — set RELAY_KEY_943 / RELAY_KEY_369)'}`)
console.log(`PoW difficulty: ${POW_BITS} bits`)
console.log(`listening:      http://${host}:${port}  (health: /health, config: /config)`)

const server = serve({ fetch: app.fetch, port, hostname: host })

const shutdown = (signal: string) => {
  console.log(`\n${signal} — shutting down…`)
  server.close(() => process.exit(0))
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
