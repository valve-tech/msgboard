import * as viem from 'viem'

/** The msgboard category the variant-B offer notices live under (per-chain board → no chain tag). */
export const FLIPX_CATEGORY = viem.stringToHex('flipx', { size: 32 })

export const flipBookXAbi = viem.parseAbi([
  'struct Offer { address maker; bytes32 commit; uint256 stake; uint256 makerBond; uint256 takerBond; uint64 takeDeadline; uint32 makerRevealWindow; uint32 takerRevealWindow; }',
  'function take(Offer o, bytes makerSig, address taker, bytes32 guessCommit, bytes takerSig) returns (bytes32)',
  'function revealChoice(bytes32 id, bool choice, bytes32 salt)',
  'function revealGuess(bytes32 id, bool guess, bytes32 salt2)',
  'function claimMakerDefault(bytes32 id)',
  'function claimTakerDefault(bytes32 id)',
  'event Taken(bytes32 indexed offerId, address indexed maker, address indexed taker, uint256 stake, bytes32 guessCommit, uint256 choiceRevealBy)',
  'event ChoiceRevealed(bytes32 indexed offerId, bool choice, uint256 guessRevealBy)',
  'event Settled(bytes32 indexed offerId, bool choice, bool guess, address indexed winner, uint256 pot)',
  'event MakerDefaulted(bytes32 indexed offerId, address indexed taker, uint256 amount)',
  'event TakerDefaulted(bytes32 indexed offerId, address indexed maker, uint256 amount)',
])

export const x402Abi = viem.parseAbi([
  'function wrap() payable',
  'function unwrap(uint256 amount)',
  'function balanceOf(address) view returns (uint256)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
])

export type XOffer = {
  maker: viem.Hex
  commit: viem.Hex
  stake: bigint
  makerBond: bigint
  takerBond: bigint
  takeDeadline: bigint
  makerRevealWindow: number
  takerRevealWindow: number
}

const OFFER_TAG = viem.keccak256(viem.toBytes('FlipBookX.Offer'))
const TAKE_TAG = viem.keccak256(viem.toBytes('FlipBookX.Take'))

/** Offline mirror of FlipBookX.offerId — the id IS the maker's authorization nonce. */
export const xOfferId = (chainId: number, book: viem.Hex, o: XOffer): viem.Hex =>
  viem.keccak256(
    viem.encodeAbiParameters(
      [
        { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' },
        { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
        { type: 'uint64' }, { type: 'uint32' }, { type: 'uint32' },
      ],
      [OFFER_TAG, BigInt(chainId), book, o.maker, o.commit, o.stake, o.makerBond, o.takerBond, o.takeDeadline, o.makerRevealWindow, o.takerRevealWindow],
    ),
  )

export const xTakerNonce = (id: viem.Hex, taker: viem.Hex): viem.Hex =>
  viem.keccak256(viem.encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }], [TAKE_TAG, id, taker]))

export const xCommit = (who: viem.Hex, bit: boolean, salt: viem.Hex): viem.Hex =>
  viem.keccak256(viem.encodeAbiParameters([{ type: 'address' }, { type: 'bool' }, { type: 'bytes32' }], [who, bit, salt]))

export const newSalt = (): viem.Hex => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return viem.bytesToHex(bytes)
}

/**
 * The wallet-facing EIP-712 payload for a ReceiveWithAuthorization on the x402 wrapper — what
 * MetaMask (or a Safe) shows and signs. Domain matches the deployed wrapper (`name` "x402 PLS",
 * version "1"); the nonce carries the whole offer's terms, so this one signature IS the offer.
 */
export const receiveAuthTypedData = (args: {
  chainId: number
  token: viem.Hex
  from: viem.Hex
  to: viem.Hex
  value: bigint
  validBefore: bigint
  nonce: viem.Hex
}) =>
  ({
    domain: { name: 'x402 PLS', version: '1', chainId: args.chainId, verifyingContract: args.token },
    types: {
      ReceiveWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'ReceiveWithAuthorization' as const,
    message: {
      from: args.from,
      to: args.to,
      value: args.value,
      validAfter: 0n,
      validBefore: args.validBefore,
      nonce: args.nonce,
    },
  }) as const

/** LOSING THESE = FORFEITING — persisted before any signature leaves the browser. */
export type XSecret = { bit: boolean; salt: viem.Hex; role: 'maker' | 'taker'; savedAt: number }

const secretsKey = (chainId: number, book: viem.Hex) => `msgboard-games:flipx:${chainId}:${book.toLowerCase()}:secrets`

const readStore = (key: string): Record<string, XSecret> => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, XSecret>
  } catch {
    return {}
  }
}

export const saveXSecret = (chainId: number, book: viem.Hex, commit: viem.Hex, secret: Omit<XSecret, 'savedAt'>): void => {
  const key = secretsKey(chainId, book)
  const store = readStore(key)
  store[commit.toLowerCase()] = { ...secret, savedAt: Date.now() }
  localStorage.setItem(key, JSON.stringify(store))
}

export const xSecretFor = (chainId: number, book: viem.Hex, commit: viem.Hex): XSecret | undefined =>
  readStore(secretsKey(chainId, book))[commit.toLowerCase()]
