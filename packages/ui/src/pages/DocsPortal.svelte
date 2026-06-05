<script lang="ts">
  import MarkdownIt from 'markdown-it'
  import { readme, openrpc } from '../lib/docs-content.generated'
  import Docs from '../components/Docs.svelte'
  import Footer from '../components/Footer.svelte'
  import OpenRpcReference from '../components/OpenRpcReference.svelte'
  import { highlightToHtml } from '../lib/highlighter'

  // Highlight fenced code blocks with the same shiki instance as <Code>, so the
  // prose snippets (viem/ethers quickstart, etc.) are highlighted, not plain.
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: false,
    highlight: (code, lang) => highlightToHtml(code, lang),
  })
  // Strip HTML comments (e.g. the GENERATED:OPENRPC anchor markers) so html:false
  // markdown-it doesn't print them as literal text.
  const stripComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '')

  // Split the README around the generated OpenRPC block: the prose stays markdown,
  // but the reference is rendered by the structured <OpenRpcReference> component
  // (built from the same `openrpc` object), not as flat markdown tables.
  const START = '<!-- GENERATED:OPENRPC:START -->'
  const END = '<!-- GENERATED:OPENRPC:END -->'
  const startIdx = readme.indexOf(START)
  const endIdx = readme.indexOf(END)
  const hasBlock = startIdx >= 0 && endIdx > startIdx
  const beforeHtml = md.render(stripComments(hasBlock ? readme.slice(0, startIdx) : readme))
  const afterHtml = hasBlock ? md.render(stripComments(readme.slice(endIdx + END.length))) : ''
</script>

<div class="mx-auto max-w-3xl px-4 py-12">
  <div class="flex items-center justify-between text-sm">
    <a href="#/" class="text-indigo-600 dark:text-indigo-400 hover:underline">← Back to home</a>
    <a
      href="https://github.com/valve-tech/msgboard"
      target="_blank"
      rel="noopener noreferrer"
      class="text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline">Source ↗</a>
  </div>
  <article class="docs-prose mt-6 text-slate-800 dark:text-gray-200">
    {@html beforeHtml}
  </article>
  {#if hasBlock}
    <div class="mt-8">
      <OpenRpcReference {openrpc} />
    </div>
    <article class="docs-prose mt-8 text-slate-800 dark:text-gray-200">
      {@html afterHtml}
    </article>
  {/if}
</div>

<section class="border-t border-gray-200 dark:border-gray-700">
  <Docs />
</section>

<Footer />

<style>
  .docs-prose :global(h1) { font-size: 2rem; font-weight: 700; margin: 1.5rem 0 1rem; }
  .docs-prose :global(h2) { font-size: 1.5rem; font-weight: 700; margin: 2rem 0 0.75rem; }
  .docs-prose :global(h3) { font-size: 1.15rem; font-weight: 600; margin: 1.5rem 0 0.5rem; }
  .docs-prose :global(p) { margin: 0.75rem 0; line-height: 1.7; }
  .docs-prose :global(ul) { list-style: disc; padding-left: 1.5rem; margin: 0.75rem 0; }
  .docs-prose :global(a) { color: var(--color-indigo-600, #4f46e5); text-decoration: underline; }
  .docs-prose :global(code) { font-family: ui-monospace, monospace; font-size: 0.9em; background: rgba(120,120,120,0.15); padding: 0.1em 0.3em; border-radius: 0.25rem; }
  .docs-prose :global(pre) { background: rgba(120,120,120,0.12); padding: 1rem; border-radius: 0.5rem; overflow-x: auto; margin: 0.75rem 0; }
  .docs-prose :global(pre code) { background: none; padding: 0; }
  .docs-prose :global(table) { width: 100%; border-collapse: collapse; margin: 0.75rem 0; font-size: 0.9rem; }
  .docs-prose :global(th), .docs-prose :global(td) { border: 1px solid rgba(120,120,120,0.3); padding: 0.4rem 0.6rem; text-align: left; }
</style>
