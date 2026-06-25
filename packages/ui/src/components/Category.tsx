import { isHash, stringToHex, keccak256 } from 'viem'
import { useChainStore, selectFaucetIsActive } from '../stores/chain'
import { ToggleButton } from './ToggleButton'
import { Info } from './Info'

type CategoryKey = 'gas-request' | 'input'
type Props = {
  disabled?: boolean
  type?: CategoryKey
  value?: string
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

/** Ported from `Category.svelte`. */
export function Category({
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
}: Props) {
  const faucetIsActive = useChainStore((s) => selectFaucetIsActive(s))

  const selectCategory = (cat: CategoryKey) => {
    oncategoryupdate(cat, cat === 'gas-request' ? 'gasmoneyplease' : '')
  }

  const categoryInputDisabled = disabled || type !== 'input'
  const effectiveDirectEncoding = type === 'input' && !useKeccak && !categoryExceedsLimit
  const encodingToggleDisabled = disabled || type !== 'input' || categoryExceedsLimit
  const categoryInputValueHex = isHash(value)
    ? value
    : effectiveDirectEncoding
      ? stringToHex(value, { size: 32 })
      : keccak256(stringToHex(value))

  return (
    <>
      <h3 className="text-lg italic justify-between flex mb-2">
        <span className="flex flex-row items-center gap-x-2">
          <ToggleButton
            off="txt"
            on="0x"
            offIcon="mdi:format-text"
            onIcon="mdi:code-brackets"
            checked={showHexResult}
            onClick={() => onToggleShowHex(!showHexResult)}
          />
          <Info text="The category is 32 bytes long. It is often used coordinate where to look for messages on the msgboard by clients to quickly find useful messages for their protocol. Switch the toggle to `0x` to view the hex version of your input." />
          Category
          <span className="group flex items-center gap-x-2">
            <ToggleButton
              off="0x"
              on="keccak"
              onIcon="mdi:fingerprint"
              iconClass="size-3.5"
              checked={useKeccak}
              disabled={encodingToggleDisabled}
              onClick={() => onToggleKeccak(!useKeccak)}
            />
            <Info
              text={
                categoryExceedsLimit
                  ? 'Category exceeds 32 bytes, keccak256 hashing is required.'
                  : '0x: category is hex-encoded and zero-padded to 32 bytes. keccak (fingerprint icon): category hex is keccak256 hashed to 32 bytes. Strings longer than 32 bytes are always hashed.'
              }
            />
          </span>
        </span>
        {working && (
          <button
            className="bg-red-500 text-slate-100 px-4 rounded-full text-sm leading-6 cursor-pointer"
            onClick={cancel}
          >
            Cancel
          </button>
        )}
      </h3>
      <div className="w-full flex flex-row items-start">
        <div className="radio gap-2 grow flex items-start">
          {faucetIsActive && (
            <span className={`flex flex-row items-center py-2 ${type === 'input' ? 'italic' : ''}`}>
              <ToggleButton
                off="⛽"
                on="txt"
                checked={type === 'input'}
                onClick={() => selectCategory(type === 'gas-request' ? 'input' : 'gas-request')}
              />
            </span>
          )}
          <div className="sm:flex rounded-lg flex-col flex-grow gap-1">
            <input
              type="text"
              className="bg-white dark:bg-gray-800 border dark:border-gray-600 py-2 px-2 block w-full sm:mt-0 sm:first:ms-0 text-sm relative text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder-gray-500 focus:z-10 focus:border-blue-500 focus:ring-blue-500 disabled:opacity-70 disabled:pointer-events-none rounded-lg"
              value={value}
              disabled={categoryInputDisabled}
              onInput={(e) => oncategoryupdate(type, (e.target as HTMLInputElement).value)}
            />
            {showHexResult && (
              <input
                type="text"
                className="bg-white dark:bg-gray-800 border dark:border-gray-600 py-2 px-2 block w-full sm:mt-0 sm:first:ms-0 text-sm relative text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder-gray-500 focus:z-10 focus:border-blue-500 focus:ring-blue-500 disabled:opacity-70 disabled:pointer-events-none rounded-lg"
                value={categoryInputValueHex}
                disabled
                readOnly
              />
            )}
          </div>
        </div>
      </div>
    </>
  )
}
