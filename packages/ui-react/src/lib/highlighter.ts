// Shared shiki highlighter (sync core) used by both the <Code> component and the
// docs markdown renderer, so syntax highlighting is identical everywhere.
// https://shiki.style/guide/sync-usage
import { createHighlighterCoreSync } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import themeDarkPlus from 'shiki/themes/dark-plus.mjs'
import shell from 'shiki/langs/shell.mjs'
import typescript from 'shiki/langs/typescript.mjs'
import json from 'shiki/langs/json.mjs'

export const theme = 'dark-plus'

export const shiki = createHighlighterCoreSync({
  engine: createJavaScriptRegexEngine(),
  themes: [themeDarkPlus],
  langs: [shell, typescript, json],
})

// markdown fences use short names (```ts / ```sh); map them to the loaded grammars.
const aliases: Record<string, string> = { ts: 'typescript', sh: 'shell', bash: 'shell' }
const loaded = new Set(['typescript', 'shell', 'json'])

/**
 * Highlight a code block to shiki HTML, falling back to plain text for languages
 * that are not bundled. Returns a `<pre class="shiki">…</pre>` string, which
 * markdown-it uses directly (it skips its own wrapper when the result starts
 * with `<pre`).
 */
export const highlightToHtml = (code: string, lang: string): string => {
  const resolved = aliases[lang] ?? lang
  return shiki.codeToHtml(code, { lang: loaded.has(resolved) ? resolved : 'text', theme })
}
