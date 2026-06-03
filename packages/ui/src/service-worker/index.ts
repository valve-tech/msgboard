/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import * as msgboard from '@msgboard/sdk'
import type { StartWorkReq, WorkerRequestMsg, WorkerResponseMsg } from './types'
export type * from './types'
import { createPublicClient, http, type PublicClient } from 'viem'
import { pulsechainV4 } from 'viem/chains'

const sw = self as unknown as ServiceWorkerGlobalScope

let boardClient!: msgboard.MsgBoardClient
let provider!: PublicClient

sw.addEventListener('message', (e) => {
  const { data: msg, srcElement: source }: { data: WorkerRequestMsg; srcElement: any } = e
  switch (msg.type) {
    case 'cancel':
      boardClient?.cancel()
      break
    case 'work':
      doWork(source, msg)
      break
    default:
      console.log('unknown message:', msg)
      break
  }
})

const doWork = async (source: Client, data: StartWorkReq) => {
  const postMessage = (msg: WorkerResponseMsg) => source.postMessage(msg)
  provider = createPublicClient({ chain: pulsechainV4, transport: http(data.rpc) })
  boardClient = new msgboard.MsgBoardClient(provider as msgboard.Provider, {
    difficultyFactors: {
      workMultiplier: BigInt(data.workMultiplier),
      workDivisor: BigInt(data.workDivisor),
    },
    breakInterval: 10_000n, // break every 10k iterations
    logger: (format, method: string, ...params: any[]) => {
      if (
        typeof method !== 'string' ||
        (!method.startsWith('eth_') && !method.startsWith('msgboard_'))
      ) {
        return
      }
      postMessage({ type: 'log', message: method })
    },
    progress: (stats) => postMessage({ type: 'progress', stats }),
  })
  setTimeout(async () => {
    try {
      const result = await boardClient.doPoW(data.category, data.data)
      if (!result.stats.isValid) {
        postMessage({ type: 'error', message: 'Failed to find valid message' })
        return
      }
      postMessage({ type: 'complete', result })
    } catch (e) {
      postMessage({ type: 'error', message: e instanceof Error ? e.message : 'Unknown error during PoW' })
    }
  })
}
