<!-- @component Code Block based on: https://shiki.style/ -->

<script module>
  // Shared shiki instance (also used by the docs markdown renderer).
  import { shiki } from '../lib/highlighter';
</script>

<script lang="ts">
  import type { CodeBlockProps } from './types';
  import Copy from './Copy.svelte'

  let {
    code = '',
    lang = 'shell',
    theme = 'dark-plus',
    // Base Style Props
    base = ' relative overflow-hidden [&>pre]:overflow-x-auto',
    rounded = 'rounded-2xl',
    shadow = '',
    classes = '',
    // Pre Style Props
    preBase = '',
    prePadding = '[&>pre]:p-3',
    preClasses = ''
  }: CodeBlockProps = $props();

  // Shiki convert to HTML
  const generatedHtml = $derived(shiki.codeToHtml(code, { lang, theme }));
</script>

<div class="relative">
  <div class="{base} {rounded} {shadow} {classes} {preBase} {prePadding} {preClasses}">
    <!-- Output Shiki's Generated HTML -->
    {@html generatedHtml}
  </div>
  <Copy value={code} classes="absolute top-2 right-2 text-gray-50 size-8 flex items-center justify-center cursor-pointer border rounded-xl" />
</div>
