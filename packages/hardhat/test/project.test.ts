import { describe, it, beforeEach, expect } from 'vitest'
import type { Hex } from 'viem'
import type { Status, WorkResult } from '@msgboard/sdk'
import { isHex, keccak256, toHex } from 'viem'
import * as msgboard from '@msgboard/sdk'
import hre from 'hardhat'
import * as helpers from '@nomicfoundation/hardhat-network-helpers'

// required for hre to find the type extensions

import '../src/type-extensions'
const {
  MsgBoardProvider,
  setNodeConstraints,
}: {
  MsgBoardProvider: {
    defaultSettings: () => {
      enabled: boolean
      workMultiplier: bigint
      workDivisor: bigint
    }
  }
  setNodeConstraints: (constraints: { workMultiplier: bigint; workDivisor: bigint }) => void
} = require('../dist/provider')

describe('Integration tests msgboard', () => {
  describe('Hardhat Runtime Environment extension', () => {
    it('Should add the msgboard field', () => {
      expect(hre.msgboard).toBeTypeOf('object')
      expect(!!hre.msgboard).toEqual(true)
    })
  })
  describe('msgboard:status', () => {
    const defaults = MsgBoardProvider.defaultSettings()
    const checkStatus = (status: Status, comparison = defaults) => {
      const extended = { ...defaults, ...comparison }
      expect(status.enabled).toEqual(true)
      expect(BigInt(status.workMultiplier)).toEqual(extended.workMultiplier)
      expect(BigInt(status.workDivisor)).toEqual(extended.workDivisor)
      expect(BigInt(status.count)).toEqual(0n)
      expect(BigInt(status.size)).toEqual(0n)
    }
    it('should return the status of the msgboard', async () => {
      checkStatus(await hre.msgboard.status())
    })
    it('works as a task', async () => {
      checkStatus(await hre.run({
        scope: 'msgboard',
        task: 'status',
      }, { log: false }))
    })
  })
  describe('work', () => {
    beforeEach(async () => {
      const workMultiplier = 10n
      const workDivisor = 1_000_000n
      await hre.run({
        scope: 'msgboard',
        task: 'reset',
      })
      hre.msgboard.setDifficultyFactors(workMultiplier, workDivisor)
      setNodeConstraints({
        workMultiplier,
        workDivisor,
      })
    })
    describe('msgboard:work', () => {
      it('should return valid work', async () => {
        const work = await hre.msgboard.grind('test123', 'test123')
        expect(work.stats.difficulty).toBeGreaterThan(0n)
        expect(work.stats.iterations).toBeGreaterThan(0n)
      })
      it('works as a task', async () => {
        hre.msgboard.setDifficultyFactors(1n, 1_000_000n)
        const work = await hre.run({
          scope: 'msgboard',
          task: 'work',
        }, {
          category: 'test123',
          data: 'test123',
        })
        expect(work.stats.difficulty).toBeGreaterThan(0n)
        expect(work.stats.iterations).toBeGreaterThan(0n)
        expect(work.message.data).toEqual(toHex('test123'))
        expect(work.message.category).toEqual(keccak256(toHex('test123')))
      })
    })
    describe('msgboard:send', () => {
      it('should send a message', async () => {
        const work = (await hre.run({
          scope: 'msgboard',
          task: 'work',
        }, {
          category: 'test123',
          data: 'test123',
        })) as WorkResult
        setNodeConstraints({
          workMultiplier: 10n,
          workDivisor: 1_000_000n,
        })
        const message = await hre.run({
          scope: 'msgboard',
          task: 'send',
        }, {
          rlp: msgboard.toRLP(work.message),
        })
        expect(isHex(message, { strict: true })).toEqual(true)
      })
    })
    describe('msgboard:send-decoded', () => {
      it('should send a message', async () => {
        const work = await hre.msgboard.grind('test123', 'test123')
        const message = await hre.run({
          scope: 'msgboard',
          task: 'send-decoded',
        }, {
          message: JSON.stringify(msgboard.toRPCMessage(work.message)),
        })
        const difficulty = hre.msgboard.getDifficulty(work.message.data)
        expect(message).toEqual(msgboard.checkWork(work.message, difficulty))
      })
    })
    describe('msgboard:work:send', () => {
      it('process inputs and send a message to the msgboard', async () => {
        const message = await hre.run({
          scope: 'msgboard',
          task: 'work:send',
        }, {
          category: 'test123',
          data: 'test123',
        })
        // by the time this hits, a new block should not have been mined
        const work = await hre.msgboard.grind('test123', 'test123')
        const difficulty = hre.msgboard.getDifficulty(work.message.data)
        expect(message).toEqual(msgboard.checkWork(work.message, difficulty))
      })
    })
    describe('msgboard:get-message', () => {
      it('should get a message', async () => {
        const msgFromWork = (await hre.run({
          scope: 'msgboard',
          task: 'work:send',
        }, {
          category: 'test123',
          data: 'test123',
        })) as Hex
        const msgFromGet = await hre.msgboard.getMessage(msgFromWork)
        expect(msgFromGet.hash).toEqual(msgFromWork)
      })
      it('works as a task', async () => {
        const msgFromWork = (await hre.run({
          scope: 'msgboard',
          task: 'work:send',
        }, {
          category: 'test123',
          data: 'test123',
        })) as Hex
        const msgFromGet = (await hre.run({
          scope: 'msgboard',
          task: 'get-message',
        }, {
          hash: msgFromWork,
        })) as msgboard.Message
        expect(msgFromGet.hash).toEqual(msgFromWork)
      })
    })
    describe('msgboard:content', () => {
      it('should get the content of the msgboard', async () => {
        const content = await hre.msgboard.content()
        expect(content).toEqual({})
        const msgFromWork = (await hre.run({
          scope: 'msgboard',
          task: 'work:send',
        }, {
          category: 'test123',
          data: 'test123',
        })) as Hex
        const msg = await hre.msgboard.getMessage(msgFromWork)
        const contentAfter = await hre.msgboard.content()
        expect(contentAfter).toEqual({
          [msg.category]: [msg],
        })
      })
      it('works as a task', async () => {
        const content = await hre.run({
          scope: 'msgboard',
          task: 'content',
        }, {
        })
        expect(content).toEqual({})
        const msgFromWork = (await hre.run({
          scope: 'msgboard',
          task: 'work:send',
        }, {
          category: 'test123',
          data: 'test123',
        })) as Hex
        const msg = (await hre.run({
          scope: 'msgboard',
          task: 'get-message',
        }, {
          hash: msgFromWork,
        })) as msgboard.Message
        const contentAfter = await hre.run({
          scope: 'msgboard',
          task: 'content',
        }, {
        })
        expect(contentAfter).toEqual({
          [msg.category]: [msg],
        })
      })
      it('can filter by category or block number or any combination', async () => {
        const msgFromWorkHash1 = (await hre.run({
          scope: 'msgboard',
          task: 'work:send',
        }, {
          category: 'test123',
          data: 'test123',
        })) as Hex
        await helpers.mine(1)
        const msgFromWorkHash2 = (await hre.run({
          scope: 'msgboard',
          task: 'work:send',
        }, {
          category: 'test123',
          data: 'test1234',
        })) as Hex
        const msgFromWorkHash3 = (await hre.run({
          scope: 'msgboard',
          task: 'work:send',
        }, {
          category: 'test1234',
          data: 'test1234',
        })) as Hex
        const msgFromWork1 = await hre.msgboard.getMessage(msgFromWorkHash1)
        const msgFromWork2 = await hre.msgboard.getMessage(msgFromWorkHash2)
        const msgFromWork3 = await hre.msgboard.getMessage(msgFromWorkHash3)
        const contentNoFilter = await hre.run({
          scope: 'msgboard',
          task: 'content',
        }, {
        })
        expect(contentNoFilter).toEqual({
          [msgFromWork2.category]: [msgFromWork1, msgFromWork2],
          [msgFromWork3.category]: [msgFromWork3],
        })
        const contentCategoryFilter = await hre.run({
          scope: 'msgboard',
          task: 'content',
        }, {
          category: msgFromWork1.category,
        })
        expect(contentCategoryFilter).toEqual({
          [msgFromWork2.category]: [msgFromWork1, msgFromWork2],
        })
        // filter by lower bound
        const contentLowerBoundFilter = await hre.run({
          scope: 'msgboard',
          task: 'content',
        }, {
          fromBlock: BigInt(msgFromWork2.blockNumber),
        })
        expect(contentLowerBoundFilter).toEqual({
          [msgFromWork2.category]: [msgFromWork2],
          [msgFromWork3.category]: [msgFromWork3],
        })
        // filter by upper bound
        const contentUpperBoundFilter = await hre.run({
          scope: 'msgboard',
          task: 'content',
        }, {
          toBlock: BigInt(msgFromWork1.blockNumber),
        })
        expect(contentUpperBoundFilter).toEqual({
          [msgFromWork1.category]: [msgFromWork1],
        })
        await helpers.mine(1)
        const msgFromWorkHash4 = (await hre.run({
          scope: 'msgboard',
          task: 'work:send',
        }, {
          category: 'test123',
          data: 'test1235',
        })) as Hex
        const msgFromWork4 = await hre.msgboard.getMessage(msgFromWorkHash4)
        // show that the new message is included
        const contentNoFilterAfter = await hre.run({
          scope: 'msgboard',
          task: 'content',
        }, {
        })
        expect(contentNoFilterAfter).toEqual({
          [msgFromWork2.category]: [msgFromWork1, msgFromWork2, msgFromWork4],
          [msgFromWork3.category]: [msgFromWork3],
        })
        // use both block filters at the same time
        const contentDualBoundFilter = await hre.run({
          scope: 'msgboard',
          task: 'content',
        }, {
          fromBlock: BigInt(msgFromWork2.blockNumber),
          toBlock: BigInt(msgFromWork2.blockNumber),
        })
        expect(contentDualBoundFilter).toEqual({
          [msgFromWork2.category]: [msgFromWork2],
          [msgFromWork3.category]: [msgFromWork3],
        })
        // use all 3 filters at once
        const contentFullFilter = await hre.run({
          scope: 'msgboard',
          task: 'content',
        }, {
          fromBlock: BigInt(msgFromWork2.blockNumber),
          toBlock: BigInt(msgFromWork2.blockNumber),
          category: msgFromWork2.category,
        })
        expect(contentFullFilter).toEqual({
          [msgFromWork2.category]: [msgFromWork2],
        })
      })
    })
    describe('msgboard:categories', () => {
      it('should get the categories', async () => {
        const categories = await hre.msgboard.categories()
        expect(categories).toEqual([])
        const msgFromWork = (await hre.run({
          scope: 'msgboard',
          task: 'work:send',
        }, {
          category: 'test123',
          data: 'test123',
        })) as Hex
        const msg = await hre.msgboard.getMessage(msgFromWork)
        const categoriesAfter = await hre.msgboard.categories()
        expect(categoriesAfter).toEqual([msg.category])
      })
      it('works as a task', async () => {
        const categories = await hre.run({
          scope: 'msgboard',
          task: 'categories',
        }, {
        })
        expect(categories).toEqual([])
        const msgFromWork = (await hre.run({
          scope: 'msgboard',
          task: 'work:send',
        }, {
          category: 'test123',
          data: 'test123',
        })) as Hex
        const msg = await hre.msgboard.getMessage(msgFromWork)
        const categoriesAfter = await hre.run({
          scope: 'msgboard',
          task: 'categories',
        }, {
        })
        expect(categoriesAfter).toEqual([msg.category])
      })
    })
    describe('msgboard:get-difficulty', () => {
      it('should get the difficulty', async () => {
        const difficulty = hre.msgboard.getDifficulty('0x')
        expect(difficulty).toEqual(167n)
      })
      it('works as a task', async () => {
        const difficulty = await hre.run({
          scope: 'msgboard',
          task: 'get-difficulty',
        }, {
          size: 0,
        })
        expect(difficulty).toEqual(167n)
      })
      it('data can be passed in directly', async () => {
        const difficulty = await hre.run({
          scope: 'msgboard',
          task: 'get-difficulty',
        }, {
          data: '0x',
        })
        expect(difficulty).toEqual(167n)
      })
    })
  })
})
