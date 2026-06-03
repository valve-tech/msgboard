<!-- @component Code Block based on: https://shiki.style/ -->

<script module>
  import { createHighlighterCoreSync } from 'shiki/core';
  import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
  // Themes
  // https://shiki.style/themes
  import themeDarkPlus from 'shiki/themes/dark-plus.mjs';
  // Languages
  // https://shiki.style/languages
  import shell from 'shiki/langs/shell.mjs';
  import typescript from 'shiki/langs/typescript.mjs';
  import json from 'shiki/langs/json.mjs';
  // https://shiki.style/guide/sync-usage
  const shiki = createHighlighterCoreSync({
    engine: createJavaScriptRegexEngine(),
    // Implement your import theme.
    themes: [themeDarkPlus],
    // Implement your imported and supported languages.
    langs: [shell, typescript, json]
  });
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
