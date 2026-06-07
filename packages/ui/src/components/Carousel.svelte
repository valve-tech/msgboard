<script lang="ts" generics="T">
  import Icon from '@iconify/svelte'
  import type { Snippet } from 'svelte'

  type Props = {
    /** the cards to show */
    items: T[]
    /** renders one card for an item */
    card: Snippet<[T]>
    /** accessible label for the carousel region */
    label?: string
  }
  const { items, card, label = 'cards' }: Props = $props()

  let track = $state<HTMLDivElement>()
  let canPrev = $state(false)
  let canNext = $state(false)

  /** recompute whether the prev/next arrows are usable from the scroll position */
  const sync = () => {
    const el = track
    if (!el) return
    canPrev = el.scrollLeft > 4
    canNext = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
  }

  // re-evaluate the arrows once mounted and when the card set changes
  $effect(() => {
    void items.length
    sync()
  })

  /** scroll roughly one viewport of cards in `direction` (-1 prev, +1 next) */
  const page = (direction: number) => {
    const el = track
    if (!el) return
    el.scrollBy({ left: direction * el.clientWidth * 0.85, behavior: 'smooth' })
  }
</script>

<div class="relative" role="group" aria-roledescription="carousel" aria-label={label}>
  <!-- edge fades hint that the track scrolls -->
  <div
    class="pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-gradient-to-r from-white to-transparent transition-opacity duration-200 dark:from-gray-900 {canPrev
      ? 'opacity-100'
      : 'opacity-0'}">
  </div>
  <div
    class="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-white to-transparent transition-opacity duration-200 dark:from-gray-900 {canNext
      ? 'opacity-100'
      : 'opacity-0'}">
  </div>

  <div
    bind:this={track}
    onscroll={sync}
    class="no-scrollbar flex snap-x snap-mandatory gap-5 overflow-x-auto scroll-smooth py-4">
    {#each items as item (item)}
      <div class="flex shrink-0 basis-[86%] snap-start sm:basis-[47%] lg:basis-[31.5%]">
        {@render card(item)}
      </div>
    {/each}
  </div>

  <!-- arrow controls -->
  <div class="mt-2 flex items-center justify-center gap-3">
    <button
      type="button"
      onclick={() => page(-1)}
      disabled={!canPrev}
      aria-label="Previous"
      class="grid size-10 place-items-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm transition enabled:hover:-translate-y-0.5 enabled:hover:text-amber-600 disabled:opacity-30 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
      <Icon icon="mdi:chevron-left" class="size-6" />
    </button>
    <button
      type="button"
      onclick={() => page(1)}
      disabled={!canNext}
      aria-label="Next"
      class="grid size-10 place-items-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm transition enabled:hover:-translate-y-0.5 enabled:hover:text-amber-600 disabled:opacity-30 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
      <Icon icon="mdi:chevron-right" class="size-6" />
    </button>
  </div>
</div>

<style>
  /* hide the native scrollbar; the track still scrolls via swipe, trackpad, and the arrows */
  .no-scrollbar {
    scrollbar-width: none;
  }
  .no-scrollbar::-webkit-scrollbar {
    display: none;
  }
</style>
