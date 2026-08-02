import { useEffect, useMemo, useState } from 'react'
import * as viem from 'viem'
import { coinFlipTablesAbi, randomAbi } from '@msgboard/games-core'
import type { GameDeployment } from '../config'
import type { ChainData } from '../hooks/useChainData'
import { useTableEvents } from '../model/table-rounds'
import type { TableEvent } from '../lib/tablesIndex'
import { verifyRound, type OpenedLog, type SettledLog } from '../lib/tablesVerify'
import { sendGameTx, nextHeatLocations } from '../tx'
import { publicClientFor } from '../wallet'
import { TablePicker } from './TablePicker'
import { Menu } from './Menu'
import { parseStake } from './StakeInput'
import { GameStage } from './shell/GameStage'
import { HowItWorksLink } from './HowItWorks'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { AddressLink, explorerUrl, fmtAmount, InfoDot, MSGBOARD_GAMES_DOCS } from './Meta'

/** Minimal ERC20 approve — Chips has no ABI export in games-core; mirrors TablePicker's local const. */
const ERC20_APPROVE_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

const HEADS = 0
const SIDE_OPTIONS = ['Heads (even)', 'Tails (odd)'] as const
const ZERO32 = viem.padHex('0x0', { size: 32 })
// A round is refundable once its seed is missing AND STALE_BLOCKS have passed since it opened —
// GameBase.STALE_BLOCKS. We gate the Refund button on the block gap (cheap, from the poll head); the
// seed-missing half is enforced by the contract (refundStale reverts TooEarly if a seed did finalize).
const STALE_BLOCKS = 200n

/** Lift the flat CoinFlipTables events into the OpenedLog / SettledLog shapes verifyRound wants.
 *  useTableEvents already spreads every named arg onto the row, so this is a typed projection. */
const toOpened = (e: TableEvent): OpenedLog => ({
  roundId: e.roundId, tableId: e.tableId, player: e.player, side: Number(e.side),
  stake: e.stake, payout: e.payout, subsetHash: e.subsetHash, key: e.key, openedAtBlock: e.blockNumber,
})
const toSettled = (e: TableEvent): SettledLog => ({
  roundId: e.roundId, tableId: e.tableId, player: e.player, won: Boolean(e.won),
  payout: e.payout, seed: e.seed, settledAtBlock: e.blockNumber,
})

/** The verify receipt for one settled round — recomputes the winner from the seed parity purely from
 *  the RoundOpened + RoundSettled logs (verifyRound), never trusting the contract's own `won` flag. */
const TablesVerifyPanel = ({
  deployment,
  opened,
  settled,
}: {
  deployment: GameDeployment
  opened: OpenedLog
  settled: SettledLog
}) => {
  const { ok, reasons } = verifyRound(opened, settled)
  const parityWin = (BigInt(settled.seed) & 1n) === BigInt(opened.side)
  const gameUrl = deployment.coinFlipTables ? explorerUrl(deployment, 'address', deployment.coinFlipTables) : undefined
  const randomUrl = explorerUrl(deployment, 'address', deployment.random)
  return (
    <div className="receipt">
      <h3>
        The slip — run the flip yourself
        <InfoDot>
          Your browser recomputes the result from the seed's parity and compares it with what the{' '}
          {gameUrl ? (
            <a href={gameUrl} target="_blank" rel="noreferrer">table contract</a>
          ) : (
            'table contract'
          )}{' '}
          paid out. The seed is set by the{' '}
          {randomUrl ? (
            <a href={randomUrl} target="_blank" rel="noreferrer">Random contract</a>
          ) : (
            'Random contract'
          )}{' '}
          from the validators' revealed secrets. Written up{' '}
          <a href={MSGBOARD_GAMES_DOCS} target="_blank" rel="noreferrer">on MsgBoard</a>.
        </InfoDot>
      </h3>
      <table>
        <tbody>
          <tr>
            <td className="muted">seed (keccak of the validators' secrets)</td>
            <td className="mono">{settled.seed}</td>
          </tr>
          <tr>
            <td className="muted">your side</td>
            <td>{opened.side === HEADS ? 'Heads (even)' : 'Tails (odd)'}</td>
          </tr>
          <tr>
            <td className="muted">our count: seed is {(BigInt(settled.seed) & 1n) === 0n ? 'even' : 'odd'} →</td>
            <td>{parityWin ? 'you win' : 'you lose'}</td>
          </tr>
          <tr>
            <td className="muted">the chain's result</td>
            <td>
              {settled.won ? 'won' : 'lost'} · {fmtAmount(deployment, settled.payout)}
            </td>
          </tr>
        </tbody>
      </table>
      {ok ? (
        <span className="stamp ok">✓ verified — replayed from the chain logs</span>
      ) : (
        <span className="stamp bad">✗ does not match the chain — {reasons.join('; ')}</span>
      )}
    </div>
  )
}

const shortRound = (roundId: viem.Hex) => `${roundId.slice(0, 10)}…${roundId.slice(-6)}`

/** One of the player's rounds — pending (poll + settle, or refund once stale), settled (outcome +
 *  verify slip), or refunded (stale round whose stake was returned). */
const RoundCard = ({
  deployment,
  opened,
  settled,
  refunded,
  seed,
  busy,
  canSettle,
  stale,
  onSettle,
  onRefund,
}: {
  deployment: GameDeployment
  opened: OpenedLog
  settled?: SettledLog
  refunded?: boolean
  seed?: viem.Hex
  busy: boolean
  canSettle: boolean
  stale?: boolean
  onSettle: (opened: OpenedLog) => void
  onRefund?: (opened: OpenedLog) => void
}) => {
  const settledPending = seed !== undefined && seed !== ZERO32 && !settled
  const spine = settled ? (settled.won ? 'done' : 'expired') : refunded ? 'expired' : 'wait'
  return (
    <div className={`card bk-${spine}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>
          <span className="tag">{opened.side === HEADS ? 'Heads' : 'Tails'}</span>
          {fmtAmount(deployment, opened.stake)} stake · pays {fmtAmount(deployment, opened.payout)}
          {' · '}
          <span className="mono muted">{shortRound(opened.roundId)}</span>
        </span>
        <span className="row">
          {!settled && !refunded && (
            <>
              <button className="secondary" onClick={() => onSettle(opened)} disabled={!canSettle}>
                {busy ? 'Settling…' : 'Settle / claim'}
              </button>
              {stale && onRefund && (
                <button className="secondary" onClick={() => onRefund(opened)} disabled={!canSettle}>
                  {busy ? '…' : 'Refund stake'}
                </button>
              )}
            </>
          )}
        </span>
      </div>
      {settled ? (
        <p className={settled.won ? 'ok' : 'bad'}>
          {settled.won ? (
            <>you won {fmtAmount(deployment, settled.payout)}</>
          ) : (
            <>the flip went the other way — stake to the table</>
          )}{' '}
          · player <AddressLink deployment={deployment} address={settled.player} />
        </p>
      ) : refunded ? (
        <p className="muted">this round went stale — your {fmtAmount(deployment, opened.stake)} stake was refunded</p>
      ) : (
        <p className="muted">
          {settledPending
            ? 'seed is finalized — settle it now'
            : stale
              ? 'the validators never cast a seed for this round — you can refund your stake'
              : 'waiting on the validators to cast the seed for this round'}
        </p>
      )}
      {settled && <TablesVerifyPanel deployment={deployment} opened={opened} settled={settled} />}
    </div>
  )
}

/**
 * Play + verify surface for the permissionless player-run coin-flip tables. The player picks a table
 * (TablePicker), a side, and a stake; `open()` pulls the Chips stake and heats the canonical validator
 * subset internally (exactly like Raffle.arm); a validator cast then settles the round on-chain (push
 * via onCast, or the `claim` pull fallback here). Every settled round shows a verify slip that replays
 * the winner from the seed parity purely from the chain logs.
 */
export const CoinFlipTablesScreen = ({
  deployment,
  data,
  walletClient,
  trustAcknowledged,
  myAddress,
  initialTableId,
}: {
  deployment: GameDeployment
  data: ChainData
  walletClient?: viem.WalletClient
  trustAcknowledged: boolean
  myAddress?: viem.Hex
  /** Pre-selected table from a shared invite link (?table=…). */
  initialTableId?: viem.Hex
}) => {
  const tableEvents = useTableEvents(deployment)
  const [tableId, setTableId] = useState<viem.Hex | null>(initialTableId ?? null)
  const [copied, setCopied] = useState(false)
  // Mirror the picked table into the URL query so the address bar is itself a shareable invite and a
  // refresh keeps you on the same table (merges with App's game/chain params — replaceState, no spam).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    if (tableId) sp.set('table', tableId)
    else sp.delete('table')
    window.history.replaceState(null, '', `${window.location.pathname}?${sp}${window.location.hash}`)
  }, [tableId])
  // The full invite URL for the currently-selected table — copied to the clipboard by the invite bar.
  const inviteUrl = tableId
    ? `${window.location.origin}${window.location.pathname}?game=tables&table=${tableId}`
    : ''
  const copyInvite = async () => {
    if (!inviteUrl) return
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('could not copy — select the link and copy it manually')
    }
  }
  const [side, setSide] = useState(HEADS) // 0 = HEADS, 1 = TAILS
  const [amount, setAmount] = useState('1')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [seeds, setSeeds] = useState<Record<string, viem.Hex>>({})
  // Rounds opened THIS session, before the 12s event poll indexes them (merged with the indexed set).
  const [sessionRounds, setSessionRounds] = useState<OpenedLog[]>([])
  // Rounds refunded THIS session, shown as refunded before the poll indexes the Refunded event.
  const [refundedLocal, setRefundedLocal] = useState<viem.Hex[]>([])

  const stake = parseStake(amount)
  const deployed = deployment.coinFlipTables !== undefined
  const canPlay =
    deployed && walletClient !== undefined && trustAcknowledged && !busy && tableId !== null && stake !== undefined

  // Index every RoundOpened / RoundSettled the poll has seen, then keep only the connected wallet's
  // rounds (merged with this session's just-opened ones so a fresh bet shows before it's indexed).
  const { myRounds, settledByRound, refundedByRound } = useMemo(() => {
    const openedByRound = new Map<string, OpenedLog>()
    const settledByRound = new Map<string, SettledLog>()
    const refundedByRound = new Set<string>(refundedLocal) // optimistic — shown before the poll indexes it
    for (const e of tableEvents.events) {
      if (e.type === 'RoundOpened' && e.roundId) openedByRound.set(e.roundId, toOpened(e))
      if (e.type === 'RoundSettled' && e.roundId) settledByRound.set(e.roundId, toSettled(e))
      if (e.type === 'Refunded' && e.roundId) refundedByRound.add(e.roundId as string)
    }
    for (const o of sessionRounds) if (!openedByRound.has(o.roundId)) openedByRound.set(o.roundId, o)
    const mine = myAddress?.toLowerCase()
    const myRounds = [...openedByRound.values()]
      .filter((o) => !mine || o.player.toLowerCase() === mine)
      .sort((a, b) => (b.openedAtBlock > a.openedAtBlock ? 1 : b.openedAtBlock < a.openedAtBlock ? -1 : 0))
    return { myRounds, settledByRound, refundedByRound }
  }, [tableEvents.events, sessionRounds, myAddress, refundedLocal])

  // Disjoint by construction: the contract lets a round reach only ONE of Settled / Refunded.
  const pending = myRounds.filter((r) => !settledByRound.has(r.roundId) && !refundedByRound.has(r.roundId))
  const settled = myRounds.filter((r) => settledByRound.has(r.roundId))
  const refunded = myRounds.filter((r) => refundedByRound.has(r.roundId) && !settledByRound.has(r.roundId))
  // Refundable once STALE_BLOCKS have passed since open (seed-missing is enforced on-chain).
  const staleOf = (o: OpenedLog) =>
    tableEvents.head > 0n && o.openedAtBlock > 0n && tableEvents.head >= o.openedAtBlock + STALE_BLOCKS

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await work()
      tableEvents.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const bet = () =>
    run(async () => {
      const cft = deployment.coinFlipTables
      if (!cft) throw new Error("player-run tables aren't live on this chain yet")
      if (!tableId) throw new Error('pick a table first')
      if (stake === undefined) throw new Error('enter a positive stake')
      if (!deployment.chips) throw new Error('no Chips token configured on this chain')
      // 1. Approve the Chips stake to the tables contract (ERC-20; open() pulls it via transferFrom).
      await sendGameTx(deployment, walletClient!, {
        address: deployment.chips,
        abi: ERC20_APPROVE_ABI,
        functionName: 'approve',
        args: [cft, stake],
      })
      // 2. open() heats the canonical subset INTERNALLY exactly like Raffle.arm, so the heat locations
      //    are built the SAME way — nextHeatLocations over the SHARED validator/pool data the app loads
      //    (coin-flip lobby + raffle rounds). The tables contract draws from the same canonical pools, so
      //    the next-unconsumed slot is the same arithmetic. (Caveat: nextHeatLocations does not yet count
      //    prior CoinFlipTables rounds in its consumed tally, so a concurrent heat can race the slot —
      //    that fails in simulateContract and the player simply retries. Validated at deploy time.)
      const receipt = await sendGameTx(deployment, walletClient!, {
        address: cft,
        abi: coinFlipTablesAbi,
        functionName: 'open',
        args: [tableId, side, stake, deployment.canonicalSubset, nextHeatLocations(deployment, data.lobby, data.rounds)],
      })
      const [openedEvent] = viem.parseEventLogs({ abi: coinFlipTablesAbi, eventName: 'RoundOpened', logs: receipt.logs })
      const a = openedEvent?.args as Partial<OpenedLog> | undefined
      if (!a?.roundId || !a.key) throw new Error('no RoundOpened event in the receipt')
      setSessionRounds((prev) => [
        {
          roundId: a.roundId!, tableId: a.tableId!, player: a.player!, side: Number(a.side),
          stake: a.stake!, payout: a.payout!, subsetHash: a.subsetHash!, key: a.key!, openedAtBlock: a.openedAtBlock!,
        },
        ...prev,
      ])
    })

  // Drive a pending round to settlement: read the round's seed from Random; if finalized and the onCast
  // push hasn't already settled it, use the `claim` pull fallback. A not-yet-finalized seed just waits.
  const settleRound = (opened: OpenedLog) =>
    run(async () => {
      const client = publicClientFor(deployment.chainId, deployment.rpc)
      const randomness = (await client.readContract({
        address: deployment.random,
        abi: randomAbi,
        functionName: 'randomness',
        args: [opened.key],
      })) as { seed: viem.Hex }
      setSeeds((s) => ({ ...s, [opened.roundId]: randomness.seed }))
      if (randomness.seed === ZERO32) {
        throw new Error("the validators haven't cast the seed for this round yet — try again shortly")
      }
      // If the push already settled it, the RoundSettled event will surface on the next poll — no claim.
      if (!settledByRound.has(opened.roundId)) {
        await sendGameTx(deployment, walletClient!, {
          address: deployment.coinFlipTables!,
          abi: coinFlipTablesAbi,
          functionName: 'claim',
          args: [opened.roundId],
        })
      }
    })

  // Reclaim the stake on a round whose seed never finalized (stale). Only offered once STALE_BLOCKS
  // have passed; refundStale reverts TooEarly if a seed did finalize (then the player should settle).
  const refundRound = (opened: OpenedLog) =>
    run(async () => {
      await sendGameTx(deployment, walletClient!, {
        address: deployment.coinFlipTables!,
        abi: coinFlipTablesAbi,
        functionName: 'refundStale',
        args: [opened.roundId],
      })
      setRefundedLocal((prev) => (prev.includes(opened.roundId) ? prev : [...prev, opened.roundId]))
    })

  if (!deployed) {
    return (
      <GameStage title="PLAYER TABLES" subtitle="bet a coin flip against an operator's bankroll" action={<HowItWorksLink />}>
        <div className="card">
          <p className="muted">
            Player-run tables aren't live on this chain yet. Switch to a chain where the CoinFlipTables
            contract is deployed to open a table or take a seat.
          </p>
        </div>
      </GameStage>
    )
  }

  const wonCount = settled.filter((r) => settledByRound.get(r.roundId)!.won).length
  const takings = settled
    .filter((r) => settledByRound.get(r.roundId)!.won)
    .reduce((sum, r) => sum + settledByRound.get(r.roundId)!.payout, 0n)

  return (
    <>
      <GameStage title="PLAYER TABLES" subtitle="bet a coin flip against an operator's bankroll" action={<HowItWorksLink />}>
        <div className="cft-surface">
          <TablePicker deployment={deployment} walletClient={walletClient} selected={tableId} onSelect={setTableId} />

          {tableId && (
            <div className="row cft-invite" style={{ justifyContent: 'space-between', gap: 10, margin: '6px 2px' }}>
              <span className="muted">Invite players — share this table's link so friends land right on it</span>
              <button className="secondary" onClick={() => void copyInvite()}>
                {copied ? 'Copied ✓' : 'Copy invite link'}
              </button>
            </div>
          )}

          {tableEvents.error && <div className="banner bad">table read failed: {tableEvents.error}</div>}

          {myRounds.length === 0 ? (
            <p className="muted" style={{ padding: '8px 2px' }}>
              No bets yet — pick an armed table above, choose a side, and place a stake to open a round.
            </p>
          ) : (
            <div className="cft-rounds">
              {pending.map((o) => (
                <RoundCard
                  key={o.roundId}
                  deployment={deployment}
                  opened={o}
                  seed={seeds[o.roundId]}
                  busy={busy}
                  canSettle={walletClient !== undefined && !busy}
                  stale={staleOf(o)}
                  onSettle={(r) => void settleRound(r)}
                  onRefund={(r) => void refundRound(r)}
                />
              ))}
              {refunded.map((o) => (
                <RoundCard
                  key={o.roundId}
                  deployment={deployment}
                  opened={o}
                  refunded
                  busy={busy}
                  canSettle={false}
                  onSettle={() => {}}
                />
              ))}
              {settled.map((o) => (
                <RoundCard
                  key={o.roundId}
                  deployment={deployment}
                  opened={o}
                  settled={settledByRound.get(o.roundId)}
                  seed={seeds[o.roundId]}
                  busy={busy}
                  canSettle={false}
                  onSettle={() => {}}
                />
              ))}
            </div>
          )}
        </div>
      </GameStage>

      <div className="tray-col">
        <BetTray
          amount={amount}
          onAmount={setAmount}
          unit="◈ Chips"
          action={
            <button className="primary" onClick={() => void bet()} disabled={!canPlay}>
              {busy ? 'Sending…' : 'Place bet'}
            </button>
          }
        >
          <div className="acts" style={{ marginTop: 8 }}>
            <label className="tp-field" style={{ gridColumn: '1 / -1' }}>
              your side
              <Menu label="side" options={[...SIDE_OPTIONS]} value={side} onChange={setSide} disabled={busy} />
            </label>
          </div>
          {!walletClient && <p className="tray-hint">connect a wallet to play</p>}
          {walletClient && !trustAcknowledged && <p className="tray-hint">tap "Got it" on the fairness note above first</p>}
          {walletClient && trustAcknowledged && tableId === null && (
            <p className="tray-hint">pick an armed table above to place a bet</p>
          )}
          {!deployment.chips && <p className="tray-hint bad">no Chips token configured on this chain</p>}
          <p className="tray-hint">
            you stake Chips against the table's bankroll — a validator seed's parity decides. Your worst
            case is a stuck round you refund; the operator never touches the coin.
          </p>
          {error && <p className="bad">{error}</p>}
        </BetTray>

        <MetaPanel tabs={['Rounds', 'Record']}>
          <span>
            <b>{pending.length}</b> live · <b>{settled.length}</b> settled
            {refunded.length > 0 && <span className="muted"> · {refunded.length} refunded</span>}
            {wonCount > 0 && <span className="muted"> · you won {wonCount}</span>}
            {takings > 0n && <span className="muted"> · took {fmtAmount(deployment, takings)}</span>}
          </span>
        </MetaPanel>
      </div>
    </>
  )
}
