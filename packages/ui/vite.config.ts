import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { type PluginOption, type Connect, defineConfig } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** reads the full body from an incoming http request */
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })

/**
 * vite plugin that rejects requests with malformed urls before they
 * reach vite's built-in middleware (which calls decodeURIComponent
 * without a try/catch and crashes on invalid percent-encoding)
 */
const malformedUrlGuard = (): PluginOption => {
  const guard: Connect.NextHandleFunction = (req, res, next) => {
    try {
      decodeURIComponent(req.url ?? '/')
      next()
    } catch {
      res.statusCode = 400
      res.end('Bad Request')
    }
  }
  return {
    name: 'malformed-url-guard',
    configureServer(server) {
      server.middlewares.use(guard)
    },
    configurePreviewServer(server) {
      server.middlewares.use(guard)
    },
  }
}

/** allowed rpc url patterns — only pulsechain endpoints are proxied */
const ALLOWED_RPC_HOSTS = [
  'rpc.v4.testnet.pulsechain.com',
  'rpc.pulsechain.com',
  'rpc-pulsechain.g4mm4.io',
  // valve.city RPC gateway (the msgboard-enabled endpoint shipped by default);
  // matches one.valve.city and any *.valve.city subdomain
  'valve.city',
]

const isAllowedRpcTarget = (targetUrl: string): boolean => {
  try {
    const parsed = new URL(targetUrl)
    return ALLOWED_RPC_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))
  } catch {
    return false
  }
}

/**
 * Resolve a chain id to its full RPC url from the SERVER-SIDE runtime env (`RPC_1`/`RPC_369`/`RPC_943`,
 * the keyed valve endpoints supplied to this container via docker-compose). The client only ever asks
 * for `?chain=943` — it NEVER sees the key: this substitution happens here, in the preview server. If
 * the env var is unset (local dev / misconfig) we fall back to the public, rate-limited `vk_demo` key so
 * nothing breaks. This is precisely why `VITE_RPC_*` must NOT carry a keyed url — a build-time value is
 * inlined into the public bundle; the key must stay a runtime env var, resolved only here.
 */
const CHAIN_RPC_ENV: Record<string, string | undefined> = {
  '1': 'RPC_1',
  '369': 'RPC_369',
  '943': 'RPC_943',
}
const rpcForChain = (chainId: string): string | null => {
  const envName = CHAIN_RPC_ENV[chainId]
  if (!envName) return null // not an allowlisted chain — reject (no SSRF via arbitrary chain ids)
  return process.env[envName] ?? `https://one.valve.city/rpc/vk_demo/evm/${chainId}`
}

/**
 * vite plugin that adds a POST /api/rpc-proxy endpoint for forwarding
 * json-rpc requests to http endpoints that the browser cannot reach
 * directly from an https page (mixed content restriction)
 */
const rpcProxyPlugin = (): PluginOption => {
  const handleProxy = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return
    }
    const parsed = new URL(req.url ?? '/', 'http://localhost')
    // Preferred, key-safe mode: `?chain=943` → the server-side keyed url (the browser never sees a key).
    // Legacy mode: `?url=<full url>` (still host-allowlisted) for custom/explicit endpoints.
    const chainParam = parsed.searchParams.get('chain')
    let targetUrl: string | null
    if (chainParam !== null) {
      targetUrl = rpcForChain(chainParam)
      if (!targetUrl) {
        res.statusCode = 403
        res.end(JSON.stringify({ error: 'Unsupported chain' }))
        return
      }
    } else {
      targetUrl = parsed.searchParams.get('url')
    }
    if (!targetUrl) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: 'Missing chain or url query parameter' }))
      return
    }
    if (!isAllowedRpcTarget(targetUrl)) {
      res.statusCode = 403
      res.end(JSON.stringify({ error: 'Target URL is not an allowed RPC endpoint' }))
      return
    }
    try {
      const body = await readBody(req)
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      const data = await response.text()
      res.setHeader('Content-Type', 'application/json')
      res.end(data)
    } catch {
      res.statusCode = 502
      res.end(JSON.stringify({ error: 'Failed to proxy RPC request' }))
    }
  }
  const handler: Connect.NextHandleFunction = (req, res) => {
    void handleProxy(req, res)
  }
  return {
    name: 'rpc-proxy',
    configureServer(server) {
      server.middlewares.use('/api/rpc-proxy', handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/rpc-proxy', handler)
    },
  }
}

export default defineConfig({
  plugins: [malformedUrlGuard(), rpcProxyPlugin(), tailwindcss() as PluginOption, react()],
  base: './',
  resolve: {
    preserveSymlinks: true,
  },
  preview: {
    allowedHosts: true,
  },
  // Web Worker output must be ES modules so `new Worker(url, { type: 'module' })`
  // works and the PoW grind stays OFF the main thread.
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: ['./test/setup.tsx'],
    globals: true,
    // The heavy <App>/DocsPortal renders (markdown-it + shiki) take several seconds and
    // intermittently exceed vitest's 5s default under parallel-worker contention, flaking
    // ~5/81 tests. Raise both timeouts so the suite is reliably green at the committed
    // config (no per-run --testTimeout override needed). See Task-6 report.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
