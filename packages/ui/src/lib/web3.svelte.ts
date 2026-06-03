import { pulsechainV4 } from 'viem/chains'
import {
  createPublicClient,
  defineChain,
  fallback,
  http,
  zeroAddress,
  formatEther,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem'
import { SvelteMap } from 'svelte/reactivity'
import { untrack } from 'svelte'

import { Log, terminalState } from './log.svelte'
import { rpcs } from './rpc.svelte'

const chains = [...rpcs.values()].map((c) => c.chain)

export const allowedChains = new Set(chains.map((c) => c.id))

const chainById = new Map([...rpcs.entries()].map(([k, c]) => [c.chain.id, {
  ...c,
  key: k,
}]))

export class Account {
  modalOpen = $state(false)
  currentChain = $state<Chain | null>(chains[0])
  balance = new SvelteMap<Hex, bigint>()
  address = $state<Hex | null>(null)
  get chainId() {
    return this.currentChain?.id ?? null
  }
  get chain() {
    const chainId = this.chainId
    if (!chainId) {
      return null
    }
    return chains.find((c) => c.id === chainId) ?? null
  }
  get transport() {
    const chain = this.chain
    if (!chain) {
      return null
    }
    const config = chainById.get(chain.id)
    if (!config) return null
    return fallback([http(config.rpcUrl)])
  }
  get client() {
    const chain = this.chain
    const transport = this.transport
    if (!chain || !transport) {
      return null
    }
    return createPublicClient({ chain, transport }) as PublicClient
  }
  get gasSymbol() {
    return this.chain?.nativeCurrency.symbol ?? null
  }
  async updateBalance() {
    const client = this.client
    const address = this.address as Hex
    if (!address || !client) {
      return
    }
    const bal = await client.getBalance({ address })
    const b = untrack(() => this.balance.get(address))
    if (b === bal) {
      return
    }
    this.balance.set(address, bal)
    terminalState.printToTerminal(new Log(`balance updated: ${formatEther(bal)}`))
  }
}

export const account = new Account()

const updateBalance = () => {
  // account.updateBalance()
  if (!account.address) {
    return
  }
  account.updateBalance()
}
setInterval(updateBalance, 10_000)
updateBalance()
