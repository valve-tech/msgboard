---
name: use-msgboard-cosign-sdk
description: API reference for the @msgboard/cosign package — the SignatureRecord wire format (RECORD_ABI), category-key math, the BoardClient seam, postSignature/readSignatures/aggregate, and the CosignAdapter interface (Safe, Safe4337, Rhinestone). Use when writing code against @msgboard/cosign or explaining what a specific export does.
---

# Use the @msgboard/cosign SDK

`@msgboard/cosign` (`packages/cosign/src`) is a pure, framework-agnostic TypeScript package: generic
signature-share coordination over a MsgBoard-shaped message board, bucketed under rotating,
day-granular UTC category keys. It makes **zero chain writes** — everything on-chain (reading
owners/threshold, verifying signatures, executing) goes through the adapter you pass it, and
execution itself happens outside the SDK entirely.

## The BoardClient seam

The SDK doesn't depend on `@msgboard/sdk` directly — it depends on this minimal interface, which you
wrap around a real MsgBoard client:

```ts
interface BoardClient {
  addMessage(arg: { category: Hex; data: Hex }): Promise<unknown>
  content(arg: { category: Hex }): Promise<Content> // Content: Record<Hex, { data: Hex }[] | undefined>
}
```

`addMessage` is where any proof-of-work stamping happens (in a real MsgBoard client) — keep that off
your UI's main thread if you're in a browser.

## Category keys (`keys.ts`)

```ts
isoDay(date: Date): string                                    // UTC "YYYY-MM-DD"
categoryKey(namespace, scope, isoDate): Hex                    // keccak256(utf8(`${namespace}:${scope}:${isoDate}`))
currentKey(namespace, scope, now?): Hex                         // categoryKey(..., isoDay(now))
keysForWindow(namespace, scope, days, now?): Hex[]              // today-first, then the prior (days-1) UTC days
```

`categoryKey` is byte-for-byte identical to `@msgboard/core`'s `categoryHash(keyString)` for the
same string — computed directly here so this package has no `core` dependency. **Order is law:**
`namespace:scope:isoDate`, joined with `:`, UTF-8 bytes, keccak256.

`keysForWindow` throws if `days < 1`. `now` is injectable everywhere for deterministic tests.

## The record format (`record.ts`)

```ts
interface SignatureRecord {
  digest: Hex     // bytes32 — the signed digest (e.g. a Safe safeTxHash)
  signer: Hex     // address — the claimed signer
  signature: Hex  // bytes   — e.g. 65-byte r||s||v for ECDSA
  scheme: number  // uint8   — see SCHEME
  meta: Hex       // bytes   — scheme-specific payload; '0x' if unused
}

const SCHEME = { ECDSA: 0, EIP1271: 1, EIP712: 2 } as const

const RECORD_ABI = [
  { name: 'digest',    type: 'bytes32' },
  { name: 'signer',    type: 'address' },
  { name: 'signature', type: 'bytes'   },
  { name: 'scheme',    type: 'uint8'   },
  { name: 'meta',      type: 'bytes'   },
] as const

encodeRecord(r: SignatureRecord): Hex   // ABI-encode per RECORD_ABI — ORDER IS LAW
decodeRecord(data: Hex): SignatureRecord // throws (via viem) on malformed input
```

Both the board reader path and the cosign-archive service decode against this exact ABI tuple, in
this exact field order. Never reorder it.

## Client functions (`client.ts`)

```ts
postSignature(board, { namespace, scope, record, now? }): Promise<unknown>
  // → board.addMessage({ category: currentKey(namespace, scope, now), data: encodeRecord(record) })

readSignatures(board, { namespace, scope, days, now? }): Promise<SignatureRecord[]>
  // sweeps keysForWindow(...), decodes every message under every key,
  // SKIPS undecodable junk (the board is open — junk is expected),
  // dedupes by keccak256(raw message data). Never drops a well-formed record;
  // validity is the adapter's job, not this function's.

groupByDigest(records): Map<Hex, SignatureRecord[]>
  // buckets by record.digest, preserving input order within each bucket

aggregate(records, adapter): Promise<{ signer: Hex; signature: Hex }[]>
  // keeps only records adapter.verify() returns true for (drops the rest — does not throw),
  // then applies adapter.order(kept) and projects to { signer, signature } pairs
```

## The `CosignAdapter` interface

```ts
interface CosignAdapter {
  verify(record: SignatureRecord): Promise<boolean>
  order(records: SignatureRecord[]): SignatureRecord[]
  owners?(): Promise<Hex[]>
  threshold?(): Promise<number>
}
```

`@msgboard/cosign` ships three concrete adapters, all in `packages/cosign/src/adapters/`:

- **`makeSafeAdapter({ publicClient, safe, chainId })`** (`safe.ts`) — Gnosis Safe v1.3.0/v1.4.1.
  `verify()` recovers the effective signer over `record.digest` (EIP-712: plain `ecrecover`; ECDSA:
  `personal_sign`-prefixed recovery; EIP1271: trusts `record.signer` as the contract owner claim,
  then actually calls its `isValidSignature`), requires the recovered address (or claimed owner) is
  a *current* Safe owner via `getOwners()`, and for EIP-1271 additionally rebuilds the exact
  `0x19 0x01 ‖ domainSeparator ‖ safeTxHash` preimage and checks the owner contract returns the
  magic `0x20c13b0b`. `order()` sorts strictly ascending by signer address (Safe's
  `checkNSignatures`/blob-encoding requirement).
- **`makeSafe4337Adapter(...)`** (`safe4337.ts`) — Safe4337Module UserOperations (ERC-4337 flow),
  same shape, different digest/domain.
- **`makeRhinestoneOwnableAdapter(...)`** (`rhinestone.ts`) — Rhinestone's ownable validator module
  for smart accounts, again same `CosignAdapter` shape.

Because `verify`/`order` are the entire adapter contract, a new backend (a different multisig
standard) only needs those two functions (plus optional `owners`/`threshold` for UI quorum display)
to plug into the exact same `postSignature`/`readSignatures`/`aggregate` pipeline.

## Safe-specific helpers (`adapters/safe.ts`)

```ts
type SafeTx = { to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce }

safeDomain(chainId, safe): Hex                 // keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, chainId, safe))
                                                // NO name/version — matches Safe's on-chain domainSeparator()
safeTransactionDigest(safeTx, chainId, safe): Hex   // EIP-712 hash; == on-chain getTransactionHash(...)
safeTransactionData(safeTx, chainId, safe): Hex     // 0x19‖0x01‖domainSeparator‖safeTxHash preimage
encodeSafeMeta(safeTx, safe, chainId): Hex      // packs the full SafeTx (+safe+chainId) into record.meta
decodeSafeMeta(meta): { safeTx, safe, chainId } // unpacks it back
recoverEffectiveSigner(record): Promise<Hex>    // digest-agnostic; scheme-dispatches per above
buildSignatureBlob(orderedRecords): Hex         // the Safe `signatures` bytes (EOA: 65B word;
                                                 // EIP-1271: static word + back-patched dynamic tail)
buildExecTransactionArgs(orderedRecords, safeTx) // full positional execTransaction(...) argument tuple
SAFE_ABI       // getOwners/getThreshold/isOwner/getTransactionHash read fragment
SAFE_TX_TYPEHASH, DOMAIN_SEPARATOR_TYPEHASH, EIP1271_MAGIC_VALUE
```

`recoverEffectiveSigner` and `buildSignatureBlob`/`buildExecTransactionArgs` are useful outside the
adapter itself — e.g. a UI that wants to show "who signed" without running a full `aggregate()` pass
can call `recoverEffectiveSigner` directly per record.

## What this SDK deliberately does NOT do

- It never calls `execTransaction` or any other state-changing chain call.
- It never trusts a read source (board or otherwise) — every record is re-verified against live
  chain state by the adapter before being counted.
- It has no notion of "the" board endpoint, chain, or RPC — all of that is supplied by the caller
  via `BoardClient` and the adapter's `publicClient`.
