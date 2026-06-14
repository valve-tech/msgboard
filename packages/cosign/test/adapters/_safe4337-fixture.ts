import { createRequire } from 'node:module'
import { type Hex, type Address, parseAbi, encodeFunctionData } from 'viem'
import { privateKeyToAccount, sign, serializeSignature } from 'viem/accounts'
// Reuse the Safe adapter's anvil fixture (already in the repo from the Safe adapter plan).
import { deploySafeFixture, type SafeFixture } from './_safe-fixture.js'
import { safeTransactionDigest, buildSignatureBlob } from '../../src/adapters/safe.js'
import { SCHEME, type SignatureRecord } from '../../src/record.js'

// The Safe4337Module v0.3.0 artifact (ABI + creation bytecode). The build artifact path can vary
// by release; if this resolve fails, the beforeAll catch in the test marks the suite skip-loud.
const require = createRequire(import.meta.url)
const Safe4337ModuleArtifact = require('@safe-global/safe-4337/build/artifacts/contracts/Safe4337Module.sol/Safe4337Module.json')

/** Canonical EntryPoint v0.7 address (eth-infinitism). */
export const ENTRYPOINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address

export interface Safe4337Fixture extends SafeFixture {
  module: Address
  entryPoint: Address
}

const SAFE_EXEC_ABI = parseAbi([
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)',
  'function nonce() view returns (uint256)',
  'function enableModule(address module)',
  'function isModuleEnabled(address module) view returns (bool)',
])

/**
 * Boots a Safe via the Safe adapter fixture, deploys the Safe4337Module v0.3.0 (constructor arg =
 * EntryPoint v0.7, so SUPPORTED_ENTRYPOINT == ENTRYPOINT_V07), and enables it on the Safe via a
 * self-call `enableModule` Safe transaction signed by `threshold` owners. Returns the SafeFixture
 * plus the module + entryPoint addresses.
 */
export async function deploySafe4337Fixture(ownerPks: Hex[], threshold: number): Promise<Safe4337Fixture> {
  const fx = await deploySafeFixture(ownerPks, threshold)

  // 1) deploy the module via real CREATE so the SUPPORTED_ENTRYPOINT immutable is set.
  const moduleBytecode = (Safe4337ModuleArtifact as { bytecode: Hex }).bytecode
  const moduleAbi = (Safe4337ModuleArtifact as { abi: readonly unknown[] }).abi
  const moduleDeployHash = await fx.walletClient.deployContract({
    abi: moduleAbi,
    bytecode: moduleBytecode,
    args: [ENTRYPOINT_V07],
  })
  const moduleReceipt = await fx.publicClient.waitForTransactionReceipt({ hash: moduleDeployHash })
  const module = moduleReceipt.contractAddress as Address
  if (!module) throw new Error('Safe4337Module deploy failed (no contractAddress)')

  // 2) enable the module on the Safe via a Safe transaction (self-call enableModule), signed by owners.
  const enableData = encodeFunctionData({ abi: SAFE_EXEC_ABI, functionName: 'enableModule', args: [module] })
  const safeTx = {
    to: fx.safe,
    value: 0n,
    data: enableData,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: '0x0000000000000000000000000000000000000000' as Hex,
    refundReceiver: '0x0000000000000000000000000000000000000000' as Hex,
    nonce: 0n,
  }
  const txDigest = safeTransactionDigest(safeTx, fx.chainId, fx.safe)

  // owners sorted ascending; sign with the first `threshold` of them
  const ownerPkByAddr = new Map(ownerPks.map((pk) => [privateKeyToAccount(pk).address.toLowerCase(), pk]))
  const signers = [...fx.owners]
    .sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))
    .slice(0, threshold)
  const ordered: SignatureRecord[] = []
  for (const s of signers) {
    const pk = ownerPkByAddr.get(s.address.toLowerCase())!
    ordered.push({
      digest: txDigest,
      signer: s.address as Hex,
      signature: serializeSignature(await sign({ hash: txDigest, privateKey: pk })),
      scheme: SCHEME.EIP712,
      meta: '0x',
    })
  }
  const blob = buildSignatureBlob(ordered)
  const enableHash = await fx.walletClient.writeContract({
    address: fx.safe,
    abi: SAFE_EXEC_ABI,
    functionName: 'execTransaction',
    args: [
      safeTx.to,
      safeTx.value,
      safeTx.data,
      safeTx.operation,
      safeTx.safeTxGas,
      safeTx.baseGas,
      safeTx.gasPrice,
      safeTx.gasToken,
      safeTx.refundReceiver,
      blob,
    ],
  })
  await fx.publicClient.waitForTransactionReceipt({ hash: enableHash })

  const enabled = (await fx.publicClient.readContract({
    address: fx.safe,
    abi: SAFE_EXEC_ABI,
    functionName: 'isModuleEnabled',
    args: [module],
  })) as boolean
  if (!enabled) throw new Error('Safe4337Module was not enabled on the Safe')

  return { ...fx, module, entryPoint: ENTRYPOINT_V07 }
}

export { SAFE_EXEC_ABI }
