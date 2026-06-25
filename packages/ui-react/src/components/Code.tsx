import { shiki } from '../lib/highlighter'
import { Copy } from './Copy'

type Props = {
  code?: string
  lang?: string
  theme?: string
  base?: string
  rounded?: string
  shadow?: string
  classes?: string
  preBase?: string
  prePadding?: string
  preClasses?: string
}

/**
 * Ported from `Code.svelte` — a shiki-highlighted code block (shared `shiki` instance, also
 * used by the docs markdown renderer) with a copy button.
 */
export function Code({
  code = '',
  lang = 'shell',
  theme = 'dark-plus',
  base = ' relative overflow-hidden [&>pre]:overflow-x-auto',
  rounded = 'rounded-2xl',
  shadow = '',
  classes = '',
  preBase = '',
  prePadding = '[&>pre]:p-3',
  preClasses = '',
}: Props) {
  const generatedHtml = shiki.codeToHtml(code, { lang, theme })
  return (
    <div className="relative">
      <div
        className={`${base} ${rounded} ${shadow} ${classes} ${preBase} ${prePadding} ${preClasses}`}
        dangerouslySetInnerHTML={{ __html: generatedHtml }}
      />
      <Copy
        value={code}
        classes="absolute top-2 right-2 text-gray-50 size-8 flex items-center justify-center cursor-pointer border rounded-xl"
      />
    </div>
  )
}
