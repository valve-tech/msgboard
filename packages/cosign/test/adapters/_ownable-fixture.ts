import { createServer } from 'prool'
import { anvil } from 'prool/instances'
import {
  type Address,
  createTestClient,
  createPublicClient,
  http,
  publicActions,
} from 'viem'
import { foundry } from 'viem/chains'
import { OWNABLE_VALIDATOR_ADDRESS, OWNABLE_VALIDATOR_RUNTIME } from '../../src/adapters/rhinestone.js'

export interface OwnableFixture {
  chainId: number
  publicClient: ReturnType<typeof createPublicClient>
  validator: Address
  stop: () => Promise<void>
}

/**
 * Boots anvil and setCode's the canonical OwnableValidator runtime bytecode at its address.
 * Because validateSignatureWithData is stateless, no install / EntryPoint / account is needed.
 */
export async function deployOwnableFixture(): Promise<OwnableFixture> {
  process.env.FOUNDRY_DISABLE_NIGHTLY_WARNING ??= '1'
  const server = createServer({ instance: anvil(), port: 0 })
  await server.start()
  const { port } = server.address()!
  const rpcUrl = `http://localhost:${port}/1`
  const chain = { ...foundry, id: foundry.id }

  const test = createTestClient({ mode: 'anvil', chain, transport: http(rpcUrl) }).extend(publicActions)
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })

  const validator = OWNABLE_VALIDATOR_ADDRESS as Address
  await test.setCode({ address: validator, bytecode: OWNABLE_VALIDATOR_RUNTIME })

  // sanity: the code is present
  const code = await publicClient.getCode({ address: validator })
  if (!code || code === '0x') throw new Error('setCode failed — no bytecode at validator address')

  return {
    chainId: chain.id,
    publicClient,
    validator,
    stop: async () => { await server.stop() },
  }
}
