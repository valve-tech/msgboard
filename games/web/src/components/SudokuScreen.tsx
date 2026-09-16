import { useEffect, useMemo, useState } from 'react'
import * as viem from 'viem'
import { isValidSolution, SUDOKU_GROUPS } from '@msgboard/zk-skill/sudoku'
import type { GameDeployment } from '../config'
import { useSudoku, checkNullifierSpent, type LeaderboardRow } from '../hooks/useSudoku'
import { sudokuLogAbi } from '../lib/sudokuContract'
import { proveSudokuSolve } from '../lib/sudokuProving'
import { attestSudokuSolve, sudokuAttestedSet, sudokuEasReady } from '../lib/easAttest'
import { sendGameTx } from '../tx'
import { InfoDot } from './Meta'
import { GameStage } from './shell/GameStage'
import { ControlTray } from './shell/ControlTray'
import { MetaPanel } from './shell/MetaPanel'
import { PuzzleBoard } from './stages/PuzzleBoard'

const PUZZLE_ID = 1n

const short = (a?: viem.Hex) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')
/** Solved's `player` is the address as a uint256 field element; render it back as a short address. */
const playerAddr = (player: bigint): viem.Hex => viem.getAddress(viem.toHex(player, { size: 20 }))
const fmtElapsed = (s: number) => {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return m < 60 ? `${m}m ${rem}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

type SubmitStatus = 'idle' | 'proving' | 'checking' | 'submitting' | 'done' | 'error'

/** Cells that clash (duplicate non-zero value within a row/col/box) — for the red validity hint. */
const conflictingCells = (grid: number[]): Set<number> => {
  const bad = new Set<number>()
  for (const group of SUDOKU_GROUPS) {
    const byVal = new Map<number, number[]>()
    for (const idx of group) {
      const v = grid[idx]!
      if (v === 0) continue
      const arr = byVal.get(v) ?? []
      arr.push(idx)
      byVal.set(v, arr)
    }
    for (const arr of byVal.values()) if (arr.length > 1) for (const idx of arr) bad.add(idx)
  }
  return bad
}

/** The interactive 9×9. Clues are locked & bright; the 3×3 boxes are tinted in three diagonal groups
 *  and ruled with a thick brass line; conflicting cells go red. Restyled onto `.sg-*` (was inline). */
const Board = ({
  grid,
  clues,
  conflicts,
  disabled,
  onCell,
}: {
  grid: number[]
  clues: boolean[]
  conflicts: Set<number>
  disabled: boolean
  onCell: (i: number, v: number) => void
}) => (
  <div className="sg-grid">
    {grid.map((v, i) => {
      const r = Math.floor(i / 9)
      const c = i % 9
      const isClue = clues[i]
      const boxGroup = (Math.floor(r / 3) + Math.floor(c / 3)) % 3
      const cls = [
        'sg-cell',
        `b${boxGroup}`,
        r % 3 === 0 ? 'boxtop' : '',
        c % 3 === 0 ? 'boxleft' : '',
        c === 8 ? 'edger' : '',
        r === 8 ? 'edgeb' : '',
        isClue ? 'clue' : '',
        conflicts.has(i) ? 'bad' : '',
      ]
        .filter(Boolean)
        .join(' ')
      return (
        <input
          key={i}
          className={cls}
          value={v === 0 ? '' : String(v)}
          disabled={disabled || isClue}
          inputMode="numeric"
          maxLength={1}
          aria-label={`cell r${r + 1} c${c + 1}`}
          onChange={(e) => {
            const ch = e.target.value.replace(/[^1-9]/g, '').slice(-1)
            onCell(i, ch ? Number(ch) : 0)
          }}
        />
      )
    })}
  </div>
)

/** The solvers' leaderboard, rendered as compact ledger rows for the floating bottom-left drawer. */
const LeaderRows = ({ rows, myAddress, attested }: { rows: LeaderboardRow[]; myAddress?: viem.Hex; attested: Set<string> }) => {
  if (rows.length === 0) return <p className="muted" style={{ padding: '8px 10px' }}>No solves logged yet — be the first to post a time.</p>
  return (
    <>
      {rows.map((row) => {
        const addr = playerAddr(row.player)
        const mine = myAddress && addr.toLowerCase() === myAddress.toLowerCase()
        return (
          <div className="card" key={row.nullifier.toString()}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                <span className="tag">#{row.rank}</span>
                <span className="mono">{short(addr)}</span>
                {mine && <span className="tag ok">you</span>}
                {attested.has(row.nullifier.toString()) && <span className="tag gold" title="also recorded as an EAS attestation">EAS</span>}
              </span>
              <span className="mono">{fmtElapsed(row.elapsed)}</span>
            </div>
          </div>
        )
      })}
    </>
  )
}

export const SudokuScreen = ({
  deployment,
  walletClient,
  trustAcknowledged,
  myAddress,
}: {
  deployment: GameDeployment
  walletClient?: viem.WalletClient
  trustAcknowledged: boolean
  myAddress?: viem.Hex
}) => {
  const sudoku = useSudoku(deployment.sudokuLog ? deployment : null, PUZZLE_ID)
  const grid = sudoku.puzzle?.grid

  // Editable working grid; clues locked. Reset whenever the verified board changes.
  const [work, setWork] = useState<number[]>([])
  const clues = useMemo(() => (grid ? grid.map((v) => v !== 0) : []), [grid])
  useEffect(() => {
    if (grid) setWork([...grid])
  }, [grid])

  const [status, setStatus] = useState<SubmitStatus>('idle')
  const [message, setMessage] = useState<string>()
  const [txHash, setTxHash] = useState<viem.Hex>()

  // The last successfully generated proof bundle — kept so the solve can ALSO be recorded as an
  // EAS attestation (proof-gated by the on-chain resolver; see lib/easAttest.ts). Held even when
  // logSolve says "already logged": the two canonical records spend their nullifiers independently.
  const [lastSolve, setLastSolve] = useState<{ proof: bigint[]; nullifier: bigint; player: bigint }>()
  const [attestStatus, setAttestStatus] = useState<'idle' | 'attesting' | 'done' | 'error'>('idle')
  const [attestMessage, setAttestMessage] = useState<string>()
  const [attestUid, setAttestUid] = useState<viem.Hex>()

  // Which leaderboard nullifiers already carry an EAS attestation (the resolver's spent book).
  const [attestedRows, setAttestedRows] = useState<Set<string>>(new Set())
  useEffect(() => {
    let cancelled = false
    void sudokuAttestedSet(deployment, sudoku.leaderboard.map((r) => r.nullifier)).then((s) => {
      if (!cancelled) setAttestedRows(s)
    })
    return () => {
      cancelled = true
    }
  }, [deployment, sudoku.leaderboard])

  const conflicts = useMemo(() => (work.length === 81 ? conflictingCells(work) : new Set<number>()), [work])
  const complete = useMemo(
    () => grid !== undefined && work.length === 81 && isValidSolution(grid, work),
    [grid, work],
  )

  const wrongChain = walletClient?.chain !== undefined && walletClient.chain.id !== deployment.chainId
  const busy = status === 'proving' || status === 'checking' || status === 'submitting'

  const attest = async () => {
    if (!walletClient?.account || !grid || !myAddress || !lastSolve) return
    setAttestMessage(undefined)
    setAttestUid(undefined)
    try {
      setAttestStatus('attesting')
      const { txHash: hash, uid } = await attestSudokuSolve(deployment, walletClient, {
        puzzleId: PUZZLE_ID,
        player: lastSolve.player,
        nullifier: lastSolve.nullifier,
        proof: lastSolve.proof,
        puzzle: grid.map((c) => BigInt(c)),
        recipient: myAddress,
      })
      setAttestUid(uid)
      setAttestStatus('done')
      setAttestMessage(`attested — uid ${uid ? `${uid.slice(0, 10)}…` : hash}`)
      setAttestedRows((s) => new Set([...s, lastSolve.nullifier.toString()]))
    } catch (e) {
      setAttestStatus('error')
      const raw = e instanceof Error ? e.message : String(e)
      setAttestMessage(raw.includes('NullifierSpent') ? 'this solve is already attested' : raw)
    }
  }

  const setCell = (i: number, v: number) => {
    if (clues[i]) return
    setWork((w) => {
      const next = [...w]
      next[i] = v
      return next
    })
  }

  const submit = async () => {
    if (!walletClient?.account || !grid || !myAddress) return
    setMessage(undefined)
    setTxHash(undefined)
    try {
      const player = BigInt(myAddress)

      setStatus('proving')
      const { proof, nullifier, player: provenPlayer } = await proveSudokuSolve({
        puzzle: grid,
        solution: work,
        player,
      })
      setLastSolve({ proof, nullifier, player: provenPlayer })

      // A copied/duplicate proof would revert — surface the friendly "already solved" case up front.
      setStatus('checking')
      if (await checkNullifierSpent(deployment, nullifier)) {
        setStatus('error')
        setMessage('this exact solution was already logged for your address (nullifier spent) — nothing more to submit')
        return
      }

      setStatus('submitting')
      const receipt = await sendGameTx(deployment, walletClient, {
        address: deployment.sudokuLog!,
        abi: sudokuLogAbi as viem.Abi,
        functionName: 'logSolve',
        args: [PUZZLE_ID, proof, grid.map((c) => BigInt(c)), provenPlayer, nullifier],
      })
      setTxHash(receipt.transactionHash)
      setStatus('done')
      setMessage('Solved on-chain — your time is on the board.')
      sudoku.refresh()
    } catch (e) {
      setStatus('error')
      setMessage(e instanceof Error ? e.message : String(e))
    }
  }

  // ── gate: no contract on this chain ──
  if (!deployment.sudokuLog) {
    return (
      <div className="card">
        <h3>ZK Sudoku</h3>
        <p className="muted">No SudokuLog contract is configured for {deployment.label}. Switch to PulseChain or the v4 testnet to play.</p>
      </div>
    )
  }

  const ready = grid !== undefined && work.length === 81
  const solves = sudoku.leaderboard.length
  const statusHint = busy ? 'proving…' : complete ? 'ready' : ready ? 'fill the grid' : 'loading'

  return (
    <>
      <GameStage title="ZK SUDOKU" subtitle={`puzzle #${PUZZLE_ID.toString()} · prove without revealing`}>
        <PuzzleBoard
          tone="sudoku"
          head={
            ready ? (
              <>
                <span className="muted">board verified <span className="mono">{sudoku.puzzle?.puzzleHash?.slice(0, 10)}…</span></span>
                {!complete && conflicts.size > 0 && <span className="bad">fix the highlighted conflicts</span>}
                {!complete && conflicts.size === 0 && <span>fill every cell to submit</span>}
                {complete && <span className="ok">valid solution — ready to prove</span>}
              </>
            ) : (
              <span className="muted">
                {sudoku.error ? `chain read failed: ${sudoku.error}` : sudoku.loading ? 'loading puzzle…' : `puzzle #${PUZZLE_ID.toString()} not open yet`}
              </span>
            )
          }
        >
          {ready ? (
            <Board grid={work} clues={clues} conflicts={conflicts} disabled={busy} onCell={setCell} />
          ) : (
            <div className="puz-wait muted">{sudoku.puzzle?.gridProblem ?? (sudoku.loading ? 'loading…' : 'puzzle not open')}</div>
          )}
        </PuzzleBoard>
      </GameStage>

      <div className="tray-col">
        <ControlTray
          title="Solve"
          hint={statusHint}
          action={
            <button className="primary" onClick={() => void submit()} disabled={!walletClient || !myAddress || wrongChain || !complete || busy}>
              {status === 'proving' ? 'Proving… (~15s)' : status === 'checking' ? 'Checking…' : status === 'submitting' ? 'Submitting…' : 'Prove & submit'}
            </button>
          }
        >
          <button className="secondary" style={{ width: '100%' }} onClick={() => grid && setWork([...grid])} disabled={busy}>
            Reset
          </button>
          {!walletClient && <p className="tray-hint">connect a wallet to submit</p>}
          {walletClient && wrongChain && <p className="bad">switch your wallet to {deployment.label}</p>}
          {walletClient && !wrongChain && !trustAcknowledged && <p className="tray-hint">solving is trustless — no acknowledgement needed</p>}
          {status === 'proving' && <p className="tray-hint">generating the PLONK proof in a Web Worker (first run downloads the ~66 MB key, cached after)…</p>}
          {message && <p className={status === 'done' ? 'ok' : 'bad'}>{message}</p>}
          {lastSolve && sudokuEasReady(deployment) && (
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="secondary"
                onClick={() => void attest()}
                disabled={attestStatus === 'attesting' || attestStatus === 'done' || wrongChain}
              >
                {attestStatus === 'attesting' ? 'Attesting…' : attestStatus === 'done' ? 'Attested ✓' : 'Record to EAS'}
              </button>
              <InfoDot label="what an EAS attestation is">
                Optionally record the same proven solve as an <strong>EAS attestation</strong> — a standard, composable
                credential other apps can read. It is gated by an on-chain resolver that re-verifies your PLONK proof, so
                the attestation can only exist because the solve is real, and it can never be revoked.
              </InfoDot>
              {attestMessage && <span className={attestStatus === 'done' ? 'ok' : 'bad'}>{attestMessage}</span>}
              {attestUid && <span className="mono muted">{attestUid.slice(0, 14)}…</span>}
            </div>
          )}
          {txHash && (
            <p className="card-meta muted">
              tx{' '}
              {deployment.explorer ? (
                <a href={`${deployment.explorer}/tx/${txHash}`} target="_blank" rel="noreferrer" className="mono">{short(txHash)}</a>
              ) : (
                <span className="mono">{short(txHash)}</span>
              )}
            </p>
          )}
        </ControlTray>

        <MetaPanel tabs={['Puzzle', 'Solvers']}>
          <span>
            puzzle #{PUZZLE_ID.toString()} · <b>{solves}</b> solve{solves === 1 ? '' : 's'}
            {sudoku.puzzle?.openedAt && <span className="muted"> · opened {new Date(sudoku.puzzle.openedAt * 1000).toLocaleDateString()}</span>}
          </span>
        </MetaPanel>
      </div>

      <h2>Leaderboard</h2>
      <details className="history" open>
        <summary>
          {solves} solve{solves === 1 ? '' : 's'}
          <span className="muted"> · ranked by time · source {sudoku.source === 'indexer' ? 'indexer' : sudoku.source === 'logs' ? 'chain logs' : '—'}</span>
        </summary>
        <LeaderRows rows={sudoku.leaderboard} myAddress={myAddress} attested={attestedRows} />
      </details>
    </>
  )
}
