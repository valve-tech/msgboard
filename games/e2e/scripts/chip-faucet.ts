/**
 * chip-faucet.ts — the msgboard.xyz fun-chips FAUCET actor.
 *
 * Watches the `chipsplease:943` board category; for each PoW-stamped post whose data is an address
 * (the recipient), owner-mints Chips to it once (dedup by message hash). Mirrors packages/sponsor
 * (the v4 gas faucet) with a mint action. The faucet key (mnemonic index FAUCET_INDEX, default 51)
 * is the Chips owner and needs 943 gas — minting is an on-chain tx. It posts nothing to the board.
 *
 * GAS AUTO-REFILL: minting spends gas, so the faucet key is kept topped up from account 0 (FUNDER_INDEX)
 * on a timer — the same pattern the other funded actors use — via the tested `refuelGas` helper.
 */
import './redact-console' // first: scrub the valve RPC key from all console output before anything logs
import { createPublicClient, createWalletClient, http, parseEther } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { runChipFaucet, refuelGas, type RefuelPublicClient, type RefuelWalletClient } from '@msgboard/games-house-service'
import { resolveChain } from '@msgboard/relayer'

const env = process.env
const CHAIN = env.CHAIN ?? '943'
const FAUCET_INDEX = Number(env.FAUCET_INDEX ?? '51')
// Gas auto-refill: keep the faucet key between REFILL_BELOW and REFILL_TO, funded from account 0.
const FUNDER_INDEX = Number(env.FUNDER_INDEX ?? '0')
const REFILL_BELOW = parseEther(env.REFILL_BELOW ?? '1')
const REFILL_TO = parseEther(env.REFILL_TO ?? '3')
const REFILL_INTERVAL_MS = Number(env.REFILL_INTERVAL_MS ?? '300000') // 5 min

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

  // ── gas auto-refill loop (funder = account 0) ──
  const chain = resolveChain(Number(CHAIN))
  const funder = mnemonicToAccount(env.MNEMONIC, { addressIndex: FUNDER_INDEX })
  const publicClient = createPublicClient({ chain, transport: http(env.RPC!) })
  const walletClient = createWalletClient({ account: funder, chain, transport: http(env.RPC!) })
  const refuelWallet: RefuelWalletClient = { sendTransaction: (a) => walletClient.sendTransaction(a as never) }
  const refuel = async () => {
    try {
      const { topUp, hash } = await refuelGas({
        publicClient: publicClient as RefuelPublicClient, walletClient: refuelWallet,
        funder, target: account.address, below: REFILL_BELOW, to: REFILL_TO, chain,
      })
      if (topUp > 0n) console.log(`gas refill: topped faucet ${account.address} up to ${REFILL_TO} wei (tx ${hash})`)
    } catch (e) {
      console.error('gas refill failed:', e instanceof Error ? e.message : e)
    }
  }
  await refuel() // top up now if the faucet is already low
  const refillTimer = setInterval(() => { void refuel() }, REFILL_INTERVAL_MS)

  const shutdown = (sig: string) => {
    console.log(`\n${sig} — stopping chip faucet…`)
    clearInterval(refillTimer)
    stop()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
