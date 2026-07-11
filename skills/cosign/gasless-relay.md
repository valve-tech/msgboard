---
name: gasless-relay
description: Deploy a new Gnosis Safe v1.4.1 with NO gas in the deployer's wallet, via the cosign-relay gasless-deploy service — sign a request digest, solve a small proof-of-work, POST to the relay, and it submits createProxyWithNonce paying its own gas. Use when asked to deploy a Safe gaslessly, sponsor a Safe deploy, or drive the relay's /deploy-safe endpoint directly (e.g. from an agent with no funded wallet).
---

# Gasless deploy via the relay

`packages/cosign-relay` is an optional, purely-additive service that sponsors gas for deploying a
new Safe v1.4.1 on chains it has a funded key for. It never touches co-signing or execution — only
the deploy step from `create-a-safe.md` — and a user/agent with zero native gas can still deploy a
Safe through it.

Ground truth: `packages/cosign-relay/src/{server,validate,pow,ratelimit,submit}.ts` (relay),
`packages/cosign-web/src/lib/gasless.ts` (client). Read `create-a-safe.md` first — this skill only
replaces its Step 2 ("Deploy"); Steps 1, 3, and 4 (predict, verify mined==predicted, hand off) are
**unchanged and still mandatory**.

Live relay: `https://cosign.msgboard.xyz/relay`. Currently sponsors chain **943** (PulseChain v4
testnet) only; 369 (PulseChain mainnet) activates once an operator funds `RELAY_KEY_369` on the
relay (PulseChain mainnet has no faucet). Ethereum mainnet is never sponsored. Check `GET /config`
rather than assuming — see below.

## Endpoints

| Method & path | Returns |
|---|---|
| `GET /relay/health` | `{ "ok": true }` — liveness. |
| `GET /relay/config` | `{ "chains": [943, ...], "powBits": 20, "sponsors": [{ "chainId": 943, "address": "0x...", "balance": "123..." }] }` — which chains currently have a funded relay key, the PoW difficulty to solve, and each sponsor's own address + native balance (wei, as a decimal string). Never throws; an RPC hiccup just reports that chain's balance as `"0"`. |
| `POST /relay/deploy-safe` | `{ "txHash": "0x...", "proxy": "0x..." }` on success. `400 { "error": "..." }` for any gate failure, `429` for the rate limit, `500` for anything unexpected. |

Only deploy through the relay a chain that `GET /config`'s `chains` array actually lists —
requesting an unsponsored chain is rejected with 400 before anything else runs.

## Step 2′ — Deploy via the relay instead of the wallet

1. Build `initializer = buildSetup(owners, threshold)` and `predicted = predictSafeAddress(...)`
   exactly as in `create-a-safe.md` Step 1 — **the relay path does not change prediction at all.**
2. Compute the request digest — **byte-identical** to `create-a-safe.md`'s deploy call, just bound
   to a request instead of sent straight to the factory:

   ```ts
   digest = keccak256(abi.encode(
     ['uint256', 'address', 'bytes32', 'uint256'],
     [chainId, SAFE_V141.singletonL2, keccak256(initializer), saltNonce],
   ))
   ```

   This must match `requestDigest()` in `packages/cosign-relay/src/validate.ts` and
   `deployRequestDigest()` in `packages/cosign-web/src/lib/gasless.ts` exactly — binding chain id +
   singleton + initializer + saltNonce means a signature over one request can never be replayed
   against a different chain, singleton, or Safe configuration.
3. **Gate 1 — signed owner.** Have one of the Safe's intended `owners[]` personal-sign the raw
   32-byte digest (`recoverMessageAddress({ message: { raw: digest }, signature })` — EIP-191, not
   EIP-712). The relay recovers the signer and rejects the request unless it's one of the setup's
   own owners. Signing does not cost gas and does not require the signer to hold any funds.
4. **Gate 2 — proof of work.** Solve a hashcash-style stamp over the same digest: find a 32-byte
   `powNonce` such that `keccak256(digest ++ pad(powNonce, 32))`, read as a uint256, is below
   `2^256 / 2^powBits` (`powBits` comes from `GET /config`, default 20 — about 1,000,000 hashes,
   roughly a second of grinding). This is a walletless CPU cost that makes spamming the relay
   expensive without requiring the caller to hold gas. Grind off the UI thread if driving this from
   a browser (a Web Worker, matching the MsgBoard PoW convention elsewhere in this repo); a plain
   loop is fine from a script/agent.

   ```ts
   function solvePow(digest, bits) {
     for (let i = 0n; ; i++) {
       const nonce = toHex(i, { size: 32 })
       if (BigInt(keccak256(concat([digest, pad(nonce, { size: 32 })]))) < 2n ** BigInt(256 - bits)) return nonce
     }
   }
   ```
5. POST to `/relay/deploy-safe`:

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

   `singleton` must be the canonical Safe v1.4.1 L2 singleton — the relay rejects anything else.
   `saltNonce` is sent as a decimal string (or number) and parsed with `BigInt(...)` server-side.

The relay additionally enforces (in order, cheapest-first, before it ever recovers a signature or
sends a transaction):

1. `chainId` is enabled and `singleton` is the canonical L2 singleton.
2. `initializer` decodes as a Safe `setup(...)` call for a **plain owners+threshold multisig
   only** — `to == 0x0`, `data == 0x`, `fallbackHandler ==` the canonical v1.4.1 handler,
   `paymentToken == 0`, `payment == 0`, `paymentReceiver == 0`, owners non-empty and unique,
   `1 <= threshold <= owners.length`. **The relay will never sponsor a setup that delegatecalls out
   or redirects a payment** — this is the anti-abuse core that makes it safe to sponsor gas at all
   (`assertPlainSafeSetup` in `validate.ts`). Don't build a setup with a non-zero `to`/`data`/
   `payment*` expecting the relay to submit it — it will be rejected with a 400 before the PoW or
   signature gates even run.
3. PoW gate (step 4 above).
4. Signed-owner gate (step 3 above).
5. Per-IP daily rate limit (`X-Forwarded-For`, first hop; default 5/day, in-memory — resets on
   relay restart).
6. Only then does the relay submit `createProxyWithNonce` from its own funded key and wait for the
   receipt, parsing `ProxyCreation` for the deployed proxy.

## Step 3 — Verify: still mandatory, still unchanged

Run `confirmDeploy(client, txHash, predicted)` from `create-a-safe.md` against the `txHash` the
relay returns, exactly as in the user-pays path. CREATE2 addresses are **submitter-independent** —
the relay paying gas does not change what address a given `(factory, singleton, initializer,
saltNonce)` tuple deploys to — so a misbehaving or compromised relay can at most fail to submit
your request; it can never trick you into accepting a Safe at a different address than you
predicted and signed for. **Never skip this check just because the relay "already validated"
anything** — the relay's validation protects its own gas, not your address assumption.

## Self-sustaining sponsor

The relay pays gas from a per-chain hot wallet (`RELAY_KEY_943`/`RELAY_KEY_369` on the relay's own
host — never exposed over the API). `GET /config`'s `sponsors[]` array exposes that wallet's
address and current native balance so anyone can check how much runway is left, and anyone can top
it up by sending it native gas directly — no special permission needed. cosign-web's footer
(`SponsorStatus.tsx`) renders this live.

## Common mistakes

- Treating the relay's acceptance as proof of anything beyond "gas got paid" — still run
  `confirmDeploy` against the mined receipt.
- Signing the EIP-712 `SafeTx` digest instead of the raw request digest — the relay's signed-owner
  gate expects a personal-sign (`message: { raw: digest }`) over the request digest defined above,
  not a `SafeTx`/`execTransaction` signature (those are for co-signing an existing Safe's
  transactions, unrelated to this deploy-time gate).
- Building a non-plain `setup()` (any non-zero `to`/`data`/`payment*`, or a non-canonical
  `fallbackHandler`) and expecting the relay to sponsor it — it won't; use the user-pays path in
  `create-a-safe.md` for anything beyond a plain multisig.
- Assuming 369 is sponsored — check `GET /config`'s `chains` array; only 943 is live until an
  operator funds `RELAY_KEY_369`.
- Running the PoW grind on a browser's main thread — it should never block the UI (see the
  MsgBoard PoW convention: PoW always runs off the main thread).
