/**
 * Presentation-mode store — the pure, framework-free half of the visual/classic toggle.
 *
 * The catalog has two ways to watch a game settle:
 *   - `visual`  — the game object animates and lands on the sealed result (the default).
 *   - `classic` — the number-first probability strip + stat tiles (the opt-out).
 *
 * One key, all games (the owner's decision): a player picks a house style once. These helpers read
 * and write that key. They take an injected store so a Node test can drive them without a DOM.
 */

export type PresentationMode = 'visual' | 'classic'

/** The single localStorage key that holds the player's choice for every game. */
export const PRESENTATION_STORAGE_KEY = 'mbg:presentation-mode'

/** The house default. Players opt OUT of visual, never into it. */
export const DEFAULT_PRESENTATION_MODE: PresentationMode = 'visual'

const isMode = (v: unknown): v is PresentationMode => v === 'visual' || v === 'classic'

/** The slice of the Web Storage API these helpers use. A fake object satisfies it in tests. */
export interface ModeStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Read the saved mode. Falls back to the default when the store is absent, unreadable, or holds
 *  anything other than a known mode. */
export function readMode(store?: ModeStore | null): PresentationMode {
  if (!store) return DEFAULT_PRESENTATION_MODE
  try {
    const raw = store.getItem(PRESENTATION_STORAGE_KEY)
    return isMode(raw) ? raw : DEFAULT_PRESENTATION_MODE
  } catch {
    return DEFAULT_PRESENTATION_MODE
  }
}

/** Persist the mode. Swallows a storage error (private mode / disabled) — the choice just won't
 *  survive a reload. */
export function writeMode(store: ModeStore | null | undefined, mode: PresentationMode): void {
  if (!store) return
  try {
    store.setItem(PRESENTATION_STORAGE_KEY, mode)
  } catch {
    // storage unavailable — non-fatal
  }
}
