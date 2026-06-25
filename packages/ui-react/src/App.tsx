import { useEffect } from 'react'
import { startChainPolling } from './stores/chain'
import { initThemeOSListener } from './stores/theme'
import { Interactive } from './components/Interactive'

/**
 * App shell for the MVP vertical slice (Task 4).
 *
 * Mounts the two global lifecycle helpers the Task-3 stores exported but left unmounted:
 *   - `startChainPolling()` — the 20s content poll (+ an immediate load)
 *   - `initThemeOSListener()` — re-applies the theme on OS scheme changes while preference is
 *     "system"
 * Both return a cleanup; we tear them down on unmount.
 *
 * The core screen is the `Interactive` post/PoW flow (SelectChain → compose → grind in the
 * Web Worker seam → post → board updates → Terminal/TreeView). The full landing-page
 * sections + hash router land in Task 5.
 */
export function App() {
  useEffect(() => {
    const stopPolling = startChainPolling()
    const stopThemeListener = initThemeOSListener()
    return () => {
      stopPolling()
      stopThemeListener()
    }
  }, [])

  return (
    <main className="min-h-screen w-full bg-gray-50 dark:bg-gray-900">
      <div
        id="interactive-container"
        className="flex bg-gray-50 dark:bg-gray-900 w-full flex-row items-center justify-center shadow py-8"
      >
        <Interactive />
      </div>
    </main>
  )
}
