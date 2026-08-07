import * as viem from 'viem'
import hre from 'hardhat'

// Shared x402 EIP-3009 deposit-authorization helpers for the ZkTable hardhat suites
// (ZkTable.test.ts / ZkTableDispute.test.ts / ZkGas.test.ts). Mirrors the Foundry suites'
// X402AuthLib.sol: builds the `ReceiveWithAuthorization` EIP-712 digest against a wrapper
// token's own domain, signs it, and packs the result into ZkTable's `DepositAuth` shape.
// MockX402's domain is fixed ("x402 PLS" / "1") to mirror the real deployed wrapper exactly.

export const X402_DOMAIN_NAME = 'x402 PLS'
export const X402_DOMAIN_VERSION = '1'

export type X402Domain = {
  name: string
  version: string
  chainId: number
  verifyingContract: viem.Hex
}

/// Deploys ZkTable with `factory_` as its x402 wrapper-factory constructor arg (see ZkTable.sol's
/// IWrapperFactory — pass `viem.zeroAddress` to skip the create()-time clone-check, matching the
/// Foundry unit suites' factory=address(0) escape hatch).
///
/// ZkTable link-references the EXTERNAL (separately-deployed) ShowdownDecodeLib library — unlike
/// Foundry, which auto-links external libraries transparently when a test does `new ZkTable(...)`,
/// `hre.viem.deployContract` requires the library to be deployed and its address passed
/// explicitly via the `libraries` option, or it throws MissingLibraryAddressError. This deploys
/// ShowdownDecodeLib once and links it for every ZkTable instance the hardhat suites create.
export const deployZkTable = async (factory: viem.Hex) => {
  const showdownDecodeLib = await hre.viem.deployContract('ShowdownDecodeLib')
  return await hre.viem.deployContract('ZkTable', [factory], {
    libraries: { ShowdownDecodeLib: showdownDecodeLib.address },
  })
}

export const makeX402Domain = (chainId: number, verifyingContract: viem.Hex): X402Domain => ({
  name: X402_DOMAIN_NAME,
  version: X402_DOMAIN_VERSION,
  chainId,
  verifyingContract,
})

const RECEIVE_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

export type TypedDataSigner = {
  signTypedData(args: any): Promise<viem.Hex>
  address?: viem.Hex
  account?: { address: viem.Hex }
}

export const signerAddress = (signer: TypedDataSigner): viem.Hex =>
  (signer.address ?? signer.account!.address) as viem.Hex

/// ZkTable.DepositAuth as a tuple-shaped object matching the generated ABI's struct arg.
export type DepositAuth = {
  from: viem.Hex
  validBefore: bigint
  salt: viem.Hex
  sig: viem.Hex
}

/// Signs the EIP-3009 ReceiveWithAuthorization struct for `signer` against `domain`
/// (viem's `signTypedData` already returns the packed 65-byte (r,s,v) form ZkTable._pull
/// routes through its universal EOA overload — no manual repacking needed) and wraps it in
/// ZkTable's DepositAuth shape.
const signDepositAuth = async (
  signer: TypedDataSigner,
  domain: X402Domain,
  message: { from: viem.Hex; to: viem.Hex; value: bigint; validAfter: bigint; validBefore: bigint; nonce: viem.Hex },
  salt: viem.Hex,
): Promise<DepositAuth> => {
  const sig = await signer.signTypedData({
    domain,
    types: RECEIVE_TYPES,
    primaryType: 'ReceiveWithAuthorization',
    message,
  })
  return { from: message.from, validBefore: message.validBefore, salt, sig }
}

// A near-future (not far-future — see ZkTable.sol's DepositAuth @dev note on topUp) default
// expiry: 1 hour out, plenty for a synchronous hardhat test but nowhere near a "live landmine".
export const defaultValidBefore = () => BigInt(Math.floor(Date.now() / 1000) + 3600)

// The ZkTable contract handle from hardhat-viem's `deployContract`/`getContractAt`. Typed `any`
// deliberately: viem's generated contract type carries a broad `read` index signature that a
// hand-written interface can't structurally satisfy, and these helpers only ever touch
// `zk.read.{create,join,topUp}Nonce` + `zk.address` — matching the loose viem typing the rest of
// this package's hardhat suites use. Runtime shape is exercised by the suites themselves.
type ZkLike = any

export const buildCreateAuth = async (
  zk: ZkLike,
  tokenAddress: viem.Hex,
  domain: X402Domain,
  signer: TypedDataSigner,
  opts: {
    rules: viem.Hex
    buyIn: bigint
    joinStake: bigint
    clockBlocks: bigint
    channelKey: viem.Hex
    deckKey: readonly [bigint, bigint]
    salt?: viem.Hex
    validBefore?: bigint
  },
): Promise<DepositAuth> => {
  const from = signerAddress(signer)
  const salt = opts.salt ?? viem.zeroHash
  const validBefore = opts.validBefore ?? defaultValidBefore()
  const nonce = await zk.read.createNonce([
    from,
    tokenAddress,
    opts.rules,
    opts.buyIn,
    opts.joinStake,
    opts.clockBlocks,
    opts.channelKey,
    opts.deckKey,
    salt,
  ])
  return await signDepositAuth(
    signer,
    domain,
    { from, to: zk.address, value: opts.buyIn, validAfter: 0n, validBefore, nonce },
    salt,
  )
}

export const buildJoinAuth = async (
  zk: ZkLike,
  domain: X402Domain,
  signer: TypedDataSigner,
  opts: {
    tableId: viem.Hex
    stake: bigint
    channelKey: viem.Hex
    deckKey: readonly [bigint, bigint]
    salt?: viem.Hex
    validBefore?: bigint
  },
): Promise<DepositAuth> => {
  const from = signerAddress(signer)
  const salt = opts.salt ?? viem.zeroHash
  const validBefore = opts.validBefore ?? defaultValidBefore()
  const nonce = await zk.read.joinNonce([opts.tableId, from, opts.channelKey, opts.deckKey])
  return await signDepositAuth(
    signer,
    domain,
    { from, to: zk.address, value: opts.stake, validAfter: 0n, validBefore, nonce },
    salt,
  )
}

export const buildTopUpAuth = async (
  zk: ZkLike,
  domain: X402Domain,
  signer: TypedDataSigner,
  opts: {
    tableId: viem.Hex
    amount: bigint
    salt?: viem.Hex
    validBefore?: bigint
  },
): Promise<DepositAuth> => {
  const from = signerAddress(signer)
  // SHORT-lived by default (see ZkTable.sol's DepositAuth @dev note): a topUp auth is
  // bearer-submittable for as long as it's valid, so tests mirror the real client obligation
  // instead of defaulting to a far-future expiry.
  const salt = opts.salt ?? viem.zeroHash
  const validBefore = opts.validBefore ?? BigInt(Math.floor(Date.now() / 1000) + 300)
  const nonce = await zk.read.topUpNonce([opts.tableId, from, opts.amount, salt])
  return await signDepositAuth(
    signer,
    domain,
    { from, to: zk.address, value: opts.amount, validAfter: 0n, validBefore, nonce },
    salt,
  )
}

// ── HoldemTableN (N-party) helpers ──────────────────────────────────────────────────────────
// HoldemTableN.sol's sibling x402 conversion (2026-08). Same DepositAuth shape and
// ReceiveWithAuthorization signing as ZkTable — only the create()/join() nonce formulas differ
// (createNonce additionally binds maxSeats/rakeBps/rakeCap; joinNonce ALSO carries a salt, as of
// F2 — not for anti-double-join, which the seat/key collision loop already enforces, but so a
// player who `leaveBeforeStart`s can rejoin the same table with a fresh salt instead of being
// permanently locked out by the wrapper's burned nonce for the bare (tableId, from, channelKey,
// deckKey) tuple).

/// Deploys HoldemTableN with `(treasury, factory_)` constructor args (see HoldemTableN.sol's
/// IWrapperFactory — pass `viem.zeroAddress` for `factory` to skip the create()-time clone-check,
/// matching the Foundry unit suites' factory=address(0) escape hatch). Unlike ZkTable,
/// HoldemTableN links NO external library, so this is a plain deployContract call.
export const deployHoldemTableN = async (treasury: viem.Hex, factory: viem.Hex) => {
  return await hre.viem.deployContract('HoldemTableN', [treasury, factory])
}

export const buildCreateAuthN = async (
  zk: ZkLike,
  tokenAddress: viem.Hex,
  domain: X402Domain,
  signer: TypedDataSigner,
  opts: {
    rules: viem.Hex
    buyIn: bigint
    maxSeats: bigint
    rakeBps: number
    rakeCap: bigint
    clockBlocks: bigint
    channelKey: viem.Hex
    deckKey: readonly [bigint, bigint]
    salt?: viem.Hex
    validBefore?: bigint
  },
): Promise<DepositAuth> => {
  const from = signerAddress(signer)
  const salt = opts.salt ?? viem.zeroHash
  const validBefore = opts.validBefore ?? defaultValidBefore()
  const nonce = await zk.read.createNonce([
    from,
    tokenAddress,
    opts.rules,
    opts.buyIn,
    opts.maxSeats,
    opts.rakeBps,
    opts.rakeCap,
    opts.clockBlocks,
    opts.channelKey,
    opts.deckKey,
    salt,
  ])
  return await signDepositAuth(
    signer,
    domain,
    { from, to: zk.address, value: opts.buyIn, validAfter: 0n, validBefore, nonce },
    salt,
  )
}

export const buildJoinAuthN = async (
  zk: ZkLike,
  domain: X402Domain,
  signer: TypedDataSigner,
  opts: {
    tableId: viem.Hex
    stake: bigint
    channelKey: viem.Hex
    deckKey: readonly [bigint, bigint]
    salt?: viem.Hex
    validBefore?: bigint
  },
): Promise<DepositAuth> => {
  const from = signerAddress(signer)
  // F2 (2026-08): joinNonce now takes a salt too — NOT for anti-double-join (the seat/key
  // collision loop already enforces one seat per (tableId, from) while a player is seated), but
  // for REJOIN LIVENESS: without it, a player who `leaveBeforeStart`s could never rejoin the
  // same table with the identical channelKey/deckKey (the wrapper's nonce for that bare tuple
  // would already be burned forever). Defaults to zeroHash for the common case (first join);
  // callers doing a rejoin after `leaveBeforeStart` must pass a FRESH salt.
  const salt = opts.salt ?? viem.zeroHash
  const validBefore = opts.validBefore ?? defaultValidBefore()
  const nonce = await zk.read.joinNonce([opts.tableId, from, opts.channelKey, opts.deckKey, salt])
  return await signDepositAuth(
    signer,
    domain,
    { from, to: zk.address, value: opts.stake, validAfter: 0n, validBefore, nonce },
    salt,
  )
}
