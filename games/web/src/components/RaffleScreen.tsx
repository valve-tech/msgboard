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
import { AddressLink, InfoDot, Provenance, SourceNote, archiveTrailUrl, explorerUrl, fmtAmount, formatWhen } from './Meta'
import { StakeInput, parseStake } from './StakeInput'
import { RoundTiming } from './TurnTiming'
import { involvement } from '../model/participation'

const commitmentFor = (guess: bigint, salt: viem.Hex, player: viem.Hex): viem.Hex =>
  viem.keccak256(
    viem.encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }, { type: 'address' }], [guess, salt, player]),
  )

const ACTIVE_PHASES = new Set(['filling', 'drawing', 'claiming'])

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
  <div className="card">
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

  return (
    <div>
      <div className="card">
        <h3>
          Play a number
          <InfoDot>
            Tickets with the same price and player count pool into the same round. The draw fires once the
            round has its players. Your number stays hidden until you reveal — the salt proving it lives in
            THIS browser; lose it before revealing and the stake is forfeit. Keep the backup string safe.
          </InfoDot>
        </h3>
        <div className="row">
          <StakeInput value={amount} onChange={setAmount} placeholder="ticket price" />
          <label className="threshold-label">
            players
            <input
              type="number"
              min={2}
              max={256}
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              style={{ width: '4.2rem' }}
              aria-label="player threshold"
            />
          </label>
          <input
            type="number"
            min={1}
            max={256}
            placeholder="your number 1–256"
            value={guess}
            onChange={(e) => setGuess(e.target.value)}
            style={{ width: '9rem' }}
          />
          <button onClick={() => void commit()} disabled={!canPlay || guess === '' || !paramsOk}>
            {busy ? 'Sending…' : 'Commit'}
          </button>
          {!walletClient && <span className="muted">connect a wallet to play</span>}
          {walletClient && !trustAcknowledged && <span className="muted">tap "Got it" on the fairness note above first</span>}
        </div>
        {(amount !== '' && stake === undefined) ||
        (threshold !== '' && (thresholdN === undefined || thresholdN < 2n)) ||
        joinsRound ? (
          <p className="muted" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {amount !== '' && stake === undefined && <span className="bad">enter a positive ticket price</span>}
            {threshold !== '' && (thresholdN === undefined || thresholdN < 2n) && (
              <span className="bad">threshold must be at least 2 players</span>
            )}
            {joinsRound && (
              <span className="ok">
                joins the round filling now ({joinsRound.commitCount.toString()}/{joinsRound.threshold.toString()})
              </span>
            )}
          </p>
        ) : null}
        {backupShown && (
          <div className="banner">
            <strong>Backup your salts now:</strong>
            <p className="mono">{backupShown}</p>
            <button className="secondary" onClick={() => void navigator.clipboard.writeText(backupShown)}>
              Copy backup
            </button>
          </div>
        )}
        <div className="row" style={{ marginTop: '0.5rem' }}>
          <input
            placeholder="paste a backup string to restore salts"
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            style={{ flex: 1 }}
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
                alert(`${count} ticket salt(s) restored`)
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e))
              }
            }}
          >
            Import backup
          </button>
        </div>
        {error && <p className="bad">{error}</p>}
      </div>

      <h2>
        Open rounds
        <SourceNote deployment={deployment} contract={deployment.raffle} contractLabel="Raffle" />
      </h2>
      {liveRounds.length === 0 && <p className="muted">No round on the table — play a number to open one.</p>}
      {[...liveRounds].reverse().map((round) => (
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
        />
      ))}

      {myAddress && (
        <>
          <h2>
            Your book
            <SourceNote deployment={deployment} contract={deployment.raffle} contractLabel="Raffle" />
          </h2>
          {myRounds.length === 0 && (
            <p className="muted">Nothing under your name yet — every round you play or validate lands here.</p>
          )}
          {myRounds.length > 0 && (
            <details className="history" open>
              <summary>
                {myRounds.length} round{myRounds.length === 1 ? '' : 's'}
                {myFinished.length > 0 && (
                  <span className="muted">
                    {' '}
                    · {myWon.length}/{myFinished.length} won · {fmtAmount(deployment, myTakings)} taken
                  </span>
                )}
              </summary>
              {[...myRounds].reverse().map((round) => (
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
                  validated={mineByRound.get(round.roundId)!.validated}
                />
              ))}
            </details>
          )}
        </>
      )}

      <h2>
        The record
        <SourceNote deployment={deployment} contract={deployment.raffle} contractLabel="Raffle" />
      </h2>
      {doneRounds.length === 0 && <p className="muted">No finished rounds yet.</p>}
      {doneRounds.length > 0 && (
        <details className="history">
          <summary>
            {doneRounds.length} finished round{doneRounds.length === 1 ? '' : 's'} · {fmtAmount(deployment, paidOut)} paid
            out
            {lastDoneWhen && <span className="muted"> · last {lastDoneWhen}</span>}
            {archiveTrailUrl(deployment) && (
              <a
                href={archiveTrailUrl(deployment)}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                msgboard trail ↗
              </a>
            )}
            <span className="muted history-hint">every one verifiable — open the book</span>
          </summary>
          {[...doneRounds].reverse().map((round) => (
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
            />
          ))}
        </details>
      )}
    </div>
  )
}
