<script lang="ts">
  import Icon from "@iconify/svelte"

  type Props = {
    text: string
    /** horizontal anchor for the tooltip popup - defaults to 'left' */
    align?: 'left' | 'right'
    /** optional size/class for the info icon (defaults to inheriting the text size) */
    iconClass?: string
  }
  const { text, align = 'left', iconClass = '' }: Props = $props()
</script>

<div class="flex group relative">
  <!-- focusable trigger: shows on hover (pointer), focus (keyboard), and tap (touch).
       stopPropagation so tapping the icon inside a clickable row does not also toggle it. -->
  <button
    type="button"
    aria-label={text}
    class="flex items-center cursor-help border-0 bg-transparent p-0 text-current focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400 rounded"
    onclick={(e) => e.stopPropagation()}>
    <Icon icon="mdi:information-outline" class={iconClass} />
  </button>
  <div
    role="tooltip"
    class="absolute top-0 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-md p-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 invisible group-hover:visible group-focus-within:visible transition-opacity duration-100 text-xs w-72 sm:w-96 max-w-[calc(100vw-1rem)] shadow z-10 -translate-y-full"
    class:left-0={align === 'left'}
    class:right-0={align === 'right'}
  >
    {text}
  </div>
</div>
