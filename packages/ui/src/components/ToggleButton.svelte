<script lang="ts">
  import Icon from "@iconify/svelte"
  type Props = {
    /** label shown when unchecked (also the accessible name for the off state) */
    off: string
    /** label shown when checked (also the accessible name for the on state) */
    on: string
    /** optional iconify icon shown instead of the `off` text when unchecked */
    offIcon?: string
    /** optional iconify icon shown instead of the `on` text when checked */
    onIcon?: string
    /** size/class applied to the icons (default size-3.5 = 14px) */
    iconClass?: string
    checked: boolean
    onclick: (e: MouseEvent) => void
    disabled?: boolean
  }
  const { off, on, offIcon, onIcon, iconClass = 'size-3.5', checked = false, onclick, disabled = false }: Props = $props()
</script>
<!-- pointer-events-none when disabled lets a wrapping `group` still receive hover
     (a disabled <button> is inert and would otherwise swallow the hover) -->
<button type="button" {onclick} class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent bg-gray-200 dark:bg-gray-700 transition-all duration-200 ease-in-out focus:outline-none focus:ring-1 focus:ring-amber-500 focus:ring-offset-1" role="switch" aria-checked={checked} aria-label={checked ? on : off} class:opacity-50={disabled} class:pointer-events-none={disabled} class:bg-amber-400={checked} class:dark:bg-amber-500={checked} class:bg-gray-300={!checked} disabled={disabled}>
  <span class="pointer-events-none relative inline-block size-5 transform rounded-full bg-white dark:bg-gray-100 shadow-sm ring-0 transition duration-200 ease-in-out" class:translate-x-5={checked} class:translate-x-0={!checked}>
    <span class="absolute inset-0 flex size-full items-center justify-center transition-opacity overflow-hidden" class:opacity-0={checked} class:opacity-100={!checked} class:duration-100={checked} class:duration-200={!checked} class:ease-out={checked} class:ease-in={!checked} aria-hidden="true">
      {#if offIcon}<Icon icon={offIcon} class="{iconClass} text-gray-600" />{:else}<span class="text-[9px] font-mono text-gray-600">{off}</span>{/if}
    </span>
    <span class="absolute inset-0 flex size-full items-center justify-center transition-opacity overflow-hidden" class:opacity-100={checked} class:opacity-0={!checked} class:duration-100={checked} class:duration-200={!checked} class:ease-out={checked} class:ease-in={!checked} aria-hidden="true">
      {#if onIcon}<Icon icon={onIcon} class="{iconClass} text-amber-700" />{:else}<span class="text-[9px] font-mono text-amber-700">{on}</span>{/if}
    </span>
  </span>
</button>
