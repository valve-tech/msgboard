import { useEffect, useState } from 'react'

/**
 * useReveal — the shared "spin then settle on the committed value" helper. Every game object uses it
 * so timing stays consistent across the catalog.
 *
 * HARD RULE (see the design spec, Provably-fair binding): the flurry is pure presentation. It NEVER
 * generates or influences the result. The value the hook rests on is always the `finalValue` it is
 * handed — the sealed outcome from the co-signed session. The random frames shown mid-flurry are
 * decoration only; they never decide anything.
 *
 * Accessibility: under `prefers-reduced-motion` (or in Node/SSR, where there is no `matchMedia`) the
 * hook skips the flurry and sets `finalValue` at once.
 */

/** Default flurry length in milliseconds. */
export const DEFAULT_FLURRY_MS = 850

/** Read the OS reduced-motion setting. Returns false when `matchMedia` is unavailable (Node/SSR). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** A random roll percent in [0, 99.99] on the 2-decimal grid. Pure — the caller supplies `rand`, so
 *  it is deterministic under test. Used only for flurry frames, never for an outcome. */
export function randomRollPercent(rand: () => number = Math.random): number {
  const clamped = Math.min(0.999999, Math.max(0, rand()))
  return Math.floor(clamped * 10_000) / 100
}

export type RevealResult = {
  /** The value to show now: a flurry frame while spinning, then the settled `finalValue`. */
  value: number | undefined
  /** True while the flurry runs. */
  flurrying: boolean
}

export type RevealOptions = {
  /** Flurry length in ms. Defaults to `DEFAULT_FLURRY_MS`. */
  durationMs?: number
  /** Changing this replays the flurry — pass the round number so each new roll spins again. */
  nonce?: unknown
  /** Force the reduced-motion path on/off. Defaults to the OS setting via `prefersReducedMotion()`. */
  reducedMotion?: boolean
}

/**
 * Spin, then settle on `finalValue`.
 *
 * The resting state (and the SSR/first render) is `finalValue`, so a static render always shows the
 * real result — that is what makes the no-JS and reduced-motion paths correct by construction.
 */
export function useReveal(finalValue: number | undefined, opts?: RevealOptions): RevealResult {
  const durationMs = opts?.durationMs ?? DEFAULT_FLURRY_MS
  const nonce = opts?.nonce
  const forcedReduced = opts?.reducedMotion

  const [value, setValue] = useState<number | undefined>(finalValue)
  const [flurrying, setFlurrying] = useState(false)

  useEffect(() => {
    if (finalValue === undefined) {
      setValue(undefined)
      setFlurrying(false)
      return
    }
    const reduced = forcedReduced ?? prefersReducedMotion()
    if (reduced) {
      setValue(finalValue)
      setFlurrying(false)
      return
    }

    setFlurrying(true)
    const interval = setInterval(() => setValue(randomRollPercent()), 60)
    const timer = setTimeout(() => {
      clearInterval(interval)
      setValue(finalValue)
      setFlurrying(false)
    }, durationMs)

    return () => {
      clearInterval(interval)
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finalValue, nonce, durationMs, forcedReduced])

  return { value, flurrying }
}
