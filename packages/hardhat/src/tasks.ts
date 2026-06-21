import { scope } from 'hardhat/config'
import { type Hex, isHex, keccak256, stringToBytes, toHex } from 'viem'

import * as msgboard from '@msgboard/sdk'
import * as argumentTypes from 'hardhat/internal/core/params/argumentTypes'

type BoardOptional = { board?: msgboard.MsgBoardClient }
type LogOptional = { log?: boolean }
type BoardAndLogOptional = BoardOptional & LogOptional

const options = {
  // params
  category: ['category', 'the category of the work', '', argumentTypes.string],
  data: ['data', 'the data of the work', '', argumentTypes.string],
  rlp: ['rlp', 'the rlp of the message', '', argumentTypes.string],
  messageJson: ['message', 'the decoded message to send', 'null', argumentTypes.string],
  hash: ['hash', 'the hash of the message', '', argumentTypes.string],
  // optional params
  board: ['board', 'the board to use (programmatic only - no CLI)', null, argumentTypes.any],
  message: ['message', 'the decoded message to send', null, argumentTypes.any],
  fromBlock: ['fromBlock', 'the block number to start from', null, argumentTypes.bigint],
  toBlock: ['toBlock', 'the block number to end at', null, argumentTypes.bigint],
  size: ['size', 'the number of bytes to calculate the difficulty for', 0, argumentTypes.int],
  workMultiplier: ['workMultiplier', 'the work multiplier', 0n, argumentTypes.bigint],
  workDivisor: ['workDivisor', 'the work divisor', 0n, argumentTypes.bigint],
  // flags
  log: ['log', 'log the status'],
} as const
const descriptions = {
  status: 'Gets the status of the msgboard',
  work: 'Produce a proof of work for a given category and data',
  send: 'Send an RLP encoded message to the msgboard',
  sendDecoded: 'Send a decoded message to the msgboard',
  workSend: 'Produce and send a proof of work to the msgboard',
  getMessage: 'Get a message from the msgboard',
  reset: 'Reset the msgboard',
  categories: 'Get the categories of the msgboard',
  content: 'Get the content of the msgboard',
  getDifficulty: 'Calculate the difficulty for a given number of bytes',
} as const
const taskNames = {
  status: 'status',
  work: 'work',
  send: 'send',
  sendDecoded: 'send-decoded',
  workSend: 'work:send',
  getMessage: 'get-message',
  reset: 'reset',
  categories: 'categories',
  content: 'content',
  getDifficulty: 'get-difficulty',
} as const

const globalTaskName = (taskName: string) => `${scopeKey}:${taskName}`

const scopeKey = 'msgboard'

const scoped = scope(scopeKey, 'A scope for msgboard tasks')

const omitNull = (obj: Record<string, any>) => Object.fromEntries(Object.entries(obj).filter(([_, v]) => v !== null && v !== undefined))

scoped.subtask<BoardAndLogOptional>(globalTaskName(taskNames.status))
  .setDescription(descriptions.status)
  .addOptionalParam(...options.board)
  .addFlag(...options.log)
  .setAction(async (taskArgs, hre) => {
    const board = (taskArgs.board ?? hre.msgboard) as msgboard.MsgBoardClient
    const status = await board.status()
    if (taskArgs.log) {
      board.log('status: %o', {
        enabled: status.enabled,
        workMultiplier: BigInt(status.workMultiplier),
        workDivisor: BigInt(status.workDivisor),
        count: BigInt(status.count),
        size: BigInt(status.size),
      })
    }
    return status
  })
scoped.task<LogOptional>(taskNames.status)
  .setDescription(descriptions.status)
  .addFlag(...options.log)
  .setAction(async (taskArgs, hre) => {
    return hre.run({
      scope: scopeKey,
      task: globalTaskName(taskNames.status),
    }, omitNull(taskArgs))
  })

type WorkInputs = { category: string; data: string }
scoped.subtask<BoardAndLogOptional & WorkInputs>(globalTaskName(taskNames.work))
  .setDescription(descriptions.work)
  .addParam(...options.category)
  .addParam(...options.data)
  .addFlag(...options.log)
  .addOptionalParam(...options.board)
  .setAction(async (taskArgs, hre): Promise<msgboard.WorkResult> => {
    const { category, data, board: b, log } = taskArgs
    const d = msgboard.encodeData(data)
    const c = isHex(category) ? toHex(category, { size: 32 }) : keccak256(stringToBytes(category))
    const board = (b ?? hre.msgboard) as msgboard.MsgBoardClient
    const work = await board.grind(c, d)
    if (log) {
      board.log('work: %o', work)
    }
    return work
  })
scoped.task<LogOptional & WorkInputs>(taskNames.work)
  .setDescription(descriptions.work)
  .setAction(async (taskArgs, hre): Promise<msgboard.WorkResult> => {
    return hre.run({
      scope: scopeKey,
      task: globalTaskName(taskNames.work),
    }, omitNull(taskArgs))
  })

type EncodedSendInputs = { rlp: Hex }
scoped.subtask<BoardOptional & EncodedSendInputs>(globalTaskName(taskNames.send))
  .setDescription(descriptions.send)
  .addParam(...options.rlp)
  .addOptionalParam(...options.board)
  .setAction(async (taskArgs, hre): Promise<Hex> => {
    const { rlp, board: b } = taskArgs
    const board = (b ?? hre.msgboard) as msgboard.MsgBoardClient
    return await board.addMessage(rlp)
  })
scoped.task<EncodedSendInputs>(taskNames.send)
  .setDescription(descriptions.send)
  .setAction(async (taskArgs, hre): Promise<Hex> => {
    return hre.run({
      scope: scopeKey,
      task: globalTaskName(taskNames.send),
    }, omitNull(taskArgs))
  })

type DecodedSendInputs = { message: msgboard.Message }
scoped.subtask<BoardOptional & DecodedSendInputs>(globalTaskName(taskNames.sendDecoded))
  .setDescription(descriptions.sendDecoded)
  .addParam(...options.message)
  .addOptionalParam(...options.board)
  .setAction(async (taskArgs, hre): Promise<Hex> => {
    const { message, board: b } = taskArgs
    return await hre.run({
      scope: scopeKey,
      task: globalTaskName(taskNames.send),
    }, {
      rlp: msgboard.toRLP(message),
      board: b,
    })
  })
scoped.task<DecodedSendInputs>(taskNames.sendDecoded)
  .setDescription(descriptions.sendDecoded)
  .setAction(async (taskArgs, hre): Promise<Hex> => {
    return hre.run({
      scope: scopeKey,
      task: globalTaskName(taskNames.sendDecoded),
    }, {
      ...taskArgs,
      message: JSON.parse(taskArgs.message),
    })
  })

type WorkSendInputs = { category: string; data: string }
scoped.subtask<BoardAndLogOptional & WorkSendInputs>(globalTaskName(taskNames.workSend))
  .setDescription(descriptions.workSend)
  .addParam(...options.category)
  .addParam(...options.data)
  .addOptionalParam(...options.board)
  .addFlag(...options.log)
  .setAction(async (taskArgs, hre) => {
    const board = (taskArgs.board ?? hre.msgboard) as msgboard.MsgBoardClient
    const work = (await hre.run({
      scope: scopeKey,
      task: globalTaskName(taskNames.work),
    }, {
      ...taskArgs,
      board,
    })) as msgboard.WorkResult
    return await hre.run({
      scope: scopeKey,
      task: globalTaskName(taskNames.sendDecoded),
    }, {
      message: work.message,
      board,
    })
  })
scoped.task<LogOptional & WorkSendInputs>(taskNames.workSend)
  .setDescription(descriptions.workSend)
  .addFlag(...options.log)
  .addParam(...options.category)
  .addParam(...options.data)
  .setAction(async (taskArgs, hre) => {
    return hre.run({
      scope: scopeKey,
      task: globalTaskName(taskNames.workSend),
    }, omitNull(taskArgs))
  })

type GetMessageInputs = { hash: Hex }
scoped.subtask<BoardOptional & GetMessageInputs>(globalTaskName(taskNames.getMessage))
  .setDescription(descriptions.getMessage)
  .addParam(...options.hash)
  .addOptionalParam(...options.board)
  .setAction(async (taskArgs, hre) => {
    const { hash, board: b } = taskArgs
    const board = (b ?? hre.msgboard) as msgboard.MsgBoardClient
    return await board.getMessage(hash)
  })
scoped.task<GetMessageInputs>(taskNames.getMessage)
  .setDescription(descriptions.getMessage)
  .addParam(...options.hash)
  .setAction(async (taskArgs, hre) => {
    return hre.run({
      scope: scopeKey,
      task: globalTaskName(taskNames.getMessage),
    }, omitNull(taskArgs))
  })

scoped.task(taskNames.reset)
  .setDescription(descriptions.reset)
  .setAction(async (_taskArgs, hre) => {
    if (hre.network.name !== 'hardhat') return
    await hre.network.provider.send('msgboard_reset', [])
  })

scoped.task('categories')
  .setDescription('Get the categories of the msgboard')
  .setAction(async (_taskArgs, hre) => {
    return await hre.network.provider.send('msgboard_categories', [])
  })

type ContentInputs = { category?: string; fromBlock?: bigint; toBlock?: bigint }
scoped.subtask<BoardOptional & ContentInputs>(globalTaskName(taskNames.content))
  .setDescription(descriptions.content)
  .addOptionalParam(...options.board)
  .addOptionalParam(...options.category)
  .addOptionalParam(...options.fromBlock)
  .addOptionalParam(...options.toBlock)
  .setAction(async (taskArgs, hre) => {
    const { board: b, category, fromBlock, toBlock } = taskArgs
    const board = (b ?? hre.msgboard) as msgboard.MsgBoardClient
    return await board.content({ category, fromBlock, toBlock })
  })
scoped.task<ContentInputs>(taskNames.content)
  .setDescription(descriptions.content)
  .addOptionalParam(...options.category)
  .addOptionalParam(...options.fromBlock)
  .addOptionalParam(...options.toBlock)
  .setAction(async (taskArgs, hre) => {
    return hre.run({
      scope: scopeKey,
      task: globalTaskName(taskNames.content),
    }, omitNull(taskArgs))
  })

type GetDifficultyInputs = { data: string; size: number; workMultiplier: bigint; workDivisor: bigint }
scoped.subtask<BoardOptional & GetDifficultyInputs>(globalTaskName(taskNames.getDifficulty))
  .setDescription(descriptions.getDifficulty)
  .addOptionalParam(...options.data)
  .addOptionalParam(...options.size)
  .addOptionalParam(...options.workMultiplier)
  .addOptionalParam(...options.workDivisor)
  .addOptionalParam(...options.board)
  .setAction(async (taskArgs, hre) => {
    const { size, data, board: b, workMultiplier, workDivisor } = taskArgs
    const board = (b ?? hre.msgboard) as msgboard.MsgBoardClient
    if (workMultiplier && workDivisor) {
      board.setDifficultyFactors(workMultiplier, workDivisor)
    } else {
      const status = await board.status().catch(() => null)
      if (status) board.setDifficultyFactors(BigInt(status.workMultiplier), BigInt(status.workDivisor))
    }
    const d = data ?? `0x${new Array(size * 2).fill(0).join('')}`
    return board.getDifficulty(d)
  })
scoped.task<GetDifficultyInputs>(taskNames.getDifficulty)
  .setDescription(descriptions.getDifficulty)
  .addOptionalParam(...options.size)
  .addOptionalParam(...options.data)
  .addOptionalParam(...options.workMultiplier)
  .addOptionalParam(...options.workDivisor)
  .setAction(async (taskArgs, hre) => {
    return hre.run({
      scope: scopeKey,
      task: globalTaskName(taskNames.getDifficulty),
    }, omitNull(taskArgs))
  })
