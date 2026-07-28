import { http, isAddress, parseGwei, type Account, type Hex } from 'viem'
import type { RPCMessage } from '@msgboard/sdk'
import { Relayer, msgboardContentSource, memoryTtlStore, resolveChain, type RelayerContext, type RelayerConfig } from '@msgboard/relayer'
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
  /** EIP-1559 fees for the mint tx. Default to PulseChain-sane values (see below) — REQUIRED there,
   *  where auto fee-estimation underprices the tx (~16 wei) and it never mines. */
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
  walletFactory?: Parameters<typeof mintChipsAction<RPCMessage>>[0]['walletFactory']
}

const DEFAULT_AMOUNT = 1000n * 10n ** 18n
// PulseChain base fee is ~7 wei; a ~0.5 gwei tip gets a tx mined promptly. maxFee covers base + tip
// with ample headroom. These make the mint actually confirm (an unpriced mint stalls at ~16 wei).
const DEFAULT_MAX_PRIORITY_FEE = parseGwei('0.5')
const DEFAULT_MAX_FEE = parseGwei('2')

/** PURE relayer config for the chip faucet — the entry AND tests consume the identical object. */
export function chipFaucetConfig(opts: ChipFaucetOpts): RelayerConfig<RPCMessage> {
  const amount = opts.amount ?? DEFAULT_AMOUNT
  return {
    node: { transport: http(opts.rpcUrl), chain: resolveChain(opts.chainId ?? 943) },
    mode: opts.mode ?? 'live',
    intervalMs: opts.intervalMs ?? 20_000,
    source: msgboardContentSource({ category: opts.category ?? 'chipsplease:943' }),
    condition: (m: RPCMessage, _context: RelayerContext) => isAddress(m.data),
    key: (m: RPCMessage) => m.hash.toLowerCase(),
    store: memoryTtlStore<RPCMessage>({ ttlMs: opts.ttlMs ?? 3_600_000 }),
    action: mintChipsAction<RPCMessage>({
      account: opts.account, chips: opts.chips,
      recipient: (m) => m.data as Hex,
      amount, cap: opts.cap ?? amount,
      maxFeePerGas: opts.maxFeePerGas ?? DEFAULT_MAX_FEE,
      maxPriorityFeePerGas: opts.maxPriorityFeePerGas ?? DEFAULT_MAX_PRIORITY_FEE,
      walletFactory: opts.walletFactory,
    }),
  }
}

export function runChipFaucet(opts: ChipFaucetOpts) {
  const relayer = new Relayer<RPCMessage>(chipFaucetConfig(opts))
  relayer.start()
  return { relayer, stop: () => relayer.stop() }
}
