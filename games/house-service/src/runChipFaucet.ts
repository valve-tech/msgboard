import { http, isAddress, type Account, type Hex } from 'viem'
import type { RPCMessage } from '@msgboard/sdk'
import { Relayer, msgboardContentSource, memoryTtlStore, type RelayerContext } from '@msgboard/relayer'
import { mintChipsAction } from '@msgboard/relayer'

export interface ChipFaucetOpts {
  account: Account
  chips: Hex
  rpcUrl: string
  category?: string
  amount?: bigint
  cap?: bigint
  chainId?: number
  intervalMs?: number
  ttlMs?: number
  mode?: 'observe' | 'live'
  walletFactory?: Parameters<typeof mintChipsAction<RPCMessage>>[0]['walletFactory']
}

const DEFAULT_AMOUNT = 1000n * 10n ** 18n

/** PURE relayer config for the chip faucet — the entry AND tests consume the identical object. */
export function chipFaucetConfig(opts: ChipFaucetOpts) {
  const amount = opts.amount ?? DEFAULT_AMOUNT
  return {
    node: { transport: http(opts.rpcUrl) },
    mode: opts.mode ?? 'live',
    intervalMs: opts.intervalMs ?? 20_000,
    source: msgboardContentSource({ category: opts.category ?? 'chipsplease:943' }),
    condition: (m: RPCMessage, _context: RelayerContext) => isAddress(m.data) as boolean,
    key: (m: RPCMessage) => m.hash.toLowerCase(),
    store: memoryTtlStore<RPCMessage>({ ttlMs: opts.ttlMs ?? 3_600_000 }),
    action: mintChipsAction<RPCMessage>({
      account: opts.account, chips: opts.chips,
      recipient: (m) => m.data as Hex,
      amount, cap: opts.cap ?? amount,
      walletFactory: opts.walletFactory,
    }),
  } as const
}

export function runChipFaucet(opts: ChipFaucetOpts) {
  const relayer = new Relayer<RPCMessage>(chipFaucetConfig(opts) as never)
  relayer.start()
  return { relayer, stop: () => relayer.stop() }
}
