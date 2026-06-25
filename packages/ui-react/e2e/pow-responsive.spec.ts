import { test, expect } from '@playwright/test'

/**
 * Task-6 — THE authoritative "main thread stays responsive during a REAL grind" assertion.
 *
 * Tasks 2–5 deferred this here. It drives the harness at :4320 (`e2e/harness/`), which spawns
 * the REAL `@msgboard/sdk` `doPoW` grind in a Web Worker — the same grind the production worker
 * (`src/worker/pow-worker.ts`) runs — at a low (but non-zero) difficulty so it completes in
 * well under a second. A main-thread heartbeat (`setInterval`, advances only when the main
 * thread's event loop is free) is sampled DURING the grind. If the grind ran on the main
 * thread, the heartbeat would freeze. It does not — proving the grind is genuinely off-thread.
 *
 * REAL here: the grind (a multi-thousand-iteration elliptic-curve PoW search via the shipped
 * SDK), the Web Worker, the main-thread responsiveness measurement. MOCKED: only the block
 * read (`eth_getBlockByNumber`, stubbed in-worker) and the on-chain `addMessage` (omitted —
 * unreachable headlessly). The proof-of-work itself is not mocked.
 */
const HARNESS = 'http://localhost:4320'

test('a real PoW grind runs in a Web Worker, off the main thread', async ({ page }) => {
  await page.goto(`${HARNESS}/`, { waitUntil: 'load' })
  await page.waitForFunction(
    () => document.body.getAttribute('data-harness-ready') === 'true',
    null,
    {
      timeout: 10_000,
    },
  )

  const heartbeatBefore = await page.evaluate(() => window.__powHarness.heartbeat())

  // Kick off a REAL grind in the worker.
  await page.evaluate(() => window.__powHarness.start())

  // Sample the main-thread heartbeat repeatedly WHILE the worker grinds. A main-thread grind
  // would starve these samples (no advance); an off-thread grind lets the heartbeat keep ticking.
  const samples: number[] = []
  for (let i = 0; i < 5; i += 1) {
    await page.waitForTimeout(40)
    samples.push(await page.evaluate(() => window.__powHarness.heartbeat()))
  }

  // Wait for the real grind to finish (or surface an error).
  await page.waitForFunction(
    () => window.__powHarness.result() !== null || window.__powHarness.error() !== null,
    null,
    { timeout: 20_000 },
  )

  const outcome = await page.evaluate(() => ({
    result: window.__powHarness.result(),
    error: window.__powHarness.error(),
    progress: window.__powHarness.progressCount(),
    heartbeat: window.__powHarness.heartbeat(),
  }))

  // 1. The real grind succeeded (a valid PoW was found) — not a mock.
  expect(outcome.error).toBeNull()
  expect(outcome.result).not.toBeNull()
  expect(outcome.result!.isValid).toBe(true)
  expect(Number(outcome.result!.iterations)).toBeGreaterThan(0)

  // 2. The main thread stayed RESPONSIVE: the heartbeat advanced monotonically across the
  //    grind. Each sample is strictly greater than the previous — the event loop never froze.
  expect(samples.length).toBe(5)
  for (let i = 1; i < samples.length; i += 1) {
    expect(samples[i]).toBeGreaterThan(samples[i - 1])
  }
  // And it advanced from the pre-grind baseline through to completion.
  expect(outcome.heartbeat).toBeGreaterThan(heartbeatBefore)
})
