/**
 * Anvil-fork rehearsal of the operator coin-flip play loop against the LIVE 943 bytecode + state.
 * No private key: it forks 943, then impersonates accounts with anvil cheatcodes.
 *
 * It drives the round using the SAME functions the fixed UI's "Place bet" button uses —
 * `nextOperatorHeatIndex` (on-chain slot probe) + `operatorHeatLocations` (offset-0 STAKED pool) + the
 * one-time GameEscrow `setPlayerGame` consent — so this is a logic-level end-to-end of the UI bet path
 * against the real deployed contracts. The steps:
 *   1. depositBankroll — the operator funds its bankroll (0 on live), so a bet can open.
 *   2. ink            — simulate the validator node service inking fresh preimages into the offset-0
 *                       staked pool (exhausted at head: 13/13 consumed), so a heat slot is available.
 *   3. setPlayerGame  — the player's one-time consent (GameEscrow reverts PlayerNotConsented without it).
 *   4. open()         — approve + open, with the UI's own location math.
 *   5. refundStale()  — mine past STALE_BLOCKS and reclaim the stake (asserted: stake fully returned).
 *
 * Settle correctness is proven separately on real settled rounds by operator-verify-replay.ts. Run:
 *   npx tsx scripts/operator-fork-rehearsal.ts        # forks head (default)
 *   FORK_BLOCK=25121436 npx tsx scripts/...           # a block where the pool already had inventory
 * Requires `anvil` on PATH.
 */
import * as viem from 'viem'
import { spawn, type ChildProcess } from 'child_process'
import { operatorCoinFlipAbi, randomAbi, poolLocationFor, type Info } from '@msgboard/games-core'
import { operatorHeatLocations, nextOperatorHeatIndex, OPERATOR_POOL_SIZE } from '../src/model/operator-table'

const FORK_RPC = 'https://games.msgboard.xyz/rpc/evm/943'
const LOCAL_RPC = 'http://127.0.0.1:8545'
const CHAIN_ID = 943

const OPERATOR: viem.Hex = '0x5182574eE268ABD0A48f97DcfcdE65234E8422E2'
const CHIPS: viem.Hex = '0x81f130c7d9ff020f46f3b01918424173f8d5ca64'
const ESCROW: viem.Hex = '0xb572481635904fe2e3957bc45d81be07337e0838'
const COINFLIP: viem.Hex = '0x0c80607ec07999cdab97d4374d6b7a3b5a6f1833'
const RANDOM: viem.Hex = '0x775AF72d62c85d2F7f0Bcc05BAa4Be0830087217'
const TABLE_ID: viem.Hex = '0x3fa2c0761000611393da5f51cb05dbb676655415ca6451d8d1f397c154b63fac'
const SUBSET: viem.Hex[] = [
  '0xAe96b0748f933914867d59486251043790cB2896',
  '0x2a638D7135966a5cA1973c930bD0317cd7d6874c',
  '0x0D3148A85608708Fe944EE71E13B4C9181b7cc83',
]
const STALE_BLOCKS = 200n
const PLAYER: viem.Hex = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' // anvil account #0 (impersonated)
const HEADS = 0
const STAKE = 1_000_000_000_000_000_000n // 1 Chip (table range 1..8)

const ERC20_ABI = viem.parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address a) view returns (uint256)',
])
const ESCROW_ABI = viem.parseAbi([
  'function bankrollOf(address operator, address token) view returns (uint256)',
  'function depositBankroll(address operator, address token, uint256 amount)',
  'function setPlayerGame(address game, bool allowed)',
  'function playerAllowsGame(address player, address game) view returns (bool)',
])
const CONSUMED_ABI = viem.parseAbi([
  'function consumed((address provider,bool callAtChange,bool durationIsTimestamp,uint256 duration,address token,uint256 price,uint256 offset,uint256 index) info) view returns (bool)',
])

const chain = { id: CHAIN_ID, name: 'pulse-fork', nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 }, rpcUrls: { default: { http: [LOCAL_RPC] } } } as const
const pub = viem.createPublicClient({ chain, transport: viem.http(LOCAL_RPC) })
const wallet = viem.createWalletClient({ chain, transport: viem.http(LOCAL_RPC) })

const rpc = (method: string, params: unknown[]) => pub.request({ method: method as any, params: params as any })
const fmt = (x: bigint) => viem.formatEther(x)
const balOf = (a: viem.Hex) => pub.readContract({ address: CHIPS, abi: ERC20_ABI, functionName: 'balanceOf', args: [a] }) as Promise<bigint>

const send = async (account: viem.Hex, address: viem.Hex, abi: viem.Abi, functionName: string, args: readonly unknown[]) => {
  const { request } = await pub.simulateContract({ account, address, abi, functionName, args })
  const hash = await wallet.writeContract(request as any)
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted`)
  return receipt
}

/** The UI's own slot probe: read Random.consumed for the offset-0 pool slot k with the staking terms. */
const isConsumed = (tierPrice: bigint) => async (k: bigint): Promise<boolean> => {
  const { offset, index } = poolLocationFor(k, 0n, OPERATOR_POOL_SIZE)
  try {
    return (await pub.readContract({
      address: RANDOM,
      abi: CONSUMED_ABI,
      functionName: 'consumed',
      args: [{ provider: SUBSET[0]!, callAtChange: false, durationIsTimestamp: false, duration: 12n, token: CHIPS, price: tierPrice, offset, index }],
    })) as boolean
  } catch {
    return false
  }
}

/** Simulate the validator node service: ink `n` fresh preimages per validator into the offset-0 pool. */
const inkFresh = async (n: number) => {
  for (const v of SUBSET) {
    await rpc('anvil_setBalance', [v, viem.toHex(10n ** 20n)])
    await rpc('anvil_impersonateAccount', [v])
    const section: Info = { provider: v, callAtChange: false, durationIsTimestamp: false, duration: 12n, token: viem.zeroAddress, price: 0n, offset: 0n, index: 0n }
    for (let j = 0; j < n; j++) {
      const preimage = viem.keccak256(viem.keccak256(viem.toHex(`fork-rehearsal-${v}-${j}`)))
      await send(v, RANDOM, randomAbi, 'ink', [section, preimage])
    }
  }
}

const startAnvil = async (): Promise<ChildProcess> => {
  const forkBlock = process.env.FORK_BLOCK
  const args = ['--fork-url', FORK_RPC, '--chain-id', String(CHAIN_ID), '--silent', ...(forkBlock && forkBlock !== 'head' ? ['--fork-block-number', forkBlock] : [])]
  const anvil = spawn('anvil', args, { stdio: 'ignore' })
  for (let i = 0; i < 60; i++) {
    try {
      await pub.getBlockNumber()
      return anvil
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  anvil.kill()
  throw new Error('anvil did not come up within 30s')
}

const main = async () => {
  console.log('starting anvil fork of 943 …')
  const anvil = await startAnvil()
  try {
    console.log(`forked at block ${await pub.getBlockNumber()}\n`)
    for (const a of [OPERATOR, PLAYER]) {
      await rpc('anvil_setBalance', [a, viem.toHex(10n ** 20n)])
      await rpc('anvil_impersonateAccount', [a])
    }

    // 1. Operator funds bankroll (0 on live) and stakes the player some Chips.
    console.log('operator: approve + depositBankroll(100) + fund player(10)')
    await send(OPERATOR, CHIPS, ERC20_ABI, 'approve', [ESCROW, 100n * STAKE])
    await send(OPERATOR, ESCROW, ESCROW_ABI, 'depositBankroll', [OPERATOR, CHIPS, 100n * STAKE])
    await send(OPERATOR, CHIPS, ERC20_ABI, 'transfer', [PLAYER, 10n * STAKE])
    const bankroll = (await pub.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: 'bankrollOf', args: [OPERATOR, CHIPS] })) as bigint
    console.log(`  bankroll now ${fmt(bankroll)} Chips`)

    // 2. Simulate the validator node service replenishing the exhausted offset-0 staked pool.
    console.log('validators: ink a fresh preimage each into the offset-0 staked pool')
    await inkFresh(1)

    // 3. The UI bet path: probe the next slot → build the staked locations → consent → approve → open.
    const tierPrice = (await pub.readContract({ address: COINFLIP, abi: operatorCoinFlipAbi, functionName: 'tierPriceOf', args: [TABLE_ID, STAKE] })) as bigint
    const heatIndex = await nextOperatorHeatIndex(isConsumed(tierPrice))
    const locations = operatorHeatLocations(SUBSET, heatIndex, CHIPS, tierPrice)
    console.log(`player: bet — next slot index ${heatIndex}, tier ${fmt(tierPrice)} Chips (UI location math)`)

    const before = await balOf(PLAYER)
    await send(PLAYER, CHIPS, ERC20_ABI, 'approve', [ESCROW, STAKE])
    if (!(await pub.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: 'playerAllowsGame', args: [PLAYER, COINFLIP] }))) {
      await send(PLAYER, ESCROW, ESCROW_ABI, 'setPlayerGame', [COINFLIP, true])
    }
    const openReceipt = await send(PLAYER, COINFLIP, operatorCoinFlipAbi, 'open', [TABLE_ID, HEADS, STAKE, SUBSET, locations])
    const opened = viem.parseEventLogs({ abi: operatorCoinFlipAbi, eventName: 'RoundOpened', logs: openReceipt.logs })[0]
    const roundId = (opened!.args as { roundId: viem.Hex }).roundId
    const afterOpen = await balOf(PLAYER)
    console.log(`  ✓ opened ${roundId.slice(0, 12)}…; staked ${fmt(before - afterOpen)} Chips`)

    // 4. Refund path: no seed forms on the fork → mine past STALE_BLOCKS and reclaim.
    console.log(`mining ${STALE_BLOCKS + 1n} blocks → refundStale()`)
    await rpc('anvil_mine', [viem.toHex(STALE_BLOCKS + 1n)])
    const refundReceipt = await send(PLAYER, COINFLIP, operatorCoinFlipAbi, 'refundStale', [roundId])
    if (!viem.parseEventLogs({ abi: operatorCoinFlipAbi, eventName: 'RoundRefunded', logs: refundReceipt.logs })[0]) throw new Error('no RoundRefunded event')
    const afterRefund = await balOf(PLAYER)
    console.log(`  ✓ refunded; got back ${fmt(afterRefund - afterOpen)} Chips`)
    if (afterRefund !== before) throw new Error(`stake not fully returned: before ${before} after ${afterRefund}`)

    console.log('\nFORK REHEARSAL PASSED — the UI bet path (locations + consent) opens + refunds against live 943 bytecode.')
  } finally {
    anvil.kill()
  }
}

main().catch((e) => {
  console.error('\nFORK REHEARSAL FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
