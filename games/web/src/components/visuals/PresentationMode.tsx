import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { readMode, writeMode, DEFAULT_PRESENTATION_MODE, type PresentationMode } from './presentationStore'

/**
 * PresentationMode context — the React half of the visual/classic toggle. It holds the current mode,
 * persists every change to the shared `localStorage` key, and exposes a setter. A single
 * `<PresentationToggle />` sits in the game-stage header and drives it.
 *
 * The pure read/write logic lives in `presentationMode.ts`; this file only wires it to React.
 */

type PresentationCtx = {
  mode: PresentationMode
  setMode: (m: PresentationMode) => void
}

/** No-provider fallback: default mode, no persistence. Keeps a stray screen from crashing and never
 *  calls a hook conditionally. Wrap the app in `<PresentationModeProvider>` for the real thing. */
const FALLBACK: PresentationCtx = { mode: DEFAULT_PRESENTATION_MODE, setMode: () => {} }

const Context = createContext<PresentationCtx | undefined>(undefined)

const browserStore = (): Storage | undefined =>
  typeof localStorage !== 'undefined' ? localStorage : undefined

export const PresentationModeProvider = ({ children }: { children: ReactNode }) => {
  // First render uses the default so server and client markup match; a mount effect then syncs the
  // stored choice. This avoids a hydration mismatch and works when storage is unavailable.
  const [mode, setModeState] = useState<PresentationMode>(DEFAULT_PRESENTATION_MODE)

  useEffect(() => {
    const stored = readMode(browserStore())
    if (stored !== mode) setModeState(stored)
    // Run once on mount — we want the stored value, not a re-sync on every mode change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setMode = useCallback((m: PresentationMode) => {
    setModeState(m)
    writeMode(browserStore(), m)
  }, [])

  const value = useMemo(() => ({ mode, setMode }), [mode, setMode])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

/** Read the active presentation mode and its setter. Safe outside a provider (returns the default). */
export const usePresentationMode = (): PresentationCtx => useContext(Context) ?? FALLBACK

/**
 * PresentationToggle — the header control. A real two-button pair (Visual | Classic), not a native
 * control, so it styles cleanly and keeps focus states. Each button reports `aria-pressed`.
 */
export const PresentationToggle = () => {
  const { mode, setMode } = usePresentationMode()
  return (
    <span className="presmode" role="group" aria-label="Table view">
      <button
        type="button"
        className={`presmode-opt${mode === 'visual' ? ' on' : ''}`}
        aria-pressed={mode === 'visual'}
        onClick={() => setMode('visual')}
      >
        Visual
      </button>
      <button
        type="button"
        className={`presmode-opt${mode === 'classic' ? ' on' : ''}`}
        aria-pressed={mode === 'classic'}
        onClick={() => setMode('classic')}
      >
        Classic
      </button>
    </span>
  )
}
