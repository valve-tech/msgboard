import type { AssetKind } from './assetRef'

/**
 * The canonical skin-point registry — the ONLY surfaces an operator theme may touch (invariant I6).
 *
 * Themes apply through this allowlist and nothing else. Trust chrome is unskinnable NOT by a blocklist
 * but by CONSTRUCTION: the trust-chrome elements below are simply absent from this map, so a manifest
 * can never name them (`parseManifest` drops any skin whose id is not a key here).
 *
 * The skin points were read off the shipped stage stylesheet (`src/styles/table.css`) and the stage
 * components under `src/components/stages/` + `src/components/shell/`, so each entry maps to art that
 * actually renders today:
 *   - felt            → `.felt` fill + `--felt-hi/-a/-b/-edge` (FeltTable)
 *   - woodRail        → `.rail-ring` + `--wood-hi/-a/-b` (the table's wooden ring)
 *   - backdrop        → `.stage` radial base + each `*-scene` background (the stage floor)
 *   - ambientLayer    → `.stage::before` glow / ambient atmosphere overlay
 *   - cardBack        → `.playcard.back` / `.fcard.back` art (the ◈ SEAL overlaid via ::after is NOT skinnable)
 *   - chipFace        → `.chip`, `.cval` chip/coin faces
 *   - tablePlaque     → `.medal`, `.arc`, `.cf-plate` nameplate lettering
 *   - accentPalette   → `--gold` / `--gold-live` / `--gold-dim` decorative accents (declarative only)
 *   - lobbyTile       → `.cf-puck` / `.cf-table` lobby tiles (CasinoFloor)
 *   - wheelWedges     → `.mw-rotor` wedges + roulette wheel (TRUST-ADJACENT: hue encodes payout tier)
 *   - dropBoardTints  → `.drop-bucket.lo/.mid/.hi` (TRUST-ADJACENT: hue encodes payout tier)
 *
 * TRUST CHROME — DELIBERATELY EXCLUDED (unskinnable by construction, I6). None of these appear as a
 * skin-point id, so no manifest can target them:
 *   - the ◈ seal in every form: `.playcard.back::after`, `.wheel .hub::after`, `.cf-seal`,
 *     TrustBanner `.trust-seal`, and the "THE ◈ HOUSE" wordmark (CasinoFloor.tsx);
 *   - the fairness / trust strip and how-it-works: `.trust-strip`, `.trust-line`, `.trust-validators`
 *     (TrustBanner.tsx), HowItWorks.tsx, VerifyPanel.tsx, the "Provably fair" `.pf` / `.pf-link` pills;
 *   - ALL amounts / odds / multipliers / receipts / seed proofs: `.amount` + `.amount-input` (BetTray),
 *     `.ticker .amt` (WinTicker), `.mult` (Crash), `.mw-hub` multiplier readout, `.lad-mult`,
 *     `.stat b`, `.hchip`, `.pool-odds` / `.pool-stake` / `.pool-fair`, `.nb-head`, and the payout
 *     numbers printed inside drop buckets / wheel wedges (only their TINT is skinnable, never the digits);
 *   - alert lanes — money-critical notices: `.bk-alert`, `.banner`;
 *   - wallet + network chrome: the `.shell-top` wallet cluster.
 *
 * NOTE: `wheelWedges` / `dropBoardTints` are trust-ADJACENT, not trust chrome — hue encodes the payout
 * tier, so a theme may restyle the hue family (declarative only) while the renderer keeps the
 * tier→family mapping and the legend. The payout DIGITS drawn over them stay trust chrome (above).
 */
export type SkinPoint = {
  /** Logical surface group the skin point belongs to (felt, stage, cards, …). */
  surface: string
  /** The representation tiers this surface accepts. Trust-adjacent surfaces accept `declarative` only. */
  allowedKinds: AssetKind[]
  /** True where color encodes payout tier — restyle the hue family only, keep the tier→family mapping. */
  trustAdjacent: boolean
}

export const SKIN_POINTS: Record<string, SkinPoint> = {
  felt: { surface: 'felt', allowedKinds: ['declarative', 'media'], trustAdjacent: false },
  woodRail: { surface: 'felt', allowedKinds: ['declarative', 'media'], trustAdjacent: false },
  // backdrop + ambient may run generative (poster-until-click, never trust chrome) — spec §6.2 table.
  backdrop: { surface: 'stage', allowedKinds: ['declarative', 'media', 'generative'], trustAdjacent: false },
  ambientLayer: { surface: 'stage', allowedKinds: ['declarative', 'media', 'generative'], trustAdjacent: false },
  cardBack: { surface: 'cards', allowedKinds: ['declarative', 'media', 'erc1155'], trustAdjacent: false },
  chipFace: { surface: 'chips', allowedKinds: ['declarative', 'media', 'erc1155'], trustAdjacent: false },
  tablePlaque: { surface: 'plaque', allowedKinds: ['declarative', 'media'], trustAdjacent: false },
  accentPalette: { surface: 'palette', allowedKinds: ['declarative'], trustAdjacent: false },
  lobbyTile: { surface: 'lobby', allowedKinds: ['declarative', 'media', 'erc1155'], trustAdjacent: false },
  wheelWedges: { surface: 'wheel', allowedKinds: ['declarative'], trustAdjacent: true },
  dropBoardTints: { surface: 'dropboard', allowedKinds: ['declarative'], trustAdjacent: true },
}

export type SkinPointId = keyof typeof SKIN_POINTS

/** True only for a registered skin point. Trust chrome is never registered, so it always returns false. */
export const isSkinPoint = (id: string): boolean => Object.prototype.hasOwnProperty.call(SKIN_POINTS, id)
