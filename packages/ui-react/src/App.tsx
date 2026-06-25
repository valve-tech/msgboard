import { useEffect } from 'react'
import { startChainPolling } from './stores/chain'
import { initThemeOSListener } from './stores/theme'
import { useRoute } from './router'
import { Home } from './pages/Home'
import { DocsPortal } from './pages/DocsPortal'
import { Examples } from './pages/Examples'
import { Games } from './pages/Games'
import { RedirectToHome } from './pages/RedirectToHome'

/**
 * App shell — the full hash-routed application (Task 5).
 *
 * Mounts the two global lifecycle helpers the Task-3 stores export:
 *   - `startChainPolling()` — the 20s content poll (+ an immediate load)
 *   - `initThemeOSListener()` — re-applies the theme on OS scheme changes while preference is
 *     "system"
 * Both return a cleanup; we tear them down on unmount.
 *
 * The route is `location.hash` (the Task-3 ported hash router, NOT react-router). Every
 * `#/route` the Svelte `App.svelte` served resolves to the same page here:
 *   `#/` → Home · `#/docs` → DocsPortal · `#/examples` → Examples · `#/games` → Games ·
 *   anything else → RedirectToHome (→ `#/`).
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

  const { id } = useRoute()

  return (
    <main className="min-h-screen w-full bg-white dark:bg-gray-950">
      {id === '/' ? (
        <Home />
      ) : id === '/docs' ? (
        <DocsPortal />
      ) : id === '/examples' ? (
        <Examples />
      ) : id === '/games' ? (
        <Games />
      ) : (
        <RedirectToHome />
      )}
    </main>
  )
}
