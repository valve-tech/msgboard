import {
  type Hex,
  type Log,
  type PublicClient,
  concat,
  decodeEventLog,
  encodeFunctionData,
  getContractAddress,
  isAddressEqual,
  keccak256,
  pad,
  toHex,
  zeroAddress,
} from 'viem'

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

/**
 * The Safe v1.4.1 SafeProxy creation code (from the canonical SafeProxyFactory.proxyCreationCode()).
 * keccak256 == 0x1856e0ee08399d74e0ea0b03adca210aeade6f748969ac023cdcb4dd62dcaf5f. Embedded so address
 * prediction is a pure, synchronous function (no RPC per keystroke). Locked by the Task-2 fixture test
 * and by the Task-7 integration deploy (mined proxy == predicted).
 */
export const PROXY_CREATION_CODE_V141: Hex =
  '0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564'

/** Deterministic CREATE2 address for a v1.4.1 Safe with these params. Pure + synchronous. */
export function predictSafeAddress(args: { owners: Hex[]; threshold: number; saltNonce: bigint }): Hex {
  const initializer = buildSetup(args.owners, args.threshold)
  const salt = keccak256(concat([keccak256(initializer), pad(toHex(args.saltNonce), { size: 32 })]))
  const deploymentData = concat([PROXY_CREATION_CODE_V141, pad(SAFE_V141.singletonL2, { size: 32 })])
  return getContractAddress({ opcode: 'CREATE2', from: SAFE_V141.factory, salt, bytecode: deploymentData })
}

/** True when Safe v1.4.1's factory has code on `chainId` (i.e. Create-Safe can run there). */
export async function isDeploySupported(client: PublicClient): Promise<boolean> {
  const code = await client.getCode({ address: SAFE_V141.factory })
  return !!code && code !== '0x'
}

/** A fresh 256-bit saltNonce so re-deploying the same owner set yields a distinct address. */
export function randomSaltNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return BigInt('0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''))
}

/** Thrown by {@link confirmDeploy} when the mined Safe proxy address doesn't match the predicted one. */
export class SafeAddressMismatchError extends Error {}

/** Waits for the deploy receipt, parses the `ProxyCreation` event, and returns the created proxy only if it equals the predicted address; otherwise throws. */
export async function confirmDeploy(client: PublicClient, txHash: Hex, predicted: Hex): Promise<Hex> {
  const receipt = await client.waitForTransactionReceipt({ hash: txHash })
  if (receipt.status !== 'success') throw new Error('Deploy transaction reverted')
  for (const log of receipt.logs as Log[]) {
    if (!isAddressEqual(log.address, SAFE_V141.factory)) continue
    try {
      const ev = decodeEventLog({ abi: PROXY_FACTORY_ABI, topics: log.topics, data: log.data })
      if (ev.eventName === 'ProxyCreation') {
        const proxy = (ev.args as { proxy: Hex }).proxy
        if (!isAddressEqual(proxy, predicted)) {
          throw new SafeAddressMismatchError(
            `Deployed Safe ${proxy} does not match the predicted address ${predicted} — do not use it.`,
          )
        }
        return proxy
      }
    } catch (e) {
      if (e instanceof SafeAddressMismatchError) throw e
      // not a ProxyCreation log — skip
    }
  }
  throw new Error('Deploy transaction produced no ProxyCreation event')
}
