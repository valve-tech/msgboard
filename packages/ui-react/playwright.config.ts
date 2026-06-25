import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

/**
 * Task-6 PARITY GATE config.
 *
 * Drives THREE servers and asserts the new React app reaches behavioral parity with the live
 * Svelte app before the (user-gated) cutover:
 *
 *   - :4310  the NEW React app   (`packages/ui-react`,  `vite preview` of its built `dist/`)
 *   - :4311  the LIVE Svelte app (`packages/ui`,        `vite preview` of its built `dist/`)
 *   - :4320  the PoW responsiveness harness (`vite --config vite.e2e.config.ts`), which spawns
 *            the REAL `@msgboard/sdk` grind in a Web Worker so the spec can assert the main
 *            thread stays responsive during a real grind (the assertion Tasks 2–5 deferred here).
 *
 * `parity.spec.ts` runs every route/board/docs assertion against BOTH :4310 and :4311 so a
 * single source of assertions proves the two apps render the same thing.
 *
 * NOTE on Chromium resolution: Playwright normally uses the build it pinned, but some
 * environments only have a different cached Chrome-for-Testing. If the pinned build is
 * missing we fall back to any cached full Chrome-for-Testing so the suite is runnable without
 * a network `playwright install`. Returns undefined to let Playwright use its default.
 */
function resolveChromium(): string | undefined {
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright')
  if (!existsSync(cache)) return undefined
  for (const dir of readdirSync(cache)) {
    if (!dir.startsWith('chromium-')) continue
    const candidate = join(
      cache,
      dir,
      'chrome-mac-arm64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    )
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const chromiumPath = resolveChromium()

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { trace: 'off' },
  projects: [
    {
      name: 'chromium',
      // Intentionally NOT spreading `devices['Desktop Chrome']` — it sets `channel: 'chrome'`,
      // which makes Playwright ignore `executablePath` and look for a system Chrome. We want
      // the cached Chrome-for-Testing build via `executablePath`.
      use: {
        viewport: { width: 1280, height: 800 },
        ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
      },
    },
  ],
  webServer: [
    {
      // React app — serve its built dist via vite preview.
      command: '../../node_modules/.bin/vite preview --port 4310 --strictPort',
      url: 'http://localhost:4310',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // Live Svelte app — serve its built dist (UNTOUCHED) via vite preview, for comparison.
      command: '../../node_modules/.bin/vite preview --port 4311 --strictPort',
      cwd: join(__dirname, '..', 'ui'),
      url: 'http://localhost:4311',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // PoW responsiveness harness — real grind in a Web Worker, no app boot / no chain.
      command: '../../node_modules/.bin/vite --config vite.e2e.config.ts',
      url: 'http://localhost:4320',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
})
