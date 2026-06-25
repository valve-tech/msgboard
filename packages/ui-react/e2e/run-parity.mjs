/**
 * Standalone driver for the Task-6 parity gate — the SAME assertions as `parity.spec.ts` +
 * `pow-responsive.spec.ts`, driven directly through Playwright's browser API (no test runner).
 *
 * It exists for the cosign-web reason: in some sandboxed/headless CI-like environments the
 * Playwright *test runner*'s worker IPC may not start, while the browser itself launches fine.
 * This script gives a reproducible green signal there. (In THIS repo's sandbox the standard
 * runner does start — see the Task-6 report — so prefer `npm run test:e2e`; this is the
 * belt-and-braces fallback that needs only the browser.)
 *
 * Self-contained: it auto-resolves a cached Chrome-for-Testing executable (mirroring
 * `playwright.config.ts`) and starts/stops all three Vite servers itself:
 *
 *   node e2e/run-parity.mjs
 *
 * Prints `E2E_PARITY_PASS` and exits 0 on success.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(__dirname, '..')
const repoRoot = join(pkgRoot, '..', '..')
const vite = join(repoRoot, 'node_modules', '.bin', 'vite')

const REACT = 'http://localhost:4310'
const SVELTE = 'http://localhost:4311'
const HARNESS = 'http://localhost:4320'

function resolveChromium() {
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright')
  if (!existsSync(cache)) return undefined
  for (const dir of readdirSync(cache)) {
    if (!dir.startsWith('chromium-')) continue
    const c = join(
      cache,
      dir,
      'chrome-mac-arm64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    )
    if (existsSync(c)) return c
  }
  return undefined
}

async function up(url) {
  return fetch(url + '/')
    .then((r) => r.ok)
    .catch(() => false)
}

async function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await up(url)) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

/** Start a vite server if its url isn't already serving. Returns the child (or undefined). */
async function ensureServer(url, args, cwd) {
  if (await up(url)) return undefined
  const child = spawn(vite, args, { cwd, stdio: 'ignore' })
  assert(await waitForServer(url), `server did not come up: ${url}`)
  return child
}

async function goRoute(page, base, route) {
  await page.goto(`${base}/${route}`, { waitUntil: 'load' })
  await page.waitForLoadState('networkidle').catch(() => {})
}

/** The parity assertions, run against one app base url. */
async function assertApp(page, label, base) {
  // #/ — Home + interactive board section
  await goRoute(page, base, '#/')
  assert((await page.locator('#try-it').count()) === 1, `${label}: #try-it on #/`)
  assert((await page.locator('#interactive').count()) === 1, `${label}: #interactive on #/`)

  // core board scaffolding — `select#location[name="location"]` is the markup BOTH apps share
  // (the React port additionally sets `aria-label="chain"`, which the live Svelte select lacks).
  assert(
    (await page.locator('select#location[name="location"]').count()) === 1,
    `${label}: chain select`,
  )
  assert((await page.locator('textarea#message').count()) === 1, `${label}: message textarea`)
  assert(
    (await page.getByRole('button', { name: 'Work + Send It!' }).count()) === 1,
    `${label}: post button`,
  )
  assert((await page.getByText('Logs', { exact: true }).count()) >= 1, `${label}: Logs panel`)

  // #/docs — SDK README with stable #install slug
  await goRoute(page, base, '#/docs')
  assert((await page.locator('#install').count()) === 1, `${label}: #install on #/docs`)

  // #/examples
  await goRoute(page, base, '#/examples')
  assert(
    (await page.getByRole('heading', { name: 'Examples', exact: true }).count()) >= 1,
    `${label}: Examples heading`,
  )
  assert(
    (await page.getByText('Live GraphQL archive').count()) >= 1,
    `${label}: examples GraphQL callout`,
  )

  // #/games
  await goRoute(page, base, '#/games')
  assert(
    (await page.getByRole('heading', { name: 'MsgBoard Games' }).count()) >= 1,
    `${label}: Games heading`,
  )

  // unknown route → redirect home
  await goRoute(page, base, '#/does-not-exist')
  await page.waitForFunction(() => location.hash === '#/' || location.hash === '', null, {
    timeout: 5_000,
  })
  assert((await page.locator('#try-it').count()) === 1, `${label}: unknown route redirects home`)

  console.log(`  OK parity — ${label}`)
}

/** The real-grind main-thread-responsiveness assertion against the harness. */
async function assertResponsiveGrind(page) {
  await page.goto(`${HARNESS}/`, { waitUntil: 'load' })
  await page.waitForFunction(
    () => document.body.getAttribute('data-harness-ready') === 'true',
    null,
    {
      timeout: 10_000,
    },
  )
  const before = await page.evaluate(() => window.__powHarness.heartbeat())
  await page.evaluate(() => window.__powHarness.start())
  const samples = []
  for (let i = 0; i < 5; i += 1) {
    await page.waitForTimeout(40)
    samples.push(await page.evaluate(() => window.__powHarness.heartbeat()))
  }
  await page.waitForFunction(
    () => window.__powHarness.result() !== null || window.__powHarness.error() !== null,
    null,
    { timeout: 20_000 },
  )
  const outcome = await page.evaluate(() => ({
    result: window.__powHarness.result(),
    error: window.__powHarness.error(),
    heartbeat: window.__powHarness.heartbeat(),
  }))
  assert(outcome.error === null, `grind error: ${outcome.error}`)
  assert(outcome.result && outcome.result.isValid === true, 'real grind found a valid PoW')
  assert(Number(outcome.result.iterations) > 0, 'grind ran real iterations')
  for (let i = 1; i < samples.length; i += 1) {
    assert(samples[i] > samples[i - 1], `heartbeat advanced during grind (sample ${i})`)
  }
  assert(outcome.heartbeat > before, 'heartbeat advanced from baseline')
  console.log(`  OK responsive grind — iterations=${outcome.result.iterations}`)
}

async function main() {
  const servers = []
  servers.push(await ensureServer(REACT, ['preview', '--port', '4310', '--strictPort'], pkgRoot))
  servers.push(
    await ensureServer(
      SVELTE,
      ['preview', '--port', '4311', '--strictPort'],
      join(pkgRoot, '..', 'ui'),
    ),
  )
  servers.push(await ensureServer(HARNESS, ['--config', 'vite.e2e.config.ts'], pkgRoot))

  const browser = await chromium.launch({
    headless: true,
    executablePath: resolveChromium(),
  })
  try {
    const page = await browser.newPage()
    await assertApp(page, 'react (ui-react)', REACT)
    await assertApp(page, 'svelte (ui)', SVELTE)
    await assertResponsiveGrind(page)
    console.log('E2E_PARITY_PASS')
  } finally {
    await browser.close()
    for (const s of servers) if (s) s.kill()
  }
}

main().catch((e) => {
  console.error('ERR', e?.message ?? e)
  process.exit(1)
})
