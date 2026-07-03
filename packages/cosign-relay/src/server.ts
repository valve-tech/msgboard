import { Hono } from 'hono'
import type { Context } from 'hono'
import { type Hex, isAddress, isAddressEqual } from 'viem'
import { SAFE_V141 } from './constants.js'
import { POW_BITS, verifyPow } from './pow.js'
import { createRateLimiter } from './ratelimit.js'
import { enabledChains, sponsorInfo, submitDeploy, type RelayChainId } from './submit.js'
import { assertPlainSafeSetup, decodeSafeSetup, recoverRequestSigner, requestDigest } from './validate.js'

const RATE_LIMIT_PER_DAY = Number(process.env.RATE_LIMIT_PER_DAY ?? 5)

/** The relay only ever sponsors 943/369. Anything else is rejected before it costs anything. */
const KNOWN_CHAIN_IDS: readonly RelayChainId[] = [943, 369]

type DeploySafeBody = {
  chainId?: unknown
  singleton?: unknown
  initializer?: unknown
  saltNonce?: unknown
  signature?: unknown
  powNonce?: unknown
}

/** Cheap shape validation before any decoding/crypto — malformed JSON never reaches the gates. */
function parseBody(body: DeploySafeBody):
  | { ok: true; value: { chainId: number; singleton: Hex; initializer: Hex; saltNonce: bigint; signature: Hex; powNonce: Hex } }
  | { ok: false; error: string } {
  const { chainId, singleton, initializer, saltNonce, signature, powNonce } = body
  if (typeof chainId !== 'number' || !Number.isInteger(chainId)) {
    return { ok: false, error: 'chainId must be an integer' }
  }
  if (typeof singleton !== 'string' || !isAddress(singleton)) {
    return { ok: false, error: 'singleton must be an address' }
  }
  if (typeof initializer !== 'string' || !initializer.startsWith('0x')) {
    return { ok: false, error: 'initializer must be 0x-prefixed calldata' }
  }
  if (typeof saltNonce !== 'string' && typeof saltNonce !== 'number') {
    return { ok: false, error: 'saltNonce must be a string or number' }
  }
  if (typeof signature !== 'string' || !signature.startsWith('0x')) {
    return { ok: false, error: 'signature must be 0x-prefixed' }
  }
  if (typeof powNonce !== 'string' || !powNonce.startsWith('0x')) {
    return { ok: false, error: 'powNonce must be 0x-prefixed' }
  }
  let saltNonceBig: bigint
  try {
    saltNonceBig = BigInt(saltNonce)
  } catch {
    return { ok: false, error: 'saltNonce is not a valid integer' }
  }
  return {
    ok: true,
    value: {
      chainId,
      singleton: singleton as Hex,
      initializer: initializer as Hex,
      saltNonce: saltNonceBig,
      signature: signature as Hex,
      powNonce: powNonce as Hex,
    },
  }
}

function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return 'unknown'
}

export function createApp({ rateLimiter = createRateLimiter({ perDay: RATE_LIMIT_PER_DAY }) } = {}) {
  const app = new Hono()

  app.get('/health', (c) => c.json({ ok: true }))
  app.get('/config', async (c) => {
    // sponsorInfo() already never throws, but this endpoint must never fail on an RPC hiccup —
    // belt and suspenders so /config always answers with at least the chains + PoW difficulty.
    let sponsors: Awaited<ReturnType<typeof sponsorInfo>> = []
    try {
      sponsors = await sponsorInfo()
    } catch {
      sponsors = []
    }
    return c.json({ chains: enabledChains(), powBits: POW_BITS, sponsors })
  })

  app.post('/deploy-safe', async (c) => {
    let rawBody: DeploySafeBody
    try {
      rawBody = await c.req.json()
    } catch {
      return c.json({ error: 'request body must be JSON' }, 400)
    }

    const parsed = parseBody(rawBody)
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)
    const { chainId, singleton, initializer, saltNonce, signature, powNonce } = parsed.value

    try {
      // (1) cheapest: chain enabled + singleton is the canonical v1.4.1 L2 singleton.
      if (!KNOWN_CHAIN_IDS.includes(chainId as RelayChainId) || !enabledChains().includes(chainId as RelayChainId)) {
        return c.json({ error: `chain ${chainId} is not enabled on this relay` }, 400)
      }
      if (!isAddressEqual(singleton, SAFE_V141.singletonL2)) {
        return c.json({ error: 'singleton must be the canonical Safe v1.4.1 L2 singleton' }, 400)
      }

      // (2) decode + assert a plain multisig setup — never a delegatecall/payment-redirect setup.
      let decoded
      try {
        decoded = decodeSafeSetup(initializer)
        assertPlainSafeSetup(decoded)
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : 'invalid initializer' }, 400)
      }

      // (3) PoW gate — verified before any signature recovery / rate-limit bookkeeping.
      const digest = requestDigest({ chainId, singleton, initializer, saltNonce })
      if (!verifyPow(digest, powNonce, POW_BITS)) {
        return c.json({ error: 'invalid or insufficient proof of work' }, 400)
      }

      // (4) signed-owner gate — the recovered signer must be one of the Safe's own owners.
      let signer: Hex
      try {
        signer = await recoverRequestSigner(digest, signature)
      } catch {
        return c.json({ error: 'invalid signature' }, 400)
      }
      if (!decoded.owners.some((owner) => isAddressEqual(owner, signer))) {
        return c.json({ error: 'signature is not from a Safe owner' }, 400)
      }

      // (5) per-IP daily rate limit.
      const ip = clientIp(c)
      if (!rateLimiter.take(ip)) {
        return c.json({ error: 'rate limit exceeded — try again tomorrow' }, 429)
      }

      // (6) submit — pays gas from the relay's per-chain key.
      const { txHash, proxy } = await submitDeploy({ chainId: chainId as RelayChainId, initializer, saltNonce })
      return c.json({ txHash, proxy })
    } catch (e) {
      console.error('POST /deploy-safe failed:', e instanceof Error ? e.message : 'unknown error')
      return c.json({ error: 'internal error' }, 500)
    }
  })

  return app
}

export const app = createApp()
