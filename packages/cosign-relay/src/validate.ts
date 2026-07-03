import {
  type Hex,
  decodeFunctionData,
  encodeAbiParameters,
  isAddress,
  isAddressEqual,
  keccak256,
  recoverMessageAddress,
  zeroAddress,
} from 'viem'
import { SAFE_SETUP_ABI, SAFE_V141 } from './constants.js'

/** The decoded arguments of a Safe v1.4.1 `setup(...)` call. */
export type SafeSetup = {
  owners: Hex[]
  threshold: bigint
  to: Hex
  data: Hex
  fallbackHandler: Hex
  paymentToken: Hex
  payment: bigint
  paymentReceiver: Hex
}

/** Decodes a Safe `setup(...)` initializer. Throws if `initializer` is not a `setup` call. */
export function decodeSafeSetup(initializer: Hex): SafeSetup {
  const decoded = (() => {
    try {
      return decodeFunctionData({ abi: SAFE_SETUP_ABI, data: initializer })
    } catch {
      throw new Error('initializer does not decode as a Safe setup call')
    }
  })()
  if ((decoded.functionName as string) !== 'setup') {
    throw new Error('initializer is not a Safe setup call')
  }
  const [owners, threshold, to, data, fallbackHandler, paymentToken, payment, paymentReceiver] = decoded.args
  return {
    owners: [...owners],
    threshold,
    to,
    data,
    fallbackHandler,
    paymentToken,
    payment,
    paymentReceiver,
  }
}

/**
 * The anti-abuse core: throws unless `decoded` is a PLAIN owners+threshold multisig — no
 * delegatecall (`to`/`data`), no payment redirect, and no non-canonical fallback handler. This is
 * what makes it safe for the relay to sponsor gas: it can never be tricked into paying for a
 * setup that hands control or funds anywhere but the Safe's own ownership set.
 */
export function assertPlainSafeSetup(decoded: SafeSetup): void {
  if (!isAddressEqual(decoded.to, zeroAddress)) {
    throw new Error('setup.to must be the zero address (no delegatecall on setup)')
  }
  if (decoded.data !== '0x') {
    throw new Error('setup.data must be empty (no delegatecall payload on setup)')
  }
  if (!isAddressEqual(decoded.fallbackHandler, SAFE_V141.fallbackHandler)) {
    throw new Error('setup.fallbackHandler must be the canonical Safe v1.4.1 fallback handler')
  }
  if (!isAddressEqual(decoded.paymentToken, zeroAddress)) {
    throw new Error('setup.paymentToken must be the zero address')
  }
  if (decoded.payment !== 0n) {
    throw new Error('setup.payment must be zero')
  }
  if (!isAddressEqual(decoded.paymentReceiver, zeroAddress)) {
    throw new Error('setup.paymentReceiver must be the zero address')
  }
  if (decoded.owners.length < 1) {
    throw new Error('setup must have at least one owner')
  }
  for (const owner of decoded.owners) {
    if (!isAddress(owner)) {
      throw new Error(`setup owner ${owner} is not a valid address`)
    }
  }
  const lowered = decoded.owners.map((owner) => owner.toLowerCase())
  if (new Set(lowered).size !== lowered.length) {
    throw new Error('setup owners must be unique')
  }
  if (decoded.threshold < 1n || decoded.threshold > BigInt(decoded.owners.length)) {
    throw new Error('setup threshold must satisfy 1 <= threshold <= owners.length')
  }
}

/**
 * The canonical request digest the relay's signed-owner gate is anchored to:
 * `keccak256(abi.encode(chainId, singleton, keccak256(initializer), saltNonce))`. Binding the
 * chain id + singleton + initializer + saltNonce means a signature over one deploy request can
 * never be replayed against a different chain, singleton, or Safe configuration.
 */
export function requestDigest(args: { chainId: number | bigint; singleton: Hex; initializer: Hex; saltNonce: bigint }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }],
      [BigInt(args.chainId), args.singleton, keccak256(args.initializer), args.saltNonce],
    ),
  )
}

/** Recovers the EIP-191 personal-sign address for a signature over the raw 32-byte digest. */
export function recoverRequestSigner(digest: Hex, signature: Hex): Promise<Hex> {
  return recoverMessageAddress({ message: { raw: digest }, signature })
}
