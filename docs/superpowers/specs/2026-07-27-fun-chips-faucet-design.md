# Fun-Chips Faucet — Design Spec

**Date:** 2026-07-27
**Status:** Approved design; awaiting spec review → implementation plan.
**Context:** msgboard.xyz landing (`packages/ui`) + games (`games/*`, `packages/relayer`). Greenlit Task 1 from `progress.txt` ("mint fun-chips on request"). Design decisions confirmed with the user (see §2).

## 1. Goal

Let a visitor to msgboard.xyz **mint testnet play-chips to their own wallet** by asking over the board — the same "post a message, get funded" pattern as the existing v4 **gas faucet** (`packages/sponsor` + the UI `gas-request` flow), but the payout is an ERC-20 `Chips.mint` instead of a native transfer.

Chips are a **grant** (they land in the user's ownership); they are taken to games.msgboard.xyz to play the real (still testnet) games. The landing coin-flip **stays zero-stakes and untouched** — the faucet never stakes or settles anything.

Non-goals: real-money chips (those stay games.msgboard.xyz); staking the landing flip; any change to the coin-flip fairness path; an HTTP endpoint.

## 2. Confirmed decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Chips semantics** | **Grant** — mint to ownership; landing flip stays zero-stakes | On mainnet, chips are escrowed up-front via `HouseChannel.open()` (`safeTransferFrom(player→channel)`) and co-signed states settle the escrowed pot — staking is a *separate* flow. The faucet just gives you chips to own. |
| **Architecture** | **Board-watcher service on `@msgboard/relayer`** (no HTTP) | Mirrors `packages/sponsor` (the v4 gas faucet). The relayer framework already does board-watch + dedup + observe/live. |
| **Recipient** | **Connected wallet** | Same wallet the user brings to games.msgboard.xyz (where staking needs a funded wallet). Adds lightweight wallet-connect to the previously walletless Arcade. |
| **Mint authority** | **Transfer Chips ownership → a dedicated faucet key**; the service mints directly | `Chips` is single-owner Solady `Ownable` (`mint` is `onlyOwner`, no minter role). Keeps the valve-deployer key off the box. |

## 3. What we reuse from the v4 gas faucet

The v4 gas faucet is the template. Studied:

- **`packages/sponsor/index.ts`** — a `@msgboard/relayer` `Relayer<RPCMessage>`:
  - `source: msgboardContentSource({ category: 'gasmoneyplease' })`
  - `condition: (message) => isAddress(message.data)` — **the post's `data` IS the recipient address** (no envelope)
  - `key: (message) => message.hash.toLowerCase()` — **one PoW-stamped post = one payout** (dedup)
  - `store` (dedup persistence) + `action: sendValueAction({ account, recipient, amount, gas })`
  - `mode: 'observe' | 'live'`, `intervalMs`.
- **UI `gas-request` flow** (`Interactive.tsx` / `Category.tsx`): `categoryType: 'gas-request'` posts the user's **address as the message text** to the `gasmoneyplease` category, PoW-stamped, gated on `selectFaucetIsActive` (the chain has a `gasSponsor` in `rpc.ts`).
- **`packages/relayer` primitives:** `msgboardContentSource`, `sendValueAction` (the shape `mintChipsAction` mirrors), `memoryTtlStore` (in-memory TTL dedup — no postgres), `postgresStore` (available if durable dedup is wanted).
- **`games/house-service/src/faucet.ts`** — `faucetMint` already has the owner-`mint` ABI fragment + `min(amount, cap)` cap; the new action reuses this logic.

**Delta from the gas faucet:** a new `mintChipsAction` (ERC-20 `mint` instead of `sendTransaction`); a distinct category; the Arcade "Get chips" UI instead of the generic `gas-request` input.

## 4. Architecture

```
Arcade (packages/ui)                 Board (games.msgboard.xyz)         chip-faucet service (fleet)
  connect wallet  ───────────┐
  "Get chips"                │  PoW-stamped post
     post: data = walletAddr ├────────►  category chipsplease:943  ◄──── msgboardContentSource poll
                             │            (data = recipient addr)         condition: isAddress(data)
  poll Chips.balanceOf(you) ◄┘                                            key: message.hash (dedup)
     shows on-chain balance                                              action: mintChipsAction
                                        Chips.mint(you, amount) ◄─────────  (writeContract, waits receipt)
```

### 4.1 Components

1. **`mintChipsAction`** — `packages/relayer/src/actions/mint-chips.ts` (new; barrel-exported from `packages/relayer/src/index.ts`). Mirrors `sendValueAction`:
   - options `{ account, chips: Address, recipient: (item,ctx)=>Address, amount: bigint, cap: bigint, gas?: bigint, walletFactory? }`.
   - `describe`: `mint <amount> chips to <recipient>`.
   - `execute`: `wallet.writeContract({ address: chips, abi: MINT_ABI, functionName: 'mint', args: [to, min(amount,cap)] })`, then `waitForTransactionReceipt`, return `{ ok: true, ref: hash }`. `MINT_ABI` = the fragment already in `faucet.ts` (extract to a shared const or duplicate the 4-line fragment).
2. **chip-faucet entry** — `games/e2e/scripts/chip-faucet.ts` (a fleet actor, esbuild-bundled like `landing-house.ts`; mirrors `packages/sponsor/index.ts`). Builds a `Relayer<RPCMessage>`:
   - `source: msgboardContentSource({ category: CHIP_CATEGORY })`
   - `condition: (m) => isAddress(m.data)`
   - `key: (m) => m.hash.toLowerCase()`
   - `store: memoryTtlStore({ maxAgeMs })` (durable postgres is a later option, not v1)
   - `action: mintChipsAction({ account: faucetKey, chips: CHIPS_943, recipient: (m)=>m.data, amount: GRANT, cap: GRANT, gas })`
   - `mode: FAKE ? 'observe' : 'live'`, `intervalMs`.
   - Startup banner logs the faucet address (like `landing-house`) so the deploy can smoke it.
3. **Arcade UI** (`packages/ui/src/components/Arcade.tsx` + a small `lib/wallet.ts` + `stores/chain.ts` config):
   - **Connect wallet** — lightweight injected/EIP-1193 connect via viem (`createWalletClient({ transport: custom(window.ethereum) })`), request accounts, expose the address. Reuse `games/web`'s connect pattern if one exists; otherwise a minimal local hook.
   - **"Get chips"** button — enabled when a wallet is connected AND the chip faucet is active for the chain. On click: post the connected address (as message data) to `CHIP_CATEGORY` via the existing **worker board** (PoW off-thread — same seam the flip uses), then poll `Chips.balanceOf(wallet)` on 943 until it increases (timeout → "still pending, check back"). Show the on-chain balance.
   - **"memory-only" toggle** — keeps the current local `1000n` counter (walletless, no mint) as the default frictionless mode. When on, the flip/tally use the local counter exactly as today; connecting + minting is opt-in.
   - **Config** — add a `chipFaucet` entry to the 943 chain config in `rpc.ts` (mirror `gasSponsor`): `{ chips: Address, category: string, amount: bigint }`, plus a `selectChipFaucetActive` selector (mirror `selectFaucetIsActive`).

### 4.2 Data / protocol

- **Category:** `CHIP_CATEGORY = 'chipsplease:943'` — a short, memorable name in the `gasmoneyplease` spirit, chain-suffixed to isolate 943. The UI poster and the faucet service must use this exact string.
- **Request message:** `data = <recipient address>` (a plain hex address string, exactly like `gasmoneyplease`). PoW-stamped by the poster (the Sybil cost). No JSON envelope.
- **Grant:** the on-chain `Chips.mint` tx itself is the receipt; the tx hash is the relayer action's `ref`. (v1 posts **no** board receipt — the UI confirms via `balanceOf`. A `chip-grant` board receipt is a possible later nicety, not v1.)

### 4.3 Keys, funding, ownership

- **Faucet key:** dedicated mnemonic **`HOUSE`-fleet index 51** (clear of 50=landing-house, 40–42=cosign, 30=session-bots, 20–22=bots). Env `FAUCET_INDEX` (default 51).
- **Gas:** minting is an on-chain tx → the faucet key **needs 943 gas (tPLS)**. Fund it and auto-top-up from account 0 like the other funded fleet bots (match the existing top-up envelope for 943).
- **Ownership:** **one-time** `Chips.transferOwnership(faucetKeyAddr)` sent by the current owner (valve-deployer). Chips 943 = `0x81f130c7d9ff020f46f3b01918424173f8d5ca64`; verify the current owner on-chain before transfer (memory says valve-deployer `0x5182574e…`, 2026-07-24 migration). **Trade-off accepted:** valve-deployer relinquishes Chips ownership; only the faucet key can mint/reclaim thereafter.

### 4.4 Anti-abuse / caps

- **PoW stamp** on the request post is the primary Sybil cost (identical to the gas faucet).
- **Dedup:** `key: message.hash` → one post = one grant; `memoryTtlStore` TTL covers the board's ~120-block retention window.
- **Per-tx cap:** `cap` in `mintChipsAction` bounds a single grant (defence against a misconfigured `amount`).
- **v1 keeps the gas faucet's simplicity** (fixed amount per PoW post + hash dedup). Per-recipient / global-daily caps are a **tunable follow-up** (a `condition` that counts prior grants per recipient in the store), noted but not built in v1 — testnet play-chips carry no real value.

## 5. Defaults (tunable)

- `GRANT` (amount per request) = **1000 chips** (base units per Chips decimals — confirm decimals; matches the landing's `1000` starting feel).
- `intervalMs` = 20_000 (mirror sponsor).
- `CHIP_CATEGORY` = `chipsplease:943`.
- `maxAgeMs` (dedup TTL) = 1h (mirror sponsor's store window).

## 6. Testing

- **`mintChipsAction`** (relayer vitest, mirror any `send-value` test): with an injected `walletFactory`, asserts it calls `writeContract` with `mint(recipient, min(amount,cap))` and waits the receipt; caps `amount>cap` to `cap`; `describe` is observe-safe (no tx).
- **chip-faucet wiring** (fleet-actor level): a fake board + fake wallet — a valid address post triggers exactly one mint; a duplicate post-hash triggers none; a non-address post is ignored (`condition`); observe mode mints nothing.
- **UI**: the Arcade "Get chips" path posts the connected address to `CHIP_CATEGORY` and reflects a `balanceOf` increase; the memory-only toggle preserves the current local-counter behaviour (no wallet, no post). Keep the 3 pre-existing chain-selector shell-test failures out of scope.

## 7. Deploy / ops (run by the operator — port-22 egress is blocked from the dev bg env)

1. **One-time:** `Chips.transferOwnership(faucetKeyAddr)` from valve-deployer on 943; fund the faucet key (index 51) with gas.
2. **Fleet:** add a `chip-faucet` service to `ansible/files/games-actors-compose.yml` (CHAIN 943, keyed RPC, `CHIPS`/`CHIP_CATEGORY`/`GRANT` env) and add `chip-faucet` to `deploy-games-actors.yml`'s bundle list + smoke banner; `ansible-playbook deploy-games-actors.yml`.
3. **UI:** rebuild + `ansible-playbook deploy-msgboard-ui.yml` (ships the Arcade connect + Get-chips changes).

## 8. Open items to confirm during planning

- Chips **decimals** (sets `GRANT`'s base-unit value).
- Whether to reuse an existing wallet-connect module from `games/web`, or add a minimal one in `packages/ui`.
- Final category string (`chipsplease:943` proposed).
