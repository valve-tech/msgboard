<script lang="ts">
  import { rpcs } from "../lib/rpc.svelte"
  import * as board from "../lib/msgboard.svelte"
  import Copy from "./Copy.svelte"
  import Info from "./Info.svelte"
  import ToggleButton from "./ToggleButton.svelte"
  type Props = {
    onchange: (e: Event) => void
  }
  const { onchange }: Props = $props()

  const isCustom = $derived(board.chain.chainOption === 'custom')
  let customUrl = $state(board.chain.customRpcUrl)

  /** commits the local custom url input to ChainState, triggering a content reload */
  const commitCustomUrl = () => {
    board.chain.customRpcUrl = customUrl
  }

  /** live msgboard_ availability for the selected rpc (null = still checking) */
  const msgboardEnabled = $derived(board.chain.msgboardEnabled)
  const probeTitle = $derived(
    msgboardEnabled === null
      ? 'Checking whether this RPC serves the msgboard_ namespace…'
      : msgboardEnabled
        ? 'This RPC serves the msgboard_ namespace — the board is live on this endpoint.'
        : 'This RPC does not expose the msgboard_ namespace — the board cannot be read or posted here.',
  )
</script>
<div class="flex flex-row gap-4 my-2 w-full items-center">
  <div class="flex flex-row shrink-0 items-center gap-2">
    <div class="grid grid-cols-1">
      <select id="location" name="location" value={board.chain.chainOption} class="col-start-1 row-start-1 w-full appearance-none rounded-md bg-white dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100 py-1 pl-3 pr-8 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 dark:outline-gray-600 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6" {onchange}>
        {#each rpcs.entries() as [key, value]}
          <option value={key} disabled={!!value.disabled}>{value.chain.name}</option>
        {/each}
        <option value="custom">Custom</option>
      </select>
      <svg class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end text-gray-500 dark:text-gray-400 sm:size-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" data-slot="icon">
        <path fill-rule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" />
      </svg>
    </div>
  </div>
  <div class="flex-1 min-w-0">
    {#if isCustom}
      <input
        type="text"
        bind:value={customUrl}
        onblur={commitCustomUrl}
        onkeydown={(e) => { if (e.key === 'Enter') commitCustomUrl() }}
        placeholder="Enter RPC URL..."
        class="w-full text-sm text-gray-700 dark:text-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1 dark:placeholder-gray-500 focus:outline-indigo-600 focus:outline-2 focus:-outline-offset-1 h-8"
      />
    {:else}
      <span class="text-sm text-gray-500 dark:text-gray-400 truncate block">{board.chain.rpcUrl}</span>
    {/if}
  </div>
  <div class="flex items-center gap-1 shrink-0">
    {#if isCustom ? customUrl : board.chain.rpcUrl}
      <span class="flex items-center gap-1 text-xs shrink-0" title={probeTitle}>
        {#if msgboardEnabled === null}
          <span class="size-2 rounded-full bg-gray-400 animate-pulse"></span>
          <span class="text-gray-400 dark:text-gray-500 hidden sm:inline">checking</span>
        {:else if msgboardEnabled}
          <span class="size-2 rounded-full bg-green-500"></span>
          <span class="text-green-600 dark:text-green-400 hidden sm:inline">msgboard</span>
        {:else}
          <span class="size-2 rounded-full bg-red-500"></span>
          <span class="text-red-500 dark:text-red-400 hidden sm:inline">no&nbsp;msgboard</span>
        {/if}
      </span>
      <Copy value={isCustom ? customUrl : board.chain.rpcUrl} />
    {/if}
    <span class="group flex items-center gap-1">
      <ToggleButton off="direct" on="proxy" offIcon="mdi:lightning-bolt" onIcon="mdi:server" checked={board.chain.isProxied} disabled={board.chain.mustProxy} onclick={() => { board.chain.forceProxy = !board.chain.forceProxy }} />
      <Info text={board.chain.mustProxy ? 'Proxy (server icon): HTTP URLs must be proxied through the msgboard server because browsers block HTTP requests from HTTPS pages.' : board.chain.isProxied ? 'Proxy (server icon): RPC requests are proxied through the msgboard server to work around mixed-content restrictions.' : 'Direct (lightning icon): RPC requests go directly from the browser to the endpoint. Switch to Proxy (server icon) to route through the msgboard server if the RPC is HTTP-only.'} align="right" />
    </span>
  </div>
</div>
