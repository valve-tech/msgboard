/**
 * Deep-link params for the "Try it" surface — so a URL restores the exact view (which the user
 * can share, e.g. the "Demo: talk to yourself" pane).
 *
 * The app is a HASH router (the route lives in `location.hash`), so the query string in
 * `location.search` is free for this state. We read/write three params:
 *
 *   ?tab=chat|mechanics|arcade   — the TryIt section
 *   &mode=public|anonymous|encrypted|direct — the Chat privacy mode
 *   &demo=encrypted|direct       — the TwoUserDemo "talk to yourself" overlay (omitted when closed)
 *
 * Reads are validated (garbage → undefined, so callers fall back to their own defaults). Writes go
 * through `history.replaceState` (NEVER pushState — a mode/tab flip must not spawn a history entry)
 * and PRESERVE the current pathname + hash, so the router is untouched. Each writer patches only its
 * own key; the others survive, so the three independent components compose one URL without clobbering.
 */

export type TabId = 'chat' | 'mechanics' | 'arcade'
export type ChatMode = 'public' | 'anonymous' | 'encrypted' | 'direct'
export type DemoKind = 'encrypted' | 'direct'

const TABS: readonly TabId[] = ['chat', 'mechanics', 'arcade']
const MODES: readonly ChatMode[] = ['public', 'anonymous', 'encrypted', 'direct']
const DEMOS: readonly DemoKind[] = ['encrypted', 'direct']

export interface DeepLink {
  tab?: TabId
  mode?: ChatMode
  demo?: DemoKind
}

const currentParams = (): URLSearchParams => {
  try {
    return new URLSearchParams(window.location.search)
  } catch {
    return new URLSearchParams()
  }
}

/** Read + validate the deep-link params. Missing or invalid values come back as `undefined`. */
export function readDeepLink(): DeepLink {
  const p = currentParams()
  const tab = p.get('tab')
  const mode = p.get('mode')
  const demo = p.get('demo')
  return {
    tab: tab && TABS.includes(tab as TabId) ? (tab as TabId) : undefined,
    mode: mode && MODES.includes(mode as ChatMode) ? (mode as ChatMode) : undefined,
    demo: demo && DEMOS.includes(demo as DemoKind) ? (demo as DemoKind) : undefined,
  }
}

/**
 * Patch one or more deep-link params in place. Pass `null`/`''` to DROP a key. Reads the live params
 * fresh so independent callers merge instead of overwrite; uses `replaceState` and keeps path + hash.
 */
export function writeDeepLink(patch: Partial<Record<'tab' | 'mode' | 'demo', string | null>>): void {
  try {
    const p = currentParams()
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === '') p.delete(key)
      else p.set(key, value)
    }
    const qs = p.toString()
    const url = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
    window.history.replaceState(window.history.state, '', url)
  } catch {
    /* no History API (SSR / locked-down env) — deep-linking is a progressive enhancement */
  }
}

/** The current full URL — what a "copy link" affordance shares (after writers have synced it). */
export function currentShareUrl(): string {
  try {
    return window.location.href
  } catch {
    return ''
  }
}
