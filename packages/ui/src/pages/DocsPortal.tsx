import { useMemo } from 'react'
import MarkdownIt from 'markdown-it'
import { readme, openrpc } from '../lib/docs-content.generated'
import { Docs } from '../components/Docs'
import { Footer } from '../components/Footer'
import { OpenRpcReference } from '../components/OpenRpcReference'
import { SideToc } from '../components/SideToc'
import { highlightToHtml } from '../lib/highlighter'
import { slugify } from '../lib/section-nav'

const START = '<!-- GENERATED:OPENRPC:START -->'
const END = '<!-- GENERATED:OPENRPC:END -->'

// Strip HTML comments (e.g. the GENERATED:OPENRPC anchor markers) so html:false
// markdown-it doesn't print them as literal text.
const stripComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '')

const headings = (markdown: string) =>
  markdown
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3).trim())

/**
 * Ported from `pages/DocsPortal.svelte`.
 *
 * Renders the SDK README markdown with the same shiki instance as <Code> (so prose code
 * fences are highlighted), splits around the generated OpenRPC block to render the structured
 * <OpenRpcReference> instead of flat markdown tables, and gives every heading a stable slug id.
 */
export function DocsPortal() {
  const { beforeHtml, afterHtml, hasBlock, docSections } = useMemo(() => {
    // Highlight fenced code blocks with the same shiki instance as <Code>.
    const md = new MarkdownIt({
      html: false,
      linkify: true,
      breaks: false,
      highlight: (code, lang) => highlightToHtml(code, lang),
    })
    // give every heading a stable id so the side table of contents can scroll to it
    md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
      tokens[idx].attrSet('id', slugify(tokens[idx + 1]?.content ?? ''))
      return self.renderToken(tokens, idx, options)
    }

    const startIdx = readme.indexOf(START)
    const endIdx = readme.indexOf(END)
    const hasBlock = startIdx >= 0 && endIdx > startIdx
    const beforeHtml = md.render(stripComments(hasBlock ? readme.slice(0, startIdx) : readme))
    const afterHtml = hasBlock ? md.render(stripComments(readme.slice(endIdx + END.length))) : ''

    const docSections = [
      ...headings(hasBlock ? readme.slice(0, startIdx) : readme).map((t) => ({
        id: slugify(t),
        label: t,
      })),
      ...(hasBlock
        ? [
            { id: 'json-rpc-methods', label: 'JSON-RPC methods' },
            { id: 'schemas', label: 'Schemas' },
          ]
        : []),
      ...headings(hasBlock ? readme.slice(endIdx + END.length) : '').map((t) => ({
        id: slugify(t),
        label: t,
      })),
    ]
    return { beforeHtml, afterHtml, hasBlock, docSections }
  }, [])

  return (
    <>
      <SideToc sections={docSections} />

      <div className="mx-auto max-w-3xl px-4 py-12">
        <div className="flex items-center justify-between text-sm">
          <a href="#/" className="text-indigo-600 dark:text-indigo-400 hover:underline">
            ← Back to home
          </a>
          <a
            href="https://github.com/valve-tech/msgboard"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline">
            Source ↗
          </a>
        </div>
        <article
          className="docs-prose mt-6 text-slate-800 dark:text-gray-200"
          dangerouslySetInnerHTML={{ __html: beforeHtml }}
        />
        {hasBlock && (
          <>
            <div className="mt-8">
              <OpenRpcReference openrpc={openrpc} />
            </div>
            <article
              className="docs-prose mt-8 text-slate-800 dark:text-gray-200"
              dangerouslySetInnerHTML={{ __html: afterHtml }}
            />
          </>
        )}
      </div>

      <section className="border-t border-gray-200 dark:border-gray-700">
        <Docs />
      </section>

      <Footer />
    </>
  )
}
