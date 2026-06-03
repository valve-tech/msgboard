import type { Hex } from 'viem'

/** MessageSeed is the minimum set of inputs required for encoding and submitting a message to the board RPC. */
export type MessageSeed = {
  /** The message/encoding version. */
  version: number
  /** The hash of the block the message is rooted to. */
  blockHash: Hex
  /** The 32-byte category hash. */
  category: Hex
  /** The arbitrary message data. */
  data: Hex
  /** The message nonce, discovered through PoW. */
  nonce: bigint
  /** Factor to increase the required message work (set by RPC). */
  workMultiplier: bigint
  /** Factor to decrease the required message work (set by RPC). */
  workDivisor: bigint
}

/** The full message object, with numerical values. */
export type Message = MessageSeed & {
  /** The number of the block the message is rooted to. */
  blockNumber: bigint
  /** The message hash. */
  hash: Hex
}

/** Stats about the message work process. */
export type WorkStats = {
  /** The number of nonces that were attempted before a valid message was found. */
  iterations: bigint
  /** The message difficulty, based on the message size and the configured difficulty factors. */
  difficulty: bigint
  /** The duration of the message work process in milliseconds. */
  duration: number
  /** True if the message is valid, false if not yet valid. */
  isValid: boolean
}

/** Result from the pow calculation. */
export type WorkResult = {
  /** The resulting message object. */
  message: Message
  /** Stats about the message work performed. */
  stats: WorkStats
}

// ==================== RPC Response Types ====================

/** Message is the hex-encoded message type returned from the board RPC. */
export type RPCMessage = { [K in keyof Message]: Hex }

/** Categories is the type returned from the msgboard_categories RPC. */
export type Categories = Hex[]

/** Content filter can be used to filter board content responses from the RPC. */
export type ContentFilter = { category?: Hex; fromBlock?: bigint; toBlock?: bigint }

/** Content is the type returned from the msgboard_content RPC. */
export type Content = { [categoryHash: Hex]: RPCMessage[] }

/** Status is the type returned from the msgboard_status RPC. */
export type Status = {
  enabled: boolean
  /** Overall size of messages stored on the board. */
  size: Hex
  /** Overall count of messages stored on the board. */
  count: Hex
  /** The board's configured workMultiplier, required for valid messages. */
  workMultiplier: Hex
  /** The board's configured workDivisor, required for valid messages. */
  workDivisor: Hex
}

// ==================== Lib Types ====================

/** The bare minimum provider interface required by the MsgBoardClient. */
export type Provider = {
  request<T, U extends unknown[]>(arg: { method: string; params: U }): Promise<T>
}

/** The bare minimum legacy provider interface required by the MsgBoardClient. */
export type LegacyProvider = {
  send(method: string, params?: unknown[] | Record<string, any>): Promise<unknown>
}

/** The logger type used by the MsgBoardClient. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Logger = (formatter: any, ...args: any[]) => void

/** DifficultyFactors are the modifiers for the message work, as required by the board RPC. */
export type DifficultyFactors = {
  workMultiplier: bigint
  workDivisor: bigint
}

/** MsgBoardClient config. */
export type Config = {
  /** The difficulty factors for the msgboard (default: 10_000 / 1_000_000). */
  difficultyFactors?: DifficultyFactors
  /** An optional logger (default: DEBUG logger). */
  logger?: Logger
  /** The number of POW iterations between progress and block updates (default: 10s). */
  breakInterval?: bigint
  /** Progress handler function called periodically when performing message work (default: none). */
  progress?: (stats: WorkStats) => void
}
