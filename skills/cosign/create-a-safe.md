---
name: create-a-safe
description: Deploy a new Gnosis Safe v1.4.1 with a predicted, verified CREATE2 address (predict → deploy via createProxyWithNonce → confirm mined==predicted) and hand it into a cosign session. Use when asked to deploy/create a new Safe, or to predict a Safe's deployment address before deploying it.
---

# Create a Safe (v1.4.1)

cosign-web's "Create a Safe" flow deploys a fresh Gnosis Safe using the canonical, deterministic
v1.4.1 deployment — same factory/singleton/fallback-handler addresses on every EVM chain — and
refuses to hand the result downstream unless the address that actually got deployed matches the one
predicted before signing the deploy transaction.

Ground truth: `packages/cosign-web/src/lib/deploy-safe.ts`,
`packages/cosign-web/src/components/CreateSafe.tsx`. These constants/functions currently live in
cosign-web, not yet re-exported from the `@msgboard/cosign` SDK root.

## Canonical v1.4.1 addresses (`SAFE_V141`)

```ts
factory:        '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67'  // SafeProxyFactory
singletonL2:     '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762'  // Safe v1.4.1 L2 singleton
fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99'
```

Before offering this flow, confirm the factory is actually deployed on the target chain:

```ts
async function isDeploySupported(client): Promise<boolean> {
  const code = await client.getCode({ address: SAFE_V141.factory })
  return !!code && code !== '0x'
}
```

(As of 2026-07-02, v1.4.1 is deployed on all three chains the app lists — Ethereum mainnet (1),
PulseChain (369), and PulseChain v4 testnet (943). 943 originally shipped only v1.3.0; the canonical
v1.4.1 suite was deployed there via the Safe safe-singleton-factory — see
`packages/cosign-web/scripts/provision-safe-v141-943.ts`. Still always check live with the code above
rather than assuming — a different chain may not have it.)

## Step 1 — Predict the address (pure, synchronous, no RPC)

```ts
function buildSetup(owners: Hex[], threshold: number): Hex {
  // encodeFunctionData(setup, [owners, threshold, zeroAddress, '0x',
  //   SAFE_V141.fallbackHandler, zeroAddress, 0n, zeroAddress])  — no module/guard/payment
}

function predictSafeAddress({ owners, threshold, saltNonce }): Hex {
  const initializer = buildSetup(owners, threshold)
  const salt = keccak256(concat([keccak256(initializer), pad(toHex(saltNonce), { size: 32 })]))
  const deploymentData = concat([PROXY_CREATION_CODE_V141, pad(SAFE_V141.singletonL2, { size: 32 })])
  return getContractAddress({ opcode: 'CREATE2', from: SAFE_V141.factory, salt, bytecode: deploymentData })
}
```

`PROXY_CREATION_CODE_V141` is the canonical `SafeProxyFactory.proxyCreationCode()`, embedded so
prediction never needs a network round-trip — you can show a live predicted address as an owners/
threshold form is edited. Generate `saltNonce` fresh per deploy attempt with a CSPRNG
(`randomSaltNonce()` — 256 random bits) so re-deploying the same owner set yields a distinct
address rather than colliding with (or replaying) a prior deploy.

```ts
function randomSaltNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return BigInt('0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''))
}
```

Dedupe/normalize owners before predicting (case-insensitive; the same address twice only counts
once) and clamp `1 <= threshold <= owners.length`.

## Step 2 — Deploy

Have the connected wallet call the factory directly:

```
createProxyWithNonce(singleton: SAFE_V141.singletonL2, initializer: buildSetup(owners, threshold), saltNonce)
  → emits ProxyCreation(proxy, singleton)
```

## Step 3 — Verify: mined address must equal predicted (or throw)

```ts
class SafeAddressMismatchError extends Error {}

async function confirmDeploy(client, txHash, predicted): Promise<Hex> {
  const receipt = await client.waitForTransactionReceipt({ hash: txHash })
  if (receipt.status !== 'success') throw new Error('Deploy transaction reverted')
  for (const log of receipt.logs) {
    if (log.address !== SAFE_V141.factory) continue
    const ev = decodeEventLog({ abi: PROXY_FACTORY_ABI, topics: log.topics, data: log.data })
    if (ev.eventName === 'ProxyCreation') {
      const proxy = ev.args.proxy
      if (proxy !== predicted) throw new SafeAddressMismatchError(`deployed ${proxy} != predicted ${predicted}`)
      return proxy
    }
  }
  throw new Error('Deploy transaction produced no ProxyCreation event')
}
```

**Do not skip this check and do not use an address you merely predicted** — always use the address
`confirmDeploy` returns (or the throw), which is independently read back from the mined
`ProxyCreation` log. This is what stands between "we deployed a Safe" and "we deployed a Safe or
possibly something else, we didn't check."

## Step 4 — Hand off into a cosign session

Once confirmed, treat the new Safe exactly like a manually-entered one: re-read `owners`/
`threshold` off the live contract (don't trust the values you just deployed with — re-derive them
from chain state), pin the read to the chain the deploy actually ran on (not "whatever chain the
wallet is on by the time this resolves" — a wallet can switch chains mid-flow), and proceed with
`operate-a-cosign-session.md` from its step 1.

## Common mistakes

- Trusting the predicted address as the deployed address without calling `confirmDeploy` (or
  equivalent) against the actual mined receipt.
- Reusing a `saltNonce` across attempts with the same owner set — predicts (and may collide with)
  the same address as a previous attempt.
- Assuming v1.4.1 is deployed everywhere the app lists a chain — always gate on `isDeploySupported`
  (a live `eth_getCode` check), don't hardcode chain support.
- Building `setup()` calldata with a different field order or fallback handler than
  `SAFE_SETUP_ABI`/`SAFE_V141.fallbackHandler` — this silently changes the predicted CREATE2 address
  because the initializer hash feeds directly into the `salt`.
