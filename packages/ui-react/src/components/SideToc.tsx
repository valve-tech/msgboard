import { useEffect, useState } from 'react'
import { scrollToSection, getSectionParam, setSectionParam } from '../lib/section-nav'

type Section = { id: string; label: string }
type Props = { sections: Section[] }

/**
 * Ported from `SideToc.svelte` — a sticky side table of contents that highlights the section
 * nearest the top of the viewport (IntersectionObserver) and deep-links via `?section=`.
 */
export function SideToc({ sections }: Props) {
  const [activeId, setActiveId] = useState(sections[0]?.id ?? '')

  const go = (id: string) => {
    scrollToSection(id)
    setActiveId(id)
    setSectionParam(id)
  }

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const tops = new Map<string, number>()
    const observer = new IntersectionObserver(
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
        if (best) setActiveId((prev) => (best !== prev ? best! : prev))
      },
      { rootMargin: '-15% 0px -70% 0px', threshold: 0 },
    )
    for (const section of sections) {
      const el = document.getElementById(section.id)
      if (el) observer.observe(el)
    }

    // honor a deep link (?section=) on first load
    const initial = getSectionParam()
    if (initial && sections.some((s) => s.id === initial)) {
      setActiveId(initial)
      requestAnimationFrame(() => scrollToSection(initial))
    }
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections])

  return (
    <nav
      className="fixed left-4 top-1/2 z-40 hidden max-h-[80vh] w-44 -translate-y-1/2 overflow-y-auto xl:block"
      aria-label="On this page">
      <ul className="flex flex-col gap-0.5 border-l border-gray-200 pl-3 text-sm dark:border-gray-700">
        {sections.map((section) => (
          <li key={section.id}>
            <button
              type="button"
              onClick={() => go(section.id)}
              aria-current={activeId === section.id ? 'true' : undefined}
              className={`block w-full truncate py-0.5 text-left transition ${
                activeId === section.id
                  ? 'font-semibold text-amber-600 dark:text-amber-400'
                  : 'text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200'
              }`}
              title={section.label}>
              {section.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
