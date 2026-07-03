import type { Hex } from 'viem'

/**
 * Canonical Safe v1.4.1 deterministic-deployment addresses (L2 singleton). Same values as
 * cosign-web's `deploy-safe.ts` (the app that predicts the CREATE2 address the relay's tx must
 * mine to) — this relay only ever sponsors THIS exact factory/singleton/fallback-handler triple.
 */
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
