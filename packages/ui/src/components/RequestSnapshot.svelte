<script lang="ts">
  import Icon from '@iconify/svelte'

  /** Frozen snapshot of the data inputs captured when a work request begins */
  type WorkSnapshot = {
    /** display name of the chain */
    chainName: string
    /** numeric chain id */
    chainId: number
    /** rpc endpoint used for this request */
    rpc: string
    /** category mode – 'gas-request' or 'input' */
    categoryType: string
    /** raw category string before encoding */
    categoryValue: string
    /** encoding applied to the category to produce bytes32 */
    categoryEncoding: 'keccak256' | 'direct'
    /** resulting bytes32 hex of the category */
    categoryHex: string
    /** raw message text as entered by the user */
    messageText: string
    /** hex-encoded message sent to the worker */
    messageHex: string
    /** byte length of the hex-encoded message (drives work difficulty) */
    messageByteLength: number
  }

  type Props = {
    /** the frozen snapshot to display – null hides the component */
    snapshot: WorkSnapshot | null
    /** true while work is actively being computed / sent */
    working?: boolean
    /** called when the user closes the snapshot – cancels work and removes the box */
    onclose?: () => void
  }

  const { snapshot, working = false, onclose }: Props = $props()

  let collapsed = $state(false)
</script>

{#if snapshot}
<div class="flex flex-col rounded-lg border border-gray-300 dark:border-gray-600 shadow bg-gray-50 dark:bg-gray-900 p-3 font-mono text-sm mt-4">
  <div class="flex items-center justify-between">
    <span class="flex items-center gap-2">
      <span class="font-semibold text-gray-700 dark:text-gray-200">Request Data</span>
      {#if working}<Icon icon="svg-spinners:3-dots-bounce" class="size-4 text-gray-500 dark:text-gray-400" />{/if}
    </span>
    <span class="flex items-center gap-1">
      <button
        type="button"
        class="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
        onclick={() => (collapsed = !collapsed)}
        title={collapsed ? 'expand' : 'minimize'}
      >
        <Icon icon={collapsed ? 'pajamas:expand-down' : 'pajamas:expand-up'} class="size-4" />
      </button>
      {#if onclose}
        <button
          type="button"
          class="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
          onclick={onclose}
          title="cancel and close"
        >
          <Icon icon="mdi:close" class="size-4" />
        </button>
      {/if}
    </span>
  </div>

  {#if !collapsed}
    <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 mt-2 text-xs">
      <dt class="text-gray-500 dark:text-gray-400 text-right">chain</dt>
      <dd class="flex flex-col md:flex-row md:justify-between md:gap-4">
        <span>{snapshot.chainName} ({snapshot.chainId})</span>
        <span class="break-all text-gray-500 dark:text-gray-400">{snapshot.rpc}</span>
      </dd>

      <dt class="text-gray-500 dark:text-gray-400 text-right">category</dt>
      <dd class="break-all">{snapshot.categoryEncoding === 'keccak256' ? `keccak256(toHex(${snapshot.categoryValue}))` : `toHex(${snapshot.categoryValue})`}</dd>

      <dt class="text-gray-500 dark:text-gray-400 text-right">↳</dt>
      <dd class="break-all">{snapshot.categoryHex}</dd>

      <dt class="text-gray-500 dark:text-gray-400 text-right">message</dt>
      <dd class="break-all">{snapshot.messageText || '(empty)'}</dd>

      <dt class="text-gray-500 dark:text-gray-400 text-right">↳ hex</dt>
      <dd class="break-all">{snapshot.messageHex}</dd>

      <dt class="text-gray-500 dark:text-gray-400 text-right">↳ bytes</dt>
      <dd>{snapshot.messageByteLength}</dd>
    </dl>
  {/if}
</div>
{/if}
