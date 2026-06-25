/**
 * Ambient type for the PoW-responsiveness harness hook (`e2e/harness/main.ts`) so the
 * Playwright specs that read it via `page.evaluate` typecheck. Mirrors the shape defined
 * in `harness/main.ts`.
 */
interface Window {
  __powHarness: {
    heartbeat: () => number
    start: (opts?: { workMultiplier?: string; workDivisor?: string }) => void
    progressCount: () => number
    result: () => {
      isValid: boolean
      iterations: string
      duration: number
    } | null
    error: () => string | null
  }
}
