import { useState } from 'react'
import { Icon } from '@iconify/react'
import { Channel } from './Channel'
import { ZkChat } from './ZkChat'
import { Interactive } from './Interactive'

/**
 * The "Try it" shell — flippable sections over one board. The room comes first: a visitor's first
 * question is "what is everyone saying?", not "how is a message encoded?" So Channel (a live IRC
 * room) leads, ZK Chat (post anonymously behind a membership proof) sits beside it, and the raw
 * compose-and-inspect mechanics move to their own tab for people who want to see the wire format.
 *
 * Each tab is a self-contained experience that drives the shared chain store; switching is free
 * (the board content is polled once for the whole page).
 */

type SectionId = 'channel' | 'zk' | 'mechanics'

const SECTIONS: { id: SectionId; label: string; icon: string; blurb: string }[] = [
  { id: 'channel', label: 'Channel', icon: 'mdi:pound', blurb: 'a live room — join a channel, read it, say something' },
  { id: 'zk', label: 'ZK Chat', icon: 'mdi:incognito', blurb: 'post anonymously behind a zero-knowledge membership proof' },
  { id: 'mechanics', label: 'Mechanics', icon: 'mdi:cog-outline', blurb: 'compose a raw message and watch the proof-of-work + wire format' },
]

export function TryIt({ workerFactory }: { workerFactory?: () => Worker }) {
  const [active, setActive] = useState<SectionId>('channel')
  const current = SECTIONS.find((s) => s.id === active)!

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="try it sections">
        {SECTIONS.map((s) => {
          const on = s.id === active
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={on}
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

      {/* Each section stays mounted-per-switch (simple remount) — cheap, and it resets transient
          composer state cleanly when you flip away and back. */}
      {active === 'channel' && <Channel workerFactory={workerFactory} />}
      {active === 'zk' && <ZkChat />}
      {active === 'mechanics' && <Interactive workerFactory={workerFactory} />}
    </div>
  )
}
