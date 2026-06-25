import { useSyncExternalStore } from 'react'

/**
 * Ported hash router (from `page.svelte.ts`) — NOT react-router.
 *
 * The route is `location.hash` minus the leading `#` (e.g. `#/docs` → id `/docs`); an empty
 * hash means `/`. URLs are byte-identical to the Svelte app. A `hashStore` singleton exposes
 * `subscribe`/`getSnapshot` for `useSyncExternalStore`, and `goto`/`pushState` keep the same
 * `#`-then-`/` validation `goto()` enforced in Svelte.
 */

export type Route = { id: string }

const computeId = (): string => {
  if (typeof window === 'undefined') return '/'
  return window.location.hash.slice(1) || '/'
}

type Listener = () => void

const createHashStore = () => {
  const listeners = new Set<Listener>()
  let snapshot: Route = { id: computeId() }

  const emit = () => listeners.forEach((l) => l())

  /** Recompute the snapshot from `location.hash`; notify subscribers when it changed. */
  const handleHashChange = () => {
    const id = computeId()
    if (id !== snapshot.id) {
      snapshot = { id }
      emit()
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', handleHashChange)
    window.addEventListener('popstate', handleHashChange)
    window.addEventListener('load', handleHashChange)
  }

  return {
    subscribe(listener: Listener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot(): Route {
      return snapshot
    },
    handleHashChange,
    /** set the hash (history.pushState + recompute), mirroring `Page.value` setter */
    push(raw: string) {
      history.pushState(null, '', `#${raw}`)
      snapshot = { id: raw }
      emit()
    },
  }
}

export const hashStore = createHashStore()

/** Route hook; re-renders subscribers when the hash changes (useSyncExternalStore). */
export const useRoute = (): Route =>
  useSyncExternalStore(hashStore.subscribe, hashStore.getSnapshot, hashStore.getSnapshot)

/** Navigate, keeping the same `#`-then-`/` validation as the Svelte `goto`. */
export const goto = async (path: string): Promise<void> => {
  if (!path.startsWith('#')) {
    throw new Error('path must start with #')
  }
  const p = path.slice(1)
  if (!p.startsWith('/')) {
    throw new Error('second character must be /')
  }
  if (p === hashStore.getSnapshot().id) {
    return
  }
  hashStore.push(p)
}

export const pushState = async (
  path: string,
  _state?: Record<string, unknown>,
): Promise<void> => {
  await goto(path)
}

export const browser = typeof window !== 'undefined'
