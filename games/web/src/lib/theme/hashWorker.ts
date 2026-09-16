/**
 * The theme integrity worker. It fetches a themed asset and verifies its SHA-256 against the
 * committed `contentHash` OFF the main thread (spec §6.3: hash verification and heavy decode run in a
 * worker, never the main thread). It returns the verified bytes so the caller can build a blob URL or
 * a sandboxed srcdoc. On any failure — bad fetch, hash mismatch — it reports `ok: false`, and the
 * resolver falls back to the house default.
 *
 * The worker never receives wallet or round data; it is given only { id, url, contentHash }.
 */

// A dedicated worker's global. Typed loosely so this file compiles under the DOM lib without pulling
// in the webworker lib (which would redeclare `self` and conflict).
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

const normalizeHash = (h: string): string => h.trim().toLowerCase().replace(/^0x/, '')

ctx.onmessage = async (e: MessageEvent) => {
  const { id, url, contentHash } = e.data as { id: number; url: string; contentHash: string }
  try {
    const res = await fetch(url, { mode: 'cors', redirect: 'follow' })
    if (!res.ok) {
      ctx.postMessage({ id, ok: false })
      return
    }
    const mime = res.headers.get('content-type') || 'application/octet-stream'
    const buffer = await res.arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    if (toHex(digest) !== normalizeHash(contentHash)) {
      ctx.postMessage({ id, ok: false })
      return
    }
    ctx.postMessage({ id, ok: true, buffer, mime }, [buffer])
  } catch {
    ctx.postMessage({ id, ok: false })
  }
}
