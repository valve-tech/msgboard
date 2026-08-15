import { useState } from 'react'
import * as viem from 'viem'
import { raffleAbi, randomAbi } from '@msgboard/games-core'
import { CANONICAL_PERIOD, CANONICAL_THRESHOLD } from '@msgboard/raffle'
import type { GameDeployment } from '../config'
import type { ChainData } from '../hooks/useChainData'
import type { RaffleRoundView } from '../model/raffle-rounds'
import { saveSalt, loadSalt, exportBackup, importBackup } from '../model/salts'
import { sendGameTx, nextHeatLocations } from '../tx'
import { publicClientFor } from '../wallet'
import { RaffleVerifyPanel } from './VerifyPanel'
import { AddressLink, Provenance, explorerUrl, fmtAmount, formatWhen } from './Meta'
import { parseStake } from './StakeInput'
import { RoundTiming } from './TurnTiming'
import { involvement } from '../model/participation'
import { GameStage } from './shell/GameStage'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { BookBoard } from './stages/BookBoard'

const commitmentFor = (guess: bigint, salt: viem.Hex, player: viem.Hex): viem.Hex =>
  viem.keccak256(
    viem.encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }, { type: 'address' }], [guess, salt, player]),
  )

const ACTIVE_PHASES = new Set(['filling', 'drawing', 'claiming'])

/** the lifecycle spine colour for a round card (matches BookBoard's .bk-open/.bk-wait/.bk-done). */
const roundSpine = (round: RaffleRoundView): 'open' | 'wait' | 'done' | 'expired' =>
  round.phase === 'filling'
    ? 'open'
    : round.phase === 'drawing' || round.phase === 'claiming'
      ? 'wait'
      : round.phase === 'no-contest'
        ? 'expired'
        : 'done'

/**
 * Hoisted to module level on purpose: a nested definition gets a fresh component identity
 * every render, so the 4 s poll remounted every card and replayed the entry animation —
 * the "periodic flashing". Stable identity = in-place re-render.
 */
const RoundCard = ({
round,
deployment,
data,
seed,
busy,
canPlay,
phaseTag,
onArm,
onFinalise,
onLoadSeed,
onReveal,
onRefund,
validated,
}: {
round: RaffleRoundView
deployment: GameDeployment
data: ChainData
seed?: viem.Hex
busy: boolean
canPlay: boolean
phaseTag: (round: RaffleRoundView) => string
onArm: (round: RaffleRoundView) => void
onFinalise: (round: RaffleRoundView) => void
onLoadSeed: (round: RaffleRoundView) => void
onReveal: (ticketId: bigint) => void
onRefund: (ticketId: bigint) => void
validated?: boolean
}) => (
  <div className={`card bk-${roundSpine(round)}${validated ? ' bk-mine' : ''}`}>
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <span>
        <span className="tag">{phaseTag(round)}</span>
        {fmtAmount(deployment, round.stake)} per ticket · {round.threshold.toString()} players ·{' '}
        pot {fmtAmount(deployment, round.stake * round.commitCount)}
        {round.draw !== undefined && <span className="tag">draw: {round.draw.toString()}</span>}
        {validated && <span className="tag gold">you validated</span>}
      </span>
      <span className="row">
        {round.phase === 'filling' && round.commitCount >= round.threshold && (
          <button className="secondary" onClick={() => onArm(round)} disabled={!canPlay}>
            Arm (heat the validators)
          </button>
        )}
        {round.phase === 'claiming' && round.finaliseOpen && (
          <button onClick={() => onFinalise(round)} disabled={!canPlay}>
            Finalise
          </button>
        )}
        {round.phase === 'claiming' && !seed && (
          <button className="secondary" onClick={() => onLoadSeed(round)} disabled={busy}>
            Load seed to verify
          </button>
        )}
      </span>
    </div>
    {round.phase === 'paid' && (
      <p className="ok">
        winner <AddressLink deployment={deployment} address={round.winner!} /> took{' '}
        {fmtAmount(deployment, round.payout!)}
      </p>
    )}
    <Provenance
      deployment={deployment}
      timestamps={data.timestamps}
      items={[
        { label: 'opened', block: round.openedAtBlock },
        { label: 'armed', block: round.armedAtBlock, tx: round.armTx },
        { label: 'drawn', block: round.drawnAtBlock, tx: round.drawTx },
        { label: 'paid', block: round.finalisedAtBlock, tx: round.finaliseTx },
      ]}
    />
    <RoundTiming
      totalLabel="settled"
      timestamps={data.timestamps}
      phases={[
        { label: 'opened', block: round.openedAtBlock },
        { label: 'armed', block: round.armedAtBlock },
        { label: 'drawn', block: round.drawnAtBlock },
        { label: 'paid', block: round.finalisedAtBlock },
      ]}
    />
    <table>
      <tbody>
        {round.tickets.map((ticket) => {
          const commitWhen = formatWhen(data.timestamps[ticket.committedAtBlock.toString()])
          const commitUrl = ticket.commitTx ? explorerUrl(deployment, 'tx', ticket.commitTx) : undefined
          const revealUrl = ticket.revealTx ? explorerUrl(deployment, 'tx', ticket.revealTx) : undefined
          return (
            <tr key={ticket.ticketId.toString()}>
              <td>#{ticket.ticketId.toString()}</td>
              <td>
                <AddressLink deployment={deployment} address={ticket.player} />
                {ticket.mine && <span className="tag ok">you</span>}
              </td>
              <td>
                {ticket.cancelled && <span className="muted">cancelled</span>}
                {ticket.refunded && <span className="muted">refunded</span>}
                {ticket.revealed && (
                  <span>
                    guess {ticket.guess!.toString()} (distance {ticket.distance!.toString()})
                    {ticket.leading && <span className="tag ok">leading</span>}
                  </span>
                )}
                {!ticket.revealed && !ticket.cancelled && !ticket.refunded && <span className="muted">hidden</span>}
              </td>
              <td className="card-meta">
                {commitWhen && <span title={`committed at block ${ticket.committedAtBlock}`}>{commitWhen}</span>}
                {commitUrl && (
                  <span>
                    {' · '}
                    <a href={commitUrl} target="_blank" rel="noreferrer">
                      commit ↗
                    </a>
                  </span>
                )}
                {revealUrl && (
                  <span>
                    {' · '}
                    <a href={revealUrl} target="_blank" rel="noreferrer">
                      reveal ↗
                    </a>
                  </span>
                )}
              </td>
              <td>
                {ticket.mine && round.phase === 'claiming' && round.revealOpen && !ticket.revealed && (
                  <button onClick={() => onReveal(ticket.ticketId)} disabled={!canPlay}>
                    Reveal
                  </button>
                )}
                {ticket.mine && round.staleRefundCandidate && !ticket.refunded && (
                  <button className="danger" onClick={() => onRefund(ticket.ticketId)} disabled={!canPlay}>
                    Refund stake
                  </button>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
    <RaffleVerifyPanel round={round} seed={seed} deployment={deployment} />
  </div>
)


export const RaffleScreen = ({
  deployment,
  data,
  walletClient,
  trustAcknowledged,
  myAddress,
}: {
  deployment: GameDeployment
  data: ChainData
  walletClient?: viem.WalletClient
  trustAcknowledged: boolean
  myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [threshold, setThreshold] = useState(CANONICAL_THRESHOLD.toString())
  const [guess, setGuess] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [backupShown, setBackupShown] = useState<string>()
  const [importText, setImportText] = useState('')
  const [seeds, setSeeds] = useState<Record<string, viem.Hex>>({})

  const stake = parseStake(amount)
  const thresholdN = /^\d+$/.test(threshold.trim()) ? BigInt(threshold.trim()) : undefined
  const paramsOk = stake !== undefined && thresholdN !== undefined && thresholdN >= 2n
  const canPlay = walletClient !== undefined && trustAcknowledged && !busy

  // a filling round with the same stake+threshold — your ticket would join its pot
  const joinsRound = data.rounds.find(
    (r) => r.phase === 'filling' && r.stake === stake && r.threshold === thresholdN,
  )

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await work()
      data.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const commit = () =>
    run(async () => {
      if (!paramsOk) throw new Error('set a positive stake and a player threshold of at least 2')
      const g = BigInt(guess)
      if (g < 1n || g > 256n) throw new Error('guess must be between 1 and 256')
      const salt = viem.bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
      const player = walletClient!.account!.address
      const receipt = await sendGameTx(deployment, walletClient!, {
        address: deployment.raffle,
        abi: raffleAbi,
        functionName: 'commit',
        args: [stake!, thresholdN!, CANONICAL_PERIOD, deployment.canonicalSubset, commitmentFor(g, salt, player)],
        value: stake!,
      })
      const committed = viem.parseEventLogs({ abi: raffleAbi, eventName: 'Committed', logs: receipt.logs })[0]
        ?.args as { ticketId?: bigint } | undefined
      if (committed?.ticketId === undefined) throw new Error('no Committed event in the receipt')
      saveSalt(localStorage, deployment.chainId, deployment.raffle, committed.ticketId, { guess: g, salt })
      setBackupShown(exportBackup(localStorage, deployment.chainId, deployment.raffle))
      setGuess('')
    })

  const arm = (round: RaffleRoundView) =>
    run(async () => {
      await sendGameTx(deployment, walletClient!, {
        address: deployment.raffle,
        abi: raffleAbi,
        functionName: 'arm',
        args: [round.roundId, nextHeatLocations(deployment, data.lobby, data.rounds)],
      })
    })

  const reveal = (ticketId: bigint) =>
    run(async () => {
      const record = loadSalt(localStorage, deployment.chainId, deployment.raffle, ticketId)
      if (!record) throw new Error(`no stored salt for ticket ${ticketId} — paste your backup below`)
      await sendGameTx(deployment, walletClient!, {
        address: deployment.raffle,
        abi: raffleAbi,
        functionName: 'reveal',
        args: [ticketId, record.guess, record.salt],
      })
    })

  const finalise = (round: RaffleRoundView) =>
    run(async () => {
      await sendGameTx(deployment, walletClient!, {
        address: deployment.raffle,
        abi: raffleAbi,
        functionName: 'finalise',
        args: [round.roundId],
      })
    })

  const refund = (ticketId: bigint) =>
    run(async () => {
      await sendGameTx(deployment, walletClient!, {
        address: deployment.raffle,
        abi: raffleAbi,
        functionName: 'refundTicket',
        args: [ticketId],
      })
    })

  const loadSeed = (round: RaffleRoundView) =>
    run(async () => {
      if (!round.key) throw new Error('round has no request key yet')
      const randomness = (await publicClientFor(deployment.chainId, deployment.rpc).readContract({
        address: deployment.random,
        abi: randomAbi,
        functionName: 'randomness',
        args: [round.key],
      })) as { seed: viem.Hex }
      if (randomness.seed === viem.padHex('0x0', { size: 32 })) throw new Error('seed not finalized yet')
      setSeeds((s) => ({ ...s, [round.roundId]: randomness.seed }))
    })

  const phaseTag = (round: RaffleRoundView) => {
    switch (round.phase) {
      case 'filling':
        return `filling ${round.commitCount}/${round.threshold}`
      case 'drawing':
        return round.staleRefundCandidate ? 'stale — refunds open' : 'waiting for the cast'
      case 'claiming':
        return round.revealOpen ? `revealing — ${round.blocksUntilClose} blocks left` : 'reveal closed — finalise'
      case 'paid':
        return 'paid'
      case 'no-contest':
        return 'no contest — pot to validators'
    }
  }


  const liveRounds = data.rounds.filter((r) => ACTIVE_PHASES.has(r.phase))
  const doneRounds = data.rounds.filter((r) => !ACTIVE_PHASES.has(r.phase))

  // the connected wallet's history — rounds they hold a ticket in, or validated entropy for
  const mineByRound = new Map(
    data.rounds.map((r) => [
      r.roundId,
      involvement({ mine: r.tickets.some((t) => t.mine), subsetHash: r.subsetHash }, deployment.canonicalSubset, myAddress),
    ]),
  )
  const myRounds = data.rounds.filter((r) => {
    const inv = mineByRound.get(r.roundId)!
    return inv.played || inv.validated
  })
  const myFinished = myRounds.filter((r) => !ACTIVE_PHASES.has(r.phase) && mineByRound.get(r.roundId)!.played)
  const myWon = myFinished.filter(
    (r) => r.winner && myAddress && r.winner.toLowerCase() === myAddress.toLowerCase(),
  )
  const myTakings = myWon.reduce((sum, r) => sum + (r.payout ?? 0n), 0n)
  const paidOut = doneRounds.reduce((sum, r) => sum + (r.payout ?? 0n), 0n)
  const lastDone = doneRounds.at(-1)
  const lastDoneWhen =
    lastDone?.finalisedAtBlock !== undefined
      ? formatWhen(data.timestamps[lastDone.finalisedAtBlock.toString()])
      : undefined

  // money-critical alerts, pinned above the lanes: a reveal window closing, or a stalled round to refund.
  const myUnrevealed = (r: RaffleRoundView) => r.tickets.filter((t) => t.mine && !t.revealed && !t.cancelled && !t.refunded)
  const revealDueRounds = data.rounds.filter((r) => r.phase === 'claiming' && r.revealOpen && myUnrevealed(r).length > 0)
  const staleRefundRounds = data.rounds.filter((r) => r.staleRefundCandidate && r.tickets.some((t) => t.mine && !t.refunded))

  const renderRounds = (rounds: RaffleRoundView[]) =>
    [...rounds].reverse().map((round) => (
      <RoundCard
        key={round.roundId}
        round={round}
        deployment={deployment}
        data={data}
        seed={seeds[round.roundId]}
        busy={busy}
        canPlay={canPlay}
        phaseTag={phaseTag}
        onArm={(r) => void arm(r)}
        onFinalise={(r) => void finalise(r)}
        onLoadSeed={(r) => void loadSeed(r)}
        onReveal={(t) => void reveal(t)}
        onRefund={(t) => void refund(t)}
        validated={mineByRound.get(round.roundId)?.validated}
      />
    ))

  const alertNode =
    revealDueRounds.length > 0 || staleRefundRounds.length > 0 ? (
      <>
        {revealDueRounds.map((r) => (
          <div className="banner" key={r.roundId}>
            ⏰ Reveal your number now — {r.blocksUntilClose?.toString() ?? 'few'} blocks left in this round, or the stake is forfeit.
          </div>
        ))}
        {staleRefundRounds.map((r) => (
          <div className="banner bad" key={`stale-${r.roundId}`}>
            Round stalled — open <b>Your book</b> and refund your stake.
          </div>
        ))}
      </>
    ) : undefined

  const invalidTicket = amount !== '' && stake === undefined
  const invalidThreshold = threshold !== '' && (thresholdN === undefined || thresholdN < 2n)

  return (
    <>
      <GameStage title="THE NUMBERS" subtitle="pick 1–256 · closest to the draw wins the pot">
        <BookBoard
          alert={alertNode}
          defaultKey={revealDueRounds.length > 0 ? 'mine' : 'open'}
          empty="No round on the table — play a number to open one."
          lanes={[
            { key: 'open', label: 'Open rounds', count: liveRounds.length, node: renderRounds(liveRounds) },
            { key: 'mine', label: 'Your book', count: myRounds.length, node: renderRounds(myRounds) },
            { key: 'record', label: 'The record', count: doneRounds.length, node: renderRounds(doneRounds) },
          ]}
        />
      </GameStage>

      <div className="tray-col">
        <BetTray
          amount={amount}
          onAmount={setAmount}
          action={
            <button className="primary" onClick={() => void commit()} disabled={!canPlay || guess === '' || !paramsOk}>
              {busy ? 'Sending…' : 'Commit'}
            </button>
          }
        >
          <div className="acts" style={{ marginTop: 8 }}>
            <label className="threshold-label">
              players
              <input type="number" min={2} max={256} value={threshold} onChange={(e) => setThreshold(e.target.value)} aria-label="player threshold" />
            </label>
            <label className="threshold-label">
              your #
              <input type="number" min={1} max={256} placeholder="1–256" value={guess} onChange={(e) => setGuess(e.target.value)} aria-label="your number" />
            </label>
          </div>
          <p className="tray-hint">
            {invalidTicket && <span className="bad">enter a positive ticket price · </span>}
            {invalidThreshold && <span className="bad">threshold ≥ 2 · </span>}
            {joinsRound ? (
              <span className="ok">joins the round filling now ({joinsRound.commitCount.toString()}/{joinsRound.threshold.toString()})</span>
            ) : (
              <span className="muted">same price + player count pool into one round</span>
            )}
          </p>
          {!walletClient && <p className="tray-hint">connect a wallet to play</p>}
          {walletClient && !trustAcknowledged && <p className="tray-hint">tap "Got it" on the fairness note above first</p>}
          <p className="tray-hint">your number stays hidden until you reveal — the salt lives in THIS browser. Back it up.</p>
          {backupShown && (
            <div className="banner">
              <strong>Back up your salts now:</strong>
              <p className="mono" style={{ wordBreak: 'break-all' }}>{backupShown}</p>
              <button className="secondary" onClick={() => void navigator.clipboard.writeText(backupShown)}>Copy backup</button>
            </div>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <input
              className="puz-input"
              style={{ flex: 1, marginTop: 0 }}
              placeholder="paste a backup to restore salts"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
            <button
              className="secondary"
              disabled={importText === ''}
              onClick={() => {
                try {
                  const count = importBackup(localStorage, importText.trim())
                  setError(undefined)
                  setImportText('')
                  setBackupShown(undefined)
                  window.alert(`${count} ticket salt(s) restored`)
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e))
                }
              }}
            >
              Import
            </button>
          </div>
          {error && <p className="bad">{error}</p>}
        </BetTray>

        <MetaPanel tabs={['Rounds', 'Record']}>
          <span>
            <b>{liveRounds.length}</b> open · <b>{doneRounds.length}</b> finished
            {paidOut > 0n && <span className="muted"> · {fmtAmount(deployment, paidOut)} paid out</span>}
            {myTakings > 0n && <span className="muted"> · you took {fmtAmount(deployment, myTakings)}</span>}
            {lastDoneWhen && <span className="muted"> · last {lastDoneWhen}</span>}
          </span>
        </MetaPanel>
      </div>
    </>
  )
}
