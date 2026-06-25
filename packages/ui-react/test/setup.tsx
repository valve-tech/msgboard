import { vi } from 'vitest'

/**
 * Test-only stub for `@iconify/react`.
 *
 * In jsdom there is no network, so the real `Icon` lazy-loads icon data for non-bundled sets
 * (`mdi:*`, `ph:*`, …) over the Iconify API and defers the resulting state update through an
 * internal `setTimeout`. That timer fires *after* the test environment is torn down, surfacing
 * as noisy "caught after teardown" errors. We replace `Icon` with a synchronous element that
 * still reflects the swap faithfully: it renders an inline `<svg>` and carries the requested
 * icon name on `data-icon`, so the `@iconify/svelte` → `@iconify/react` migration is exercised
 * (components import `Icon` from `@iconify/react` and pass `icon=`/`className`) without any
 * dangling network timer. Production is unaffected — this mock is test-scoped only.
 */
vi.mock('@iconify/react', () => ({
  Icon: ({ icon, className }: { icon: string; className?: string }) => (
    <svg data-icon={icon} className={className} aria-hidden="true" />
  ),
}))
