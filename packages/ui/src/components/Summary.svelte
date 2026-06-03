<script lang="ts">
  import { chain } from '../lib'
  import { decodeAll, saveTreeNodeState } from './TreeView.svelte'
  import ToggleButton from './ToggleButton.svelte'
  // import { terminalState } from '../lib/log.svelte'
  // let nPerSecond = $state('-')
  // $effect(() => {
  //   const lastProgress = terminalState.lastProgress
  //   if (lastProgress) {
  //     // duration is in ms and we need another factor of 1000 to get accurate numbers
  //     nPerSecond = `~${(BigInt(lastProgress.iterations) * 1_000_000n) / (BigInt(lastProgress.duration) || 1n) / 1_000n}`
  //   } else {
  //     nPerSecond = '-'
  //   }
  // })
  const categories = $derived(chain.categories.length)
  const messages = $derived(chain.messages.length)
</script>

<div class="flex flex-col justify-between my-2 font-mono w-full">
  <!-- <div class="w-full">
    Average: {nPerSecond} hashes/s
  </div> -->
  <div class="w-full flex flex-row justify-between">
    <span class="flex flex-row items-center">Categories: {categories}
      <span class="ml-3 flex flex-row items-center gap-1">
        <ToggleButton off="0x" on="txt" checked={decodeAll.value} onclick={() => { decodeAll.value = !decodeAll.value; saveTreeNodeState() }} />
        <span class="text-xs text-gray-500 dark:text-gray-400 italic font-sans">decode all</span>
      </span>
    </span>
    <span>Messages: {messages}</span>
  </div>
</div>
