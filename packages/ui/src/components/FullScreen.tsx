import { type ReactNode } from 'react'

type Props = {
  children: ReactNode
  id?: string
  className?: string
}

/**
 * A full-width section frame — padding, borders and centring, nothing else.
 *
 * This wrapper (ported from `FullScreen.svelte`) used to scale and fade its content by scroll
 * position. The landing page applies it to exactly one section, the interactive demo, so that block
 * alone rendered at 77% scale and 63% opacity until the reader scrolled it to the middle of the
 * viewport, and its upward translate overlapped the cards above it. The section is taller than a
 * phone viewport, so it could never be both centred and whole. The effect is gone. Keep the DOM
 * shape (frame + inner grow div) so the layout does not move.
 */
export function FullScreen({ children, id, className = '' }: Props) {
  return (
    <div
      className={`flex grow items-center justify-center flex-row py-24 border-y border-gray-200 dark:border-gray-700 ${className}`}
      id={id}>
      <div className="w-full flex grow">{children}</div>
    </div>
  )
}
