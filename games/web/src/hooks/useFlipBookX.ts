import { useCallback, useEffect, useRef, useState } from 'react'
import * as viem from 'viem'
import { WsBoardTransport, MsgBoardClient, toWsUrl } from '@msgboard/games'
import { publicClientFor } from '../wallet'
import type { GameDeployment } from '../config'
import { flipBookXAbi, xOfferId, FLIPX_CATEGORY, type XOffer } from '../lib/flipBookXContract'

const MAX_RANGE = 10_000n

/** A live signed offer read off the msgboard (funds move only if someone takes it). */
export type BoardOffer = { offer: XOffer; id: viem.Hex; makerSig: viem.Hex }

/** One in-flight or settled flip, folded from FlipBookX events. */
export type XFlip = {
  offerId: viem.Hex
  maker: viem.Hex
  taker: viem.Hex
  stake: bigint
  guessCommit: viem.Hex
  status: 'taken' | 'choiceRevealed' | 'settled' | 'makerDefaulted' | 'takerDefaulted'
  choiceRevealBy: number
  guessRevealBy?: number
  choice?: boolean
  winner?: viem.Hex
  pot?: bigint
}

export type FlipBookXData = {
  /** Standing signed offers on the board (WS-fed: refreshed on every pushed chain head). */
  boardOffers: BoardOffer[]
  /** WS connection state — the live proof the socket pathway is carrying the book. */
  wsHeads: number
  flips: XFlip[]
  chainNow: number
  loading: boolean
  error?: string
  refresh: () => void
}

type RawEvent = { eventName: string; args: Record<string, unknown> }

const foldFlips = (events: RawEvent[]): XFlip[] => {
  const byId = new Map<string, XFlip>()
  for (const e of events) {
    const id = e.args.offerId as viem.Hex | undefined
    if (!id) continue
    if (e.eventName === 'Taken') {
      byId.set(id, {
        offerId: id,
        maker: e.args.maker as viem.Hex,
        taker: e.args.taker as viem.Hex,
        stake: e.args.stake as bigint,
        guessCommit: e.args.guessCommit as viem.Hex,
        status: 'taken',
        choiceRevealBy: Number(e.args.choiceRevealBy as bigint),
      })
      continue
    }
    const f = byId.get(id)
    if (!f) continue
    if (e.eventName === 'ChoiceRevealed') {
      f.status = 'choiceRevealed'
      f.choice = e.args.choice as boolean
      f.guessRevealBy = Number(e.args.guessRevealBy as bigint)
    } else if (e.eventName === 'Settled') {
      f.status = 'settled'
      f.winner = e.args.winner as viem.Hex
      f.pot = e.args.pot as bigint
    } else if (e.eventName === 'MakerDefaulted') {
      f.status = 'makerDefaulted'
      f.winner = e.args.taker as viem.Hex
      f.pot = e.args.amount as bigint
    } else if (e.eventName === 'TakerDefaulted') {
      f.status = 'takerDefaulted'
      f.winner = e.args.maker as viem.Hex
      f.pot = e.args.amount as bigint
    }
  }
  return [...byId.values()].reverse()
}

/**
 * The variant-B book: standing offers live on MSGBOARD (read over a WebSocket whose newHeads
 * pushes are the refresh clock — no HTTP polling), flips live on-chain (incremental event scan).
 * Offers whose maker authorization is already burned (taken/cancelled) are filtered out.
 */
export const useFlipBookX = (deployment: GameDeployment | null): FlipBookXData => {
  const [data, setData] = useState<Omit<FlipBookXData, 'refresh'>>({
    boardOffers: [],
    wsHeads: 0,
    flips: [],
    chainNow: Math.floor(Date.now() / 1000),
    loading: false,
  })
  const busy = useRef(false)
  const acc = useRef<{ chainId: number; events: RawEvent[]; lastBlock: bigint } | null>(null)
  const ws = useRef<{ transport: WsBoardTransport; board: MsgBoardClient } | null>(null)

  const load = useCallback(async () => {
    if (!deployment?.flipBookX || busy.current) return
    const { flipBookX, x402Pls } = deployment
    busy.current = true
    setData((d) => ({ ...d, loading: true }))
    try {
      const client = publicClientFor(deployment.chainId, deployment.rpc)
      const headBlock = await client.getBlock({ blockTag: 'latest' })
      if (!acc.current || acc.current.chainId !== deployment.chainId) {
        acc.current = {
          chainId: deployment.chainId,
          events: [],
          lastBlock: BigInt(deployment.flipBookXDeployBlock ?? deployment.deployBlock) - 1n,
        }
      }
      for (let lo = acc.current.lastBlock + 1n; lo <= headBlock.number; lo += MAX_RANGE) {
        const hi = lo + MAX_RANGE - 1n < headBlock.number ? lo + MAX_RANGE - 1n : headBlock.number
        const logs = await client.getContractEvents({ address: flipBookX, abi: flipBookXAbi, fromBlock: lo, toBlock: hi, strict: true })
        for (const l of logs) acc.current.events.push({ eventName: l.eventName, args: l.args as Record<string, unknown> })
      }
      acc.current.lastBlock = headBlock.number

      // The board's standing offers — over the SAME websocket the head pushes ride.
      let boardOffers: BoardOffer[] = []
      if (ws.current) {
        const content = (await ws.current.board.content({ category: FLIPX_CATEGORY })) as unknown as Record<string, Array<{ data: viem.Hex }>>
        const now = BigInt(Math.floor(Date.now() / 1000))
        const seen = new Map<string, BoardOffer>()
        for (const messages of Object.values(content ?? {})) {
          for (const { data: raw } of messages ?? []) {
            try {
              const n = JSON.parse(viem.hexToString(raw)) as { t?: string; makerSig?: viem.Hex; offer?: Record<string, string | number> }
              if (n.t !== 'offerx' || !n.offer || !n.makerSig) continue
              const o = n.offer as Record<string, string>
              const offer: XOffer = {
                maker: o.maker as viem.Hex,
                commit: o.commit as viem.Hex,
                stake: BigInt(o.stake!),
                makerBond: BigInt(o.makerBond!),
                takerBond: BigInt(o.takerBond!),
                takeDeadline: BigInt(o.takeDeadline!),
                makerRevealWindow: Number(o.makerRevealWindow),
                takerRevealWindow: Number(o.takerRevealWindow),
              }
              if (offer.takeDeadline <= now) continue
              const id = xOfferId(deployment.chainId, flipBookX, offer)
              if (!seen.has(id)) seen.set(id, { offer, id, makerSig: n.makerSig })
            } catch {
              /* not an offer notice */
            }
          }
        }
        const live: BoardOffer[] = []
        for (const o of seen.values()) {
          const used = (await client.readContract({
            address: x402Pls!,
            abi: viem.parseAbi(['function authorizationState(address, bytes32) view returns (bool)']),
            functionName: 'authorizationState',
            args: [o.offer.maker, o.id],
          }).catch(() => true)) as boolean
          if (!used) live.push(o)
        }
        boardOffers = live
      }

      setData((d) => ({
        ...d,
        boardOffers,
        flips: foldFlips(acc.current!.events),
        chainNow: Number(headBlock.timestamp),
        loading: false,
        error: undefined,
      }))
    } catch (error) {
      setData((d) => ({ ...d, loading: false, error: error instanceof Error ? error.message : String(error) }))
    } finally {
      busy.current = false
    }
  }, [deployment])

  // WS lifecycle: one socket per (chain) — newHeads pushes trigger loads (debounced by `busy`).
  useEffect(() => {
    if (!deployment?.flipBookX || !deployment.boardRpc) return
    const transport = new WsBoardTransport(toWsUrl(deployment.boardRpc))
    const board = new MsgBoardClient(transport)
    ws.current = { transport, board }
    void transport.subscribeNewHeads(() => {
      setData((d) => ({ ...d, wsHeads: d.wsHeads + 1 }))
      void load()
    })
    void load()
    return () => {
      transport.close()
      ws.current = null
    }
  }, [deployment, load])

  return { ...data, refresh: () => void load() }
}
