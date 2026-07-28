# Fun-Chips Faucet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a msgboard.xyz visitor mint testnet play-Chips to their connected wallet by posting a PoW-stamped board message, via a `@msgboard/relayer` service that mirrors the v4 gas faucet.

**Architecture:** A new `mintChipsAction` (ERC-20 `mint` twin of `sendValueAction`) plugs into `@msgboard/relayer`. A `runChipFaucet` assembly in `@msgboard/games-house-service` wires it to a board category (`msgboardContentSource` + `isAddress(data)` condition + `message.hash` dedup + `memoryTtlStore`), mirroring `packages/sponsor`. A thin fleet actor runs it. The Arcade gains wallet-connect + a "Get chips" button that posts the wallet address to the category and reads `Chips.balanceOf`.

**Tech Stack:** TypeScript, viem, `@msgboard/relayer`, `@msgboard/sdk`, React (packages/ui), vitest, Ansible/Docker Compose.

**Spec:** `docs/superpowers/specs/2026-07-27-fun-chips-faucet-design.md`

## Global Constraints

- **Testnet play-chips only.** 943 (pulsechainV4). Real chips stay games.msgboard.xyz.
- **The landing coin-flip is untouched.** The faucet only grants; it never stakes/settles.
- **No HTTP surface.** Board-watch only.
- **Chips 943:** `0x81f130c7d9ff020f46f3b01918424173f8d5ca64` (single-owner Solady `Ownable`; `mint(to,amount)` is `onlyOwner`).
- **Category:** `chipsplease:943` (exact string; UI poster and service must match). `@msgboard/sdk` `categoryHash` / relayer `toCategoryHex` zero-pad a name to bytes32.
- **Wire trick (from the gas faucet):** the request post's `data` **is** the recipient address (a hex address string). Dedup by `message.hash.toLowerCase()` — one PoW post = one grant.
- **Faucet key:** dedicated mnemonic index **51**. Needs 943 gas (minting is on-chain). valve-deployer transfers Chips ownership to it (one-time, §Task 8).
- **Grant amount default:** `1000` chips in base units (confirm Chips decimals during Task 1; `Chips` is a plain Solady ERC20 → 18 decimals unless overridden, so `1000n * 10n ** 18n`). Per-tx `cap` guards a misconfig.
- **Commit style:** unsigned, no `Co-Authored-By` (match the repo's existing commits).

---

### Task 1: `mintChipsAction` in `@msgboard/relayer`

**Files:**
- Create: `packages/relayer/src/actions/mint-chips.ts`
- Test: `packages/relayer/test/actions/mint-chips.test.ts`
- Modify: `packages/relayer/src/index.ts` (barrel export)

**Interfaces:**
- Consumes: `RelayerAction<T>`, `RelayerContext` from `../types.js`; viem `Account`, `Address`, `WalletClient`, `createWalletClient`.
- Produces: `mintChipsAction<T>(options: MintChipsActionOptions<T>): RelayerAction<T>` where
  `MintChipsActionOptions<T> = { account: Account; chips: Address; recipient: (item: T, ctx: RelayerContext) => Address; amount: bigint; cap: bigint; gas?: bigint; walletFactory?: (ctx: RelayerContext) => WalletClient }`.

- [ ] **Step 1: Write the failing test** (mirror `test/actions/send-value.test.ts`)

```ts
import { describe, expect, it, vi } from 'vitest'
import { mintChipsAction } from '../../src/actions/mint-chips.js'
import type { RelayerContext } from '../../src/types.js'

const chips = '0x81f130c7d9ff020f46f3b01918424173f8d5ca64' as const
const recipient = '0x1111111111111111111111111111111111111111' as const

describe('mintChipsAction', () => {
  it('describe reports the recipient and amount', () => {
    const action = mintChipsAction<string>({
      account: { address: '0xfrom' } as never,
      chips, recipient: (item) => item as `0x${string}`,
      amount: 1000n, cap: 1000n,
    })
    expect(action.describe(recipient, {} as RelayerContext)).toMatch(recipient)
  })

  it('execute mints min(amount,cap) to the recipient and waits for the receipt', async () => {
    const writeContract = vi.fn(async () => '0xtx')
    const waitForTransactionReceipt = vi.fn(async () => ({ transactionHash: '0xtx' }))
    const ctx = { chain: { id: 943 }, node: { transport: {} as never },
      publicClient: { waitForTransactionReceipt } } as unknown as RelayerContext
    const action = mintChipsAction<string>({
      account: { address: '0xfrom' } as never, chips,
      recipient: (item) => item as `0x${string}`, amount: 5000n, cap: 1000n,
      walletFactory: () => ({ writeContract }) as never,
    })
    const result = await action.execute(recipient, ctx)
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({
      address: chips, functionName: 'mint', args: [recipient, 1000n], // capped from 5000
    }))
    expect(result).toEqual({ ok: true, ref: '0xtx' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/relayer && ../../node_modules/.bin/vitest run test/actions/mint-chips.test.ts`
Expected: FAIL — `mintChipsAction` is not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
import { type Account, type Address, type WalletClient, createWalletClient } from 'viem'
import type { RelayerAction, RelayerContext } from '../types.js'

const MINT_ABI = [{
  name: 'mint', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [],
}] as const

export type MintChipsActionOptions<T> = {
  account: Account
  chips: Address
  recipient: (item: T, context: RelayerContext) => Address
  amount: bigint
  cap: bigint
  gas?: bigint
  walletFactory?: (context: RelayerContext) => WalletClient
}

/** Owner-mints `min(amount, cap)` of an ERC-20 to an address derived from each item; waits the receipt. */
export const mintChipsAction = <T>(options: MintChipsActionOptions<T>): RelayerAction<T> => {
  const makeWallet = (context: RelayerContext): WalletClient =>
    options.walletFactory?.(context) ??
    createWalletClient({ account: options.account, chain: context.chain, transport: context.node.transport })
  const minted = options.amount < options.cap ? options.amount : options.cap
  return {
    describe: (item, context) => `mint ${minted} chips to ${options.recipient(item, context)}`,
    execute: async (item, context) => {
      const wallet = makeWallet(context)
      const to = options.recipient(item, context)
      const hash = await wallet.writeContract({
        account: options.account, chain: context.chain,
        address: options.chips, abi: MINT_ABI, functionName: 'mint', args: [to, minted],
        ...(options.gas ? { gas: options.gas } : {}),
      })
      await context.publicClient.waitForTransactionReceipt({ hash })
      return { ok: true, ref: hash }
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/relayer && ../../node_modules/.bin/vitest run test/actions/mint-chips.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Export from the barrel + typecheck**

Add to `packages/relayer/src/index.ts` (next to the other action exports):
```ts
export { mintChipsAction, type MintChipsActionOptions } from './actions/mint-chips.js'
```
Run: `cd packages/relayer && npm run typecheck && npm test`
Expected: typecheck clean; all relayer tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/relayer/src/actions/mint-chips.ts packages/relayer/test/actions/mint-chips.test.ts packages/relayer/src/index.ts
git commit -m "feat(relayer): mintChipsAction — owner-mint an ERC-20 per item (twin of sendValueAction)"
```

---

### Task 2: `runChipFaucet` assembly in `@msgboard/games-house-service`

**Files:**
- Create: `games/house-service/src/runChipFaucet.ts`
- Test: `games/house-service/test/chipFaucet.test.ts`
- Modify: `games/house-service/src/index.ts` (barrel), `games/house-service/package.json` (add `"@msgboard/relayer": "*"` to `dependencies`)

**Interfaces:**
- Consumes: `mintChipsAction` (Task 1); `Relayer`, `msgboardContentSource`, `memoryTtlStore` from `@msgboard/relayer`; `RPCMessage` from `@msgboard/sdk`; viem `isAddress`, `Account`, `Hex`.
- Produces:
  `chipFaucetConfig(opts: ChipFaucetOpts): RelayerConfig<RPCMessage>` (PURE — entry and tests share it) and
  `runChipFaucet(opts: ChipFaucetOpts): { relayer: Relayer<RPCMessage>; stop: () => void }`.
  `ChipFaucetOpts = { account: Account; chips: Hex; category?: string; amount?: bigint; cap?: bigint; rpcUrl: string; chainId?: number; intervalMs?: number; ttlMs?: number; mode?: 'observe' | 'live'; walletFactory?: ... }`.
  Defaults: `category='chipsplease:943'`, `amount=1000n*10n**18n`, `cap=amount`, `chainId=943`, `intervalMs=20_000`, `ttlMs=3_600_000`, `mode='live'`.

- [ ] **Step 1: Add the dependency**

In `games/house-service/package.json` `dependencies`, add `"@msgboard/relayer": "*"` (alongside `@msgboard/games`, `@msgboard/settle`). Run `npm install` at the repo root to link the workspace.

- [ ] **Step 2: Write the failing test** (pure-config assertions — no live board/wallet)

```ts
import { describe, expect, it } from 'vitest'
import { isAddress, stringToHex } from 'viem'
import { chipFaucetConfig } from '../src/runChipFaucet'

const account = { address: '0xfaucet' } as never
const chips = '0x81f130c7d9ff020f46f3b01918424173f8d5ca64' as const
const addrMsg = { data: '0x1111111111111111111111111111111111111111', hash: '0xAAA' } as never
const junkMsg = { data: '0xnotanaddress', hash: '0xBBB' } as never

describe('chipFaucetConfig', () => {
  it('accepts an address post and rejects a non-address post', async () => {
    const cfg = chipFaucetConfig({ account, chips, rpcUrl: 'http://x' })
    expect(await cfg.condition!(addrMsg, {} as never)).toBe(true)
    expect(await cfg.condition!(junkMsg, {} as never)).toBe(false)
  })
  it('dedups by lowercased message hash (one PoW post = one grant)', () => {
    const cfg = chipFaucetConfig({ account, chips, rpcUrl: 'http://x' })
    expect(cfg.key!(addrMsg)).toBe('0xaaa')
  })
  it('mints to the post’s data address (the wire trick)', () => {
    const cfg = chipFaucetConfig({ account, chips, rpcUrl: 'http://x' })
    expect(cfg.action.describe(addrMsg, {} as never)).toMatch(/0x1111/i)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd games/house-service && ../../node_modules/.bin/vitest run test/chipFaucet.test.ts`
Expected: FAIL — `chipFaucetConfig` not defined.

- [ ] **Step 4: Write minimal implementation**

```ts
import { http, isAddress, type Account, type Hex } from 'viem'
import type { RPCMessage } from '@msgboard/sdk'
import { Relayer, msgboardContentSource, memoryTtlStore } from '@msgboard/relayer'
import { mintChipsAction } from '@msgboard/relayer'

export interface ChipFaucetOpts {
  account: Account
  chips: Hex
  rpcUrl: string
  category?: string
  amount?: bigint
  cap?: bigint
  chainId?: number
  intervalMs?: number
  ttlMs?: number
  mode?: 'observe' | 'live'
  walletFactory?: Parameters<typeof mintChipsAction<RPCMessage>>[0]['walletFactory']
}

const DEFAULT_AMOUNT = 1000n * 10n ** 18n

/** PURE relayer config for the chip faucet — the entry AND tests consume the identical object. */
export function chipFaucetConfig(opts: ChipFaucetOpts) {
  const amount = opts.amount ?? DEFAULT_AMOUNT
  return {
    node: { transport: http(opts.rpcUrl) },
    mode: opts.mode ?? 'live',
    intervalMs: opts.intervalMs ?? 20_000,
    source: msgboardContentSource({ category: opts.category ?? 'chipsplease:943' }),
    condition: (m: RPCMessage) => isAddress(m.data),
    key: (m: RPCMessage) => m.hash.toLowerCase(),
    store: memoryTtlStore<RPCMessage>({ ttlMs: opts.ttlMs ?? 3_600_000 }),
    action: mintChipsAction<RPCMessage>({
      account: opts.account, chips: opts.chips,
      recipient: (m) => m.data as Hex,
      amount, cap: opts.cap ?? amount,
      walletFactory: opts.walletFactory,
    }),
  } as const
}

export function runChipFaucet(opts: ChipFaucetOpts) {
  const relayer = new Relayer<RPCMessage>(chipFaucetConfig(opts) as never)
  relayer.start()
  return { relayer, stop: () => relayer.stop() }
}
```

Note: confirm the `Relayer` constructor field names against `packages/relayer/src/types.ts` `RelayerConfig` (`node`, `mode`, `intervalMs`, `source`, `condition`, `key`, `store`, `action`) — they match `packages/sponsor/index.ts`. If `Relayer` exposes `start()/stop()` differently, mirror `sponsor/index.ts` (`relayer.start()`).

- [ ] **Step 5: Run test + typecheck**

Run: `cd games/house-service && ../../node_modules/.bin/vitest run test/chipFaucet.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Export from the barrel**

Add to `games/house-service/src/index.ts`:
```ts
export { runChipFaucet, chipFaucetConfig, type ChipFaucetOpts } from './runChipFaucet'
```

- [ ] **Step 7: Commit**

```bash
git add games/house-service/src/runChipFaucet.ts games/house-service/test/chipFaucet.test.ts games/house-service/src/index.ts games/house-service/package.json
git commit -m "feat(house-service): runChipFaucet — relayer assembly minting Chips on a board request (mirrors sponsor)"
```

---

### Task 3: Fleet actor entry `chip-faucet.ts`

**Files:**
- Create: `games/e2e/scripts/chip-faucet.ts`

**Interfaces:**
- Consumes: `runChipFaucet` (Task 2); `mnemonicToAccount` (viem/accounts).
- Produces: a runnable esbuild-bundleable actor (mirror `games/e2e/scripts/landing-house.ts` structure + `packages/sponsor/index.ts` wiring). No PoW stamper (it reads the board and mints on-chain; it posts nothing).

- [ ] **Step 1: Write the actor** (no unit test — thin glue, covered by Task 2 + the deploy smoke)

```ts
/**
 * chip-faucet.ts — the msgboard.xyz fun-chips FAUCET actor.
 *
 * Watches the `chipsplease:943` board category; for each PoW-stamped post whose data is an address
 * (the recipient), owner-mints Chips to it once (dedup by message hash). Mirrors packages/sponsor
 * (the v4 gas faucet) with a mint action. The faucet key (mnemonic index FAUCET_INDEX, default 51)
 * is the Chips owner and needs 943 gas — minting is an on-chain tx. It posts nothing to the board.
 */
import { mnemonicToAccount } from 'viem/accounts'
import { runChipFaucet } from '@msgboard/games-house-service'

const env = process.env
const CHAIN = env.CHAIN ?? '943'
const FAUCET_INDEX = Number(env.FAUCET_INDEX ?? '51')

const main = async () => {
  if (!env.MNEMONIC) throw new Error('MNEMONIC required')
  if (!env.CHIPS) throw new Error('CHIPS (Chips ERC-20 address) required')
  const account = mnemonicToAccount(env.MNEMONIC, { addressIndex: FAUCET_INDEX })
  // The deploy greps this banner prefix; the address is who must own Chips + hold gas.
  console.log(`chip faucet on chain ${CHAIN} @ ${account.address}`)
  const { stop } = runChipFaucet({
    account,
    chips: env.CHIPS as `0x${string}`,
    rpcUrl: env.RPC!,
    chainId: Number(CHAIN),
    category: env.CHIP_CATEGORY ?? 'chipsplease:943',
    amount: env.CHIP_GRANT ? BigInt(env.CHIP_GRANT) : undefined,
    mode: env.FAKE_MINTS ? 'observe' : 'live',
  })
  const shutdown = (sig: string) => { console.log(`\n${sig} — stopping chip faucet…`); stop(); process.exit(0) }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
```

- [ ] **Step 2: Verify it bundles** (same esbuild recipe the deploy uses)

Run:
```bash
cd games/e2e && npx esbuild scripts/chip-faucet.ts --bundle --platform=node --target=node24 --format=esm \
  --banner:js="import { createRequire as __r } from 'module'; const require = __r(import.meta.url);" \
  --outfile=/tmp/chip-faucet.mjs && echo BUNDLE_OK
```
Expected: `BUNDLE_OK`, no unresolved imports.

- [ ] **Step 3: Commit**

```bash
git add games/e2e/scripts/chip-faucet.ts
git commit -m "feat(games): chip-faucet fleet actor — watches chipsplease:943 and owner-mints Chips"
```

---

### Task 4: Deploy wiring (Ansible fleet)

**Files:**
- Modify: `ansible/files/games-actors-compose.yml` (add a `chip-faucet` service)
- Modify: `ansible/deploy-games-actors.yml` (add `chip-faucet` to `bundles` + the banner smoke loop; bump the "all N services" count)

**Interfaces:** Consumes the actor (Task 3). The box `/opt/games-actors/.env` must gain `CHIPS=0x81f130c7d9ff020f46f3b01918424173f8d5ca64` (asserted, not written by the play).

- [ ] **Step 1: Add the compose service** (after `landing-house-369`, mirroring `landing-house`; note: funded key → it does NOT need a stamper, but DOES need gas)

```yaml
  # The fun-chips FAUCET: watches games.msgboard.xyz:chipsplease:943 and owner-mints Chips to the
  # posted recipient address (one PoW post = one grant, dedup by message hash). The faucet key
  # (mnemonic index 51) is the Chips owner and needs 943 GAS (minting is on-chain). Posts nothing.
  chip-faucet:
    image: node:24-alpine
    restart: unless-stopped
    working_dir: /app
    volumes: [ "./:/app" ]
    env_file: .env
    environment:
      CHAIN: "943"
      RPC: "https://one.valve.city/rpc/${VALVE_RPC_KEY}/evm/943"
      CHIPS: "0x81f130c7d9ff020f46f3b01918424173f8d5ca64"
      FAUCET_INDEX: "51"
      CHIP_CATEGORY: "chipsplease:943"
    command: node chip-faucet.mjs
```

- [ ] **Step 2: Wire the deploy playbook**

In `ansible/deploy-games-actors.yml`: add `chip-faucet` to the `bundles` list; add to the restart map `+ (['chip-faucet'] if 'chip-faucet' in changed_bundles else [])`; change the "all nine services" smoke `!= 9` to `!= 10`; add a banner loop entry `- { svc: chip-faucet, banner: "chip faucet on chain 943" }`.

- [ ] **Step 3: Validate**

Run: `cd ansible && ansible-playbook deploy-games-actors.yml --syntax-check` (if a live inventory is reachable; otherwise `python3 -c "import yaml; yaml.safe_load(open('files/games-actors-compose.yml'))"` to confirm valid YAML).
Expected: no syntax errors.

- [ ] **Step 4: Commit**

```bash
git add ansible/files/games-actors-compose.yml ansible/deploy-games-actors.yml
git commit -m "chore(deploy): chip-faucet fleet service (943) + deploy playbook wiring"
```

---

### Task 5: UI config — `chipFaucet` in `rpc.ts` + selector in `chain.ts`

**Files:**
- Modify: `packages/ui/src/lib/rpc.ts` (add `chipFaucet` to the `pulsechainV4` `ChainConfig` + the `ChainConfig` type)
- Modify: `packages/ui/src/stores/chain.ts` (add `selectChipFaucetActive`)
- Test: `packages/ui/test/chip-faucet-config.test.ts`

**Interfaces:**
- Produces: `ChainConfig.chipFaucet?: { chips: Hex; category: string; amount: bigint }`; `selectChipFaucetActive(s: RawChain): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { rpcs } from '../src/lib/rpc'

describe('chip faucet config', () => {
  it('pulsechainV4 (943) declares a chipFaucet, others do not', () => {
    expect(rpcs.get('pulsechainV4')?.chipFaucet?.category).toBe('chipsplease:943')
    expect(rpcs.get('pulsechainV4')?.chipFaucet?.chips.toLowerCase())
      .toBe('0x81f130c7d9ff020f46f3b01918424173f8d5ca64')
    expect(rpcs.get('ethereum')?.chipFaucet).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/ui && ../../node_modules/.bin/vitest run test/chip-faucet-config.test.ts`
Expected: FAIL — `chipFaucet` undefined.

- [ ] **Step 3: Implement**

In `rpc.ts`, extend `ChainConfig` with `chipFaucet?: { chips: `0x${string}`; category: string; amount: bigint }` and add to the `pulsechainV4` entry:
```ts
      chipFaucet: {
        chips: '0x81f130c7d9ff020f46f3b01918424173f8d5ca64',
        category: 'chipsplease:943',
        amount: 1000n * 10n ** 18n,
      },
```
In `chain.ts` (next to `selectFaucetIsActive`):
```ts
export const selectChipFaucetActive = (s: RawChain): boolean =>
  s.chainOption !== 'custom' && !!selectSelectedOption(s)?.chipFaucet
```

- [ ] **Step 4: Run test + typecheck**

Run: `cd packages/ui && ../../node_modules/.bin/vitest run test/chip-faucet-config.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/rpc.ts packages/ui/src/stores/chain.ts packages/ui/test/chip-faucet-config.test.ts
git commit -m "feat(ui): 943 chipFaucet config + selectChipFaucetActive selector"
```

---

### Task 6: UI wallet-connect helper

**Files:**
- Create: `packages/ui/src/lib/wallet.ts`
- Test: `packages/ui/test/wallet.test.ts`

First check `games/web` for an existing injected-connect helper (`grep -rn "window.ethereum\|eth_requestAccounts\|createWalletClient" games/web/src`). If a clean reusable one exists, port its pattern; otherwise implement the minimal version below.

**Interfaces:**
- Produces: `connectInjectedWallet(): Promise<{ address: `0x${string}`; chainId: number }>` and `getInjectedProvider(): Eip1193Provider | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { connectInjectedWallet } from '../src/lib/wallet'

describe('connectInjectedWallet', () => {
  it('requests accounts and returns the address + chainId', async () => {
    const request = vi.fn(async ({ method }: { method: string }) =>
      method === 'eth_requestAccounts' ? ['0x1111111111111111111111111111111111111111']
      : method === 'eth_chainId' ? '0x3af' : undefined)
    ;(globalThis as never as { window: unknown }).window = { ethereum: { request } }
    const res = await connectInjectedWallet()
    expect(res.address.toLowerCase()).toBe('0x1111111111111111111111111111111111111111')
    expect(res.chainId).toBe(943)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/ui && ../../node_modules/.bin/vitest run test/wallet.test.ts`
Expected: FAIL — `connectInjectedWallet` not defined.

- [ ] **Step 3: Implement**

```ts
import type { Eip1193Provider } from 'viem'

export function getInjectedProvider(): Eip1193Provider | undefined {
  const w = globalThis as unknown as { window?: { ethereum?: Eip1193Provider } }
  return w.window?.ethereum
}

/** Minimal injected-wallet connect: request accounts + read chainId. Throws if no wallet. */
export async function connectInjectedWallet(): Promise<{ address: `0x${string}`; chainId: number }> {
  const provider = getInjectedProvider()
  if (!provider) throw new Error('No injected wallet found — install a wallet to receive chips.')
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[]
  const address = accounts?.[0] as `0x${string}` | undefined
  if (!address) throw new Error('No account authorized.')
  const chainIdHex = (await provider.request({ method: 'eth_chainId' })) as string
  return { address, chainId: Number(BigInt(chainIdHex)) }
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `cd packages/ui && ../../node_modules/.bin/vitest run test/wallet.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/wallet.ts packages/ui/test/wallet.test.ts
git commit -m "feat(ui): minimal injected wallet-connect helper"
```

---

### Task 7: Arcade "Get chips" + on-chain balance + memory-only toggle

**Files:**
- Modify: `packages/ui/src/components/Arcade.tsx`
- Test: `packages/ui/test/arcade-faucet.test.ts`

**Interfaces:**
- Consumes: `connectInjectedWallet` (Task 6), `selectChipFaucetActive` + the `chipFaucet` config (Task 5), the existing `board` seam (`makeWorkerBoard`) already in `Arcade.tsx`, `@msgboard/sdk` `categoryHash`, viem `stringToHex`, and a `Chips.balanceOf` read via the chain store's `selectClient`.

Behavior:
- A **"memory-only" toggle** (default ON) preserves today's local `1000n` counter (walletless, no chain). When OFF and `selectChipFaucetActive`, a **Connect** button appears; once connected, a **"Get chips"** button posts the connected address to the `chipFaucet.category` via the worker board (PoW off-thread), then polls `Chips.balanceOf(address)` and shows the on-chain balance.
- The flip itself is unchanged in both modes (zero-stakes).

- [ ] **Step 1: Write the failing test** (assert the post lands on the faucet category)

```ts
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Arcade } from '../src/components/Arcade'
// Mock the wallet + board so no chain is touched; assert a post to chipsplease:943 category hash.
// (Follow the existing arcade.test.ts harness for lazy-engine + worker-board mocking.)
```
Write a test that: mocks `connectInjectedWallet` to return a fixed address; renders `<Arcade>` on 943; turns the memory-only toggle OFF; clicks Connect then "Get chips"; asserts the worker board received an `addMessage` whose category equals `categoryHash('chipsplease:943')` and whose `data` decodes to the wallet address. Reuse the board/worker mock approach from `test/arcade.test.ts` and `test/smoke.test.tsx`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/ui && ../../node_modules/.bin/vitest run test/arcade-faucet.test.ts`
Expected: FAIL — no Connect/Get-chips UI, no post.

- [ ] **Step 3: Implement the Arcade changes**

Add state: `memoryOnly` (default `true`), `wallet` (`{address} | null`), `onchainChips` (`bigint | null`), `granting` (`boolean`). Read `chipFaucet = eng && chainId ? selectSelectedOption(chainStore)?.chipFaucet : undefined` and `chipActive = useChainStore(selectChipFaucetActive)`.

`getChips` handler:
```ts
const getChips = async () => {
  if (!wallet || !board || !chipFaucet) return
  setGranting(true)
  try {
    // The wire trick: data IS the recipient address (matches the faucet's isAddress(data) condition).
    await board.addMessage({
      category: categoryHash(chipFaucet.category) as `0x${string}`,
      data: stringToHex(wallet.address),
    })
    // Poll the on-chain balance until it rises (or a timeout).
    const client = useChainStore.getState() // selectClient(...) → publicClient
    for (let i = 0; i < 30; i++) {
      const bal = await readChipsBalance(client, chipFaucet.chips, wallet.address)
      if (onchainChips == null || bal > onchainChips) { setOnchainChips(bal); break }
      await new Promise((r) => setTimeout(r, 2000))
    }
  } finally { setGranting(false) }
}
```
Add a `readChipsBalance(client, chips, addr)` helper (viem `readContract` with a `balanceOf` ABI fragment) — put it in `packages/ui/src/lib/chips.ts` with its own trivial test, or inline. Render: the toggle; when `!memoryOnly && chipActive`, a Connect button (`connectInjectedWallet` → `setWallet`) and, when connected, "Get chips" (calls `getChips`) + the on-chain balance display. Keep the existing balance/flip UI untouched when `memoryOnly`.

- [ ] **Step 4: Run test + typecheck + full UI suite**

Run: `cd packages/ui && ../../node_modules/.bin/vitest run test/arcade-faucet.test.ts && npm run typecheck && ../../node_modules/.bin/vitest run`
Expected: new test passes; typecheck clean; only the 3 known pre-existing chain-selector shell failures (`mvp-flow`, `routes`, `smoke`) remain.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/Arcade.tsx packages/ui/src/lib/chips.ts packages/ui/test/arcade-faucet.test.ts
git commit -m "feat(ui): Arcade 'Get chips' — connect wallet, post to the faucet category, show on-chain Chips balance"
```

---

### Task 8: Ops runbook (operator-run — NOT a code task)

Document these in the PR description / hand to the operator. Port-22 egress is blocked from the dev bg env, so a human runs them.

- [ ] **One-time: transfer Chips ownership to the faucet key.** Derive the index-51 address from the actors' `MNEMONIC` (the deploy banner logs `chip faucet on chain 943 @ 0x…`). Verify the current Chips owner on-chain (`owner()` — expect the valve-deployer). Then, signing as the current owner, call `Chips.transferOwnership(0x<index51>)` on 943 (Solady `Ownable`). Confirm `owner()` now returns the index-51 address.
- [ ] **Fund the faucet key with 943 gas** (tPLS) and add it to the fleet's auto-top-up-from-account-0 set at the 943 envelope (match the other funded 943 bots).
- [ ] **Add `CHIPS=0x81f130c7d9ff020f46f3b01918424173f8d5ca64` to `/opt/games-actors/.env`** (asserted by the deploy).
- [ ] **Deploy the fleet:** `cd ansible && ansible-playbook deploy-games-actors.yml` (smoke asserts 10 services + the `chip faucet on chain 943` banner).
- [ ] **Deploy the UI:** `cd ansible && ansible-playbook deploy-msgboard-ui.yml`.
- [ ] **Smoke:** on msgboard.xyz Arcade (943), toggle off memory-only → Connect → Get chips → confirm the wallet's on-chain Chips balance rises; re-posting the same message hash grants nothing (dedup).

---

## Self-Review

**Spec coverage:** §3 reuse → Tasks 1–2 (mintChipsAction, relayer assembly, message.hash dedup, memoryTtlStore). §4.1 components → Task 1 (action), Task 2 (assembly), Task 3 (actor), Task 7 (Arcade), Task 5 (config). §4.2 protocol (`chipsplease:943`, data=address) → Tasks 2,4,7. §4.3 keys/funding/ownership → Tasks 3,4,8. §4.4 anti-abuse (PoW+hash dedup+cap) → Tasks 1,2. §5 defaults → Global Constraints + Tasks 2,5. §6 testing → each task's tests. §7 deploy → Tasks 4,8. §8 open items (decimals, wallet-connect reuse, category) → Global Constraints + Task 6 note.

**Placeholder scan:** Task 7's UI test says "follow the existing harness" rather than inlining the full mock — acceptable because the harness (`test/arcade.test.ts`, `test/smoke.test.tsx`) is an existing concrete reference the implementer reads; the assertion (post to `categoryHash('chipsplease:943')` with data=address) is explicit. All other steps have runnable code/commands.

**Type consistency:** `mintChipsAction` options (`account, chips, recipient, amount, cap, gas?, walletFactory?`) are identical in Task 1 (def), Task 2 (use), and the tests. `chipFaucetConfig`/`runChipFaucet`/`ChipFaucetOpts` consistent Task 2 ↔ Task 3. `chipFaucet` config shape (`{chips, category, amount}`) consistent Task 5 ↔ Task 7. `connectInjectedWallet` return (`{address, chainId}`) consistent Task 6 ↔ Task 7. Category string `chipsplease:943` consistent throughout.
