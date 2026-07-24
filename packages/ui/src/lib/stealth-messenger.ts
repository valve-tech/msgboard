/**
 * stealth-messenger — the on-chain wiring for StealthMessenger.sol (ERC-5564 + ERC-6538), the
 * "send a private message to an address" contract deployed on PulseChain testnet v4 (chain 943).
 *
 * This is the thin viem layer that the Stealth Chat mode drives:
 *   • READS  (stealthMetaAddressOf, messageDigest, MessageSent logs) go through a DEDICATED public
 *            client on 943 — the contract lives on 943 regardless of which chain the board UI is
 *            pointed at, so we never borrow the active-chain client. RPC is the app's keyed
 *            valve.city endpoint (VITE_RPC_943 override respected via ../lib/rpc).
 *   • WRITES (registerStealthMetaAddress, sendMessage) + the sender's EIP-712 signature go through
 *            the connected injected wallet, which we first nudge onto chain 943.
 *
 * The ABI here is INLINED (a minimal, hand-picked subset) rather than imported from the games/
 * contracts package — the ui package must not reach across that boundary. It carries exactly the
 * members the Stealth mode calls: SCHEME_ID, the registry read/writes, the message digest + send,
 * and both events.
 *
 * The crypto (key derivation, ECDH, view-tag scan, AEAD) all lives in ./stealth. This module only
 * moves bytes to/from the chain and asks the wallet to sign.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  keccak256,
  concat,
  toHex,
  hexToBytes,
  bytesToHex,
  numberToHex,
  isAddress,
  getAddress,
  recoverMessageAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { pulsechainV4 } from 'viem/chains'
import { rpcs } from './rpc'
import {
  deriveStealthMetaAddressFromSeed,
  deriveStealthAddress,
  encryptMessage,
  type StealthMetaAddress,
} from './stealth'

// ── deployment coordinates ────────────────────────────────────────────────────────────────────

/** StealthMessenger on PulseChain testnet v4 (chain 943). */
export const STEALTH_MESSENGER_ADDRESS: Address = '0x09917b05709224aef677d314cb9d50c62c3a3171'
/** The contract lives on 943 no matter which chain the board UI is pointed at. */
export const STEALTH_CHAIN_ID = 943
/** 0x3af — 943 as the hex chainId `wallet_switchEthereumChain` expects. */
const STEALTH_CHAIN_ID_HEX = numberToHex(STEALTH_CHAIN_ID)
/** Block the contract was deployed at — the floor for the MessageSent log scan. */
export const STEALTH_DEPLOY_BLOCK = 24955655n
/** ERC-5564 secp256k1 scheme id (matches SCHEME_ID() on-chain and stealth.ts). */
export const STEALTH_SCHEME_ID = 1n

/**
 * Log scan chunk span. getLogs range caps are per-RPC; 5k blocks is comfortably under common caps.
 * The contract is newly deployed, so latest is close to the deploy block and the loop is short.
 */
const LOG_CHUNK = 5000n

// ── inlined minimal ABI (do NOT import across the games/ boundary) ──────────────────────────────

export const STEALTH_MESSENGER_ABI = [
  { type: 'function', name: 'SCHEME_ID', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'stealthMetaAddressOf',
    inputs: [{ name: 'registrant', type: 'address' }],
    outputs: [{ name: 'stealthMetaAddress', type: 'bytes' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'registerStealthMetaAddress',
    inputs: [{ name: 'stealthMetaAddress', type: 'bytes' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'registerStealthMetaAddressOnBehalf',
    inputs: [
      { name: 'registrant', type: 'address' },
      { name: 'stealthMetaAddress', type: 'bytes' },
      { name: 'deadline', type: 'uint256' },
      { name: 'sig', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'registrationDigest',
    inputs: [
      { name: 'registrant', type: 'address' },
      { name: 'stealthMetaAddress', type: 'bytes' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'messageDigest',
    inputs: [
      { name: 'schemeId', type: 'uint256' },
      { name: 'sender', type: 'address' },
      { name: 'stealthAddress', type: 'address' },
      { name: 'ephemeralPubKey', type: 'bytes' },
      { name: 'viewTag', type: 'bytes1' },
      { name: 'ciphertext', type: 'bytes' },
    ],
    outputs: [{ type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'sendMessage',
    inputs: [
      { name: 'schemeId', type: 'uint256' },
      { name: 'sender', type: 'address' },
      { name: 'stealthAddress', type: 'address' },
      { name: 'ephemeralPubKey', type: 'bytes' },
      { name: 'viewTag', type: 'bytes1' },
      { name: 'ciphertext', type: 'bytes' },
      { name: 'senderSig', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'MessageSent',
    anonymous: false,
    inputs: [
      { name: 'schemeId', type: 'uint256', indexed: true },
      { name: 'stealthAddress', type: 'address', indexed: true },
      { name: 'sender', type: 'address', indexed: true },
      { name: 'ephemeralPubKey', type: 'bytes', indexed: false },
      { name: 'viewTag', type: 'bytes1', indexed: false },
      { name: 'ciphertext', type: 'bytes', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'StealthMetaAddressSet',
    anonymous: false,
    inputs: [
      { name: 'registrant', type: 'address', indexed: true },
      { name: 'schemeId', type: 'uint256', indexed: false },
      { name: 'stealthMetaAddress', type: 'bytes', indexed: false },
    ],
  },
] as const

// ── EIP-712 typed data (mirrors StealthMessenger.MESSAGE_TYPEHASH + Solady's domain) ────────────

/** Solady folds chainId + verifyingContract into the separator; name/version are fixed on-chain. */
const EIP712_DOMAIN = {
  name: 'MsgBoardStealth',
  version: '1',
  chainId: STEALTH_CHAIN_ID,
  verifyingContract: STEALTH_MESSENGER_ADDRESS,
} as const

const MESSAGE_TYPES = {
  Message: [
    { name: 'schemeId', type: 'uint256' },
    { name: 'sender', type: 'address' },
    { name: 'stealthAddress', type: 'address' },
    { name: 'ephemeralPubKeyHash', type: 'bytes32' },
    { name: 'viewTag', type: 'bytes1' },
    { name: 'ciphertextHash', type: 'bytes32' },
  ],
} as const

// ── the wallet-derived stealth identity message (FIXED FOREVER — mirrors wallet-identity.ts) ────

/**
 * The message the wallet signs to derive the stealth spending + viewing keys. FIXED — every user's
 * stealth identity is a function of this exact string, so a single byte change silently rotates
 * everyone. The signature is HKDF input keying material only; it never leaves the browser.
 */
export const STEALTH_IDENTITY_MESSAGE =
  'MsgBoard stealth identity v1\n\n' +
  'Sign to derive your stealth-address spending & viewing keys on this device.\n\n' +
  'This signature is used only to derive keys locally — it is never sent anywhere. It lets others ' +
  'send you private on-chain messages that only you can detect. Anyone who can produce this ' +
  'signature controls the identity, so only sign it in wallets you trust.'

// ── clients ─────────────────────────────────────────────────────────────────────────────────

/** The dedicated read client on 943 (the contract's chain), keyed valve.city RPC + any override. */
export function stealthPublicClient(): PublicClient {
  const rpcUrl = rpcs.get('pulsechainV4')!.rpcUrl
  return createPublicClient({ chain: pulsechainV4, transport: http(rpcUrl) }) as PublicClient
}

/** Minimal EIP-1193 injected-provider shape — we only need request(). */
type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }

/** True when an injected wallet is present. */
export function hasInjectedWallet(): boolean {
  return typeof (globalThis as unknown as { ethereum?: Eip1193 }).ethereum?.request === 'function'
}

function injected(): Eip1193 {
  const eth = (globalThis as unknown as { ethereum?: Eip1193 }).ethereum
  if (!eth?.request) throw new Error('No injected wallet found — install one to use stealth messaging.')
  return eth
}

/** Connect + return the primary account address (checksummed). */
export async function connectWallet(): Promise<Address> {
  const accounts = (await injected().request({ method: 'eth_requestAccounts' })) as string[]
  const address = accounts?.[0]
  if (!address) throw new Error('No account authorized in the wallet.')
  return getAddress(address)
}

/** Nudge the wallet onto chain 943; adds it if the wallet doesn't know it (error 4902). */
export async function ensureChain943(): Promise<void> {
  const eth = injected()
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: STEALTH_CHAIN_ID_HEX }] })
  } catch (err) {
    const code = (err as { code?: number })?.code
    if (code === 4902) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: STEALTH_CHAIN_ID_HEX,
            chainName: pulsechainV4.name,
            nativeCurrency: pulsechainV4.nativeCurrency,
            rpcUrls: [rpcs.get('pulsechainV4')!.rpcUrl],
            blockExplorerUrls: pulsechainV4.blockExplorers?.default?.url
              ? [pulsechainV4.blockExplorers.default.url]
              : undefined,
          },
        ],
      })
    } else {
      throw err
    }
  }
}

/** A wallet client bound to `account` on 943, over the injected provider. */
function walletClientFor(account: Address): WalletClient {
  return createWalletClient({ account, chain: pulsechainV4, transport: custom(injected()) })
}

// ── wallet-derived identity ─────────────────────────────────────────────────────────────────

/** The user's stealth identity: their EOA (registration key + sender) + derived meta-address. */
export interface StealthIdentity {
  /** The connected EOA — the registrant key and the authenticated `sender` on every message. */
  address: Address
  /** The spending + viewing keypairs derived deterministically from the wallet signature. */
  meta: StealthMetaAddress
}

/**
 * Connect the wallet, sign the fixed identity message, and derive the stealth keys from it. EOA-only
 * (mirrors wallet-identity.ts): a signature that doesn't recover to the signer (EIP-1271 / SCW) can't
 * reproduce the same keys, so we reject it rather than silently derive an unstable identity.
 */
export async function deriveStealthIdentityFromWallet(): Promise<StealthIdentity> {
  const address = await connectWallet()
  const sig = (await injected().request({
    method: 'personal_sign',
    params: [STEALTH_IDENTITY_MESSAGE, address],
  })) as Hex
  const recovered = await recoverMessageAddress({ message: STEALTH_IDENTITY_MESSAGE, signature: sig })
  if (getAddress(recovered) !== address) {
    throw new Error(
      'This wallet did not produce a standard, reproducible signature (it may be a smart-contract ' +
        'wallet). Stealth identity needs a standard EOA so your keys are recoverable by re-signing.',
    )
  }
  return { address, meta: deriveStealthMetaAddressFromSeed(hexToBytes(sig)) }
}

// ── registry reads/writes ─────────────────────────────────────────────────────────────────────

/**
 * Read a registrant's published stealth meta-address, or null if they haven't registered. The
 * contract returns empty bytes for an unregistered address; a valid schemeId-1 meta-address is 66
 * bytes (spendingPub ‖ viewingPub), so anything else is treated as "not registered".
 */
export async function readRegisteredMeta(
  client: PublicClient,
  registrant: Address,
): Promise<Uint8Array | null> {
  const raw = (await client.readContract({
    address: STEALTH_MESSENGER_ADDRESS,
    abi: STEALTH_MESSENGER_ABI,
    functionName: 'stealthMetaAddressOf',
    args: [registrant],
  })) as Hex
  const bytes = hexToBytes(raw)
  return bytes.length === 66 ? bytes : null
}

/** Publish (or update) your own meta-address on-chain. Returns the tx hash. */
export async function registerOnChain(account: Address, meta: Uint8Array): Promise<Hex> {
  await ensureChain943()
  return walletClientFor(account).writeContract({
    address: STEALTH_MESSENGER_ADDRESS,
    abi: STEALTH_MESSENGER_ABI,
    functionName: 'registerStealthMetaAddress',
    args: [bytesToHex(meta)],
    account,
    chain: pulsechainV4,
  })
}

// ── send ────────────────────────────────────────────────────────────────────────────────────

/** Everything a caller might want after a send: the tx hash + the derived announcement fields. */
export interface SentMessage {
  txHash: Hex
  stealthAddress: Hex
  ephemeralPubKey: Hex
  viewTag: Hex
  ciphertext: Hex
}

/**
 * Send an authenticated stealth message to `recipientMeta`:
 *   derive one-time stealth address + ephemeral key + view tag → encrypt the body under the ERC-5564
 *   shared secret → sign the EIP-712 Message digest with the wallet → sendMessage(...) on 943.
 * The contract recovers the signature and reverts unless it equals `account`, so the emitted
 * `sender` topic is a proven fact.
 */
export async function sendStealthMessage(
  account: Address,
  recipientMeta: Uint8Array,
  body: string,
): Promise<SentMessage> {
  const { stealthAddress, ephemeralPubKey, viewTag, sharedSecret } = deriveStealthAddress(recipientMeta)
  const ciphertext = encryptMessage(sharedSecret, body)

  const stealthAddressHex = getAddress(bytesToHex(stealthAddress))
  const ephemeralPubKeyHex = bytesToHex(ephemeralPubKey)
  const ciphertextHex = bytesToHex(ciphertext)
  const viewTagHex = toHex(viewTag, { size: 1 })

  await ensureChain943()
  const wallet = walletClientFor(account)

  // Sign the EXACT EIP-712 struct the contract hashes in messageDigest(): dynamic bytes are bound by
  // their keccak256 hash. signTypedData → eth_signTypedData_v4, the wallet-friendly path, and it
  // recovers to `account` over the same digest the contract recomputes on-chain.
  const senderSig = await wallet.signTypedData({
    account,
    domain: EIP712_DOMAIN,
    types: MESSAGE_TYPES,
    primaryType: 'Message',
    message: {
      schemeId: STEALTH_SCHEME_ID,
      sender: account,
      stealthAddress: stealthAddressHex,
      ephemeralPubKeyHash: keccak256(ephemeralPubKeyHex),
      viewTag: viewTagHex,
      ciphertextHash: keccak256(ciphertextHex),
    },
  })

  const txHash = await wallet.writeContract({
    address: STEALTH_MESSENGER_ADDRESS,
    abi: STEALTH_MESSENGER_ABI,
    functionName: 'sendMessage',
    args: [STEALTH_SCHEME_ID, account, stealthAddressHex, ephemeralPubKeyHex, viewTagHex, ciphertextHex, senderSig],
    account,
    chain: pulsechainV4,
  })

  return { txHash, stealthAddress: stealthAddressHex, ephemeralPubKey: ephemeralPubKeyHex, viewTag: viewTagHex, ciphertext: ciphertextHex }
}

// ── inbox scan (MessageSent logs) ─────────────────────────────────────────────────────────────

/** A raw announcement pulled from a MessageSent log, before the recipient-side scan. */
export interface RawAnnouncement {
  sender: Address
  stealthAddress: Address
  ephemeralPubKey: Hex
  viewTag: Hex
  ciphertext: Hex
  blockNumber: bigint
  txHash: Hex
}

/**
 * Content hash for client-side dedup — keccak256(ephemeralPubKey ‖ ciphertext). The contract keeps
 * NO on-chain dedup (event-only primitive), so a verbatim replay or an ECDSA-malleability twin can
 * re-emit an identical message; collapsing on this hash removes both.
 */
export function announcementContentHash(ephemeralPubKey: Hex, ciphertext: Hex): Hex {
  return keccak256(concat([ephemeralPubKey, ciphertext]))
}

/**
 * Fetch every MessageSent log from the deploy block to head, chunked to stay under RPC getLogs range
 * caps. Returns them oldest-first.
 */
export async function fetchAnnouncements(
  client: PublicClient,
  fromBlock: bigint = STEALTH_DEPLOY_BLOCK,
): Promise<RawAnnouncement[]> {
  const head = await client.getBlockNumber()
  const out: RawAnnouncement[] = []
  for (let start = fromBlock; start <= head; start += LOG_CHUNK) {
    const end = start + LOG_CHUNK - 1n > head ? head : start + LOG_CHUNK - 1n
    const logs = await client.getLogs({
      address: STEALTH_MESSENGER_ADDRESS,
      event: STEALTH_MESSENGER_ABI[7] as (typeof STEALTH_MESSENGER_ABI)[7], // MessageSent
      fromBlock: start,
      toBlock: end,
    })
    for (const log of logs) {
      const a = log.args as {
        sender?: Address
        stealthAddress?: Address
        ephemeralPubKey?: Hex
        viewTag?: Hex
        ciphertext?: Hex
      }
      if (!a.sender || !a.stealthAddress || !a.ephemeralPubKey || a.viewTag == null || a.ciphertext == null) continue
      out.push({
        sender: a.sender,
        stealthAddress: a.stealthAddress,
        ephemeralPubKey: a.ephemeralPubKey,
        viewTag: a.viewTag,
        ciphertext: a.ciphertext,
        blockNumber: log.blockNumber ?? 0n,
        txHash: log.transactionHash ?? ('0x' as Hex),
      })
    }
  }
  return out
}

/** viewTag byte (0-255) from its bytes1 hex form. */
export function viewTagByte(viewTag: Hex): number {
  return hexToBytes(viewTag)[0] ?? 0
}

export { isAddress }
