import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GameStage } from './GameStage'
import { CardBack } from '../decisionShared'

// Plain `.test.ts` (not `.tsx`) so this file matches the project's vitest include glob
// (`src/**/*.test.ts`, `vitest.config.ts`) without adding a jsdom/testing-library dependency — a
// static SSR render via `react-dom/server` is enough to assert on the rendered markup in a Node
// environment. React never runs `useEffect` during `renderToStaticMarkup`, so `useSkin`'s async
// resolution never fires here — every skin point renders its house fallback, which is exactly what
// makes this the right test for the "trust chrome stays fixed" proof: it isolates the SYNCHRONOUS
// part of theming (the declarative `palette` → CSS custom properties on `.theme-root`) from the
// async resolver, and shows that part alone can never touch anything outside the `.stage` box.

// A manifest that INVALIDLY tries to target trust chrome (a `betAmount` skin — not a registered
// skin point, see skinPoints.ts) and VALIDLY themes the felt via the declarative palette.
const manifest = {
  skins: {
    // Not in SKIN_POINTS — parseManifest must drop this. The pointer is a distinctive marker string
    // so the test can assert it never reaches the rendered HTML in any form.
    betAmount: {
      kind: 'media',
      pointer: 'https://evil.example/HACKED-TRUST-CHROME.png',
      contentHash: `0x${'11'.repeat(32)}`,
    },
  },
  palette: {
    // A real, registered skin-point var (felt) with a contrast-passing color — must survive.
    '--felt-hi': '#0a3121',
  },
}

describe('GameStage (trust-chrome-stays-fixed proof)', () => {
  it('applies the felt custom property from the manifest while leaving trust-adjacent markup untouched', () => {
    const html = renderToStaticMarkup(
      React.createElement(GameStage, {
        title: 'BLACKJACK',
        subtitle: 'sealed before you play',
        action: 'Provably fair',
        themeManifest: manifest,
        children: React.createElement(CardBack, {}),
      }),
    )

    // 1. The felt skin point WAS themed: the overridden value reaches the rendered `.theme-root`
    //    style attribute (the synchronous declarative-palette path).
    expect(html).toContain('--felt-hi:#0a3121')

    // 2. The invalid trust-chrome-targeting skin was dropped — its id, kind, and pointer never
    //    appear anywhere in the rendered output.
    expect(html).not.toContain('betAmount')
    expect(html).not.toContain('HACKED-TRUST-CHROME')
    expect(html).not.toContain('evil.example')

    // 3. Trust-adjacent chrome outside the stage — the "Provably fair" action pill — renders exactly
    //    as given, unstyled and untouched by the manifest (GameStage renders it OUTSIDE
    //    ThemeProvider, in `.gtitle`, never inside the themed `.stage` subtree).
    expect(html).toContain('Provably fair')
    expect(html).toContain('class="pf"')

    // 4. The card back's markup/structure is unchanged: same class, same aria-label. (The ◈ seal
    //    itself is CSS `::after` content — it never appears in server-rendered HTML at all, which is
    //    exactly the point: there is no DOM node for a theme to touch.)
    expect(html).toContain('playcard back')
    expect(html).toContain('aria-label="face-down card"')
  })

  it('an empty/omitted manifest renders the house default — no theme-root override at all', () => {
    const html = renderToStaticMarkup(
      React.createElement(GameStage, { title: 'BLACKJACK', children: React.createElement(CardBack, {}) }),
    )
    expect(html).not.toContain('--felt-hi:')
    expect(html).toContain('playcard back')
  })
})
