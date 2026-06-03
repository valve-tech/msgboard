<script lang="ts">
  import Icon from '@iconify/svelte'
  import { theme, setTheme, type ThemePreference } from '../lib/theme.svelte'

  const options: { value: ThemePreference; icon: string; label: string }[] = [
    { value: 'light', icon: 'mdi:white-balance-sunny', label: 'Light' },
    { value: 'dark', icon: 'mdi:moon-waning-crescent', label: 'Dark' },
    { value: 'system', icon: 'mdi:monitor', label: 'System' },
  ]
</script>

<div class="text-center text-sm text-gray-200 bg-slate-900 dark:bg-black p-4 flex flex-col items-center gap-3">
  <div
    class="inline-flex items-center gap-0.5 rounded-full border border-slate-700 p-0.5"
    role="radiogroup"
    aria-label="Color theme">
    {#each options as opt}
      <button
        type="button"
        title={opt.label}
        aria-label={opt.label}
        role="radio"
        aria-checked={theme.preference === opt.value}
        class="flex items-center justify-center size-7 rounded-full transition-colors hover:text-white"
        class:bg-slate-700={theme.preference === opt.value}
        class:text-white={theme.preference === opt.value}
        class:text-slate-400={theme.preference !== opt.value}
        onclick={() => setTheme(opt.value)}>
        <Icon icon={opt.icon} class="size-4" />
      </button>
    {/each}
  </div>
  <div>
    © {new Date().getFullYear()} Distributed MsgBoard. All rights reserved.
    <br />
    Built with ❤️ for the decentralized web.
  </div>
</div>
