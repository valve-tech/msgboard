<script lang="ts">
  import Icon from '@iconify/svelte'
  import { formatEther, isAddress, isHex, stringToHex, zeroAddress, type Hex } from 'viem'
  import { account } from '../lib/web3.svelte'
  import ToggleButton from './ToggleButton.svelte'
  import Info from './Info.svelte'
  type Props = {
    text?: string
    type?: string
    disabled?: boolean
    hexdText?: string
    showHexResult?: boolean
    onchange?: (value: string) => void
    setToRandom?: () => void
    onToggleShowHex?: (show: boolean) => void
  }
  const { text = '', disabled = false, showHexResult = false, onchange = () => {}, type = 'gas-request', setToRandom = () => {}, onToggleShowHex = () => {} }: Props = $props()
  const hexTextValue = $derived((isHex(text) ? text : stringToHex(text)).toLowerCase())
  const changeMessageValue = (e: Event) => {
    const value = (e.target as HTMLTextAreaElement).value
    onchange(value)
  }
  const chain = $derived(account.chain)
  const invalidInput = $derived.by(() => {
    if (type !== 'gas-request') {
      return false
    }
    return !isAddress(text)
  })
  const balance = $derived(account.balance.get(account.address as Hex) ?? 0n)
</script>

<div class="flex flex-row items-center justify-between">
  <h3 class="text-lg justify-between flex mb-2 italic flex-row items-center gap-x-2 text-left">
    <ToggleButton off="txt" on="0x" checked={showHexResult} onclick={() => onToggleShowHex(!showHexResult)} />
    <Info text="The message can be any input. The text will be converted to a hex string, and the bytes counted. For each byte the difficulty will increase. Switch the toggle to `0x` to view the resulting hex version of your input." />
    <span>Message</span>
  </h3>
  {#if type === 'gas-request'}
  <span class="flex flex-row items-center gap-x-2 italic">
    <Icon icon="fe:wallet" class="size-6" />
    {formatEther(balance)}
    {chain?.nativeCurrency.symbol}
  </span>
  {:else}
    <span class="flex flex-row items-center gap-x-2">
      <Info text="Generate a random keccak256 hash as the message content. Useful when you just want to post something quickly without typing a specific message." align="right" />
      <button type="button" onclick={setToRandom} class="cursor-pointer">
        <Icon icon="fe:random" class="size-6" />
      </button>
    </span>
  {/if}
</div>
<div class="flex flex-col items-center">
  <textarea
    value={text}
    name="message"
    id="message"
    rows="3"
    class="font-mono p-2 border rounded-lg bg-white dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100 dark:placeholder-gray-500 w-full m-auto outline-none"
    {disabled}
    class:border-red-500={invalidInput}
    oninput={changeMessageValue}
    placeholder={'gas-request' === type ? zeroAddress : 'any text can go here'}></textarea>
  {#if showHexResult}
    <div class="min-h-4">
      <Icon icon="fe:arrow-down" />
    </div>
    <textarea
      value={hexTextValue}
      name="message"
      id="message"
      rows="3"
      class="font-mono p-2 border rounded-lg bg-white dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100 dark:placeholder-gray-500 w-full m-auto outline-none"
      class:border-red-500={!isHex(hexTextValue)}
      disabled={true}></textarea>
  {/if}
</div>
