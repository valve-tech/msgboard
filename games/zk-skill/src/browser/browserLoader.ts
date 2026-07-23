/// <reference lib="dom" />
// Browser-side loader for the PLONK proving artifacts (zkey + witness-generator wasm).
//
// It fetches an artifact from an untrusted host, caches it in IndexedDB keyed by its sha256, and
// verifies the bytes against the manifest hash before handing them to the prover.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE HASH CHECK IS A UX GUARD, NOT A TRUST BOUNDARY
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A PLONK proving key needs AVAILABILITY, not integrity, for soundness. The on-chain verifier is the
// real commitment to the trusted setup; a corrupted/swapped/malicious zkey cannot forge a proof that
// verifier accepts — it can only fail to produce a valid one. So we may fetch these from any untrusted
// host (GitHub Release, CDN like one.valve.city). We verify sha256 only to DETECT corruption early and
// to key the cache — a changed key busts the cache automatically — NOT to protect funds. See
// scripts/publishProvingKeys.ts + PROVING_KEYS.md for the full argument.
//
// This module is framework-agnostic (plain DOM APIs). It runs on the MAIN thread — fetching bytes and
// touching IndexedDB is I/O, not CPU. The heavy CPU work (proving) happens in a Web Worker; see
// prover.ts / prover.worker.ts. The proving key bytes returned here are handed to that worker as a
// transferable, so the 66 MB zkey is never processed on the main thread.

/** One artifact (zkey or wasm) as described by proving-keys.manifest.json. */
export interface ArtifactEntry {
  file: string
  sha256: string
  bytes: number
}

/** The subset of the manifest a loader needs to resolve + verify one circuit's artifacts. */
export interface CircuitManifestEntry {
  circuit: string
  zkey: ArtifactEntry
  wasm: ArtifactEntry
  release: string
}

const DB_NAME = 'zk-skill-proving-keys'
const STORE = 'artifacts'
const DB_VERSION = 1

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'))
  })
}

function idbGet(db: IDBDatabase, key: string): Promise<ArrayBuffer | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result as ArrayBuffer | undefined)
    req.onerror = () => reject(req.error ?? new Error('idb get failed'))
  })
}

function idbPut(db: IDBDatabase, key: string, value: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('idb put failed'))
  })
}

/** Lowercase hex sha256 of the bytes, via Web Crypto (runs on whatever thread calls it). */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Fetch + cache + verify a single artifact, returning its bytes.
 *
 * Fast path: if IndexedDB already holds bytes under this artifact's sha256, we re-verify them (cheap
 * insurance against a corrupted cache) and return without any network. Because the cache key IS the
 * hash, a re-setup that changes the key writes under a new key and the old bytes are simply never
 * requested again — a changed key busts the cache for free.
 *
 * Slow path: fetch `${baseUrl}/${entry.file}` as an ArrayBuffer, verify sha256 against the manifest,
 * throw on mismatch (do NOT cache bad bytes), else store under the hash and return.
 *
 * @param entry     the manifest entry for THIS artifact (zkey or wasm) — has file + expected sha256
 * @param baseUrl   asset base, e.g. manifest.release.assetBaseUrl (or a CDN fronting it)
 */
export async function loadArtifact(entry: ArtifactEntry, baseUrl: string): Promise<ArrayBuffer> {
  const db = await openDb()
  try {
    const cached = await idbGet(db, entry.sha256)
    if (cached) {
      const got = await sha256Hex(cached)
      if (got === entry.sha256) return cached
      // Cache corruption — fall through and re-fetch rather than trusting bad bytes.
    }

    const url = `${baseUrl.replace(/\/$/, '')}/${entry.file}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`loadArtifact: fetch ${url} failed: ${res.status} ${res.statusText}`)
    const bytes = await res.arrayBuffer()

    const got = await sha256Hex(bytes)
    if (got !== entry.sha256) {
      // Corruption detected. This is a DoS/UX failure, not a security breach (a bad key can't forge a
      // proof the on-chain verifier accepts) — but we refuse to prove against unverifiable bytes.
      throw new Error(
        `loadArtifact: sha256 mismatch for ${entry.file} — expected ${entry.sha256}, got ${got}. ` +
          `The host served corrupt/stale bytes; not a forgery risk, but proving would waste time then ` +
          `emit a proof the chain rejects. Refusing to cache or use these bytes.`,
      )
    }
    if (bytes.byteLength !== entry.bytes) {
      throw new Error(`loadArtifact: byte length mismatch for ${entry.file} — expected ${entry.bytes}, got ${bytes.byteLength}`)
    }
    await idbPut(db, entry.sha256, bytes)
    return bytes
  } finally {
    db.close()
  }
}

/** Convenience: load both artifacts for a circuit. Returns transferable ArrayBuffers. */
export async function loadCircuit(
  circuit: CircuitManifestEntry,
  baseUrl: string,
): Promise<{ zkey: ArrayBuffer; wasm: ArrayBuffer }> {
  const [zkey, wasm] = await Promise.all([loadArtifact(circuit.zkey, baseUrl), loadArtifact(circuit.wasm, baseUrl)])
  return { zkey, wasm }
}
