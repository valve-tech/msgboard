import type { ReactNode } from 'react'
import { ThemeProvider } from '../theme/ThemeProvider'
import { SkinnedAsset } from '../theme/SkinnedAsset'

/**
 * GameStage — the shared stage every game screen renders on. `themeManifest` is the operator theme
 * for this table (a static prop today; a `setTheme`/`setMetadataURI` chain event in a later slice).
 * Omitting it (the default) is the same as an empty manifest: `ThemeProvider` resolves no skins, so
 * every surface below falls back to its hard-coded house default — an unthemed stage is unchanged.
 *
 * `ThemeProvider` wraps ONLY the `.stage` box, never `.gtitle`'s "Provably fair" pill above it — so a
 * theme's declarative palette can never reach that trust-adjacent chrome, no matter what CSS
 * custom-property name a manifest happens to name (I6).
 */
export const GameStage = ({ title, subtitle, action, children, themeManifest }: {
  title: string; subtitle?: string; action?: ReactNode; children: ReactNode
  /** Raw/unvalidated theme manifest for this table; re-validated inside `ThemeProvider`. */
  themeManifest?: unknown
}) => (
  <div className="stage-col">
    <div className="gtitle">
      <h1>{title}</h1>
      {subtitle && <span className="sub">{subtitle}</span>}
      {action && <span className="pf">{action}</span>}
    </div>
    <div className="stage">
      <ThemeProvider manifest={themeManifest ?? {}}>
        {/* backdrop: generative, poster-until-click (GenerativeFrame), house default = render
            nothing so the .stage CSS backdrop above shows through untouched. */}
        <SkinnedAsset skinPoint="backdrop" fallback={null} />
        {children}
      </ThemeProvider>
    </div>
  </div>
)
