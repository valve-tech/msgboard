import { useCallback, useRef, useState } from 'react'
import * as viem from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { useBoardBroadcaster } from './useBoardBroadcaster'
import {
  AttestedElGamalDeck,
  LocalTransport,
  TEST_DOMAIN,
  makeDomain,
  type ChannelDomain,
} from '@msgboard/zk-cards-core'
import {
  Player,
  openSession,
  decisionMs,
  networkMs,
  totalMs,
  Phase,
  type Bet,
  type FlipChoices,
  type HiLoState,
  type WalletSigner,
} from '@msgboard/hilo-war'

/**
 * Drives ONE Hi-Lo War table in the browser as a two-peer ZK-masked-deck session.
 *
 * Unlike the single-house session games (useSession.ts), Hi-Lo War has no entropy beacon — the
 * randomness IS the masked-deck double shuffle. There is no house: there are two PEERS. We mirror
 * how the other session screens run an in-browser house: the human is Player A and an in-browser
 * random-strategy bot is Player B, both driven over a `LocalTransport.pair()` with one shared
 * `AttestedElGamalDeck` (exactly the test's setup).
 *
 * ASSUMPTIONS (documented):
 *  - HUMAN WALLET = ephemeral in-browser key. The hilo-war session co-signs MANY envelopes per flip
 *    (keygen, double-shuffle proofs, deal shares, bet commit/open, two channel co-signs, reveal),
 *    each via `signTypedData`/`signMessage`. Routing every one of those through the injected wallet
 *    would pop a wallet prompt dozens of times per flip and stall the tight `Promise.all` co-sign
 *    loop — unplayable. So, like useSession's ephemeral HOUSE, we use a fresh in-browser key for the
 *    human PLAYER too and keep the table playable. The injected `walletClient` (and `myAddress`) are
 *    still threaded in for gating/identity; swapping the human signer to an adapted wallet client is
 *    a one-line change (see `walletClientToSigner` in useSession.ts) once batched/eager-signing or a
 *    real two-machine transport is wired.
 *  - BOT WALLET = ephemeral in-browser key (Player B), with a RANDOM strategy.
 *  - DOMAIN: built from the deployment chainId via zk-core's `makeDomain` (EIP-712 "ZkTable"), with a
 *    PLACEHOLDER `verifyingContract` — there is no on-chain channel settle wired yet. The deployed
 *    `HouseChannel` is the real anchor for later; only this address changes when it lands. Falls back
 *    to `TEST_DOMAIN` if no chainId is supplied.
 */

/** EIP-712 verifyingContract placeholder — no on-chain ZkTable/HouseChannel settle is wired yet. */
const PLACEHOLDER_VERIFIER = '0x00000000000000000000000000000000005a6b54' as viem.Hex

export type WarStatus = 'idle' | 'opening' | 'ready' | 'playing' | 'settling' | 'settled' | 'error'

/** A snapshot of the co-signed channel state, surfaced for the live balance/pot readout. */
export type WarState = {
  nonce: bigint
  phase: number
  balanceA: bigint
  balanceB: bigint
  pot: bigint
}

/** One settled flip, surfaced for the receipt/history UI. */
export type FlipRecord = {
  /** sequence index of this flip on the table (1-based). */
  flip: number
  /** the channel nonce co-signed at flip end (timing key). */
  nonce: bigint
  /** the human's (Player A's) bet for this flip. */
  bet: Bet
  /** 'A' (you) | 'B' (house bot) | null on a tie (war carry). */
  winner: 'A' | 'B' | null
  /** true iff the flip ended by a fold (loser's card stays masked forever). */
  folded: boolean
  /** your card index 0..51 (always known). */
  myCard: number
  /** the house's card index, or null when hidden (fold) / not yet revealed. */
  opponentCard: number | null
  /** your co-signed balance delta across this flip. */
  deltaA: bigint
  /** running co-signed balances after this flip. */
  balanceA: bigint
  balanceB: bigint
  /** carried war pot after this flip (non-zero only on ties). */
  pot: bigint
  /**
   * per-flip wall-clock timing from Player A's non-signed `.timing` metadata (keyed by nonce).
   * In this in-process driver the marks fire ~µs apart, so deltas are often 0. Any sub-span may be
   * undefined.
   */
  timing?: { decisionMs?: number; networkMs?: number; totalMs?: number }
}

export type WarSessionApi = {
  status: WarStatus
  error?: string
  /** true once genesis is co-signed and the table is ready to flip. */
  ready: boolean
  /** live co-signed channel state; undefined before the table opens. */
  state?: WarState
  /** the genesis deck commitment — the provably-fair anchor for this table. */
  deckCommitment?: viem.Hex
  /** the escrow each side posted (conservation: balanceA + balanceB + pot === 2 * escrowEach). */
  escrowEach: bigint
  /** flips played this table, newest last. */
  history: FlipRecord[]
  /** open a fresh table: build the peer pair + shuffled-deck genesis. */
  start: () => Promise<void>
  /** play one flip; the human supplies choices, the bot chooses randomly. */
  playFlip: (choices: FlipChoices) => Promise<FlipRecord | undefined>
  /** cooperatively settle the table (splits any war carry, zeroes the pot). */
  settle: () => Promise<void>
}

export type UseWarSessionConfig = {
  /** the chain whose id pins the EIP-712 domain; falls back to TEST_DOMAIN if absent. */
  chainId?: number
  /** EIP-712 verifyingContract; defaults to a placeholder (no on-chain settle yet). */
  verifyingContract?: viem.Hex
  /** ante per flip (wei). */
  ante?: bigint
  /** escrow each peer posts into the channel (wei). */
  escrowEach?: bigint
  /** MsgBoard RPC for the live lobby feed — when set, opening a table posts an `open` notice (PoW in
   *  a Web Worker, never the UI thread). */
  boardRpc?: string
}

/** the bot picks each choice uniformly from crypto randomness (NOT Math.random). */
const randUint = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 0x1_0000_0000
const coin = (): boolean => randUint() < 0.5
/** Player B's random strategy: random bet (HOLD/RAISE) and random fold response (CALL/FOLD). */
const botChoices = (): FlipChoices => ({
  bet: coin() ? 'RAISE' : 'HOLD',
  onRaise: coin() ? 'CALL' : 'FOLD',
})

const snapshot = (s: {
  nonce: bigint
  phase: number
  balanceA: bigint
  balanceB: bigint
  pot: bigint
}): WarState => ({ nonce: s.nonce, phase: s.phase, balanceA: s.balanceA, balanceB: s.balanceB, pot: s.pot })

/**
 * The Hi-Lo War table hook. Human = Player A, in-browser random bot = Player B. A screen renders the
 * per-flip controls (bet + onRaise) and calls `playFlip(choices)`; the bot's choices are internal.
 */
export const useWarSession = (config: UseWarSessionConfig = {}): WarSessionApi => {
  const {
    chainId,
    verifyingContract = PLACEHOLDER_VERIFIER,
    ante = viem.parseEther('0.01'),
    escrowEach = viem.parseEther('1'),
    boardRpc,
  } = config
  const broadcastLobby = useBoardBroadcaster({ boardRpc, chainId: chainId ?? 0 })

  const [status, setStatus] = useState<WarStatus>('idle')
  const [error, setError] = useState<string>()
  const [state, setState] = useState<WarState>()
  const [deckCommitment, setDeckCommitment] = useState<viem.Hex>()
  const [history, setHistory] = useState<FlipRecord[]>([])

  // live engine objects are mutable session state, not render state — keep them in refs.
  const playerARef = useRef<Player>()
  const playerBRef = useRef<Player>()
  const flipSeq = useRef(0)
  const busy = useRef(false)

  const domain: ChannelDomain = chainId !== undefined ? makeDomain(chainId, verifyingContract) : TEST_DOMAIN

  const start = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    setStatus('opening')
    setError(undefined)
    try {
      const [ta, tb] = LocalTransport.pair()
      // one shared deck instance backs both peers (mirrors the test).
      const deck = new AttestedElGamalDeck()
      // ephemeral keys: human player (A) AND house bot (B) — see ASSUMPTIONS above.
      const wa = privateKeyToAccount(generatePrivateKey()) as unknown as WalletSigner
      const wb = privateKeyToAccount(generatePrivateKey()) as unknown as WalletSigner
      const tableId = viem.keccak256(viem.stringToHex(`hilo:${Date.now()}:${wa.address}`))

      const a = new Player({ role: 'A', wallet: wa, peer: wb.address, transport: ta, deck, domain, tableId, ante, escrowEach })
      const b = new Player({ role: 'B', wallet: wb, peer: wa.address, transport: tb, deck, domain, tableId, ante, escrowEach })

      await openSession(a, b)

      playerARef.current = a
      playerBRef.current = b
      flipSeq.current = 0
      const genesis = a.channel.latest!.state
      setDeckCommitment(genesis.deckCommitment)
      setState(snapshot(genesis))
      setHistory([])
      setStatus('ready')
      // announce the table on the shared live feed (PoW in a Web Worker — never the UI thread).
      broadcastLobby({ kind: 'open', game: 'hilo', tableId, deck: genesis.deckCommitment, escrowEach: viem.formatEther(escrowEach) })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    } finally {
      busy.current = false
    }
  }, [domain, ante, escrowEach])

  const playFlip = useCallback(
    async (choices: FlipChoices): Promise<FlipRecord | undefined> => {
      const a = playerARef.current
      const b = playerBRef.current
      if (!a || !b) {
        setError('open a table first')
        return undefined
      }
      if (busy.current) return undefined
      busy.current = true
      setStatus('playing')
      setError(undefined)
      try {
        const balABefore = a.channel.latest!.state.balanceA
        // BOTH peers must call playFlip simultaneously — human choices for A, random for the bot B.
        const [ra] = await Promise.all([a.playFlip(choices), b.playFlip(botChoices())])

        const after = a.channel.latest!.state
        const f: HiLoState = ra.flip
        const winner = f.result ? f.result.winner : null
        const nonce = after.nonce
        const t = a.timing.get(nonce)
        const timing = t
          ? { decisionMs: decisionMs(t), networkMs: networkMs(t), totalMs: totalMs(t) }
          : undefined

        flipSeq.current += 1
        const record: FlipRecord = {
          flip: flipSeq.current,
          nonce,
          bet: choices.bet,
          winner,
          folded: f.foldedCardHidden,
          myCard: ra.myCard,
          opponentCard: ra.opponentCard,
          deltaA: after.balanceA - balABefore,
          balanceA: after.balanceA,
          balanceB: after.balanceB,
          pot: after.pot,
          timing,
        }
        setHistory((h) => [...h, record])
        setState(snapshot(after))
        setStatus('ready')
        return record
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
        return undefined
      } finally {
        busy.current = false
      }
    },
    [],
  )

  const settle = useCallback(async () => {
    const a = playerARef.current
    const b = playerBRef.current
    if (!a || !b) {
      setError('open a table first')
      return
    }
    if (busy.current) return
    busy.current = true
    setStatus('settling')
    setError(undefined)
    try {
      // role-agnostic: A requests, B accepts; drive both with Promise.all (mirrors the test).
      const [settled] = await Promise.all([a.requestSettle(), b.acceptSettle()])
      setState(snapshot(settled.state))
      setStatus('settled')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    } finally {
      busy.current = false
    }
  }, [])

  return {
    status,
    error,
    ready: status === 'ready' || status === 'playing',
    state,
    deckCommitment,
    escrowEach,
    history,
    start,
    playFlip,
    settle,
  }
}

export { Phase }
