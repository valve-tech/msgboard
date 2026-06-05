<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { scrollToSection, getSectionParam, setSectionParam } from '../lib/section-nav'

  type Section = { id: string; label: string }
  let { sections }: { sections: Section[] } = $props()

  let activeId = $state(sections[0]?.id ?? '')
  let observer: IntersectionObserver | undefined

  const go = (id: string) => {
    scrollToSection(id)
    activeId = id
    setSectionParam(id)
  }

  onMount(() => {
    // Track which section is nearest the top of the viewport. The IntersectionObserver
    // fires only when a section crosses the band, so updating the URL here is not noisy.
    const tops = new Map<string, number>()
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) tops.set(entry.target.id, entry.boundingClientRect.top)
          else tops.delete(entry.target.id)
        }
        let best: string | null = null
        let bestTop = Infinity
        for (const [id, top] of tops) {
          if (top < bestTop) {
            bestTop = top
            best = id
          }
        }
        // scrolling drives only the highlight; the URL's ?section= reflects an
        // explicit click (so a shared link is never a mid-scroll artifact).
        if (best && best !== activeId) {
          activeId = best
        }
      },
      // active "band" sits in the upper third of the viewport
      { rootMargin: '-15% 0px -70% 0px', threshold: 0 },
    )
    for (const section of sections) {
      const el = document.getElementById(section.id)
      if (el) observer.observe(el)
    }

    // honor a deep link (?section=) on first load
    const initial = getSectionParam()
    if (initial && sections.some((s) => s.id === initial)) {
      activeId = initial
      requestAnimationFrame(() => scrollToSection(initial))
    }
  })
  onDestroy(() => observer?.disconnect())
</script>

<!-- floating, sticky side table of contents; hidden on narrow screens -->
<nav
  class="fixed left-4 top-1/2 z-40 hidden max-h-[80vh] w-44 -translate-y-1/2 overflow-y-auto xl:block"
  aria-label="On this page">
  <ul class="flex flex-col gap-0.5 border-l border-gray-200 pl-3 text-sm dark:border-gray-700">
    {#each sections as section}
      <li>
        <button
          type="button"
          onclick={() => go(section.id)}
          aria-current={activeId === section.id ? 'true' : undefined}
          class="block w-full truncate py-0.5 text-left transition
            {activeId === section.id
            ? 'font-semibold text-amber-600 dark:text-amber-400'
            : 'text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200'}"
          title={section.label}>
          {section.label}
        </button>
      </li>
    {/each}
  </ul>
</nav>
