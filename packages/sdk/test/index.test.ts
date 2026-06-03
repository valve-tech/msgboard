import * as ethers from 'ethers'
import { Chain, createPublicClient, defineChain, type Hex, http, zeroHash } from 'viem'
import { pulsechainV4 } from 'viem/chains'
import { describe, expect, it } from 'vitest'
import * as msgboard from '../src/index.js'

/** enable this to run tests against a local devnet, otherwise use pulsechain testnet */
const USE_DEVNET = process.env.USE_DEVNET === 'true'

let chain = pulsechainV4 as Chain

if (USE_DEVNET) {
  chain = defineChain({
    id: 1337,
    name: 'Local Devnet',
    testnet: true,
    nativeCurrency: { name: 'Devnet', symbol: 'DEV', decimals: 18 },
    rpcUrls: {
      default: {
        http: ['http://localhost:8539'],
        webSocket: ['ws://localhost:8539'],
      },
    },
  })
} else {
  chain.rpcUrls.default.http = ['https://rpc-testnet-pulsechain.g4mm4.io']
}

const longTimeout = 10_000_000

/** progress handler callback */
function progress(this: msgboard.MsgBoardClient, stats: msgboard.WorkStats) {
  this.log('work-in-progress stats:', stats)
}

describe('msgboard', () => {
  const ethersV6Provider = new ethers.JsonRpcProvider(chain.rpcUrls.default.http[0])
  const viemProvider = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) })
  const eip1193Providers = [
    msgboard.wrapLegacySend(ethersV6Provider),
    viemProvider,
  ] as msgboard.Provider[]
  eip1193Providers.forEach((provider, i) => {
    it(
      `can submit and read messages ${i}`,
      async () => {
        const boardClient = new msgboard.MsgBoardClient(provider, { progress })
        const status = await boardClient.status()
        boardClient.log('connected to board %o: %o', chain.id, status)
        boardClient.setDifficultyFactors(BigInt(status.workMultiplier), BigInt(status.workDivisor))
        boardClient.log(
          'expect missing message: %o',
          await boardClient.getMessage(zeroHash).catch((err: any) => err.error),
        )

        // create message and do work
        const cat = 'category'
        const data = 'test'
        const encodedData = msgboard.encodeData(data)
        boardClient.log('category: %o <- %o', msgboard.categoryHash(cat), cat)
        boardClient.log('message:  %o <- %o', encodedData, data)
        const work = await boardClient.doPoW(cat, data)
        boardClient.log('final work: %o', work)

        // test RLP encoding/decoding
        const rlp = msgboard.toRLP(work.message)
        const unRlpd = msgboard.fromRLP(rlp)
        for (const [k, v] of Object.entries(unRlpd)) {
          expect(v, `field:${k}`).toEqual(work.message[k as keyof msgboard.Message])
        }

        // verify json encoding/decoding
        expect(work.message.data).toBe(encodedData)

        // submit message to board
        const hash = (await boardClient.addMessage(rlp).catch((e) => boardClient.log('unexpected error: %o', e))) as Hex
        expect(hash).toHaveLength(66)
        boardClient.log('message accepted:', hash)

        // read message from board
        let msg: msgboard.RPCMessage | undefined
        do {
          msg = await boardClient.getMessage(hash).catch(() => undefined)
          if (msg) {
            expect(msg.hash).toEqual(hash)
            expect(msg.hash).toEqual(work.message.hash)
            break;
          }
        } while(true)
        let msgFromContent: msgboard.RPCMessage | undefined
        do {
          const content = await boardClient.content() // no params = no filter
          boardClient.log('content: category_count=%o msg_count=%o', Object.keys(content).length, Object.values(content).flatMap((c) => c).length)
          msgFromContent = content[work.message.category].find(
            (m) => m.hash == work.message.hash,
          ) as msgboard.RPCMessage
          if (!msgFromContent) {
            await new Promise((resolve) => setTimeout(resolve, 1000))
          }
        } while (!msgFromContent)
        expect(msgFromContent).toEqual(msg)
        const categories = await boardClient.categories()
        expect(categories).toContain(msg.category)
      },
      longTimeout,
    )
  })

  it(
    'can perform work multiple times',
    async () => {
      const boardClient = new msgboard.MsgBoardClient(viemProvider as msgboard.Provider, { progress })
      const messageCount = 3
      for (let i = 0; i < messageCount; i++) {
        const work = await boardClient.doPoW(msgboard.categoryHash(i.toString()), msgboard.encodeData(`msg:${i}`))
        const hash = await boardClient.addMessage(msgboard.toRLP(work.message))
        boardClient.log('message accepted:', hash)
      }
    },
    longTimeout,
  )
})
