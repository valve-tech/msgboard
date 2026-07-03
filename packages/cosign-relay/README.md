# @msgboard/cosign-relay

Gasless-deploy relay for cosign's "Create a Safe" flow. A user with an empty wallet on
**PulseChain v4 testnet (943)** or **PulseChain mainnet (369)** can still create a Safe v1.4.1:
the browser builds the `createProxyWithNonce` call, this service validates the request and
submits it on-chain, paying gas from a per-chain funded relay key, and returns the tx hash. The
app then verifies the mined proxy against its own predicted CREATE2 address (that check lives in
cosign-web, not here — CREATE2 addresses are submitter-independent).

Ethereum mainnet stays user-pays; this relay never sponsors it. `execTransaction` (co-signed tx
execution) is out of scope for v1 — deploy-only.

## Endpoint

### `GET /health`
`{ "ok": true }` — liveness.

### `GET /config`
`{ "chains": [943, 369], "powBits": 20 }` — which chains currently have a funded relay key
configured, and the PoW difficulty callers must solve for.

### `POST /deploy-safe`

Body:

```json
{
  "chainId": 943,
  "singleton": "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
  "initializer": "0x...",
  "saltNonce": "12345",
  "signature": "0x...",
  "powNonce": "0x..."
}
```

- `singleton` must be the canonical Safe v1.4.1 L2 singleton (`0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`).
- `initializer` is the Safe `setup(...)` calldata for a **plain** owners+threshold multisig only:
  `to == 0x0`, `data == 0x`, `fallbackHandler ==` the canonical v1.4.1 handler
  (`0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99`), `paymentToken == 0`, `payment == 0`,
  `paymentReceiver == 0`, owners non-empty and unique, `1 <= threshold <= owners.length`. Anything
  else is rejected — the relay will never sponsor a setup that delegatecalls out or redirects a
  payment.
- `signature` is an EIP-191 personal-sign (`recoverMessageAddress({ message: { raw: digest } })`)
  over the request digest by one of the Safe's own `owners[]`:
  `keccak256(abi.encode(chainId, singleton, keccak256(initializer), saltNonce))`.
- `powNonce` is a hashcash-style proof-of-work stamp over the same digest (see Gate 2 below).

Response (200): `{ "txHash": "0x...", "proxy": "0x..." }`.
Errors: `400 { "error": "..." }` for any validation/gate failure, `429 { "error": "..." }` for the
per-IP rate limit, `500 { "error": "internal error" }` for anything unexpected (never leaks
internals — check server logs for the real cause).

Checks run in this order, cheapest/most-likely-to-reject first, so a bad request never reaches the
expensive checks (signature recovery, then the actual on-chain send):

1. `chainId` is enabled (has a relay key configured) and `singleton` is the canonical L2 singleton.
2. `initializer` decodes as a Safe `setup` call and passes `assertPlainSafeSetup`.
3. **Gate 1 — PoW.** `powNonce` satisfies `POW_BITS` of hashcash difficulty over the request digest.
4. **Gate 2 — signed owner.** The signature recovers to one of the setup's own `owners[]`.
5. **Gate 3 — rate limit.** Per-IP (`X-Forwarded-For`, first hop) daily cap, default 5/day.
6. Submit `createProxyWithNonce` on-chain from that chain's relay key; wait for the receipt; parse
   `ProxyCreation` for the deployed proxy address.

## Abuse control (defense-in-depth)

Every request must pass **both** of:

1. **Signed-owner gate** — ties every sponsored deploy to a real participant of the Safe being
   created. A stranger who isn't one of the intended owners cannot spend relay gas.
2. **PoW gate** — a walletless CPU cost per request (self-contained hashcash: valid iff
   `keccak256(digest ++ pad(nonce, 32))`, read as a uint256, is below the `POW_BITS`-difficulty
   target). Default `POW_BITS = 20` (~1,000,000 hashes, ~1s of grinding; tune via env).

...plus a per-IP daily rate limit as a third, coarser backstop (in-memory token bucket — fine for
a single instance; note the cap doesn't survive a process restart).

## Env vars

| Var                 | Default                                              | Notes                                          |
|----------------------|-------------------------------------------------------|-------------------------------------------------|
| `RELAY_KEY_943`      | *(unset)*                                             | Funded hot-wallet private key for chain 943. Chain is disabled without it. |
| `RELAY_KEY_369`      | *(unset)*                                             | Funded hot-wallet private key for chain 369. **PulseChain mainnet has no faucet** — this must be supplied before 369 goes live. |
| `RPC_943`            | `https://one.valve.city/rpc/vk_demo/evm/943`         | RPC endpoint for chain 943. |
| `RPC_369`            | `https://one.valve.city/rpc/vk_demo/evm/369`         | RPC endpoint for chain 369. |
| `POW_BITS`           | `20`                                                   | Hashcash difficulty (leading zero bits over the digest). |
| `RATE_LIMIT_PER_DAY` | `5`                                                    | Per-IP daily deploy cap. |
| `PORT`               | `8787`                                                 | Listen port (binds `0.0.0.0`). |

The relay key env vars are never logged. `enabledChains()` (exposed via `GET /config`) reports
*which* chains are live, never the keys themselves.

## Development

```
npm test --workspace=packages/cosign-relay   # vitest — validate.ts / pow.ts / ratelimit.ts / server.ts wiring
npm run build --workspace=packages/cosign-relay   # tsc --noEmit
npm run start --workspace=packages/cosign-relay   # tsx src/index.ts — DO NOT run this against a real funded key outside of production
```
