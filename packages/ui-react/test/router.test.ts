import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { goto, pushState, useRoute, hashStore } from '../src/router'

beforeEach(() => {
  // reset hash to root between tests
  window.location.hash = ''
  hashStore.handleHashChange()
})

describe('hash router parity', () => {
  it("goto('#/docs') sets the route id and location.hash byte-identically", async () => {
    await goto('#/docs')
    expect(hashStore.getSnapshot().id).toBe('/docs')
    expect(window.location.hash).toBe('#/docs')
  })

  it("goto without a leading '#' throws", async () => {
    await expect(goto('/x')).rejects.toThrow(/must start with #/)
  })

  it("goto whose second char is not '/' throws", async () => {
    await expect(goto('#x')).rejects.toThrow(/second character must be \//)
  })

  it('a hashchange event updates the snapshot', () => {
    window.location.hash = '#/games'
    hashStore.handleHashChange()
    expect(hashStore.getSnapshot().id).toBe('/games')
  })

  it('defaults to / when the hash is empty', () => {
    window.location.hash = ''
    hashStore.handleHashChange()
    expect(hashStore.getSnapshot().id).toBe('/')
  })

  it('pushState delegates to goto', async () => {
    await pushState('#/examples')
    expect(hashStore.getSnapshot().id).toBe('/examples')
    expect(window.location.hash).toBe('#/examples')
  })
})

describe('useRoute hook (useSyncExternalStore)', () => {
  it('re-renders when the route changes', async () => {
    const { result } = renderHook(() => useRoute())
    expect(result.current.id).toBe('/')
    await act(async () => {
      await goto('#/games')
    })
    expect(result.current.id).toBe('/games')
  })
})
