<!-- https://stackoverflow.com/questions/61388273/css-display-terminal-without-scrollbars-and-responsive -->
<script lang="ts">
  import { terminalState } from '../lib/log.svelte'
  import Icon from '@iconify/svelte'

  let collapseTerminal = $state(false)
  type Props = { working?: boolean }
  const { working = false }: Props = $props()
  const toggle = () => {
    collapseTerminal = !collapseTerminal
  }
  const clearLogs = () => {
    terminalState.clearLogs()
  }
  const count = $derived(terminalState.logList.length)
  let terminalEl = $state<HTMLPreElement | null>(null)
  $effect(() => {
    // add in a bs check to trigger on count
    if (!terminalEl || !count) return
    terminalEl.scrollTo(0, terminalEl.scrollHeight)
  })
  let nPerSecond = $state('-')
  $effect(() => {
    const lastProgress = terminalState.lastProgress
    if (lastProgress) {
      // duration is in ms and we need another factor of 1000 to get accurate numbers
      nPerSecond = `${(BigInt(lastProgress.iterations) * 1_000_000n) / (BigInt(lastProgress.duration) || 1n) / 1_000n}`
    } else {
      nPerSecond = '-'
    }
  })
</script>

<div
  class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-slate-900 dark:text-gray-100 rounded-xl font-mono text-left overflow-hidden transition-all duration-100 shadow mx-auto relative w-full"
  class:h-8={collapseTerminal}
  class:h-80={!collapseTerminal}>
  <p
    class="flex justify-between bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 h-8 leading-8 text-sm w-full font-mono text-slate-900 dark:text-gray-100 pl-4 pr-2">
    <span class="flex flex-row items-center gap-2"
      >Logs{#if working}<Icon icon="svg-spinners:3-dots-bounce" />{/if} {nPerSecond === '-' ? '' : `~${nPerSecond} hash/s`}</span>
    <span class="flex flex-row">
      <button
        class="px-2 flex items-center cursor-pointer"
        title="clear logs"
        onclick={() => clearLogs()}
        aria-roledescription="clear the list of logs"
        tabindex="0"
        onkeypress={() => clearLogs()}>
        <Icon icon="grommet-icons:clear" />
      </button>
      <span
        aria-roledescription="opens and closes the terminal box which shows recent rpc requests"
        role="checkbox"
        onkeypress={toggle}
        onclick={toggle}
        tabindex="0"
        aria-checked={collapseTerminal}
        class="flex items-center px-2 cursor-pointer"
        ><Icon icon={!collapseTerminal ? "pajamas:expand-up" : "pajamas:expand-down"} class="size-4" /></span>
    </span>
  </p>
  <pre
    bind:this={terminalEl}
    class="py-2 px-4 overflow-scroll absolute top-[32px] bottom-0 right-0 left-0 scrollbar-color:white"
    >{#each terminalState.logList as log}{log.toString() + '\n'}{/each}</pre>
</div>
