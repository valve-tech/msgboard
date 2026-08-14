import type { AssetRef } from './assetRef'

/**
 * The sandboxed resolver. It turns a validated `AssetRef` into a render instruction, and it is
 * FAIL-SAFE by construction: any failure — unknown kind, fetch error, hash mismatch — returns the
 * house `fallback`, so a theme can never block or break a surface.
 *
 * Integrity: every media / erc1155 / generative ref carries a `contentHash`. The default verifier
 * fetches the bytes and checks the hash IN A WEB WORKER (never the main thread), so a CDN swap can't
 * change a live surface. Declarative refs are inline and self-verifying, so they resolve immediately
 * with no fetch and no execution.
 *
 * Sandbox tiers (spec §6.3):
 *   - declarative → CSS custom properties (no execution);
 *   - media / erc1155 → `<img>` only (SVG travels as a `data:` image, which neuters its scripts);
 *   - generative → a `<iframe sandbox="allow-scripts">` (NO `allow-same-origin` → opaque origin, no
 *     storage) whose document carries the CSP below. See `GenerativeFrame.tsx`.
 */

export type RenderInstruction =
  | { tier: 'declarative'; pointer: string }
  | { tier: 'image'; src: string }
  | { tier: 'generative'; srcDoc: string }

/** What the worker-backed verifier returns after fetching + hash-checking the bytes. */
export type VerifyResult =
  | { ok: true; kind: 'image'; src: string }
  | { ok: true; kind: 'generative'; srcDoc: string }
  | { ok: false }

/** Fetch + hash-verify a non-declarative ref (default runs in a worker; tests inject a mock). */
export type Verifier = (ref: AssetRef) => Promise<VerifyResult>

export type ResolveOptions = { verify?: Verifier }

/**
 * The Content Security Policy stamped onto every generative frame document.
 *
 * `default-src 'none'` is the floor: nothing is allowed unless re-granted below. We re-grant ONLY
 * inline script/style (the on-chain art runs as inline code — there is no remote script) and `data:`
 * images/fonts. Crucially `connect-src 'none'` (plus `frame-src`/`base-uri`/`form-action 'none'`)
 * cuts the network entirely — the art cannot fetch wallet or round data, and cannot beacon anything
 * out. Combined with the iframe's `sandbox="allow-scripts"` (no `allow-same-origin`), the frame runs
 * on an opaque origin with no storage and no network.
 */
export const GENERATIVE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/**
 * Wrap verified generative bytes in a minimal document that carries {@link GENERATIVE_CSP} and stops
 * all motion under `prefers-reduced-motion`. This is the `srcdoc` fed to the sandboxed iframe.
 */
export function buildGenerativeSrcDoc(inner: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${GENERATIVE_CSP}">` +
    '<style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}' +
    '@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation:none !important;transition:none !important}}' +
    '</style></head><body>' +
    inner +
    '</body></html>'
  )
}

const NON_DECLARATIVE = new Set(['media', 'erc1155', 'generative'])

/**
 * Resolve one skin ref to a render instruction, falling back to the house default on any failure.
 * `declarative` resolves synchronously (no worker); every other kind is fetched + hash-verified.
 */
export async function resolveSkin(ref: AssetRef, fallback: RenderInstruction, opts: ResolveOptions = {}): Promise<RenderInstruction> {
  if (ref.kind === 'declarative') return { tier: 'declarative', pointer: ref.pointer }
  if (!NON_DECLARATIVE.has(ref.kind)) return fallback // unknown kind → never call the verifier

  const verify = opts.verify ?? getDefaultVerifier()
  try {
    const res = await verify(ref)
    if (!res.ok) return fallback
    return res.kind === 'generative' ? { tier: 'generative', srcDoc: res.srcDoc } : { tier: 'image', src: res.src }
  } catch {
    return fallback // fetch / decode / worker error → house default
  }
}

// ── default browser verifier (worker-backed) ──────────────────────────────────────────────────────
// Lazily created so node/test runs (which inject a mock verifier) never construct a Worker.

let defaultVerifier: Verifier | null = null

const getDefaultVerifier = (): Verifier => {
  if (!defaultVerifier) defaultVerifier = createWorkerVerifier()
  return defaultVerifier
}

/** IPFS pointers resolve through a public gateway; https pointers pass through. */
const toFetchUrl = (pointer: string): string =>
  pointer.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${pointer.slice('ipfs://'.length)}` : pointer

/**
 * Build the real verifier. It spins one dedicated worker that fetches the bytes and checks the SHA-256
 * off the main thread, then this side turns the verified bytes into a blob URL (media) or a
 * CSP-wrapped srcdoc (generative). erc1155 is treated as media here; full token-metadata resolution
 * is a later slice (this engine takes the already-resolved media pointer).
 */
function createWorkerVerifier(): Verifier {
  const worker = new Worker(new URL('./hashWorker.ts', import.meta.url), { type: 'module' })
  let seq = 0
  const pending = new Map<number, (r: { ok: boolean; buffer?: ArrayBuffer; mime?: string }) => void>()

  worker.onmessage = (e: MessageEvent) => {
    const { id, ok, buffer, mime } = e.data as { id: number; ok: boolean; buffer?: ArrayBuffer; mime?: string }
    const resolve = pending.get(id)
    if (resolve) {
      pending.delete(id)
      resolve({ ok, buffer, mime })
    }
  }

  return async (ref) => {
    const id = ++seq
    const url = toFetchUrl(ref.pointer)
    const result = await new Promise<{ ok: boolean; buffer?: ArrayBuffer; mime?: string }>((resolve) => {
      pending.set(id, resolve)
      worker.postMessage({ id, url, contentHash: ref.contentHash })
    })
    if (!result.ok || !result.buffer) return { ok: false }

    if (ref.kind === 'generative') {
      const html = new TextDecoder().decode(result.buffer)
      return { ok: true, kind: 'generative', srcDoc: buildGenerativeSrcDoc(html) }
    }
    const blob = new Blob([result.buffer], { type: result.mime || 'application/octet-stream' })
    return { ok: true, kind: 'image', src: URL.createObjectURL(blob) }
  }
}
