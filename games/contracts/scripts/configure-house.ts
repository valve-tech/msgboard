/**
 * One-shot house configuration script.
 *
 * Runs four contract calls in dependency order:
 *   1. HouseChannel.setHouseKey(houseKey)     — registers the house signing EOA
 *   2. Chips.mint(ownerAccount, treasury)      — creates treasury supply for the operator
 *   3. Chips.approve(channel, fund)            — grant channel the pull allowance fundHouse needs
 *   4. HouseChannel.fundHouse(fund)            — moves `fund` chips into the house pool
 *
 * The approve-before-fundHouse dependency is mandatory: fundHouse calls
 * chips.safeTransferFrom(msg.sender, ...) internally, so the channel must be
 * approved before fundHouse is called.
 *
 * Each call is simulated with simulateContract first, then written, and the
 * receipt is awaited before the next dependent step.
 *
 * @param opts.walletClient  An already-constructed viem WalletClient with an account set.
 * @param opts.chips         Address of the deployed Chips ERC-20 contract.
 * @param opts.channel       Address of the deployed HouseChannel contract.
 * @param opts.houseKey      EOA address to use as the house signing key.
 * @param opts.treasury      Total Chips to mint into the operator's own account.
 * @param opts.fund          Amount of the minted treasury to deposit into the house pool.
 *
 * @returns { setHouseKey, mint, fund } — tx hashes for the three on-chain state changes
 *          (approve is a silent prerequisite and its hash is not returned).
 */
import * as viem from 'viem'

// ── Minimal ABIs (only the selectors this script touches) ─────────────────────

const chipsAbi = [
  {
    name: 'mint',
    type: 'function',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'approve',
    type: 'function',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const satisfies viem.Abi

const houseChannelAbi = [
  {
    name: 'setHouseKey',
    type: 'function',
    inputs: [{ name: 'key', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'fundHouse',
    type: 'function',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'houseKey',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
] as const satisfies viem.Abi

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConfigureHouseOpts {
  walletClient: viem.WalletClient
  chips: viem.Hex
  channel: viem.Hex
  houseKey: viem.Hex
  treasury: bigint
  fund: bigint
  /**
   * Optional LEGACY (type-0) gas price applied to every write. REQUIRED for PulseChain, where
   * default EIP-1559 estimation is unreliable (see scripts/gas.ts). When omitted, viem's default
   * fee estimation is used (fine for normal 1559 chains / anvil / hardhat).
   */
  gasPrice?: bigint
}

export interface ConfigureHouseResult {
  setHouseKey: viem.Hex
  mint: viem.Hex
  fund: viem.Hex
}

// ── Implementation ────────────────────────────────────────────────────────────

export async function configureHouse(opts: ConfigureHouseOpts): Promise<ConfigureHouseResult> {
  const { walletClient, chips, channel, houseKey, treasury, fund, gasPrice } = opts

  const account = walletClient.account
  if (!account) throw new Error('walletClient must have an account set')

  // walletClient.extend(publicActions) gives us simulateContract and waitForTransactionReceipt
  // on the same transport as the wallet, without requiring a separate publicClient.
  const client = walletClient.extend(viem.publicActions)

  // When a legacy gasPrice is supplied (PulseChain), force a type-0 fee on every write so viem
  // never auto-derives an EIP-1559 maxFeePerGas from the chain's ~0 base fee. We do NOT reuse the
  // simulate `request` object for the write (it can carry 1559 fee fields); we re-issue the call
  // explicitly with the legacy fee. simulate is still run first purely as a revert check.
  const fee = gasPrice !== undefined ? ({ gasPrice, type: 'legacy' } as const) : ({} as const)

  // ── Step 1: setHouseKey ───────────────────────────────────────────────────
  await client.simulateContract({ address: channel, abi: houseChannelAbi, functionName: 'setHouseKey', args: [houseKey], account })
  const setHouseKeyHash = await client.writeContract({
    address: channel, abi: houseChannelAbi, functionName: 'setHouseKey', args: [houseKey],
    account, chain: walletClient.chain, ...fee,
  })
  await client.waitForTransactionReceipt({ hash: setHouseKeyHash })

  // ── Step 2: mint treasury ─────────────────────────────────────────────────
  await client.simulateContract({ address: chips, abi: chipsAbi, functionName: 'mint', args: [account.address, treasury], account })
  const mintHash = await client.writeContract({
    address: chips, abi: chipsAbi, functionName: 'mint', args: [account.address, treasury],
    account, chain: walletClient.chain, ...fee,
  })
  await client.waitForTransactionReceipt({ hash: mintHash })

  // ── Step 3: approve channel to pull `fund` chips (required by fundHouse) ──
  await client.simulateContract({ address: chips, abi: chipsAbi, functionName: 'approve', args: [channel, fund], account })
  const approveHash = await client.writeContract({
    address: chips, abi: chipsAbi, functionName: 'approve', args: [channel, fund],
    account, chain: walletClient.chain, ...fee,
  })
  await client.waitForTransactionReceipt({ hash: approveHash })

  // ── Step 4: fundHouse ─────────────────────────────────────────────────────
  await client.simulateContract({ address: channel, abi: houseChannelAbi, functionName: 'fundHouse', args: [fund], account })
  const fundHash = await client.writeContract({
    address: channel, abi: houseChannelAbi, functionName: 'fundHouse', args: [fund],
    account, chain: walletClient.chain, ...fee,
  })
  await client.waitForTransactionReceipt({ hash: fundHash })

  return {
    setHouseKey: setHouseKeyHash,
    mint: mintHash,
    fund: fundHash,
  }
}
