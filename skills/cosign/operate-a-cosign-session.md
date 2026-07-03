---
name: operate-a-cosign-session
description: Drive a Gnosis Safe co-signature session end-to-end via the @msgboard/cosign SDK — pick a Safe, build/verify the digest, sign, post the share to MsgBoard, collect + aggregate other owners' shares, and execute. Use when asked to co-sign, collect signatures for, or execute a Safe transaction through cosign (as opposed to a hosted Safe transaction service).
---

# Operate a cosign session

Cosign coordinates a Gnosis Safe multisig signature **off-chain, over MsgBoard**, with no trusted
server. This skill walks a single co-sign session from "pick a Safe" to "execute." It assumes a
viem `PublicClient`/wallet client for the Safe's chain and a `BoardClient` for MsgBoard (see
`use-msgboard-cosign-sdk.md` for what that seam looks like).

Ground truth for every claim below: `packages/cosign/src/{index,client,record}.ts`,
`packages/cosign/src/adapters/safe.ts`, `packages/cosign-web/src/lib/{cosign,safe-typed-data,simulate}.ts`.

## 0. Prerequisites

```ts
import {
  makeSafeAdapter, safeTransactionDigest, SCHEME,
  postSignature, readSignatures, aggregate, buildExecTransactionArgs,
  encodeSafeMeta, decodeSafeMeta,
} from '@msgboard/cosign'
```

You need:
- `safe`: the Safe (proxy) address.
- `chainId`: the chain the Safe lives on. **This can differ from the chain MsgBoard runs on** —
  cosign never writes to the Safe's chain until the final `execTransaction` call.
- `board`: a `BoardClient` (`{ addMessage({category,data}), content({category}) }`) wired to a live
  MsgBoard endpoint.
- `publicClient`: read access to the Safe's chain (for `getOwners`/`getThreshold`/`getTransactionHash`).

## 1. Scope the session

Every share for this Safe on this chain lives under one scope string:

```ts
const scope = `safe:${chainId}:${safe.toLowerCase()}`
```

(`scopeFor()` in `packages/cosign-web/src/lib/cosign.ts` — do this exactly; the string is part of
the category-key preimage, so any deviation puts your shares in a different bucket that nobody else
is reading.)

## 2. Build the SafeTx and compute the digest

```ts
const safeTx = {
  to, value, data, operation, // 0 = Call, 1 = DelegateCall
  safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce,
}
const digest = safeTransactionDigest(safeTx, chainId, safe) // byte-equal to on-chain getTransactionHash
```

Before asking anyone to sign, **simulate** the transaction (see `simulate.ts` in cosign-web) so the
signer sees real asset movement and a revert flag — this is the "what you're signing" step, not
optional in a good implementation.

## 3. Sign — with the parity guardrail

If you replicate the EIP-712 typed-data table locally (cosign-web does, because the SDK only
exports the resulting digest function, not the raw typed-data shape), you **must** verify parity
before posting:

```ts
const signature = await wallet.signTypedData({ domain: { chainId, verifyingContract: safe }, types, primaryType: 'SafeTx', message: safeTx })

// GUARDRAIL — recompute the SDK's canonical digest and recover; refuse to post on mismatch.
const recovered = await recoverAddress({ hash: safeTransactionDigest(safeTx, chainId, safe), signature })
if (!isAddressEqual(recovered, signerAddress)) {
  throw new Error('typed-data table has drifted from the SDK — refusing to post')
}
```

This mirrors `assertSafeTxSignatureParity()` in `packages/cosign-web/src/lib/safe-typed-data.ts`.
Skipping it means a drifted local types table can silently produce a share the Safe adapter later
rejects (or worse, one that verifies against the wrong digest).

Build the record:

```ts
const record = {
  digest,
  signer: signerAddress,
  signature,
  scheme: SCHEME.EIP712,           // or SCHEME.ECDSA for a raw personal_sign digest, no SafeTx meta
  meta: encodeSafeMeta(safeTx, safe, chainId), // '0x' if you only have a bare digest, not a full SafeTx
}
```

## 4. Post the share

```ts
await postSignature(board, { namespace: 'cosign', scope, record })
```

This posts under **today's UTC-day category key**. If your `board.addMessage` involves
proof-of-work (MsgBoard's anti-spam gate), **run the grind off the calling thread** — in a browser
that means a Web Worker, never the main thread (see `packages/cosign-web/src/seams/worker-board.ts`
for the reference implementation). This is a hard requirement in this codebase
(`msgboard-pow-never-main-thread`), not a style preference.

## 5. Collect other owners' shares

```ts
const records = await readSignatures(board, { namespace: 'cosign', scope, days: 7 })
const forThisDigest = records.filter((r) => r.digest === digest)
```

For quorum robustness, union this with the cosign-archive service (shares age out of the board's
live window well before a multi-owner sign-off usually finishes):

```
GET https://cosign-archive.msgboard.xyz/cosign/cosign/${scope}/signatures?days=7
→ { signatures: [...] }
```

Dedupe the union by `${digest}:${signature}` (lowercased) — board wins on collision. Degrade to
board-only if the archive request fails; never let archive downtime block the flow.

## 6. Aggregate

```ts
const adapter = makeSafeAdapter({ publicClient, safe, chainId })
const pairs = await aggregate(forThisDigest, adapter) // verify-filters + orders
```

`aggregate()` **drops** anything that doesn't independently verify (wrong recovered signer, signer
not a current Safe owner, failed EIP-1271 check) — it does not throw on a bad share, it just
excludes it. Check `pairs.length >= threshold` (read `adapter.owners()`/`adapter.threshold()`, or
your own cached copy) before declaring quorum met.

To get the final calldata, re-map the aggregated pairs back to their source records (matching on
signature bytes) and build the blob/args:

```ts
const ordered = forThisDigest.filter((r) => pairs.some((p) => p.signature === r.signature))
const args = buildExecTransactionArgs(ordered, safeTx) // [to,value,data,operation,...,signaturesBlob]
```

(`packages/cosign-web/src/lib/cosign.ts`'s `aggregateForSafe()` does exactly this re-mapping — reuse
that pattern rather than re-deriving the blob with a second verify pass.)

## 7. Execute

Any owner (or anyone holding the assembled `args`) submits `execTransaction(...)` directly to the
Safe contract and pays gas. This is the **only** on-chain write in the entire flow, and the Safe
contract re-verifies every signature itself via `checkNSignatures` — so even if every prior step in
this skill were skipped or faked, the chain-level check is still the actual security boundary.

## Common mistakes

- Using the wrong `scope` string (must be exactly `safe:${chainId}:${lowercased safe}`) — shares
  silently land in a bucket nobody else reads.
- Trusting `readSignatures()` output without running it through `aggregate()`/`adapter.verify()` —
  the board is open; anyone can post junk or an invalid signature under any category.
- Running PoW-stamping on a UI's main thread.
- Forgetting the archive union — a real multi-owner sign-off can easily outlast the board's live
  read window.
