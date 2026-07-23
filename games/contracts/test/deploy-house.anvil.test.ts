/**
 * Integration test for the deploy + configure script against a REAL anvil node (not hardhat's
 * in-process chain), exercising the live legacy-gas code path end to end:
 *   spawn anvil → deploy Chips → deployAndConfigureHouse(patched HouseChannel) → assert on-chain
 *   state (owner / houseKey / housePool / chips balances) → smoke-prove the patched bytecode.
 *
 * Uses the real compiled artifacts, real viem clients over HTTP, and the same `resolveLegacyFee`
 * legacy-gas path the 943 run will use. Anvil does not reproduce PulseChain's exact fee values, but
 * it validates that the legacy-fee deploy/configure flow produces mineable transactions and the
 * correct end state — the logic the gas.test.ts unit tests pin to the PulseChain numbers.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { expect } from 'chai'
import * as viem from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { deployAndConfigureHouse, deployHouseChannel } from '../scripts/deploy-house'
import { resolveLegacyFee } from '../scripts/gas'

const PORT = 8599
const RPC = `http://127.0.0.1:${PORT}`
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'
const anvilChain = {
  id: 31337, name: 'anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const

function readArtifact(name: 'Chips' | 'HouseChannel') {
  const p = path.resolve(__dirname, `../artifacts/contracts/games/${name}.sol/${name}.json`)
  return JSON.parse(fs.readFileSync(p, 'utf8')) as { abi: viem.Abi; bytecode: viem.Hex }
}

async function waitForRpc(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(RPC, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      })
      if (res.ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('anvil did not become ready in time')
}

describe('deploy + configure HouseChannel on anvil (legacy-gas path)', function () {
  this.timeout(120_000)

  let anvil: ChildProcess
  const owner = mnemonicToAccount(ANVIL_MNEMONIC) // index 0 — anvil-funded
  const house = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 1 })
  const publicClient = viem.createPublicClient({ chain: anvilChain, transport: viem.http(RPC) })
  const walletClient = viem.createWalletClient({ account: owner, chain: anvilChain, transport: viem.http(RPC) })

  before(async function () {
    // CI runners (and machines without foundry) have no anvil binary — spawning it there throws
    // an uncatchable async ENOENT that fails the whole suite. This is an integration test of the
    // deploy script against a REAL node; skip it cleanly where that node cannot exist.
    const probe = spawnSync('anvil', ['--version'], { stdio: 'ignore' })
    if (probe.error) this.skip()
    anvil = spawn('anvil', ['--port', String(PORT), '--mnemonic', ANVIL_MNEMONIC, '--silent'], { stdio: 'ignore' })
    await waitForRpc(30_000)
  })

  after(() => { if (anvil && !anvil.killed) anvil.kill('SIGKILL') })

  it('deploys the patched HouseChannel and configures it, with verifiable end state', async () => {
    // 1. Deploy the existing-token stand-in (Chips) the way it is deployed on 943.
    const chipsArtifact = readArtifact('Chips')
    const fee = await resolveLegacyFee(publicClient)
    const chipsHash = await walletClient.deployContract({
      abi: chipsArtifact.abi, bytecode: chipsArtifact.bytecode,
      account: owner, chain: anvilChain, gasPrice: fee.gasPrice, type: 'legacy',
    })
    const chipsRcpt = await publicClient.waitForTransactionReceipt({ hash: chipsHash })
    const chips = chipsRcpt.contractAddress as viem.Hex
    expect(chips, 'chips deployed').to.be.a('string')

    // 2. Full deploy + configure of the patched HouseChannel via the real orchestrator.
    const houseArtifact = readArtifact('HouseChannel')
    const treasury = 1_000_000n * 10n ** 18n
    const fund = 500_000n * 10n ** 18n

    const result = await deployAndConfigureHouse({
      walletClient, publicClient,
      abi: houseArtifact.abi, bytecode: houseArtifact.bytecode,
      chips, houseKey: house.address, treasury, fund,
    })

    // 3. Verify end state the orchestrator read back.
    expect(viem.getAddress(result.verified.owner)).to.equal(viem.getAddress(owner.address))
    expect(viem.getAddress(result.verified.houseKey)).to.equal(viem.getAddress(house.address))
    expect(viem.getAddress(result.verified.chips)).to.equal(viem.getAddress(chips))
    expect(result.verified.housePool).to.equal(fund)
    expect(result.fee.gasPrice > 0n, 'legacy gas price resolved').to.equal(true)

    // 4. Independently confirm Chips balances: pool funded, operator keeps treasury - fund.
    const erc20 = [
      { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
    ] as const satisfies viem.Abi
    const channelBal = await publicClient.readContract({ address: chips, abi: erc20, functionName: 'balanceOf', args: [result.channel] })
    const ownerBal = await publicClient.readContract({ address: chips, abi: erc20, functionName: 'balanceOf', args: [owner.address] })
    expect(channelBal).to.equal(fund)
    expect(ownerBal).to.equal(treasury - fund)

    // 5. Smoke-prove this is the PATCHED bytecode: disputeFromOpen exists and reverts BadStatus on a
    //    table that was never opened (a pre-patch contract would not have the selector at all).
    let reverted = false
    try {
      await publicClient.simulateContract({
        address: result.channel, abi: houseArtifact.abi, functionName: 'disputeFromOpen',
        args: [`0x${'00'.repeat(32)}` as viem.Hex], account: owner,
      })
    } catch (e) {
      reverted = true
      expect(String((e as Error).message)).to.match(/BadStatus/) // the patched refund-floor guard
    }
    expect(reverted, 'disputeFromOpen present and guards an unopened table').to.equal(true)
  })

  it('deployHouseChannel sets the chips immutable correctly', async () => {
    const chipsArtifact = readArtifact('Chips')
    const fee = await resolveLegacyFee(publicClient)
    const chipsHash = await walletClient.deployContract({
      abi: chipsArtifact.abi, bytecode: chipsArtifact.bytecode,
      account: owner, chain: anvilChain, gasPrice: fee.gasPrice, type: 'legacy',
    })
    const chips = (await publicClient.waitForTransactionReceipt({ hash: chipsHash })).contractAddress as viem.Hex

    const houseArtifact = readArtifact('HouseChannel')
    const channel = await deployHouseChannel({
      walletClient, publicClient, abi: houseArtifact.abi, bytecode: houseArtifact.bytecode, chips, fee,
    })
    const wired = await publicClient.readContract({
      address: channel,
      abi: [{ name: 'chips', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }] as const,
      functionName: 'chips',
    })
    expect(viem.getAddress(wired as viem.Hex)).to.equal(viem.getAddress(chips))
  })
})
