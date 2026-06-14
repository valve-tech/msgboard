# @msgboard/cosign

Generic **signature-share** SDK over [MsgBoard](https://github.com/valve-tech/msgboard): post, read, and
aggregate co-signature artifacts — `(digest, signer, signature, scheme, meta)` records — bucketed under
**rotating, day-granular UTC category keys** so the working set stays small and self-pruning.

App-agnostic. A pluggable **adapter** encodes a specific multisig's verify/order/owner-read rules. cosign is a
coordination/aggregation layer for **existing** off-chain-signature-aggregation multisig tools — it does **not**
build its own multisig. The generic core plus the `CosignAdapter` interface land first; **concrete adapters ship
in this same package's `src/adapters/`** (the Gnosis Safe adapter first; full roadmap + non-fits in the cosign SDK
spec). Pure board + crypto: **no chain writes**.

## Canonical encodings (law — downstream tooling mirrors these)

- **Category key**: `keccak256(toBytes(`${namespace}:${scope}:${isoDate}`))`, where `isoDate` is UTC
  `YYYY-MM-DD`. Field separator is `:`; order is `namespace:scope:isoDate`.
- **SignatureRecord ABI tuple** (order is law):
  `(bytes32 digest, address signer, bytes signature, uint8 scheme, bytes meta)`.
- **Schemes**: `SCHEME = { ECDSA: 0, EIP1271: 1, EIP712: 2 }`.

## Quick start

```ts
import { MsgBoardClient } from '@msgboard/sdk'
import {
  type BoardClient,
  type CosignAdapter,
  SCHEME,
  postSignature,
  readSignatures,
  groupByDigest,
  aggregate,
} from '@msgboard/cosign'

// Wrap the real, lower-level MsgBoardClient into cosign's BoardClient seam.
// Posting is a two-step on the real client: doPoW (find a nonce) then addMessage.
function boardFrom(client: MsgBoardClient): BoardClient {
  return {
    async addMessage({ category, data }) {
      const { message } = await client.doPoW(category, data)
      return client.addMessage(message)
    },
    content({ category }) {
      return client.content({ category })
    },
  }
}

const board = boardFrom(new MsgBoardClient(provider))

// Post a signature under today's rotating category.
await postSignature(board, {
  namespace: 'cosign',
  scope: 'acme-team',
  record: { digest, signer, signature, scheme: SCHEME.ECDSA, meta: '0x' },
})

// Read the rolling 7-day window, group by digest, and aggregate via your adapter.
const records = await readSignatures(board, { namespace: 'cosign', scope: 'acme-team', days: 7 })
const forDigest = groupByDigest(records).get(digest) ?? []
const ordered = await aggregate(forDigest, myAdapter) // myAdapter satisfies CosignAdapter
// `ordered` is `{ signer, signature }[]` — hand to your existing execute path (out of scope here).
```

> The core + `CosignAdapter` **interface** land first — supply a concrete adapter to aggregate.
> Concrete adapters ship in this same package's `src/adapters/` (the Gnosis Safe adapter first — its own
> spec/plan; full roadmap + non-fits in the cosign SDK spec §9).

## API

- `keys`: `isoDay`, `categoryKey`, `currentKey`, `keysForWindow` (all accept an explicit `now?: Date`).
- `record`: `SignatureRecord`, `SCHEME`, `RECORD_ABI`, `encodeRecord`, `decodeRecord` (decode throws on junk).
- `client`: `BoardClient`, `postSignature`, `readSignatures` (skips undecodable junk, dedupes by data),
  `groupByDigest`, `aggregate` (filters by `adapter.verify`, applies `adapter.order`; verify errors propagate).
- `adapters`: `CosignAdapter` (the seam — interface lands first; concrete adapters ship in `src/adapters/` via follow-up plans, Safe first).
