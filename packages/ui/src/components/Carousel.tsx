import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'

type Props<T> = {
  /** the cards to show */
  items: T[]
  /** renders one card for an item */
  card: (item: T) => ReactNode
  /** accessible label for the carousel region */
  label?: string
}

/**
 * Ported from `Carousel.svelte` (generic over the card item type) — a horizontally scrollable
 * track of cards with prev/next arrows whose enabled state tracks the scroll position.
 */
export function Carousel<T>({ items, card, label = 'cards' }: Props<T>) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [canPrev, setCanPrev] = useState(false)
  const [canNext, setCanNext] = useState(false)

  const sync = useCallback(() => {
    const el = trackRef.current
    if (!el) return
    setCanPrev(el.scrollLeft > 4)
    setCanNext(el.scrollLeft + el.clientWidth < el.scrollWidth - 4)
  }, [])

  // re-evaluate the arrows once mounted and when the card set changes
  useEffect(() => {
    sync()
  }, [items.length, sync])

  const page = (direction: number) => {
    const el = trackRef.current
    if (!el) return
    el.scrollBy({ left: direction * el.clientWidth * 0.85, behavior: 'smooth' })
  }

  return (
    <div className="relative" role="group" aria-roledescription="carousel" aria-label={label}>
      <div
        className={`pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-gradient-to-r from-white to-transparent transition-opacity duration-200 dark:from-gray-900 ${
          canPrev ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div
        className={`pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-white to-transparent transition-opacity duration-200 dark:from-gray-900 ${
          canNext ? 'opacity-100' : 'opacity-0'
        }`}
      />

      <div
        ref={trackRef}
        onScroll={sync}
        className="no-scrollbar flex snap-x snap-mandatory gap-5 overflow-x-auto scroll-smooth py-4"
        style={{ scrollbarWidth: 'none' }}>
        {items.map((item, i) => (
          <div
            key={i}
            className="flex shrink-0 basis-[86%] snap-start sm:basis-[47%] lg:basis-[31.5%]">
            {card(item)}
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => page(-1)}
          disabled={!canPrev}
          aria-label="Previous"
          className="grid size-10 place-items-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm transition enabled:hover:-translate-y-0.5 enabled:hover:text-amber-600 disabled:opacity-30 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
          <Icon icon="mdi:chevron-left" className="size-6" />
        </button>
        <button
          type="button"
          onClick={() => page(1)}
          disabled={!canNext}
          aria-label="Next"
          className="grid size-10 place-items-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm transition enabled:hover:-translate-y-0.5 enabled:hover:text-amber-600 disabled:opacity-30 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
          <Icon icon="mdi:chevron-right" className="size-6" />
        </button>
      </div>
    </div>
  )
}
