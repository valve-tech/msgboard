import type { ReactNode } from 'react'
import { useSkin } from './ThemeProvider'
import { GenerativeFrame } from './GenerativeFrame'

/**
 * SkinnedAsset — render a named skin point at its correct, sandboxed tier, always with a house
 * fallback. It dispatches strictly by kind:
 *   - declarative (or unthemed) → render the house `fallback` (declarative theming flows through the
 *     ThemeProvider's CSS custom properties, which the fallback element inherits — no execution);
 *   - media / erc1155 → an `<img>` only, NEVER `<object>` / `<embed>` (an SVG travels as a `data:`
 *     image, which neuters its scripts);
 *   - generative → a `GenerativeFrame` (sandboxed iframe, poster-until-click, static under reduced
 *     motion).
 *
 * If a skin fails to resolve, `useSkin` returns null and the house `fallback` shows — a theme can
 * never blank or break a surface.
 */
export const SkinnedAsset = ({
  skinPoint,
  fallback,
  className,
  alt = '',
  poster,
}: {
  skinPoint: string
  /** The house default for this surface — shown while resolving, when unthemed, or on any failure. */
  fallback: ReactNode
  className?: string
  alt?: string
  /** A static poster for a generative skin (shown before activation / under reduced motion). */
  poster?: string
}) => {
  const skin = useSkin(skinPoint)

  if (!skin || skin.tier === 'declarative') return <>{fallback}</>

  if (skin.tier === 'image') {
    return (
      <img
        src={skin.src}
        alt={alt}
        className={className}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
      />
    )
  }

  // tier === 'generative'
  return <GenerativeFrame srcDoc={skin.srcDoc} poster={poster} className={className} />
}
