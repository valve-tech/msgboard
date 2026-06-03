import { tick } from 'svelte'

export class Page {
  private val = $state<{ raw: string; changing: boolean }>({
    raw: '/',
    changing: false,
  })
  get value() {
    return this.val.raw
  }
  get changing() {
    return this.val.changing
  }
  async finishChange() {
    await tick()
    this.val.changing = false
  }
  set value(raw: string) {
    history.pushState(null, '', `#${raw}`)
    this.val = {
      raw,
      changing: true,
    }
  }
  url = $derived.by(() => {
    return new URL(`${window.location.origin}${window.location.pathname}#${this.val}`)
  })
  params = $derived.by(() => {
    const [provider, fromChain, toChain, assetInAddress] = this.url.pathname.split('/').slice(1)
    if (provider && fromChain && toChain && assetInAddress) {
      return {
        provider,
        fromChain,
        toChain,
        assetInAddress,
      }
    }
    return {}
  })
  route = $derived.by(() => {
    return {
      id: this.val.raw,
    }
  })
}
export const page = new Page()

export class Navigating {
  to = $derived.by(() => {
    return page.changing ? page.value : null
  })
}

export const navigating = new Navigating()

export const goto = async (path: string) => {
  if (!path.startsWith('#')) {
    throw new Error('path must start with #')
  }
  const p = path.slice(1)
  if (!p.startsWith('/')) {
    throw new Error('second character must be /')
  }
  if (p === page.value) {
    return
  }
  page.value = p
  await page.finishChange()
}
const handleHashChange = async () => {
  const current = location.hash.slice(1) || '/'
  if (current !== page.value) {
    page.value = current
  }
  await page.finishChange()
}
window.addEventListener('hashchange', handleHashChange)
window.addEventListener('popstate', handleHashChange)
window.addEventListener('load', handleHashChange)
handleHashChange()

export const pushState = async (path: string, state?: Record<string, unknown>) => {
  await goto(path)
}

export const browser = typeof window !== 'undefined'
