/**
 * chip-faucet.ts — the msgboard.xyz fun-chips FAUCET actor.
 *
 * Watches the `chipsplease:943` board category; for each PoW-stamped post whose data is an address
 * (the recipient), owner-mints Chips to it once (dedup by message hash). Mirrors packages/sponsor
 * (the v4 gas faucet) with a mint action. The faucet key (mnemonic index FAUCET_INDEX, default 51)
 * is the Chips owner and needs 943 gas — minting is an on-chain tx. It posts nothing to the board.
 */
import { mnemonicToAccount } from 'viem/accounts'
import { runChipFaucet } from '@msgboard/games-house-service'

const env = process.env
const CHAIN = env.CHAIN ?? '943'
const FAUCET_INDEX = Number(env.FAUCET_INDEX ?? '51')

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
  const shutdown = (sig: string) => { console.log(`\n${sig} — stopping chip faucet…`); stop(); process.exit(0) }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
