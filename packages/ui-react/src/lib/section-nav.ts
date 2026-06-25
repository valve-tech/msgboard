// Section deep-linking that layers on the hash router. The router (lib/page.svelte.ts)
// reads only `location.hash` for the route, so we keep the active section in
// `location.search` (?section=<id>) where it can't disturb routing.

/** Stable id from a heading/label, matching the markdown-it heading-id rule. */
export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .trim()
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '')

export const scrollToSection = (id: string): void => {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

export const getSectionParam = (): string | null =>
  new URLSearchParams(window.location.search).get('section')

/** Update ?section= without touching the route (preserves pathname + hash). */
export const setSectionParam = (id: string | null): void => {
  const params = new URLSearchParams(window.location.search)
  if (id) params.set('section', id)
  else params.delete('section')
  const query = params.toString()
  const url = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`
  window.history.replaceState(window.history.state, '', url)
}
