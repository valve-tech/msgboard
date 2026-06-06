<script lang="ts">
  import type { ChangeEventHandler } from 'svelte/elements'
  import { isHash, stringToHex, keccak256 } from 'viem'
  import ToggleButton from './ToggleButton.svelte'
  import Info from './Info.svelte'
  import * as board from '../lib/msgboard.svelte'
  type CategoryKey = 'gas-request' | 'input'
  type Props = {
    disabled?: boolean
    type?: 'gas-request' | 'input'
    value?: string
    group?: string
    cancel?: () => void
    oncategoryupdate?: (cat: CategoryKey, value: string) => void
    working?: boolean
    showHexResult?: boolean
    onToggleShowHex?: (show: boolean) => void
    /** when true, category is keccak256 hashed; when false, direct utf8→hex zero-padded */
    useKeccak?: boolean
    /** when true, category exceeds 32 bytes so keccak256 is forced */
    categoryExceedsLimit?: boolean
    onToggleKeccak?: (kec: boolean) => void
  }
  const {
    disabled = false,
    type = 'gas-request',
    value = '',
    oncategoryupdate = () => {},
    cancel = () => {},
    working = false,
    showHexResult = false,
    onToggleShowHex = () => {},
    useKeccak = true,
    categoryExceedsLimit = false,
    onToggleKeccak = () => {},
  }: Props = $props()
  const selectCategory = (cat: CategoryKey) => {
    if (cat === 'gas-request') {
      oncategoryupdate(cat, 'gasmoneyplease')
    } else {
      oncategoryupdate(cat, '')
    }
  }

  const updateCategoryValue: ChangeEventHandler<HTMLInputElement> = (e) => {
    oncategoryupdate(type, (e.target as HTMLInputElement).value)
  }

  const categoryInputDisabled = $derived(disabled || type !== 'input')
  /** resolved encoding: direct hex when in input mode, keccak is off, and category fits in 32 bytes */
  const effectiveDirectEncoding = $derived(type === 'input' && !useKeccak && !categoryExceedsLimit)
  /** encoding toggle is disabled for gas-request or when category exceeds 32 bytes */
  const encodingToggleDisabled = $derived(disabled || type !== 'input' || categoryExceedsLimit)
  const categoryInputValueHex = $derived(
    isHash(value) ? value
    : effectiveDirectEncoding ? stringToHex(value, { size: 32 })
    : keccak256(stringToHex(value))
  )
</script>

<h3 class="text-lg italic justify-between flex mb-2">
  <span class="flex flex-row items-center gap-x-2">
    <ToggleButton off="txt" on="0x" offIcon="mdi:format-text" onIcon="mdi:code-brackets" checked={showHexResult} onclick={() => onToggleShowHex(!showHexResult)} />
    <Info text="The category is 32 bytes long. It is often used coordinate where to look for messages on the msgboard by clients to quickly find useful messages for their protocol. Switch the toggle to `0x` to view the hex version of your input." />
    Category
    <span class="group flex items-center gap-x-2">
      <ToggleButton off="0x" on="keccak" onIcon="mdi:fingerprint" iconClass="size-3.5" checked={useKeccak} disabled={encodingToggleDisabled} onclick={() => onToggleKeccak(!useKeccak)} />
      <Info text={categoryExceedsLimit ? 'Category exceeds 32 bytes, keccak256 hashing is required.' : '0x: category is hex-encoded and zero-padded to 32 bytes. keccak (fingerprint icon): category hex is keccak256 hashed to 32 bytes. Strings longer than 32 bytes are always hashed.'} />
    </span>
  </span>
  {#if working}
  <button
    class="bg-red-500 text-slate-100 px-4 rounded-full text-sm leading-6 cursor-pointer"
    onclick={cancel}>Cancel</button>
  {/if}
</h3>
<div class="w-full flex flex-row items-start">
  <div class="radio gap-2 grow flex items-start">
    <span class="flex flex-row items-center py-2" class:italic={type === 'input'}>
      <ToggleButton off="⛽" on="txt"
        disabled={!board.chain.faucetIsActive}
        checked={type === 'input'}
        onclick={() => selectCategory(type === 'gas-request' ? 'input' : 'gas-request')} />
    </span>
    <div class="sm:flex rounded-lg flex-col flex-grow gap-1">
      <input
        type="text"
        class="bg-white dark:bg-gray-800 border dark:border-gray-600 py-2 px-2 block w-full sm:mt-0 sm:first:ms-0 text-sm relative text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder-gray-500 focus:z-10 focus:border-blue-500 focus:ring-blue-500 disabled:opacity-70 disabled:pointer-events-none rounded-lg"
        {value}
        disabled={categoryInputDisabled}
        oninput={updateCategoryValue} />
        {#if showHexResult}
      <input
        type="text"
        class="bg-white dark:bg-gray-800 border dark:border-gray-600 py-2 px-2 block w-full sm:mt-0 sm:first:ms-0 text-sm relative text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder-gray-500 focus:z-10 focus:border-blue-500 focus:ring-blue-500 disabled:opacity-70 disabled:pointer-events-none rounded-lg"
        value={categoryInputValueHex}
        disabled />
        {/if}
    </div>
  </div>
</div>
