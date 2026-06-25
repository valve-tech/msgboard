import { useEffect, useRef, useState, type ReactNode } from 'react'

type Props = {
  children: ReactNode
  id?: string
  className?: string
}

/**
 * Ported from `FullScreen.svelte` — a section wrapper that scales/fades its content
 * based on its scroll position (parallax-ish), driven by an IntersectionObserver.
 */
export function FullScreen({ children, id, className = '' }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [topFromMid, setTopFromMid] = useState(0)
  const [height, setHeight] = useState(0)

  const translateYMax = 0
  const scaleMax = 1
  const scaleMin = 0.75
  const opacityMax = 1
  const opacityMin = 0.6

  const percent = Math.max(0, height ? (topFromMid - height / 2) / height : 0)
  const translateYMin = -Math.max(height / 3, 96)
  const translate = translateYMax - percent * (translateYMax - translateYMin)
  const opacity = opacityMax - percent * (opacityMax - opacityMin)
  const scale = scaleMax - percent * (scaleMax - scaleMin)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const { boundingClientRect } = entry
          setTopFromMid(Math.max(boundingClientRect.top, 0))
          setHeight(boundingClientRect.height)
        })
      },
      { threshold: Array.from({ length: 200 }, (_, i) => i / 200) },
    )
    observer.observe(el)
    return () => {
      observer.unobserve(el)
      observer.disconnect()
    }
  }, [])

  return (
    <div
      ref={ref}
      className={`flex grow items-center justify-center flex-row py-24 border-y border-gray-200 dark:border-gray-700 ${className}`}
      id={id}>
      <div
        className="w-full flex grow"
        style={{ transform: `translateY(${translate}px) scale(${scale})`, opacity }}>
        {children}
      </div>
    </div>
  )
}
