import { test, expect, type Page } from '@playwright/test'

/**
 * Task-6 PARITY GATE — the behavioral-parity suite.
 *
 * Runs ONE set of assertions against BOTH the live Svelte app (:4311, `packages/ui`) and the
 * new React app (:4310, `packages/ui-react`). Because the same assertions must hold on both,
 * a green run proves the React app renders the same routes / board view / docs as the app it
 * replaces — the gate the user-gated cutover (Task 7) sits behind.
 *
 * Coverage:
 *   - every `#/route` resolves to the equivalent page (`/`, `/docs`, `/examples`, `/games`,
 *     plus the unknown-route → `#/` redirect),
 *   - the core board / Interactive view renders its scaffolding (chain select, message input,
 *     the "Work + Send It!" affordance, the Logs panel),
 *   - the docs page renders (the `@msgboard/sdk` README → markdown with a stable `#install`
 *     heading slug).
 *
 * What is REAL here: both apps' real built `dist/` served by `vite preview`, every route and
 * page rendering, the real DOM. What is NOT exercised here (it can't be headlessly — no live
 * `msgboard_` RPC module + no funded account): a real on-chain post and the live board tree
 * content. The board *scaffolding* is asserted; the post round-trip is covered structurally,
 * and the real off-thread grind is proven separately in `pow-responsive.spec.ts`.
 */

const APPS = [
  { name: 'react (ui-react)', base: 'http://localhost:4310' },
  { name: 'svelte (ui)', base: 'http://localhost:4311' },
] as const

/** Navigate to a hash route and let the hash-router render. */
async function goRoute(page: Page, base: string, route: string) {
  await page.goto(`${base}/${route}`, { waitUntil: 'load' })
  // The hash router renders synchronously off the hashchange; a short settle covers async
  // effects (theme/chain polling mounts) without depending on any network.
  await page.waitForLoadState('networkidle').catch(() => {})
}

for (const app of APPS) {
  test.describe(`parity — ${app.name}`, () => {
    test('route #/ renders the Home page with the Interactive board section', async ({ page }) => {
      await goRoute(page, app.base, '#/')
      // The landing page + the interactive board live under the `#try-it` section.
      await expect(page.locator('#try-it')).toHaveCount(1)
      await expect(page.locator('#interactive')).toHaveCount(1)
    })

    test('the core board view renders its compose scaffolding', async ({ page }) => {
      await goRoute(page, app.base, '#/')
      // Chain select — `select#location[name="location"]` is the markup BOTH apps share.
      // (The React port additionally sets `aria-label="chain"`, an a11y improvement the live
      // Svelte select lacks — so the parity selector keys off the common id/name, not that.)
      await expect(page.locator('select#location[name="location"]')).toHaveCount(1)
      // The compose textarea.
      await expect(page.locator('textarea#message')).toHaveCount(1)
      // The post affordance (the PoW "Work + Send It!" button).
      await expect(page.getByRole('button', { name: 'Work + Send It!' })).toHaveCount(1)
      // The Logs / Terminal panel header.
      await expect(page.getByText('Logs', { exact: true })).toBeVisible()
    })

    test('route #/docs renders the SDK docs (markdown with a stable #install slug)', async ({
      page,
    }) => {
      await goRoute(page, app.base, '#/docs')
      // The README markdown is rendered with slugged heading ids; `#install` is the first H2.
      await expect(page.locator('#install')).toHaveCount(1)
      await expect(page.locator('#install')).toBeVisible()
    })

    test('route #/examples renders the Examples page', async ({ page }) => {
      await goRoute(page, app.base, '#/examples')
      await expect(page.getByRole('heading', { name: 'Examples', exact: true })).toBeVisible()
      await expect(page.getByText('Live GraphQL archive')).toBeVisible()
    })

    test('route #/games renders the Games page', async ({ page }) => {
      await goRoute(page, app.base, '#/games')
      await expect(page.getByRole('heading', { name: 'MsgBoard Games' })).toBeVisible()
    })

    test('an unknown #/route redirects back to #/', async ({ page }) => {
      await goRoute(page, app.base, '#/does-not-exist')
      // Both apps redirect unknown routes home; assert the hash settles to `#/` and Home renders.
      await page.waitForFunction(() => location.hash === '#/' || location.hash === '', null, {
        timeout: 5_000,
      })
      await expect(page.locator('#try-it')).toHaveCount(1)
    })
  })
}
