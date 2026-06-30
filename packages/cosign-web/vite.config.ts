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

/** allowed rpc url patterns — only msgboard-enabled endpoints are proxied (mirrors packages/ui) */
const ALLOWED_RPC_HOSTS = [
  'rpc.v4.testnet.pulsechain.com',
  'rpc.pulsechain.com',
  'rpc-pulsechain.g4mm4.io',
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
 * Forwards POST /api/rpc-proxy?url=<rpc> to an http json-rpc endpoint the browser cannot
 * reach directly from an https page (mixed-content). Copied from packages/ui's proxy so a
 * plain-http board RPC still works in dev/preview.
 */
const rpcProxyPlugin = (): PluginOption => {
  const handleProxy = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return
    }
    const parsed = new URL(req.url ?? '/', 'http://localhost')
    const targetUrl = parsed.searchParams.get('url')
    if (!targetUrl) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: 'Missing url query parameter' }))
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
  plugins: [rpcProxyPlugin(), tailwindcss() as PluginOption, react()],
  base: './',
  resolve: {
    preserveSymlinks: true,
  },
  preview: {
    allowedHosts: true,
  },
  // Web Worker output must be ES modules so `new Worker(url, { type: 'module' })` works and
  // the PoW grind stays OFF the main thread (HARD RULE).
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
  },
})
