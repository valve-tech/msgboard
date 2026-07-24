import { type Hex, hexToBytes, zeroHash } from 'viem'
import log from './logger.js'
import type {
  Config,
  Content,
  ContentFilter,
  DifficultyFactors,
  Logger,
  Message,
  MessageSeed,
  Provider,
  RPCMessage,
  Status,
  WorkResult,
  WorkStats,
} from '@msgboard/core'
import { categoryHash, createChallengeSearch, difficulty, encodeData, toRLP } from '@msgboard/core'
import { loadDefaultStamper, type Stamper } from './grinder.js'

export * from '@msgboard/core'
export { loadDefaultStamper, wrapEngineStamp, type Stamp, type StampInput, type Stamper } from './grinder.js'

/**
 * Client config, extended with the fast-grind seam:
 * - `stamper` omitted (undefined) → auto-detect the fastest engine (native → WASM → JS grind);
 * - `stamper: fn` → use the given engine (e.g. a bundler-resolved WASM `wrapEngineStamp`);
 * - `stamper: null` → force the pure-JS grind (the pre-0.0.33 behavior).
 */
export type ClientConfig = Config & { stamper?: Stamper | null }

const veryHighLimit = 100_000_000n

// eslint-disable-next-line
const defaultLogger = (prefix: string, ...args: any[]) => log(prefix, ...args)

/**
 * MsgboardClient can be used for interacting with the msgboard API
 * and performing necessary work to find valid messages.
 */
export class MsgBoardClient {
  private _difficultyFactors: DifficultyFactors

  log: Logger

  breakInterval: bigint

  cancelled: boolean = false

  progressHandler: (stats: WorkStats) => void

  version: number = 1

  constructor(
    protected provider: Provider,
    config: ClientConfig = {},
  ) {
    this._difficultyFactors = {
      workMultiplier: 10_000n,
      workDivisor: 1_000_000n,
      ...(config.difficultyFactors ?? {}),
    }
    this.log = config.logger || defaultLogger
    this.breakInterval = config.breakInterval || 10_000n
    this.progressHandler = config.progress || (() => {})
    this.configuredStamper = config.stamper
  }

  /** The `stamper` config verbatim: undefined = auto-detect, null = JS grind, fn = use it. */
  private configuredStamper: Stamper | null | undefined

  private stamperPromise: Promise<Stamper | null> | undefined

  /** Resolve the fast engine once per client (never throws — null means JS grind). */
  private resolveStamper(): Promise<Stamper | null> {
    this.stamperPromise ??=
      this.configuredStamper !== undefined
        ? Promise.resolve(this.configuredStamper)
        : loadDefaultStamper().catch(() => null)
    return this.stamperPromise
  }

  get difficultyFactors() {
    return {
      workMultiplier: this._difficultyFactors.workMultiplier,
      workDivisor: this._difficultyFactors.workDivisor,
    }
  }
  set difficultyFactors(factors: DifficultyFactors) {
    this._difficultyFactors = {
      ...this._difficultyFactors,
      ...factors,
    }
  }

  /** Can be called to cancel a doPoW operation in progress. */
  cancel() {
    this.cancelled = true
  }

  /**
   * Starts a busy work loop, in search of a nonce to create a valid pow message
   * with the given inputs and configured difficulty.
   * @param category The 32-byte hash or string to be used as the message category
   * @param data the data bytes or string to embed in the message
   * @param limit an optional limit to the number of iterations that will be attempted
   * @returns a promise that will resolve with a valid work object, containing a pow
   * message that can be submitted to the API and a stats object about the work that was done
   */
  /** Preferred name for {@link doPoW}: grind a valid proof-of-work stamp for the message. */
  grind(category: Hex | string, data: Hex | string, limit = veryHighLimit): Promise<WorkResult> {
    return this.doPoW(category, data, limit)
  }

  async doPoW(category: Hex | string, data: Hex | string, limit = veryHighLimit): Promise<WorkResult> {
    this.log('starting pow on message')
    this.cancelled = false
    let killPoll = false
    const message: Message = {
      blockHash: zeroHash,
      blockNumber: 0n,
      category: categoryHash(category),
      data: encodeData(data),
      hash: zeroHash,
      nonce: 0n,
      version: this.version,
      workMultiplier: this.difficultyFactors.workMultiplier,
      workDivisor: this.difficultyFactors.workDivisor,
    }
    const dataLen = hexToBytes(message.data).length
    const stats: WorkStats = {
      difficulty: difficulty(this.difficultyFactors, dataLen),
      duration: 0,
      isValid: false,
      iterations: 0n,
    }

    // if we want to support multiple pow searches,
    // then we need to move this polling outside of this method
    // otherwise get block will be fetching at a commenserate rate
    // to the number of outstanding pow searches are currently running
    const getBlock = async () => {
      if (killPoll) return
      const { hash, ...block } = await this.lastestBlock()
      const number = BigInt(block.number)
      if (!killPoll && (message.blockNumber === 0n || message.blockNumber !== number)) {
        message.blockHash = hash
        message.blockNumber = number
        this.log('updated block info %o@%o', hash, number)
      }
      // queue next operation
      setTimeout(() => {
        getBlock().catch(log)
      }, 1_000)
    }
    // start the polling for block updates
    await getBlock()
    const { breakInterval } = this
    const start = Date.now()
    this.progressHandler({ ...stats })

    // ── fast path: the pow-grinder engine (native or WASM), ~1-2s per stamp vs the JS loop's
    // tens of seconds. The engine grinds against a SNAPSHOT of the block info (a stamp stays
    // valid for the board's ~120-block window, so mid-grind block updates don't matter the way
    // they do for the long JS grind). Any engine failure falls through to the JS loop below.
    const stamper = await this.resolveStamper()
    if (stamper) {
      try {
        const blockHash = message.blockHash
        const blockNumber = message.blockNumber
        const { nonce, hash } = await stamper({
          category: message.category,
          data: message.data,
          workMultiplier: message.workMultiplier,
          workDivisor: message.workDivisor,
          blockHash,
        })
        if (!this.cancelled) {
          message.nonce = nonce
          message.hash = hash
          message.blockHash = blockHash
          message.blockNumber = blockNumber
          stats.iterations = nonce + 1n // the engine searches consecutive nonces from 0
          stats.duration = Date.now() - start
          stats.isValid = true
          this.progressHandler({ ...stats })
          killPoll = true
          return { message, stats }
        }
        killPoll = true
        return { message, stats }
      } catch (err) {
        this.log('pow-grinder engine failed, falling back to JS grind: %o', err)
      }
    }

    // Incremental challenge search: advances the challenge point by one curve ADDITION
    // per nonce instead of a full scalar MULTIPLY, ~10x faster while staying bit-identical
    // to checkWork (the node's verifier). It mutates message.nonce and rebases on its own
    // when the block poller above updates message.blockHash mid-grind.
    const search = createChallengeSearch(message)
    while (true) {
      if (this.cancelled) {
        killPoll = true
        return { message, stats }
      }
      stats.iterations += 1n
      const hash = search.next(stats.difficulty)
      stats.duration = Date.now() - start
      if (hash) {
        message.hash = hash
        stats.isValid = true
        killPoll = true
        return { message, stats }
      }

      if (stats.iterations >= limit) {
        killPoll = true
        throw new Error('limit met')
      }

      if (breakInterval && message.nonce % breakInterval === 0n) {
        this.progressHandler({ ...stats })
        // pauses the PoW busy loop to allow the event loop to resolve the block updates
        await new Promise((resolve) => {
          setTimeout(resolve, 10)
        })
      }
    }
  }

  /**
   * Fetches the latest block from the RPC.
   * @returns the block details
   * @throws error responses from the RPC
   */
  async lastestBlock() {
    return this.request<{ hash: Hex; number: Hex }, [string, boolean]>({
      method: 'eth_getBlockByNumber',
      params: ['latest', false],
    })
  }

  /**
   * Submits a message to the board RPC.
   * @param input the RLP encoded message to add
   * @returns the message hash
   * @throws error responses from the RPC
   */
  async addMessage(input: Hex | MessageSeed) {
    const rlp = typeof input !== 'string' ? toRLP(input) : input
    return this.request<Hex, [Hex]>({ method: 'msgboard_addMessage', params: [rlp] })
  }

  /**
   * Fetches a message from the board RPC.
   * @param category category to lookup message
   * @param msgHash hash of the message to look up message on RPC
   * @returns a message from the RPC
   * @throws error responses from the RPC
   */
  async getMessage(msgHash: Hex) {
    return this.request<RPCMessage, [Hex]>({ method: 'msgboard_getMessage', params: [msgHash] })
  }

  /**
   * Fetches message categories from the board RPC.
   * @returns the list category hashes available on the board
   * @throws error responses from the RPC
   */
  async categories() {
    return this.request<Hex[], []>({ method: 'msgboard_categories', params: [] })
  }

  /**
   * Fetches all messages from the board RPC.
   * @returns the board messages, grouped by category
   * @throws error responses from the RPC
   */
  async content(filter: ContentFilter = {}) {
    return this.request<Content, [ContentFilter]>({ method: 'msgboard_content', params: [filter] })
  }

  /**
   * Fetches the status of the msgboard from the board RPC.
   * @returns the status info of the msgboard
   * @throws error responses from the RPC
   */
  async status() {
    return this.request<Status, []>({ method: 'msgboard_status', params: [] })
  }

  /**
   * Updates the difficulty factors for performing message work.
   * @param workMultiplier the work multiplier increases difficulty
   * @param workDivisor the work divisor decreases difficulty
   */
  setDifficultyFactors(workMultiplier: bigint, workDivisor: bigint) {
    this.difficultyFactors = { workMultiplier, workDivisor }
  }
  /**
   * Calculates the difficulty for a given message.
   * @param data the data bytes or string to embed in the message
   * @returns the difficulty
   */
  getDifficulty(data: Hex) {
    return difficulty(this.difficultyFactors, hexToBytes(data).length)
  }

  /**
   * Calls the provider RPC directly
   * @param method the method to call
   * @param params the parameters to pass to the method
   * @returns the response from the RPC
   */
  async request<T, U extends unknown[]>(arg: { method: string; params: U }): Promise<T> {
    this.log('%s(%o)', arg.method, arg.params)
    return this.provider.request(arg)
  }
}
