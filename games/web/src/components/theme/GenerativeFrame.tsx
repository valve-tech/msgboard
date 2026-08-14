import { useEffect, useRef, useState } from 'react'

/**
 * GenerativeFrame — the ONLY place generative (on-chain js/html/svg) theme art is allowed to run.
 * It is locked down hard (spec §6.3):
 *   - `sandbox="allow-scripts"` with NO `allow-same-origin` → the frame runs on an opaque origin with
 *     no storage and no access to this page's DOM, cookies, or wallet;
 *   - the document carries `default-src 'none'` + `connect-src 'none'` (built in `buildGenerativeSrcDoc`),
 *     so the art has no network — it cannot read round data or beacon anything out;
 *   - `postMessage` to the frame carries ONLY `{ w, h, theme }` — never wallet or round data;
 *   - on a table-global surface it renders a STATIC poster until the viewer clicks to activate, and
 *     `prefers-reduced-motion` keeps it static (the iframe is never mounted).
 */

const usePrefersReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return reduced
}

export const GenerativeFrame = ({
  srcDoc,
  poster,
  title = 'themed art',
  theme = 'dark',
  className,
}: {
  srcDoc: string
  /** A static first-frame image shown before activation (and always, under reduced motion). */
  poster?: string
  title?: string
  theme?: string
  className?: string
}) => {
  const reduced = usePrefersReducedMotion()
  const [active, setActive] = useState(false)
  const ref = useRef<HTMLIFrameElement>(null)

  // Never auto-run: the frame mounts only after an explicit click, and never under reduced motion.
  const showFrame = active && !reduced

  const onLoad = () => {
    const el = ref.current
    if (!el || !el.contentWindow) return
    // Opaque origin → targetOrigin must be '*'. Send ONLY presentation data, never wallet/round data.
    el.contentWindow.postMessage({ w: el.clientWidth, h: el.clientHeight, theme }, '*')
  }

  const fill: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' }

  if (!showFrame) {
    return (
      <button
        type="button"
        className={className}
        onClick={() => setActive(true)}
        disabled={reduced}
        aria-label={reduced ? `${title} (static)` : `activate ${title}`}
        style={{
          ...fill,
          border: 'none',
          padding: 0,
          cursor: reduced ? 'default' : 'pointer',
          background: poster ? `center/cover no-repeat url(${JSON.stringify(poster)})` : 'radial-gradient(120% 90% at 50% -8%, #14281c, #06100a)',
          color: '#f3ead7',
          display: 'grid',
          placeItems: 'center',
          font: '600 12px var(--sans, system-ui)',
        }}
      >
        {!reduced && <span style={{ opacity: 0.85, textShadow: '0 1px 6px #000c' }}>▶ tap to animate</span>}
      </button>
    )
  }

  return (
    <iframe
      ref={ref}
      title={title}
      className={className}
      // NO allow-same-origin — opaque origin, no storage, no access to this page.
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
      allow=""
      loading="lazy"
      onLoad={onLoad}
      style={{ ...fill, border: 'none', background: 'transparent' }}
    />
  )
}
