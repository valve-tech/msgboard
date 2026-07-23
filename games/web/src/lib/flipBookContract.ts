import * as viem from 'viem'

/**
 * FlipBook ABI — the P2P guessing-game coin flip (matching pennies, variant A of
 * examples/games/P2P_COINFLIP_DESIGN.md). Offers live entirely on-chain (escrowed at post), so the
 * whole book reconstructs from the five events; `owed` is the pull-fallback balance for a winner
 * whose push payment reverted. Matches packages/contracts/.../games/FlipBook.sol.
 */
export const flipBookAbi = [
  {
    type: 'function',
    name: 'post',
    stateMutability: 'payable',
    inputs: [
      { name: 'commit', type: 'bytes32' },
      { name: 'bond_', type: 'uint256' },
      { name: 'takeDeadline', type: 'uint64' },
      { name: 'revealWindow', type: 'uint32' },
    ],
    outputs: [{ name: 'offerId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'cancel',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'offerId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'take',
    stateMutability: 'payable',
    inputs: [
      { name: 'offerId', type: 'uint256' },
      { name: 'guess', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'reveal',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'offerId', type: 'uint256' },
      { name: 'choice', type: 'bool' },
      { name: 'salt', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'offerId', type: 'uint256' }],
    outputs: [],
  },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  {
    type: 'function',
    name: 'owed',
    stateMutability: 'view',
    inputs: [{ name: 'payee', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'nextOfferId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'OfferPosted',
    inputs: [
      { name: 'offerId', type: 'uint256', indexed: true },
      { name: 'maker', type: 'address', indexed: true },
      { name: 'commit', type: 'bytes32', indexed: false },
      { name: 'stake', type: 'uint256', indexed: false },
      { name: 'bond', type: 'uint256', indexed: false },
      { name: 'takeDeadline', type: 'uint64', indexed: false },
      { name: 'revealWindow', type: 'uint32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'OfferCancelled',
    inputs: [{ name: 'offerId', type: 'uint256', indexed: true }],
  },
  {
    type: 'event',
    name: 'OfferTaken',
    inputs: [
      { name: 'offerId', type: 'uint256', indexed: true },
      { name: 'taker', type: 'address', indexed: true },
      { name: 'guess', type: 'bool', indexed: false },
      { name: 'revealBy', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Revealed',
    inputs: [
      { name: 'offerId', type: 'uint256', indexed: true },
      { name: 'choice', type: 'bool', indexed: false },
      { name: 'winner', type: 'address', indexed: true },
      { name: 'pot', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Forfeited',
    inputs: [
      { name: 'offerId', type: 'uint256', indexed: true },
      { name: 'taker', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Withdrawn',
    inputs: [
      { name: 'payee', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
] as const

/** The venue's convention for the hidden bit: true = heads, false = tails. */
export const sideLabel = (b: boolean): string => (b ? 'heads' : 'tails')

/**
 * The exact commit FlipBook.reveal checks: keccak256(abi.encode(maker, choice, salt)). Binding the
 * maker's address in means a copied commit is useless — someone re-posting it could escrow behind
 * it but never open it, and would only ever forfeit.
 */
export const flipCommit = (maker: viem.Hex, choice: boolean, salt: viem.Hex): viem.Hex =>
  viem.keccak256(
    viem.encodeAbiParameters(
      [{ type: 'address' }, { type: 'bool' }, { type: 'bytes32' }],
      [maker, choice, salt],
    ),
  )

/** A fresh 32-byte blinding salt from the browser CSPRNG. */
export const newSalt = (): viem.Hex => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return viem.bytesToHex(bytes)
}

/**
 * The maker's secret side of an offer. LOSING THIS = FORFEITING: the commit can only be opened
 * with the exact (choice, salt), so it is persisted to localStorage BEFORE the post tx is sent
 * (keyed by commit — the offerId isn't known until the tx lands).
 */
export type FlipSecret = { choice: boolean; salt: viem.Hex; savedAt: number }

const secretsKey = (chainId: number, contract: viem.Hex) =>
  `msgboard-games:flipbook:${chainId}:${contract.toLowerCase()}:secrets`

const readStore = (key: string): Record<string, FlipSecret> => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, FlipSecret>
  } catch {
    return {}
  }
}

/** Persist (choice, salt) under its commit. Called BEFORE the post tx so a mid-tx crash can't orphan the escrow. */
export const saveFlipSecret = (
  chainId: number,
  contract: viem.Hex,
  commit: viem.Hex,
  secret: Omit<FlipSecret, 'savedAt'>,
): void => {
  const key = secretsKey(chainId, contract)
  const store = readStore(key)
  store[commit.toLowerCase()] = { ...secret, savedAt: Date.now() }
  localStorage.setItem(key, JSON.stringify(store))
}

/** The stored secret for a commit, if this browser posted it. */
export const flipSecretFor = (
  chainId: number,
  contract: viem.Hex,
  commit: viem.Hex,
): FlipSecret | undefined => readStore(secretsKey(chainId, contract))[commit.toLowerCase()]

/** Drop a secret once its offer is terminally settled (revealed/forfeited/cancelled). */
export const forgetFlipSecret = (chainId: number, contract: viem.Hex, commit: viem.Hex): void => {
  const key = secretsKey(chainId, contract)
  const store = readStore(key)
  if (!(commit.toLowerCase() in store)) return
  delete store[commit.toLowerCase()]
  localStorage.setItem(key, JSON.stringify(store))
}
