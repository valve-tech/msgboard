import { Icon } from '@iconify/react'
import { formatEther, isAddress, isHex, stringToHex, zeroAddress } from 'viem'
import { ToggleButton } from './ToggleButton'
import { Info } from './Info'

type Props = {
  text?: string
  type?: string
  disabled?: boolean
  showHexResult?: boolean
  onChange?: (value: string) => void
  setToRandom?: () => void
  onToggleShowHex?: (show: boolean) => void
  /** wallet balance for the gas-request mode (from useAccount) */
  balance?: bigint | null
  /** native gas symbol of the active chain */
  gasSymbol?: string | null
}

/** Ported from `MessageInput.svelte`. Balance/symbol are passed in from the Interactive flow's
 *  `useAccount` (the Svelte version read the `account` singleton directly). */
export function MessageInput({
  text = '',
  disabled = false,
  showHexResult = false,
  onChange = () => {},
  type = 'gas-request',
  setToRandom = () => {},
  onToggleShowHex = () => {},
  balance = 0n,
  gasSymbol = '',
}: Props) {
  const hexTextValue = (isHex(text) ? text : stringToHex(text)).toLowerCase()
  const invalidInput = type === 'gas-request' && !isAddress(text)

  return (
    <>
      <div className="flex flex-row items-center justify-between">
        <h3 className="text-lg justify-between flex mb-2 italic flex-row items-center gap-x-2 text-left">
          <ToggleButton
            off="txt"
            on="0x"
            offIcon="mdi:format-text"
            onIcon="mdi:code-brackets"
            checked={showHexResult}
            onClick={() => onToggleShowHex(!showHexResult)}
          />
          <Info text="The message can be any input. The text will be converted to a hex string, and the bytes counted. For each byte the difficulty will increase. Switch the toggle to `0x` to view the resulting hex version of your input." />
          <span>Message</span>
        </h3>
        {type === 'gas-request' ? (
          <span className="flex flex-row items-center gap-x-2 italic">
            <Icon icon="fe:wallet" className="size-6" />
            {formatEther(balance ?? 0n)} {gasSymbol}
          </span>
        ) : (
          <span className="flex flex-row items-center gap-x-2">
            <Info
              text="Generate a random keccak256 hash as the message content. Useful when you just want to post something quickly without typing a specific message."
              align="right"
            />
            <button type="button" onClick={setToRandom} className="cursor-pointer">
              <Icon icon="fe:random" className="size-6" />
            </button>
          </span>
        )}
      </div>
      <div className="flex flex-col items-center">
        <textarea
          value={text}
          name="message"
          id="message"
          rows={3}
          className={`font-mono p-2 border rounded-lg bg-white dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100 dark:placeholder-gray-500 w-full m-auto outline-none ${
            invalidInput ? 'border-red-500' : ''
          }`}
          disabled={disabled}
          onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
          placeholder={type === 'gas-request' ? zeroAddress : 'any text can go here'}
        />
        {showHexResult && (
          <>
            <div className="min-h-4">
              <Icon icon="fe:arrow-down" />
            </div>
            <textarea
              value={hexTextValue}
              name="message"
              id="message"
              rows={3}
              className={`font-mono p-2 border rounded-lg bg-white dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100 dark:placeholder-gray-500 w-full m-auto outline-none ${
                !isHex(hexTextValue) ? 'border-red-500' : ''
              }`}
              disabled
              readOnly
            />
          </>
        )}
      </div>
    </>
  )
}
