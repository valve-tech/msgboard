import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * MultiWheel — the prize-wheel surface for the spin games (Wheel). A ring of equal segments, each
 * tinted by its payout tier, under a fixed top pointer with a hub readout in the middle.
 *
 * The spin is honest: the screen feeds the round's `landed` segment (recomputed from the sealed
 * `raw` as `raw % segments` — exactly what `wheelSegment` settles) and a `spinId` that bumps per
 * round; the rotor turns several full revolutions and decelerates to rest with that segment's centre
 * under the pointer. Game-agnostic — a screen supplies the per-segment `segs` (tier for colour) and
 * the `hub` content; the wheel owns only the rotation.
 */
export type WheelSeg = { tier: 'lo' | 'mid' | 'hi' }

const TIER_FILL: Record<WheelSeg['tier'], string> = {
  lo: '#7d2233', // deep carpet red — a losing / low segment
  mid: '#c9a227', // brass — a modest multiplier
  hi: '#2fae6a', // green — a spike / jackpot
}
const FULL_TURNS = 5 // revolutions of drama per spin

export const MultiWheel = ({ segs, landed, spinId, hub, idleHint }: {
  segs: WheelSeg[]
  /** the settled segment index [0, segments-1]; undefined until a spin lands. */
  landed?: number
  /** bump to (re)spin to the latest `landed`. */
  spinId: number
  /** centre-of-hub readout (the multiplier / call to spin). */
  hub: ReactNode
  /** copy shown under the wheel before the first spin. */
  idleHint?: string
}) => {
  const segments = segs.length
  const [rot, setRot] = useState(0)
  const turns = useRef(0)

  useEffect(() => {
    if (landed === undefined || segments === 0) return
    turns.current += FULL_TURNS
    const seg = 360 / segments
    // conic wedges run clockwise from the top; bring segment `landed`'s centre back under the pointer.
    setRot(turns.current * 360 - (landed + 0.5) * seg)
    // spinId is the trigger; landed/segments are read fresh each spin.
  }, [spinId]) // eslint-disable-line react-hooks/exhaustive-deps

  const seg = segments > 0 ? 360 / segments : 0
  const wedges = segs
    .map((s, i) => `${TIER_FILL[s.tier]} ${(i * seg).toFixed(3)}deg ${((i + 1) * seg).toFixed(3)}deg`)
    .join(', ')
  const spun = landed !== undefined

  return (
    <div className="mw-scene">
      <div className="mw-stage">
        <div className="mw-pointer" aria-hidden />
        <div
          className="mw-rotor"
          style={{ transform: `rotate(${rot}deg)`, background: segments > 0 ? `conic-gradient(${wedges})` : undefined }}
        >
          <div
            className="mw-seps"
            style={{ background: `repeating-conic-gradient(#06100acc 0deg ${(seg * 0.045).toFixed(3)}deg, transparent ${(seg * 0.045).toFixed(3)}deg ${seg.toFixed(3)}deg)` }}
            aria-hidden
          />
        </div>
        <div className="mw-rim" aria-hidden />
        <div className={`mw-hub${spun ? ' spun' : ''}`}>{hub}</div>
      </div>
      {!spun && idleHint && <div className="mw-hint">{idleHint}</div>}
    </div>
  )
}
