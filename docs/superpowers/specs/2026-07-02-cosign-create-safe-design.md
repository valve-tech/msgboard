# Design: "Create a Safe" in cosign-web

**Date:** 2026-07-02
**Component:** `packages/cosign-web`
**Status:** approved design → pending spec review

## Problem

cosign-web today is a gasless, off-chain co-signing coordination layer over MsgBoard: it
*discovers* Safes an owner already controls and helps co-sign their transactions. There is no
way to *create* a new Gnosis Safe from the app. A user with no Safe cannot start.

We want to add a "Create a Safe" flow that lets a user choose owners + threshold, deploy a new
Safe on-chain, and hand it straight into the existing co-sign flow. This is the app's first
first-class chain-write (the wallet hook already exposes `writeContract` for the experimental
`execTransaction` submit, so the capability exists; this makes deployment a first-class path).

## Goals

1. **Bootstrap** — someone with no Safe can create one (esp. on 943 testnet) and immediately
   co-sign with it end-to-end.
2. **Production-capable** — usable for real multisigs on mainnet (1) and PulseChain (369), with a
   provable predicted address and robust owner management.
3. **Optional gasless** — a toggle to deploy without the user paying gas, via the existing
   `sponsor`/`faucet` infra. Secondary path; user-pays is the default.

## Non-goals (YAGNI for v1)

- Modules, guards, custom fallback handlers, or non-zero `payment*` setup fields.
- Multi-send / batched setup, or deploying + submitting a first tx atomically.
- Recovering/importing a Safe by predicted address before it is deployed.
- ERC-4337 Safe accounts (the app has a `safe4337` adapter, but deploy targets the classic Safe).

## Approach

A new **"Create Safe" mode** inside the existing single-page app (there is no router today; this is
a mode/panel toggle, consistent with the current wizard). It reuses `useWallet` for the wallet tx
and `discoverSafes`/the co-sign wizard for the handoff. Rejected: a bare form (misses the
production + gasless goals); linking out to app.safe.global (no 369/943 support, not self-contained).

## Safe version & addresses — v1.4.1 only

**Decision: the app deploys v1.4.1 exclusively.** One version keeps the UI and address table
simple, and v1.4.1 is the current standard. (The co-sign flow still works with *existing* Safes of
any version — this decision only governs what the Create-Safe feature *mints*.) We deploy the
**L2 singleton** (PulseChain uses SafeL2 for event emission; discovery is consistent with this).

Canonical v1.4.1 deterministic-deployment addresses (identical on every chain that has them):

| role | v1.4.1 address |
|------|----------------|
| SafeProxyFactory | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` |
| Safe **L2** singleton | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` |
| CompatibilityFallbackHandler | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` |

**Availability is feature-detected, not assumed.** On mount / chain change the app calls
`eth_getCode` on the v1.4.1 factory for the connected chain; if it has no code, Create-Safe is
disabled on that chain with a clear reason. Verified 2026-07-02: **369 + mainnet have v1.4.1; 943
does NOT** (factory `0x4e1DCf…` returns `0x`) — see the prerequisite below.

### Prerequisite: provision Safe v1.4.1 on 943

943 has only v1.3.0 today, but its **deterministic deployment proxy (`0x4e59b448…`) IS present**, so
the canonical v1.4.1 suite can be deployed to 943 at the same addresses as other chains. This is a
one-time, on-chain provisioning step (its own mini-runbook), NOT part of the app:
- Reproducing the *exact* canonical addresses may require Safe's `safe-singleton-factory`
  (`0x914d7Fec…`) rather than the Arachnid proxy that's present — **planning must confirm** which
  factory the canonical v1.4.1 deployment used and whether it's reproducible on 943. If it is not,
  fallback: deploy v1.4.1 at 943-specific addresses and make the address table per-chain
  (`Record<chainId, {factory,singletonL2,fallbackHandler}>` instead of a single constant).
- Needs a **funded 943 deployer key** (943 faucet was rate-limited ~2026-07-01; may have reset).
- Source of truth for the deployment tx data: `@safe-global/safe-deployments` /
  `@safe-global/safe-singleton-factory`.

Until 943 is provisioned, Create-Safe is simply disabled on 943 (feature-detection handles this
gracefully); co-signing existing 943 Safes is unaffected.

## Architecture

Two new units; everything else is reuse.

### `src/lib/deploy-safe.ts` (pure, testable — no React)
- `SAFE_V141` — the canonical addresses above. If planning proves 943 needs different addresses,
  this becomes `safeDeploymentFor(chainId)` returning a per-chain `{factory,singletonL2,fallbackHandler}`.
- `PROXY_FACTORY_ABI` (just `createProxyWithNonce(address,bytes,uint256)` + the `ProxyCreation` event)
  and `SAFE_SETUP_ABI` (`setup(address[],uint256,address,bytes,address,address,uint256,address)`).
- `buildSetup(owners: Hex[], threshold: number)` → the `setup` initializer calldata:
  `to=0, data=0x, fallbackHandler=<v1.4.1 handler>, paymentToken=0, payment=0, paymentReceiver=0`.
- `predictSafeAddress({ owners, threshold, saltNonce, chainId })` → the deterministic CREATE2
  address: `keccak256(0xff ‖ factory ‖ salt ‖ keccak256(proxyCreationCode ‖ singleton))` where
  `salt = keccak256(keccak256(initializer) ‖ saltNonce)` (the Safe proxy-creation scheme). The
  v1.4.1 proxy creation code is a constant.
- `isDeploySupported(publicClient, chainId)` → `eth_getCode` on the v1.4.1 factory (the gate above).
- No wallet/tx here — pure functions so they unit-test against known CREATE2 vectors.

### `src/hooks/useWallet.ts` — one small addition
- `deploySafe(initializer, saltNonce)` → `writeContract(createProxyWithNonce)` on the v1.4.1
  factory; returns the tx hash. Mirrors the existing `submitExecTransaction`. `chain: null`
  (the wallet's current chain), same as the existing writes.

### Create-Safe UI (a panel/component + a mode toggle in `App.tsx`)
- Owner rows (default = connected wallet address; add/remove; validate `isAddress`; dedupe).
- Threshold selector (1…N, default `min(2, N)` guidance but never > N).
- If `isDeploySupported` is false for the connected chain, disable Create-Safe with a clear reason
  ("Safe v1.4.1 isn't available on this chain yet") rather than offering a version that can't deploy.
- **Predicted-address preview** — recomputed live from owners/threshold/saltNonce; shown
  before the user signs. `saltNonce` defaults to a fresh random value (regenerate button).
- Gasless toggle (see below), shown only when a sponsor is available for the connected chain.
- Deploy button → wallet tx → wait for receipt → parse `ProxyCreation` → **assert the created proxy
  == predicted address** → success.

## Gas model

- **User-pays (default):** `deploySafe(...)` sends `createProxyWithNonce` from the connected wallet.
- **Gasless (optional):** a toggle, shown only where a sponsor exists (943 first). The exact relay
  is finalized in planning against `packages/sponsor`/`faucet`, but the seam is `sponsoredDeploy()`:
  the app hands the sponsor the `{version, initializer, saltNonce}` (never a signature — deployment
  needs no Safe-owner signature) and the sponsor submits `createProxyWithNonce` and pays gas. The
  predicted address is identical regardless of who submits (CREATE2 depends on factory+init+salt,
  not the sender), so the preview + post-deploy assertion are unchanged.

## Post-deploy handoff

On success the app sets the new Safe as the active Safe/scope (`safe:<chainId>:<addr>`) and enters
the co-sign flow directly — skipping discovery, since we just created it. The new Safe will also
appear in `discoverSafes` once the safe-indexer backfill reaches its block.

## Error handling

- No wallet / wrong chain (no factory code for any version) → disable Deploy with a clear reason.
- Rejected tx / insufficient funds → surface the wallet error verbatim (like the existing sign flow).
- Receipt has no `ProxyCreation`, or the created proxy != predicted → hard error ("deployment did
  not produce the expected Safe — do not use it"), never silently proceed.
- Duplicate/invalid owners, threshold > owners, threshold < 1 → inline validation, Deploy disabled.

## Testing

- **Unit (vitest):** `predictSafeAddress` against known Safe v1.4.1 CREATE2 vectors; `buildSetup`
  encodes the exact initializer for a known fixture; `isDeploySupported` with a faked publicClient
  (code vs `0x`).
- **Integration:** extend the existing `scripts/e2e-943.ts` pattern — predict + (funds permitting)
  actually deploy a Safe on 943 and assert the mined proxy == predicted, then run the existing
  digest-parity check against the freshly-created Safe. (943 faucet was rate-limited earlier; the
  predict/encode checks run without funds, the live deploy runs when a funded key is available.)

## Rollout

Ship behind the existing deploy runbook (`ansible/deploy-cosign.yml`, rebuild cosign-web). No new
service, no new Caddy/DNS. The feature is inert until a user opens the Create-Safe panel.
