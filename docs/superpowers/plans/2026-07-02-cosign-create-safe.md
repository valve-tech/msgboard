# Create-a-Safe (cosign-web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a cosign-web user create a new Safe v1.4.1 (owners + threshold), see its predicted address before signing, deploy it (user-pays, optional gasless), and drop straight into the co-sign flow.

**Architecture:** One pure, unit-tested lib (`src/lib/deploy-safe.ts`) holding the v1.4.1 constants + CREATE2 prediction; one small addition to `useWallet` for the deploy tx; a Create-Safe UI panel toggled from `App.tsx`. Deployment uses the canonical `SafeProxyFactory.createProxyWithNonce`. Feature-detected per chain via `eth_getCode`.

**Tech Stack:** TypeScript, React, viem, vitest. Repo convention: single quotes, no semicolons, no Prettier config — match the surrounding files exactly.

## Global Constraints

- **Safe version: v1.4.1 only.** Canonical addresses (all chains that have them):
  - SafeProxyFactory `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`
  - Safe **L2** singleton `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`
  - CompatibilityFallbackHandler `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99`
- **Deploy the L2 singleton** (PulseChain uses SafeL2; consistent with the safe-indexer).
- **`setup(...)` fixed fields:** `to=0x0, data=0x, fallbackHandler=<v1.4.1 handler>, paymentToken=0x0, payment=0, paymentReceiver=0x0`.
- **Feature-detect, never assume:** `eth_getCode` the factory on the connected chain; disable Create-Safe where it has no code. Verified 2026-07-02: 369 + mainnet have v1.4.1; **943 does not** (provisioning is Task 8).
- **Never silently proceed on a mismatch:** after deploy, the mined proxy MUST equal the predicted address or it's a hard error.
- Match repo style (single quote / no semicolon). Commit after each task.

---

### Task 1: `deploy-safe.ts` constants, ABIs, and `buildSetup`

**Files:**
- Create: `packages/cosign-web/src/lib/deploy-safe.ts`
- Test: `packages/cosign-web/src/lib/deploy-safe.test.ts`

**Interfaces:**
- Produces: `SAFE_V141: { factory: Hex; singletonL2: Hex; fallbackHandler: Hex }`; `PROXY_FACTORY_ABI`, `SAFE_SETUP_ABI` (viem ABI consts); `buildSetup(owners: Hex[], threshold: number): Hex`.

- [ ] **Step 1: Write the failing test** — `deploy-safe.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildSetup, SAFE_V141 } from './deploy-safe'

describe('buildSetup', () => {
  it('encodes the exact v1.4.1 setup initializer (fixed fixture)', () => {
    const owners = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'] as const
    // Reference: fetched from the real 369 v1.4.1 factory + canonical fallback handler.
    const expected =
      '0xb63e800d0000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000160000000000000000000000000fd0732dc9e303f09fcef3a7388ad10a83459ec990000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000111111111111111111111111111111111111111100000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000000000000'
    expect(buildSetup([...owners], 1)).toBe(expected)
  })

  it('exposes the canonical v1.4.1 fallback handler', () => {
    expect(SAFE_V141.fallbackHandler).toBe('0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99')
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test --workspace=packages/cosign-web -- deploy-safe`
Expected: FAIL — cannot import `buildSetup`/`SAFE_V141`.

- [ ] **Step 3: Implement `deploy-safe.ts` (constants + ABIs + buildSetup)**

```ts
import { type Hex, encodeFunctionData, zeroAddress } from 'viem'

/** Canonical Safe v1.4.1 deterministic-deployment addresses (L2 singleton). */
export const SAFE_V141 = {
  factory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  singletonL2: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
  fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
} as const satisfies Record<string, Hex>

export const PROXY_FACTORY_ABI = [
  {
    type: 'function',
    name: 'createProxyWithNonce',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_singleton', type: 'address' },
      { name: 'initializer', type: 'bytes' },
      { name: 'saltNonce', type: 'uint256' },
    ],
    outputs: [{ name: 'proxy', type: 'address' }],
  },
  {
    type: 'event',
    name: 'ProxyCreation',
    inputs: [
      { name: 'proxy', type: 'address', indexed: true },
      { name: 'singleton', type: 'address', indexed: false },
    ],
  },
] as const

export const SAFE_SETUP_ABI = [
  {
    type: 'function',
    name: 'setup',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_owners', type: 'address[]' },
      { name: '_threshold', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'fallbackHandler', type: 'address' },
      { name: 'paymentToken', type: 'address' },
      { name: 'payment', type: 'uint256' },
      { name: 'paymentReceiver', type: 'address' },
    ],
    outputs: [],
  },
] as const

/** The Safe `setup` initializer for a plain owners+threshold multisig (no module/guard/payment). */
export function buildSetup(owners: Hex[], threshold: number): Hex {
  return encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: 'setup',
    args: [owners, BigInt(threshold), zeroAddress, '0x', SAFE_V141.fallbackHandler, zeroAddress, 0n, zeroAddress],
  })
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npm test --workspace=packages/cosign-web -- deploy-safe`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cosign-web/src/lib/deploy-safe.ts packages/cosign-web/src/lib/deploy-safe.test.ts
git commit -m "feat(cosign-web): Safe v1.4.1 constants + setup initializer builder"
```

---

### Task 2: `predictSafeAddress` + `isDeploySupported`

**Files:**
- Modify: `packages/cosign-web/src/lib/deploy-safe.ts`
- Test: `packages/cosign-web/src/lib/deploy-safe.test.ts`

**Interfaces:**
- Consumes: `SAFE_V141`, `buildSetup` (Task 1).
- Produces:
  - `predictSafeAddress(args: { owners: Hex[]; threshold: number; saltNonce: bigint }): Hex` — pure, synchronous (uses the embedded `PROXY_CREATION_CODE_V141`), so the UI can recompute on every keystroke without an RPC call.
  - `isDeploySupported(client: PublicClient, chainId: number): Promise<boolean>` — `eth_getCode` on `SAFE_V141.factory`.
  - `randomSaltNonce(): bigint`.

- [ ] **Step 1: Write the failing test** — append to `deploy-safe.test.ts`:

```ts
import { predictSafeAddress } from './deploy-safe'

describe('predictSafeAddress', () => {
  it('matches the reference CREATE2 address for the fixed fixture (saltNonce 0)', () => {
    // Reference computed from the real 369 v1.4.1 factory proxyCreationCode + canonical L2 singleton.
    const predicted = predictSafeAddress({
      owners: ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'],
      threshold: 1,
      saltNonce: 0n,
    })
    expect(predicted).toBe('0xf4065759F44c99b596448F58F59249a8C13F819C')
  })

  it('changes with the saltNonce', () => {
    const base = { owners: ['0x1111111111111111111111111111111111111111'] as Hex[], threshold: 1 }
    expect(predictSafeAddress({ ...base, saltNonce: 0n })).not.toBe(
      predictSafeAddress({ ...base, saltNonce: 1n }),
    )
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test --workspace=packages/cosign-web -- deploy-safe`
Expected: FAIL — `predictSafeAddress` is not exported.

- [ ] **Step 3: Add the embedded creation code + `predictSafeAddress` + `isDeploySupported`**

First capture the real v1.4.1 proxy creation code as a constant (its keccak256 is
`0x1856e0ee08399d74e0ea0b03adca210aeade6f748969ac023cdcb4dd62dcaf5f`; regenerate with the command in
the note below and paste the full hex):

```ts
import { type Hex, type PublicClient, concat, getContractAddress, keccak256, pad, toHex } from 'viem'

/**
 * The Safe v1.4.1 SafeProxy creation code (from the canonical SafeProxyFactory.proxyCreationCode()).
 * keccak256 == 0x1856e0ee08399d74e0ea0b03adca210aeade6f748969ac023cdcb4dd62dcaf5f. Embedded so address
 * prediction is a pure, synchronous function (no RPC per keystroke). Locked by the Task-2 fixture test
 * and by the Task-7 integration deploy (mined proxy == predicted).
 */
export const PROXY_CREATION_CODE_V141: Hex =
  '0x608060405234801561001057600080fd5b506040516101e63803806101e6...' // full 974-hex-char value — see note

/** Deterministic CREATE2 address for a v1.4.1 Safe with these params. Pure + synchronous. */
export function predictSafeAddress(args: { owners: Hex[]; threshold: number; saltNonce: bigint }): Hex {
  const initializer = buildSetup(args.owners, args.threshold)
  const salt = keccak256(concat([keccak256(initializer), pad(toHex(args.saltNonce), { size: 32 })]))
  const deploymentData = concat([PROXY_CREATION_CODE_V141, pad(SAFE_V141.singletonL2, { size: 32 })])
  return getContractAddress({ opcode: 'CREATE2', from: SAFE_V141.factory, salt, bytecode: deploymentData })
}

/** True when Safe v1.4.1's factory has code on `chainId` (i.e. Create-Safe can run there). */
export async function isDeploySupported(client: PublicClient, _chainId: number): Promise<boolean> {
  const code = await client.getCode({ address: SAFE_V141.factory })
  return !!code && code !== '0x'
}

/** A fresh 256-bit saltNonce so re-deploying the same owner set yields a distinct address. */
export function randomSaltNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return BigInt('0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''))
}
```

> **Note (regenerate the creation code):** from `packages/cosign-web`, run this to print the exact hex to paste as `PROXY_CREATION_CODE_V141` (must hash to `0x1856e0ee…`):
> ```bash
> node --input-type=module -e "import('viem').then(async v=>{const c=v.createPublicClient({transport:v.http('https://one.valve.city/rpc/vk_demo/evm/369')});const r=await c.call({to:'0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',data:'0x53e5d935'});const [code]=v.decodeAbiParameters([{type:'bytes'}],r.data);console.log(code);console.log('hash',v.keccak256(code))})"
> ```

- [ ] **Step 4: Run it, verify it passes**

Run: `npm test --workspace=packages/cosign-web -- deploy-safe`
Expected: PASS (4 tests). If the fixture test fails, the pasted creation code is wrong — re-run the note command.

- [ ] **Step 5: Commit**

```bash
git add packages/cosign-web/src/lib/deploy-safe.ts packages/cosign-web/src/lib/deploy-safe.test.ts
git commit -m "feat(cosign-web): CREATE2 Safe-address prediction + v1.4.1 feature-detect"
```

---

### Task 3: `useWallet.deploySafe`

**Files:**
- Modify: `packages/cosign-web/src/hooks/useWallet.ts`

**Interfaces:**
- Consumes: `SAFE_V141`, `PROXY_FACTORY_ABI` (Task 1).
- Produces: on `UseWallet`, `deploySafe(initializer: Hex, saltNonce: bigint) => Promise<Hex>` (returns the tx hash).

- [ ] **Step 1: Add the method** (mirror the existing `submitExecTransaction` exactly — same `createWalletClient`/`writeContract`/`chain: null` pattern). Add to the `UseWallet` interface:

```ts
  /** Deploys a new Safe v1.4.1 via createProxyWithNonce on the canonical factory. Returns the tx hash. */
  deploySafe: (initializer: Hex, saltNonce: bigint) => Promise<Hex>
```

Add the implementation inside `useWallet` (import `SAFE_V141, PROXY_FACTORY_ABI` from `../lib/deploy-safe`):

```ts
  const deploySafe = useCallback(
    async (initializer: Hex, saltNonce: bigint): Promise<Hex> => {
      const { p, account } = require()
      const wallet = createWalletClient({ account, transport: custom(p) })
      return wallet.writeContract({
        account,
        chain: null,
        address: SAFE_V141.factory,
        abi: PROXY_FACTORY_ABI,
        functionName: 'createProxyWithNonce',
        args: [SAFE_V141.singletonL2, initializer, saltNonce],
      })
    },
    [require],
  )
```

Add `deploySafe` to the returned object.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p packages/cosign-web/tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/cosign-web/src/hooks/useWallet.ts
git commit -m "feat(cosign-web): useWallet.deploySafe (createProxyWithNonce)"
```

---

### Task 4: Create-Safe panel (form + live predicted-address preview)

**Files:**
- Create: `packages/cosign-web/src/components/CreateSafe.tsx`
- Modify: `packages/cosign-web/src/App.tsx` (add a mode toggle: `'cosign' | 'create'`)

**Interfaces:**
- Consumes: `predictSafeAddress`, `randomSaltNonce`, `buildSetup`, `isDeploySupported` (Tasks 1–2); `useWallet` incl. `deploySafe` (Task 3); existing `ui.tsx` primitives (`OwnerRow`, `StepCard`) and `scopeFor` from `lib/cosign`.
- Produces: `<CreateSafe onCreated={(safe: Hex, chainId: number) => void} />` — calls `onCreated` with the new Safe address after a verified deploy.

- [ ] **Step 1: Build the component.** State: `owners: string[]` (default `[wallet.address ?? '']`), `threshold: number` (default 1), `saltNonce: bigint` (default `randomSaltNonce()`), `status: 'idle'|'deploying'|'mining'|'done'|'error'`, `error`, `txHash`, `newSafe`. Behaviors:
  - Owner rows: add/remove; trim; validate each with viem `isAddress`; dedupe (case-insensitive); the "valid owners" list = deduped valid addresses.
  - Threshold: clamp to `1..validOwners.length`.
  - `supported`: `useEffect` runs `isDeploySupported(wallet.publicClient(), wallet.chainId)`; when false, disable Deploy with the message "Safe v1.4.1 isn't available on this chain yet."
  - **Predicted address:** `useMemo` → `validOwners.length ? predictSafeAddress({ owners: validOwners, threshold, saltNonce }) : null`. Render it prominently with a "regenerate salt" button that sets `saltNonce = randomSaltNonce()`.
  - Deploy button disabled unless: wallet connected, `supported`, `validOwners.length >= 1`, `1 <= threshold <= validOwners.length`.
  - Match the app's existing visual language (reuse `StepCard`/`OwnerRow` from `components/ui.tsx`; single-quote/no-semicolon style).

- [ ] **Step 2: Wire the deploy action** (Task 5 covers verify/handoff; here just call through):

```tsx
async function onDeploy() {
  setStatus('deploying'); setError(null)
  try {
    const initializer = buildSetup(validOwners, threshold)
    const predicted = predictSafeAddress({ owners: validOwners, threshold, saltNonce })
    const hash = await wallet.deploySafe(initializer, saltNonce)
    setTxHash(hash); setStatus('mining')
    const safe = await confirmDeploy(wallet.publicClient(), hash, predicted) // Task 5
    setNewSafe(safe); setStatus('done')
    onCreated(safe, wallet.chainId!)
  } catch (e) {
    setError(e instanceof Error ? e.message : 'Deploy failed'); setStatus('error')
  }
}
```

- [ ] **Step 3: Add the mode toggle in `App.tsx`.** A small segmented control at the top: **Co-sign** (existing flow) / **Create a Safe** (`<CreateSafe onCreated={...} />`). `onCreated` sets the app's active chain+safe (build `scopeFor(chainId, safe)`) and switches back to the co-sign mode positioned on that Safe — reuse whatever setter the existing manual-Safe-entry path uses.

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit -p packages/cosign-web/tsconfig.json && npm run build --workspace=packages/cosign-web`
Expected: no errors; bundle builds.

- [ ] **Step 5: Commit**

```bash
git add packages/cosign-web/src/components/CreateSafe.tsx packages/cosign-web/src/App.tsx
git commit -m "feat(cosign-web): Create-Safe panel with live predicted-address preview"
```

---

### Task 5: Deploy confirmation + verified handoff

**Files:**
- Modify: `packages/cosign-web/src/lib/deploy-safe.ts`
- Test: `packages/cosign-web/src/lib/deploy-safe.test.ts`

**Interfaces:**
- Produces: `confirmDeploy(client: PublicClient, txHash: Hex, predicted: Hex): Promise<Hex>` — waits for the receipt, parses the `ProxyCreation` event, and returns the created proxy **only if it equals `predicted`**; otherwise throws.

- [ ] **Step 1: Write the failing test** (fake client + a `ProxyCreation` log):

```ts
import { confirmDeploy, PROXY_FACTORY_ABI, SAFE_V141 } from './deploy-safe'
import { encodeEventTopics, type Hex } from 'viem'

function fakeClientWithProxy(proxy: Hex) {
  const topics = encodeEventTopics({ abi: PROXY_FACTORY_ABI, eventName: 'ProxyCreation', args: { proxy } })
  return {
    waitForTransactionReceipt: async () => ({
      status: 'success',
      logs: [{ address: SAFE_V141.factory, topics, data: '0x' + '0'.repeat(64) }],
    }),
  } as any
}

describe('confirmDeploy', () => {
  const proxy = '0xf4065759F44c99b596448F58F59249a8C13F819C' as Hex
  it('returns the created proxy when it matches the predicted address', async () => {
    expect(await confirmDeploy(fakeClientWithProxy(proxy), '0xdead' as Hex, proxy)).toBe(proxy)
  })
  it('throws when the created proxy != predicted', async () => {
    const other = '0x1111111111111111111111111111111111111111' as Hex
    await expect(confirmDeploy(fakeClientWithProxy(proxy), '0xdead' as Hex, other)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run it, verify it fails** — `confirmDeploy` not exported.

- [ ] **Step 3: Implement `confirmDeploy`:**

```ts
import { type Log, decodeEventLog, isAddressEqual } from 'viem'

export async function confirmDeploy(client: PublicClient, txHash: Hex, predicted: Hex): Promise<Hex> {
  const receipt = await client.waitForTransactionReceipt({ hash: txHash })
  if (receipt.status !== 'success') throw new Error('Deploy transaction reverted')
  for (const log of receipt.logs as Log[]) {
    try {
      const ev = decodeEventLog({ abi: PROXY_FACTORY_ABI, topics: log.topics, data: log.data })
      if (ev.eventName === 'ProxyCreation') {
        const proxy = (ev.args as { proxy: Hex }).proxy
        if (!isAddressEqual(proxy, predicted)) {
          throw new Error(
            `Deployed Safe ${proxy} does not match the predicted address ${predicted} — do not use it.`,
          )
        }
        return proxy
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('do not use it')) throw e
      // not a ProxyCreation log — skip
    }
  }
  throw new Error('Deploy transaction produced no ProxyCreation event')
}
```

- [ ] **Step 4: Run it, verify it passes** (6 tests total in the file).

- [ ] **Step 5: Commit**

```bash
git add packages/cosign-web/src/lib/deploy-safe.ts packages/cosign-web/src/lib/deploy-safe.test.ts
git commit -m "feat(cosign-web): verify mined proxy == predicted before handoff"
```

---

### Task 6: Optional gasless deploy (sponsor seam)

**Files:**
- Modify: `packages/cosign-web/src/lib/deploy-safe.ts` (add `sponsoredDeploy` seam + config)
- Modify: `packages/cosign-web/src/lib/config.ts` (add `SPONSOR_BASE` map, may be empty)
- Modify: `packages/cosign-web/src/components/CreateSafe.tsx` (toggle)

**Interfaces:**
- Produces: `sponsorFor(chainId: number): string | null`; `sponsoredDeploy(args: { chainId; initializer: Hex; saltNonce: bigint }): Promise<Hex>` — POSTs `{ singleton: SAFE_V141.singletonL2, initializer, saltNonce }` to `${sponsorBase}/deploy-safe` and returns the tx hash the sponsor submitted.

- [ ] **Step 1: Confirm the sponsor contract.** Read `packages/sponsor` (and `packages/faucet`/`packages/relayer`) to find whether a relay endpoint exists that can submit an arbitrary `createProxyWithNonce`, or whether one must be added. Record the finding at the top of this task's commit message. If no such endpoint exists yet, ship the toggle **disabled** with tooltip "Gasless coming soon" and set `SPONSOR_BASE = {}` — the user-pays path (Tasks 3–5) is the shipping default; do not block on the sponsor.

- [ ] **Step 2: Add `sponsorFor` + `sponsoredDeploy`** guarded by `sponsorFor(chainId)` returning null when unset. The predicted address is identical regardless of submitter (CREATE2 depends on factory+init+salt), so `CreateSafe` computes `predicted` the same way and still runs `confirmDeploy(client, hash, predicted)` on the sponsor's tx hash.

- [ ] **Step 3: Add the toggle** in `CreateSafe`: shown only when `sponsorFor(wallet.chainId)` is non-null; when on, `onDeploy` calls `sponsoredDeploy(...)` instead of `wallet.deploySafe(...)`. Everything else (predict, confirm, handoff) is unchanged.

- [ ] **Step 4: Typecheck + build**, then commit:

```bash
git add packages/cosign-web/src/lib/deploy-safe.ts packages/cosign-web/src/lib/config.ts packages/cosign-web/src/components/CreateSafe.tsx
git commit -m "feat(cosign-web): optional gasless Safe deploy via sponsor seam"
```

---

### Task 7: Ship it — build + deploy + verify live

**Files:** none (deploy).

- [ ] **Step 1: Full test + typecheck + build**

Run: `npm test --workspace=packages/cosign-web && npx tsc --noEmit -p packages/cosign-web/tsconfig.json && npm run build --workspace=packages/cosign-web`
Expected: all green.

- [ ] **Step 2: Deploy via the runbook** (the box SSH uses the op-fetched key; ANSIBLE_VAULT throwaway; see the prior cosign deploys):

```bash
cd ansible && SSH_AUTH_SOCK= ANSIBLE_VAULT_PASSWORD_FILE=<throwaway> ansible-playbook deploy-cosign.yml
```
Expected: `failed=0`; positive + regression smoke pass.

- [ ] **Step 3: Verify live** — `curl https://cosign.msgboard.xyz/` returns a NEW bundle hash; confirm the Create-Safe mode renders (Playwright or manual). No regression on `/safe-indexer` or `cosign-archive`.

- [ ] **Step 4: Commit** any deploy-artifact changes (none expected).

---

### Task 8 (parallel track, gated on a funded 943 key): Provision Safe v1.4.1 on 943

**Files:**
- Create: `ansible/provision-safe-v141-943.yml` (or a documented `scripts/` runbook)

**Context:** 943 has only v1.3.0; its deterministic deployment proxy `0x4e59b44847b379578588920cA78FbF26c0B4956C` IS present. Until this runs, Create-Safe is auto-disabled on 943 (feature-detect); 369 + mainnet work without it.

- [ ] **Step 1: Determine the deployment method.** Install/read `@safe-global/safe-deployments` + `@safe-global/safe-singleton-factory`. Confirm which factory the canonical v1.4.1 addresses were minted from (Arachnid `0x4e59b448…` vs Safe's singleton-factory `0x914d7Fec…`). Check both on 943 with `eth_getCode`. If Safe's singleton-factory is required and absent, first deploy it from its presigned deployment tx (per `@safe-global/safe-singleton-factory`).
- [ ] **Step 2: Fund a 943 deployer** — retry the 943 faucet (was rate-limited 2026-07-01; likely reset) or use a funded key.
- [ ] **Step 3: Deploy the v1.4.1 suite** — SafeL2 singleton `0x29fcB…`, SafeProxyFactory `0x4e1DCf…`, CompatibilityFallbackHandler `0xfd0732…` — via the identified factory, and **assert each lands at its canonical address**. If canonical reproduction is impossible on 943, deploy at 943-specific addresses and change `SAFE_V141` in `deploy-safe.ts` to a per-chain `safeDeploymentFor(chainId)` table (update Tasks 1–3 references + tests accordingly).
- [ ] **Step 4: Verify** — `eth_getCode` on the three addresses is non-empty; then a real create → assert mined proxy == `predictSafeAddress(...)` on 943 (this is the integration source-of-truth for Task 2's fixture math on a live chain).
- [ ] **Step 5: Commit** the runbook + any per-chain address-table change.

---

## Self-Review notes
- **Spec coverage:** version/addresses+feature-detect → Tasks 1–2, 4; buildSetup → 1; predict+preview → 2, 4; wallet deploy → 3; verify==predicted → 5; user-pays default → 3–5; gasless optional → 6; 943 provisioning → 8; rollout via ansible → 7. All spec sections mapped.
- **Type consistency:** `predictSafeAddress({owners,threshold,saltNonce})`, `buildSetup(owners,threshold)`, `deploySafe(initializer,saltNonce)`, `confirmDeploy(client,txHash,predicted)`, `isDeploySupported(client,chainId)` are used identically wherever referenced.
- **Real values:** initializer `0xb63e800d…`, salt `0xecba1787…`, predicted `0xf4065759F44c99b596448F58F59249a8C13F819C`, creation-code hash `0x1856e0ee…` are the actual 369-factory-derived fixtures.
