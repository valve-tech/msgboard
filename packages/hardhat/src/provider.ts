import { ProviderWrapper } from 'hardhat/plugins'
import { numberToHex, type Hex, type Block, zeroHash, hexToBytes } from 'viem'
import type { EIP1193Provider, RequestArguments } from 'hardhat/types'
import * as msgboard from '@msgboard/sdk'

import type { MsgBoardSettings } from './types'

export const globalDefaultSettings: MsgBoardSettings = {
  enabled: true,
  workMultiplier: 10_000n,
  workDivisor: 1_000_000n,
  messageSizeLimit: 1024n * 8n,
  boardCountLimit: 10_000n,
  blockRangeLimit: 120n,
}
export const defaultSettings = () => ({
  ...globalDefaultSettings,
})

/**
 * Waits for a given number of milliseconds
 * @param ms The number of milliseconds to wait
 */
const wait = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
const isNil = (value: unknown) => value === null || value === undefined
let id = 0
export class MsgBoardProvider extends ProviderWrapper {
  private messages: msgboard.Message[] = []
  id: number
  private settings: MsgBoardSettings = {
    ...globalDefaultSettings,
  }
  constructor(
    protected readonly _wrappedProvider: EIP1193Provider,
    protected readonly isHardhatNetwork: boolean,
  ) {
    super(_wrappedProvider)
    this.id = ++id
  }
  /**
   * Returns the default settings for a msgboard instance
   * @returns The default settings for a msgboard instance
   */
  static defaultSettings() {
    return {
      ...globalDefaultSettings,
    }
  }
  /**
   * Returns the status of the msgboard
   * @returns The status object of this message board instance
   */
  private status() {
    return {
      enabled: this.settings.enabled,
      workMultiplier: numberToHex(this.settings.workMultiplier),
      workDivisor: numberToHex(this.settings.workDivisor),
      count: numberToHex(this.messages.length),
      size: numberToHex(this.messages.reduce((acc, msg) => acc + msg.data.length, 0)),
    }
  }
  /**
   * Sets the constraints for this message board instance
   * @param constraints The constraints to set for this message board instance
   */
  async setNodeConstraints(constraints: Partial<MsgBoardSettings> = {}) {
    this.settings = { ...this.settings, ...constraints }
  }
  /**
   * Validates a message
   * @param m The message to validate
   * @returns The validated message and the produced hash
   */
  private async validateMessage(m: msgboard.MessageSeed) {
    // these errors may be out of order compared to the current node implementation
    const bytes = hexToBytes(m.data)
    if (bytes.length > this.settings.messageSizeLimit) {
      throw new Error('msgboard: message too large')
    }
    if (m.version !== 1) {
      throw new Error('powmsg: invalid version')
    }
    if (hexToBytes(m.category).length !== 32) {
      throw new Error('powmsg: invalid category')
    }
    if (m.blockHash === zeroHash) {
      throw new Error('powmsg: invalid block hash')
    }
    if (m.nonce === 0n) {
      throw new Error('powmsg: invalid nonce')
    }
    if (m.workDivisor === 0n || m.workMultiplier === 0n) {
      throw new Error('powmsg: invalid difficulty')
    }
    const difficultyFactors = {
      workMultiplier: this.settings.workMultiplier,
      workDivisor: this.settings.workDivisor,
    } as const
    if (m.category === zeroHash && m.data.length !== 0) {
      throw new Error('powmsg: invalid data')
    }
    const difficulty = msgboard.difficulty(difficultyFactors, bytes.length)
    const hash = msgboard.checkWork(m, difficulty)
    if (!hash) {
      if (
        difficultyFactors.workMultiplier !== this.settings.workMultiplier ||
        difficultyFactors.workDivisor !== this.settings.workDivisor
      ) {
        console.log(this.id, difficultyFactors, m)
      }
      throw new Error('powmsg: invalid work')
    }
    const block = (await this._wrappedProvider.request({
      method: 'eth_getBlockByHash',
      params: [m.blockHash, false],
    })) as Block
    if (!block) {
      throw new Error('powmsg: invalid block hash')
    }
    return { hash, block }
  }
  /**
   * Adds a message to the msgboard
   * @param msg The rlp encoded message to add
   * @returns The hash of the message
   */
  private async addMessage(msg: Hex) {
    const m = msgboard.fromRLP(msg)
    const { hash, block: workBlock } = await this.validateMessage(m)
    const latestBlock = (await this._wrappedProvider.request({
      method: 'eth_getBlockByNumber',
      params: ['latest', false],
    })) as Block
    const latestBlockNumber = BigInt(latestBlock.number!)
    const workBlockNumber = BigInt(workBlock.number!)
    if (
      // could swap out for bignumber.js to avoid precision issues
      Number(m.workMultiplier) / Number(m.workDivisor) >
      Number(this.settings.workMultiplier) / Number(this.settings.workDivisor)
    ) {
      throw new Error('msgboard: message work too easy')
    }
    if (workBlockNumber < latestBlockNumber - this.settings.blockRangeLimit) {
      throw new Error('msgboard: message block too old')
    }
    this.addOrderedMessage(latestBlockNumber, {
      ...m,
      blockNumber: workBlockNumber,
      hash,
    })
    return hash
  }
  /**
   * Adds a message to the msgboard in order
   * @param latestBlockNumber The latest block number
   * - to be passed to the removeStaleMessages method to prune old messages
   * @param m The message to add
   */
  private addOrderedMessage(latestBlockNumber: bigint, m: msgboard.Message) {
    const index = this.messages.findIndex((msg) => {
      return msg.blockNumber > m.blockNumber
    })
    if (index === -1) {
      this.messages.push(m)
    } else {
      this.messages.splice(index, 0, m)
    }
    this.removeStaleMessages(latestBlockNumber)
  }
  /**
   * Removes stale messages from the msgboard
   * @param latestBlockNumber The latest block number - used to prune old messages
   */
  private removeStaleMessages(latestBlockNumber: bigint) {
    // remove messages that are too old
    const finalValidBlockNumber = latestBlockNumber - this.settings.blockRangeLimit
    const index = this.messages.findIndex((msg) => {
      return msg.blockNumber >= finalValidBlockNumber
    })
    if (index !== -1) {
      this.messages.splice(0, index)
    }
    // remove messages when the board count limit is exceeded
    if (BigInt(this.messages.length) > this.settings.boardCountLimit) {
      this.messages.splice(0, this.messages.length - Number(this.settings.boardCountLimit))
    }
  }
  /**
   * Returns a message from the msgboard by hash
   * @param hash The hash of the message to return
   * @returns The message or null if it is not found
   */
  private getMessage(hash: Hex) {
    const msg = this.messages.find((msg) => msg.hash === hash) ?? null
    return !msg ? null : msgboard.toRPCMessage(msg)
  }
  /**
   * Returns the content of the msgboard
   * @param filter The filter to apply to the content
   * @returns The content of the msgboard
   */
  private content(filter: msgboard.ContentFilter = {}) {
    return this.messages.reduce((content, msg) => {
      if (filter.category && msg.category !== filter.category) {
        // message category does not match filter category
        return content
      }
      if (!isNil(filter.fromBlock) && msg.blockNumber < filter.fromBlock) {
        // message block number is below lower bound block number
        return content
      }
      if (!isNil(filter.toBlock) && msg.blockNumber > filter.toBlock) {
        // message block number is above upper bound block number
        return content
      }
      if (!content[msg.category]) {
        content[msg.category] = []
      }
      content[msg.category].push(msgboard.toRPCMessage(msg))
      return content
    }, {} as msgboard.Content)
  }
  /**
   * Returns the categories of the msgboard
   * @returns The categories of the msgboard
   */
  private categories() {
    return Array.from(new Set(this.messages.map((msg) => msg.category)))
  }
  /**
   * Handles a msgboard request
   * @param args The request arguments
   * @returns The result of the request
   */
  private handleMsgboardRequest<R>(args: RequestArguments): R | Promise<R> {
    if (args.method === 'msgboard_status') {
      return this.status(...(args.params as [])) as R
    }
    if (args.method === 'msgboard_addMessage') {
      return this.addMessage(...(args.params as [Hex])) as R
    }
    if (args.method === 'msgboard_getMessage') {
      return this.getMessage(...(args.params as [Hex])) as R
    }
    if (args.method === 'msgboard_content') {
      return this.content(...(args.params as [msgboard.ContentFilter])) as R
    }
    if (args.method === 'msgboard_categories') {
      return this.categories(...(args.params as [])) as R
    }
    // only for local hardhat network - does not exist on production networks
    if (args.method === 'msgboard_reset') {
      return this.reset(...(args.params as [])) as R
    }
    throw new Error('msgboard: unknown method')
  }
  /**
   * Emulates network latency by adding a XXms delay before and after the function call
   * @param fn The function to execute
   * @returns The result of the function
   */
  private async emulateNetworkLatency<R>(fn: () => R | Promise<R>): Promise<R> {
    await wait(2)
    const result = await fn()
    await wait(2)
    return result
  }
  /**
   * Handles a request to the msgboard, handling it locally if the network is hardhat
   * @param args The request arguments
   * @returns The result of the request
   */
  async request(args: RequestArguments) {
    if (this.isHardhatNetwork && args.method.startsWith('msgboard_')) {
      return this.emulateNetworkLatency(() => this.handleMsgboardRequest(args))
    }
    return this._wrappedProvider.request(args)
  }
  /**
   * Resets the msgboard
   */
  reset() {
    this.messages = []
  }
  destroy() {
    this.reset()
    providers.delete(this)
  }
}

export const providers: Set<MsgBoardProvider> = new Set()

/**
 * Sets the constraints for all created msgboard providers
 * @param constraints The settings to apply to all msgboard providers
 */
export const setNodeConstraints = (constraints: Partial<MsgBoardSettings>) => {
  Array.from(providers).forEach((p) => {
    p.setNodeConstraints(constraints)
  })
}

export const reset = () => {
  Array.from(providers).forEach((p) => {
    p.reset()
  })
}
