import { vi } from 'vitest'

/**
 * Test-only stub for `@iconify/react`.
 *
 * In jsdom there is no network, so the real `Icon` lazy-loads icon data for non-bundled sets
 * (`mdi:*`, `ph:*`, …) over the Iconify API and defers the resulting state update through an
 * internal `setTimeout`. That timer fires *after* the test environment is torn down, surfacing
 * as noisy "caught after teardown" errors. We replace `Icon` with a synchronous element (mirrors
 * packages/ui's identical stub) so components that render `<Icon icon="mdi:…" />` still exercise
 * the render path without any dangling network timer. Production is unaffected — test-scoped only.
 */
vi.mock('@iconify/react', () => ({
  Icon: ({ icon, className }: { icon: string; className?: string }) => (
    <svg data-icon={icon} className={className} aria-hidden="true" />
  ),
}))
