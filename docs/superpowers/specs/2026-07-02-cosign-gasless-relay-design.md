# Design: cosign gasless-deploy relay

**Date:** 2026-07-02
**Component:** new `packages/cosign-relay` + cosign-web seam + deploy
**Status:** approved decisions → pending spec review

## Problem

Create-a-Safe currently makes the user pay gas (`createProxyWithNonce` from their wallet). We want an
**optional gasless path**: a relay service submits the deploy and pays gas, so a user with an empty
wallet can still create a Safe. Chains in scope (user decision): **PulseChain v4 testnet (943)** and
**PulseChain mainnet (369)**. Ethereum mainnet stays user-pays.

## Goals / non-goals

- **Goal:** `POST /deploy-safe` that validates + relays a Safe v1.4.1 `createProxyWithNonce` on 943/369
  and returns the tx hash. The app's existing `sponsoredDeploy` seam calls it; the UI's gasless toggle
  appears only where the relay is configured.
- **Non-goal (v1):** sponsoring `execTransaction` (co-signed tx execution). Deploy-only for now.
- **Non-goal:** Ethereum mainnet sponsorship.
- **Non-goal:** any change to the predicted-address / verification path — CREATE2 is submitter-independent,
  so the app still runs `confirmDeploy(client, hash, predicted)` on the relay's tx hash unchanged.

## Abuse control (defense-in-depth — user chose BOTH)

Every request must pass ALL of:
1. **Signed-owner gate.** The request carries a signature over the canonical request digest
   `keccak256(abi.encode(chainId, singleton, keccak256(initializer), saltNonce))` (EIP-191 personal-sign).
   The relay decodes the `owners[]` from the `initializer` (the Safe `setup` calldata) and requires the
   recovered signer to be **one of those owners**. This ties every sponsored deploy to a real participant
   of the Safe being created — a stranger cannot spend relay gas.
2. **PoW gate (MsgBoard-style).** The request carries a proof-of-work stamp over the same digest, verified
   with the board's PoW verifier (reuse `@msgboard/sdk`/core PoW verify + the board's live difficulty).
   Walletless CPU cost per request, consistent with how MsgBoard gates spam.
3. **Per-IP rate-limit.** A per-IP daily cap (default 5/day), keyed on `X-Forwarded-For` (Caddy/Cloudflare
   sets it). In-memory token bucket is fine for v1 (single instance); note the cap in logs.

## Payload validation (before any of the gates cost the relay anything, cheapest checks first)

- `chainId ∈ {943, 369}` and a relay key is configured for it, else 400.
- `initializer` decodes as Safe `setup(owners[], threshold, to, data, fallbackHandler, paymentToken,
  payment, paymentReceiver)` with: `to == 0`, `data == 0x`, `fallbackHandler ==` canonical v1.4.1 handler,
  `paymentToken == 0`, `payment == 0`, `paymentReceiver == 0`, `1 ≤ threshold ≤ owners.length`, owners
  non-empty + unique. Anything else → 400 (the relay only sponsors plain multisigs, never a setup with a
  `to`/`data` delegatecall or a payment redirect).
- `singleton ==` canonical v1.4.1 L2 singleton.
- The predicted address is recomputed relay-side; the relay refuses if a contract already exists there.

Order: static payload validation → signed-owner recovery → PoW verify → rate-limit → submit. (Put the
cheapest, most-likely-to-reject checks first; PoW verify before the actual send.)

## Architecture

`packages/cosign-relay` — a small Hono service (mirrors safe-indexer/cosign-archive shape):
- `src/validate.ts` (pure): `decodeSafeSetup(initializer)`, `assertPlainSafeSetup(...)`, `requestDigest(...)`,
  `recoverRequestSigner(...)`. Unit-tested.
- `src/gates.ts` (pure-ish): `verifyPow(...)` (board verifier), `rateLimiter()` (in-memory bucket). Unit-tested.
- `src/submit.ts`: per-chain funded wallet client (`RELAY_KEY_943`, `RELAY_KEY_369`), `submitDeploy(...)`
  → `writeContract(createProxyWithNonce)`; returns tx hash. Never logs keys.
- `src/server.ts`: Hono `POST /deploy-safe` (+ `GET /health`, `GET /config` → which chains are enabled).
  Binds 0.0.0.0; behind Caddy.
- Served at **`cosign.msgboard.xyz/relay/*`** (path route on the existing host — no new DNS, mirrors
  safe-indexer), or a dedicated `cosign-relay.msgboard.xyz` if a subdomain is preferred.

cosign-web:
- `config.ts`: `RELAY_BASE` + `relayChains` (943, 369).
- `deploy-safe.ts`: flesh out `sponsoredDeploy({chainId, initializer, saltNonce, ownerSignature, pow})`
  → POST `RELAY_BASE/deploy-safe`; the browser builds the PoW off-thread (reuse the worker-board PoW
  already used for cosign shares) and asks the connected owner wallet to personal-sign the request digest.
- `CreateSafe.tsx`: the gasless toggle (shown when `relayChains` includes the connected chain); when on,
  `onDeploy` gets the owner signature + PoW, calls `sponsoredDeploy`, then the SAME `confirmDeploy`.

## Funding (dependency)

- **943:** reuse the box faucet key (already funded; the "msgboard sponsorship"). Low risk (testnet).
- **369:** PulseChain mainnet has **no faucet** — the relay needs a **funded 369 hot wallet key**
  (`RELAY_KEY_369`) the operator provides. This is a real (if cheap) cost + an abuse target, which is why
  both gates above are mandatory. **The user must supply/point at a funded 369 key before 369 goes live;**
  until then the relay runs 943-only and the UI toggle shows only on 943.

## Testing

- **Unit (vitest):** `decodeSafeSetup`/`assertPlainSafeSetup` (accept a plain multisig; reject non-zero
  `to`/`data`/payment, bad threshold, dup owners); `requestDigest`/`recoverRequestSigner` (round-trip a
  known signer; reject a non-owner); `verifyPow` (accept a valid stamp, reject a forged one);
  `rateLimiter` (allows N, blocks N+1, resets next day).
- **Integration:** on 943, a full happy-path request (owner-signed + valid PoW) deploys a Safe and the
  returned tx's mined proxy == the app's `predictSafeAddress` (source-of-truth, funded by the faucet key).
- **Negative integration:** a request signed by a non-owner, or with a bad PoW, is rejected 4xx and spends
  no gas.

## Rollout

Ship via a new `ansible/deploy-cosign-relay.yml` (mirror safe-indexer's hardening: wait-for-listen,
route-aware smoke that asserts a relay-specific `/health`/`/config` body, block/rescue). Add the
`/relay/*` route to the cosign union block. cosign-web redeploys with the toggle. 943 first; 369 the
moment a funded key is supplied.
