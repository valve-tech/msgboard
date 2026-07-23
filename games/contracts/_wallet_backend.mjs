// Local headless-wallet backend for the Playwright run-through. The page's injected window.ethereum
// proxies to this: /account (address+chainId), /rpc (read passthrough), /send (sign+broadcast, legacy gas).
import { createServer } from 'node:http'
import { createWalletClient, createPublicClient, http } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { pulsechain } from 'viem/chains'

const RPC = 'https://rpc.pulsechain.com'
const CHAIN_ID = 369
const acct = mnemonicToAccount(process.env.MNEMONIC)
const wc = createWalletClient({ account: acct, chain: pulsechain, transport: http(RPC) })
const pc = createPublicClient({ chain: pulsechain, transport: http(RPC) })
console.error('wallet backend: account', acct.address, 'chain', CHAIN_ID)

const cors = (res) => { res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS'); res.setHeader('access-control-allow-headers', 'content-type') }
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : {})) })

createServer(async (req, res) => {
  cors(res)
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
  try {
    if (req.url === '/account') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ address: acct.address, chainId: CHAIN_ID })) }
    if (req.url === '/rpc') {
      const { method, params } = await body(req)
      const out = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] }) })
      const j = await out.json()
      res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(j))
    }
    if (req.url === '/send') {
      const tx = (await body(req)).tx || {}
      const gasPrice = (await pc.getGasPrice()) * 2n
      const hash = await wc.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n, gas: tx.gas ? BigInt(tx.gas) : undefined, gasPrice, type: 'legacy' })
      console.error('sent tx', hash)
      res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ hash }))
    }
    res.writeHead(404); res.end('not found')
  } catch (e) { console.error('backend err', e.shortMessage || e.message); res.writeHead(500); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: e.shortMessage || e.message })) }
}).listen(8799, () => console.error('wallet backend on http://localhost:8799'))
