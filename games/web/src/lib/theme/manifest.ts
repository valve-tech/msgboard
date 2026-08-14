import { parseAssetRef, type AssetRef } from './assetRef'
import { SKIN_POINTS } from './skinPoints'

/**
 * The theme manifest validator. `parseManifest` takes untrusted input (a static prop today; a
 * `setTheme` / `setMetadataURI` payload in a later slice) and returns a SAFE normalized manifest:
 * every invalid entry is DROPPED, never thrown on. A theme can never block or break a surface.
 *
 * A skin survives only if ALL of these hold (allowlist, never blocklist):
 *   1. its id is a registered skin point (trust chrome is absent from the registry → always dropped);
 *   2. its `kind` is in that skin point's `allowedKinds` (trust-adjacent surfaces accept declarative only);
 *   3. a non-declarative ref carries a valid `contentHash` (enforced by `parseAssetRef`).
 *
 * A palette entry survives only if its value is a parseable hex color AND clears the contrast gate
 * against the fixed trust-chrome text color. `palette` holds the trust-SURFACE background tokens that
 * trust chrome renders over; accent / foreground colors flow through the `accentPalette` skin point
 * (declarative), which is decoration, not a background under trust text.
 */

/** The fixed trust-chrome text color (the cream `--shell-ink` / `--cream` in table.css). */
export const TRUST_TEXT_COLOR = '#f3ead7'

/** WCAG AA for normal text — trust chrome carries real content (amounts, addresses) at 11–12px. */
export const MIN_CONTRAST = 4.5

export type ThemeManifest = {
  skins: Record<string, AssetRef>
  palette: Record<string, string>
}

/** Parse a `#rgb` or `#rrggbb` hex color to [r,g,b] in 0..255, or null if it is not a hex color. */
const parseHexColor = (value: string): [number, number, number] | null => {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value.trim())
  if (!m || !m[1]) return null
  const raw = m[1]
  const hex = raw.length === 3 ? raw.replace(/./g, (c) => c + c) : raw
  const int = parseInt(hex, 16)
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255]
}

/** Relative luminance per WCAG 2.x. */
const relLuminance = ([r, g, b]: [number, number, number]): number => {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio between two hex colors (1..21). Returns 1 (fails) if either is unparseable. */
export function contrastRatio(a: string, b: string): number {
  const ca = parseHexColor(a)
  const cb = parseHexColor(b)
  if (!ca || !cb) return 1
  const la = relLuminance(ca)
  const lb = relLuminance(cb)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseManifest(raw: unknown): ThemeManifest {
  const out: ThemeManifest = { skins: {}, palette: {} }
  if (!isRecord(raw)) return out

  const rawSkins = raw.skins
  if (isRecord(rawSkins)) {
    for (const [id, entry] of Object.entries(rawSkins)) {
      const point = SKIN_POINTS[id]
      if (!point) continue // not a registered skin point (all trust chrome lands here) → drop
      const ref = parseAssetRef(entry)
      if (!ref) continue // malformed / missing contentHash → drop
      if (!point.allowedKinds.includes(ref.kind)) continue // wrong tier for this surface → drop
      out.skins[id] = ref
    }
  }

  const rawPalette = raw.palette
  if (isRecord(rawPalette)) {
    for (const [token, value] of Object.entries(rawPalette)) {
      if (typeof value !== 'string') continue
      // Fail safe: unparseable color OR failing contrast against trust-chrome text → drop the entry.
      if (contrastRatio(value, TRUST_TEXT_COLOR) < MIN_CONTRAST) continue
      out.palette[token] = value
    }
  }

  return out
}
