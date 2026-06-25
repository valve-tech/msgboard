import { useEffect, useState } from 'react'
import { Icon } from '@iconify/react'

// rotating prefix word in the hero title; "MsgBoard" stays on its own line below
const words = ['Permissionless', 'Stamped by Work', 'Ephemeral', 'Distributed'] as const

// supported chains shown in the hero — one icon per distinct network logo.
const chains = [
  { id: '369', label: 'PulseChain' },
  { id: '1', label: 'Ethereum' },
]
const chainIcon = (id: string) => `https://gib.show/image/${id}?w=48&h=48&format=webp`

const scrollToInteractive = () => {
  document.scrollingElement?.scrollTo({
    top: document.querySelector('#interactive')?.getBoundingClientRect().top ?? 0,
    behavior: 'smooth',
  })
}

/** Ported from `Welcome.svelte` — the ink hero with a rotating prefix word. */
export function Welcome() {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    // hold the title still for users who prefer reduced motion
    if (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return
    const timer = setInterval(() => setIndex((i) => (i + 1) % words.length), 2200)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="relative overflow-hidden w-full bg-black text-white">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'radial-gradient(60% 55% at 50% 0%, rgba(245,158,11,0.20), transparent 70%)',
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.14]"
        style={{
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.5) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
      />

      <div className="relative m-auto flex w-full max-w-3xl flex-col items-center gap-5 px-5 py-14 text-center sm:gap-6 sm:py-20">
        <div className="grid size-12 place-items-center rounded-full bg-amber-400/10 ring-1 ring-amber-400/40 sm:size-14">
          <Icon icon="mdi:bullseye-arrow" className="size-7 text-amber-400 sm:size-8" />
        </div>

        <h1 className="flex flex-col items-center font-bold leading-[1.05] tracking-tight">
          <span className="grid place-items-center">
            <span
              key={index}
              style={{
                gridArea: '1 / 1',
                filter: 'drop-shadow(0 2px 20px rgba(245,158,11,0.35))',
              }}
              className="whitespace-nowrap bg-gradient-to-br from-amber-200 via-amber-400 to-orange-500 bg-clip-text text-3xl text-transparent sm:text-5xl md:text-6xl lg:text-7xl">
              {words[index]}
            </span>
          </span>
          <span className="text-3xl text-gray-50 sm:text-5xl md:text-6xl lg:text-7xl">
            MsgBoard
          </span>
        </h1>

        <p className="max-w-md px-2 text-sm font-light text-gray-400 text-pretty sm:max-w-xl sm:text-lg md:text-xl">
          Unstoppable, ephemeral messaging for any app.
          <br />
          No gas, no token, no account.
        </p>

        <div className="flex flex-col items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.2em] text-white/40">Supported on</span>
          <div className="flex flex-row items-center gap-3">
            {chains.map((c) => (
              <img
                key={c.id}
                src={chainIcon(c.id)}
                alt={c.label}
                title={c.label}
                className="size-7 rounded-full sm:size-8"
                loading="lazy"
              />
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
          <button
            className="cursor-pointer rounded-full bg-amber-400 px-6 py-2.5 text-sm font-semibold text-gray-950 shadow-lg shadow-amber-500/20 transition hover:bg-amber-300 sm:text-base"
            type="button"
            onClick={scrollToInteractive}>
            Try it now
          </button>
          <a
            href="#/docs"
            className="rounded-full px-5 py-2.5 text-sm text-gray-300 ring-1 ring-white/15 transition hover:text-white hover:ring-white/30 sm:text-base">
            Read the docs →
          </a>
        </div>
      </div>
    </div>
  )
}
