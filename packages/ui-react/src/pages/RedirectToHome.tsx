import { useEffect } from 'react'
import { goto } from '../router'

/** Ported from `pages/RedirectToHome.svelte` — navigates to `#/` on mount (unknown route). */
export function RedirectToHome() {
  useEffect(() => {
    void goto('#/')
  }, [])
  return null
}
