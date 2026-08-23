import { useEffect, useMemo, useState } from 'react'
import * as viem from 'viem'
import { operatorCoinFlipAbi, randomAbi } from '@msgboard/games-core'
import type { GameDeployment } from '../config'
import type { ChainData } from '../hooks/useChainData'
import { useOperatorRounds } from '../hooks/useOperatorRounds'
import { useOperatorTable } from '../hooks/useOperatorTable'
import {
  foldOperatorTables,
  foldOperatorRounds,
  verifyOperatorRound,
  latestMetadataUri,
  type OperatorOpenedLog,
  type OperatorSettledLog,
} from '../lib/operatorIndex'
import { fetchThemeManifest } from '../lib/operatorTheme'
import { operatorBetPlan, betFits, tierPrice, payoutFor, isStale } from '../model/operator-table'
import { sendGameTx, nextHeatLocations } from '../tx'
import { publicClientFor } from '../wallet'
import { OperatorTablePicker } from './OperatorTablePicker'
import { Menu } from './Menu'
import { parseStake } from './StakeInput'
import { GameStage } from './shell/GameStage'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { AddressLink, explorerUrl, fmtAmount, InfoDot, MSGBOARD_GAMES_DOCS } from './Meta'

/** Minimal ERC20 approve — Chips has no ABI export in games-core; mirrors CoinFlipTablesScreen's local const. */
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

/** The verify receipt for one settled round — recomputes the winner from the seed parity purely from the
 *  RoundOpened + RoundSettled logs (verifyOperatorRound → verifyRound), never trusting the chain's `won`
 *  flag. House trust chrome; never skinnable — enforced by rendering outside `<GameStage>` (see the
 *  `roundsLedger` wiring below), not just by convention. */
const OperatorVerifyPanel = ({
  deployment,
  opened,
  settled,
}: {
  deployment: GameDeployment
  opened: OperatorOpenedLog
  settled: OperatorSettledLog
}) => {
  const { ok, reasons } = verifyOperatorRound(opened, settled)
  const parityWin = (BigInt(settled.seed) & 1n) === BigInt(opened.side)
  const gameUrl = deployment.operator ? explorerUrl(deployment, 'address', deployment.operator.coinFlip) : undefined
  const randomUrl = explorerUrl(deployment, 'address', deployment.random)
  return (
    <div className="receipt">
      <h3>
        The slip — run the flip yourself
        <InfoDot>
          Your browser recomputes the result from the seed's parity and compares it with what the{' '}
          {gameUrl ? (
            <a href={gameUrl} target="_blank" rel="noreferrer">operator contract</a>
          ) : (
            'operator contract'
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

/** One of the player's rounds — pending (poll + settle, or refund once stale), settled (outcome + verify
 *  slip), or refunded (stale round whose stake was returned). */
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
  opened: OperatorOpenedLog
  settled?: OperatorSettledLog
  refunded?: boolean
  seed?: viem.Hex
  busy: boolean
  canSettle: boolean
  stale?: boolean
  onSettle: (opened: OperatorOpenedLog) => void
  onRefund?: (opened: OperatorOpenedLog) => void
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
            <>the flip went the other way — stake to the operator's bankroll</>
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
      {settled && <OperatorVerifyPanel deployment={deployment} opened={opened} settled={settled} />}
    </div>
  )
}

/**
 * Play + verify surface for operator coin-flip tables (plain bets, chain 943). The player picks a table,
 * a side, and a stake; approve → open pulls the Chips stake into GameEscrow and heats the auto-picked
 * canonical validator subset; a validator cast then settles the round (push via onCast, or the `claim`
 * pull fallback here). Every settled round shows a verify slip that replays the winner from the seed
 * parity purely from the chain logs. The stage board (the table picker) skins with the operator's theme;
 * the round ledger and verify slip are house trust chrome and render in `.tray-col`, outside `<GameStage>`,
 * so no operator palette can ever reach them.
 */
export const OperatorCoinFlipScreen = ({
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
  const rounds = useOperatorRounds(deployment)
  const [tableId, setTableId] = useState<viem.Hex | null>(initialTableId ?? null)
  const { table } = useOperatorTable(deployment, tableId)
  const [side, setSide] = useState(HEADS) // 0 = HEADS, 1 = TAILS
  const [amount, setAmount] = useState('1')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [seeds, setSeeds] = useState<Record<string, viem.Hex>>({})
  // Rounds opened THIS session, before the poll indexes them (merged with the indexed set).
  const [sessionRounds, setSessionRounds] = useState<OperatorOpenedLog[]>([])

  // Mirror the picked table into the URL so the address bar is a shareable invite and a refresh keeps you
  // on the same table (merges with App's game/chain params — replaceState, no history spam).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    if (tableId) sp.set('table', tableId)
    else sp.delete('table')
    window.history.replaceState(null, '', `${window.location.pathname}?${sp}${window.location.hash}`)
  }, [tableId])

  const tables = useMemo(() => foldOperatorTables(rounds.events), [rounds.events])
  const { myRounds, settledByRound, refundedByRound } = useMemo(
    () => foldOperatorRounds(rounds.events, sessionRounds, myAddress),
    [rounds.events, sessionRounds, myAddress],
  )

  // Operator-level theme: the operator's latest MetadataSet URI → fetch (timeout + house fallback) → raw
  // manifest handed to GameStage, which re-validates it through parseManifest. An absent/slow/invalid URI
  // stays undefined = the house look (spec §6, §9). Keyed on the URI so it refetches only when it changes.
  const themeUri = useMemo(() => latestMetadataUri(rounds.events, table?.operator), [rounds.events, table?.operator])
  const [themeManifest, setThemeManifest] = useState<unknown>(undefined)
  useEffect(() => {
    let live = true
    setThemeManifest(undefined)
    void fetchThemeManifest(themeUri).then((m) => {
      if (live) setThemeManifest(m)
    })
    return () => {
      live = false
    }
  }, [themeUri])

  // Disjoint by construction: the contract lets a round reach only ONE of Settled / Refunded.
  const pending = myRounds.filter((r) => !settledByRound.has(r.roundId) && !refundedByRound.has(r.roundId))
  const settled = myRounds.filter((r) => settledByRound.has(r.roundId))
  const refunded = myRounds.filter((r) => refundedByRound.has(r.roundId) && !settledByRound.has(r.roundId))

  const stake = parseStake(amount)
  const deployed = deployment.operator !== undefined
  const fit = table && stake !== undefined ? betFits(table, stake) : undefined
  const canPlay =
    deployed &&
    walletClient !== undefined &&
    trustAcknowledged &&
    !busy &&
    tableId !== null &&
    stake !== undefined &&
    table !== undefined &&
    fit?.ok === true

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await work()
      rounds.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const bet = () =>
    run(async () => {
      const opCfg = deployment.operator
      if (!opCfg) throw new Error("operator tables aren't live on this chain yet")
      if (!tableId) throw new Error('pick a table first')
      if (stake === undefined) throw new Error('enter a positive stake')
      if (!table) throw new Error('table is still loading — try again in a moment')
      const check = betFits(table, stake)
      if (!check.ok) throw new Error(check.reason ?? 'this bet does not fit the table')
      // 1. Approve the stake in the table's token to the ESCROW — open() pulls it via GameEscrow.
      const locations = nextHeatLocations(deployment, data.lobby, data.rounds)
      const plan = operatorBetPlan(opCfg, deployment.canonicalSubset, tableId, side, stake, locations)
      await sendGameTx(deployment, walletClient!, {
        address: table.token,
        abi: ERC20_APPROVE_ABI,
        functionName: 'approve',
        args: [plan.approveTo, stake],
      })
      // 2. open() heats the canonical subset internally; the player never picks validators (spec §5, NF-1).
      const receipt = await sendGameTx(deployment, walletClient!, {
        address: plan.openTo,
        abi: operatorCoinFlipAbi,
        functionName: 'open',
        args: plan.openArgs,
      })
      const [openedEvent] = viem.parseEventLogs({ abi: operatorCoinFlipAbi, eventName: 'RoundOpened', logs: receipt.logs })
      const a = openedEvent?.args as Partial<OperatorOpenedLog> | undefined
      if (!a?.roundId || !a.key) throw new Error('no RoundOpened event in the receipt')
      setSessionRounds((prev) => [
        {
          roundId: a.roundId!, tableId: a.tableId!, player: a.player!, side: Number(a.side),
          stake: a.stake!, payout: a.payout!, tierPrice: a.tierPrice!, key: a.key!, openedAtBlock: a.openedAtBlock!,
        },
        ...prev,
      ])
    })

  // Drive a pending round to settlement: read its seed from Random; if finalized and the onCast push
  // hasn't already settled it, use the `claim` pull fallback. A not-yet-finalized seed just waits.
  const settleRound = (opened: OperatorOpenedLog) =>
    run(async () => {
      const opCfg = deployment.operator
      if (!opCfg) throw new Error("operator tables aren't live on this chain yet")
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
      if (!settledByRound.has(opened.roundId)) {
        await sendGameTx(deployment, walletClient!, {
          address: opCfg.coinFlip,
          abi: operatorCoinFlipAbi,
          functionName: 'claim',
          args: [opened.roundId],
        })
      }
    })

  // Reclaim the stake on a round whose seed never finalized (stale). Only offered once STALE_BLOCKS have
  // passed; refundStale reverts TooEarly if a seed did finalize (then the player should settle instead).
  const refundRound = (opened: OperatorOpenedLog) =>
    run(async () => {
      const opCfg = deployment.operator
      if (!opCfg) throw new Error("operator tables aren't live on this chain yet")
      await sendGameTx(deployment, walletClient!, {
        address: opCfg.coinFlip,
        abi: operatorCoinFlipAbi,
        functionName: 'refundStale',
        args: [opened.roundId],
      })
    })

  if (!deployed) {
    return (
      <GameStage title="OPERATOR TABLES" subtitle="bet a coin flip against an operator's bankroll">
        <div className="card">
          <p className="muted">
            Operator tables aren't live on this chain yet. Switch to a chain where the operator substrate is
            deployed to place a bet.
          </p>
        </div>
      </GameStage>
    )
  }

  const tierNow = table && stake !== undefined ? tierPrice(table.minStake, table.maxStake, stake) : undefined
  const payoutNow = table && stake !== undefined && tierNow !== undefined ? payoutFor(stake, table.maxMultiplierX100) : undefined
  const wonCount = settled.filter((r) => settledByRound.get(r.roundId)!.won).length

  // The round ledger + verify slip are house trust chrome (bet amounts, odds, the seed/parity/address
  // proof) — never skinnable (spec §6). They render in `.tray-col`, a SIBLING of `<GameStage>`, so they
  // are never a descendant of GameStage's `theme-root` wrapper: no operator palette, hostile or benign,
  // can reach them (see OperatorCoinFlipScreen.test.ts). Only the table picker — the skinnable "board" —
  // sits inside the themed stage.
  const roundsLedger =
    myRounds.length === 0 ? (
      <p className="muted" style={{ padding: '8px 2px' }}>
        No bets yet — pick an open table above, choose a side, and place a stake to open a round.
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
            stale={isStale(o.openedAtBlock, rounds.head)}
            onSettle={(r) => void settleRound(r)}
            onRefund={(r) => void refundRound(r)}
          />
        ))}
        {refunded.map((o) => (
          <RoundCard key={o.roundId} deployment={deployment} opened={o} refunded busy={busy} canSettle={false} onSettle={() => {}} />
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
    )

  return (
    <>
      <GameStage title="OPERATOR TABLES" subtitle="bet a coin flip against an operator's bankroll" themeManifest={themeManifest}>
        <div className="cft-surface">
          <OperatorTablePicker deployment={deployment} tables={tables} selected={tableId} onSelect={setTableId} />
        </div>
      </GameStage>

      <div className="tray-col">
        {rounds.error && <div className="banner bad">operator read failed: {rounds.error}</div>}

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
          {payoutNow !== undefined && (
            <p className="tray-hint">
              a win pays {fmtAmount(deployment, payoutNow)} · tier {fmtAmount(deployment, tierNow!)}
            </p>
          )}
          {!walletClient && <p className="tray-hint">connect a wallet to play</p>}
          {walletClient && !trustAcknowledged && <p className="tray-hint">tap "Got it" on the fairness note above first</p>}
          {walletClient && trustAcknowledged && tableId === null && (
            <p className="tray-hint">pick an open table above to place a bet</p>
          )}
          {fit && !fit.ok && <p className="tray-hint bad">{fit.reason}</p>}
          <p className="tray-hint">
            you stake Chips against the operator's bankroll — a validator seed's parity decides. Your worst
            case is a stuck round you refund; the operator never touches the coin.
          </p>
          {error && <p className="bad">{error}</p>}
        </BetTray>

        <MetaPanel tabs={['Rounds', 'Record']}>
          <span>
            <b>{pending.length}</b> live · <b>{settled.length}</b> settled
            {refunded.length > 0 && <span className="muted"> · {refunded.length} refunded</span>}
            {wonCount > 0 && <span className="muted"> · you won {wonCount}</span>}
          </span>
        </MetaPanel>

        {roundsLedger}
      </div>
    </>
  )
}
