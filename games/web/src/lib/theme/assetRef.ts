/**
 * AssetRef — one asset type, four representations, shared by operator theming (System 1) and, later,
 * the bonus-chip art (System 2). See the program design spec §6.2.
 *
 *   | kind        | storage                    | integrity            | execution risk       |
 *   | ----------- | -------------------------- | -------------------- | -------------------- |
 *   | declarative | inline (data:/value, ≤1KB) | inherent             | none                 |
 *   | media       | IPFS/CDN                   | contentHash of bytes | none (`<img>` only)  |
 *   | erc1155     | token metadata → media     | contentHash resolved | none (as media)      |
 *   | generative  | on-chain render() bytes    | hash of returned js  | HIGH (sandboxed)     |
 *
 * A non-declarative ref MUST carry a `contentHash` so the resolver can refuse a CDN swap. Declarative
 * refs are inline and self-verifying, so they carry no hash. `parseAssetRef` normalizes untrusted
 * input and returns `null` for anything malformed — the caller DROPS a null (never throws).
 */

export type AssetKind = 'declarative' | 'media' | 'erc1155' | 'generative'

export const ASSET_KINDS: readonly AssetKind[] = ['declarative', 'media', 'erc1155', 'generative']

export type Hex = `0x${string}`

export type AssetRef = {
  kind: AssetKind
  /** The inline value (declarative) or the locator (ipfs/https for media/erc1155, chain ref for generative). */
  pointer: string
  /** SHA-256 of the resolved bytes, 0x + 64 hex. Required for media/erc1155/generative; absent for declarative. */
  contentHash?: Hex
}

/** Declarative pointers are inlined into the page, so they are capped small (spec: ~1KB). */
export const MAX_DECLARATIVE_BYTES = 1024

/** A 32-byte content hash: 0x followed by exactly 64 hex characters. */
export const isHex32 = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)

const isAssetKind = (v: unknown): v is AssetKind => typeof v === 'string' && (ASSET_KINDS as readonly string[]).includes(v)

/**
 * Normalize one untrusted asset reference. Returns a clean `AssetRef` or `null` if it is malformed:
 *  - `kind` must be one of the four known kinds;
 *  - `pointer` must be a non-empty string (declarative pointers additionally cap at MAX_DECLARATIVE_BYTES);
 *  - media / erc1155 / generative MUST carry a valid 32-byte `contentHash`; declarative must not need one.
 *
 * Enforced by allowlist (accept only the known shape), never by blocklist.
 */
export function parseAssetRef(raw: unknown): AssetRef | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { kind, pointer, contentHash } = raw as Record<string, unknown>

  if (!isAssetKind(kind)) return null
  if (typeof pointer !== 'string' || pointer.length === 0) return null

  if (kind === 'declarative') {
    if (pointer.length > MAX_DECLARATIVE_BYTES) return null
    return { kind, pointer }
  }

  // media / erc1155 / generative — integrity is not inherent, so a content hash is mandatory.
  if (!isHex32(contentHash)) return null
  return { kind, pointer, contentHash }
}
