import { useState } from 'react'
import { Icon } from '@iconify/react'
import { Chat } from './Chat'
import { Interactive } from './Interactive'
import { Arcade } from './Arcade'

/**
 * The "Try it" shell — flippable sections over one board. The room comes first: a visitor's first
 * question is "what is everyone saying?", not "how is a message encoded?" So Chat (a live room with
 * a privacy-mode toggle — Public / Anonymous / Encrypted, absorbing the former Channel + Whisper)
 * leads, and the raw compose-and-inspect mechanics move to their own tab for people who want to see
 * the wire format.
 *
 * Each tab is a self-contained experience that drives the shared chain store; switching is free
 * (the board content is polled once for the whole page).
 */

type SectionId = 'chat' | 'mechanics' | 'arcade'

const SECTIONS: { id: SectionId; label: string; icon: string; blurb: string }[] = [
  { id: 'chat', label: 'Chat', icon: 'mdi:chat-outline', blurb: 'a live room — pick a privacy mode (public, anonymous, or encrypted) and say something' },
  { id: 'mechanics', label: 'Mechanics', icon: 'mdi:cog-outline', blurb: 'compose a raw message and watch the proof-of-work + wire format' },
  { id: 'arcade', label: 'Arcade', icon: 'mdi:dice-multiple', blurb: 'a provably-fair coin flip over the board — the arcade\'s whole thesis in one tab' },
]

export function TryIt({ workerFactory }: { workerFactory?: () => Worker }) {
  const [active, setActive] = useState<SectionId>('chat')
  const current = SECTIONS.find((s) => s.id === active)!

  // ONE container, ONE width for everything — the tab row AND every tab's content share the same
  // max-width and left edge, so nothing floats in a wider frame and nothing resizes when you switch
  // tabs or chat modes. Content fills the container (no per-tab width, no re-centering); the inner
  // cards are w-full so they span it too.
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="try it sections">
        {SECTIONS.map((s) => {
          const on = s.id === active
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={on}
              title={s.blurb}
              onClick={() => setActive(s.id)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
                on
                  ? 'bg-indigo-600 text-white'
                  : 'text-gray-600 ring-1 ring-gray-300 hover:text-gray-900 hover:ring-gray-400 dark:text-gray-300 dark:ring-gray-600 dark:hover:text-white'
              }`}>
              <Icon icon={s.icon} className="size-4" />
              {s.label}
            </button>
          )
        })}
      </div>
      <p className="px-1 text-sm text-gray-500 dark:text-gray-400">{current.blurb}</p>

      {/* Content fills the same container as the tabs (one width, one left edge). Each section stays
          mounted-per-switch (simple remount) — cheap, and it resets transient composer state cleanly
          when you flip away and back. */}
      {active === 'chat' && <Chat workerFactory={workerFactory} />}
      {active === 'mechanics' && <Interactive workerFactory={workerFactory} />}
      {active === 'arcade' && <Arcade workerFactory={workerFactory} />}
    </div>
  )
}
