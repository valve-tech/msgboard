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
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(9, 2.4rem)',
      gridTemplateRows: 'repeat(9, 2.4rem)',
      gap: 0,
      width: 'max-content',
      background: 'var(--felt-700)',
    }}
  >
    {grid.map((v, i) => {
      const r = Math.floor(i / 9)
      const c = i % 9
      const isClue = clues[i]
      const bad = conflicts.has(i)
      // 3-colour the nine 3x3 boxes diagonally → three distinct colour groupings across the board.
      const boxGroup = (Math.floor(r / 3) + Math.floor(c / 3)) % 3
      const groupTint = ['rgba(184, 134, 11, 0.10)', 'rgba(60, 150, 105, 0.15)', 'rgba(95, 125, 175, 0.13)'][boxGroup]
      return (
        <input
          key={i}
          value={v === 0 ? '' : String(v)}
          disabled={disabled || isClue}
          inputMode="numeric"
          maxLength={1}
          aria-label={`cell r${r + 1} c${c + 1}`}
          onChange={(e) => {
            const ch = e.target.value.replace(/[^1-9]/g, '').slice(-1)
            onCell(i, ch ? Number(ch) : 0)
          }}
          style={{
            width: '2.4rem',
            height: '2.4rem',
            borderRadius: 0, // square cells so the 3x3 box rules read as one continuous line
            textAlign: 'center',
            fontFamily: 'var(--mono)',
            fontSize: '1.1rem',
            fontWeight: isClue ? 700 : 500,
            color: bad ? 'var(--bad)' : isClue ? 'var(--cream)' : 'var(--brass)',
            background: isClue
              ? `linear-gradient(rgba(0, 0, 0, 0.30), rgba(0, 0, 0, 0.30)), ${groupTint}`
              : groupTint,
            // Each cell paints only its top + left edge (plus the board's right/bottom rim), so no
            // two cells ever double a line. Thin green for the minor grid, a thick solid brass rule
            // on every 3x3 box boundary → clearly joined group lines.
            borderTop: r % 3 === 0 ? '3px solid var(--brass-soft)' : '1px solid var(--line)',
            borderLeft: c % 3 === 0 ? '3px solid var(--brass-soft)' : '1px solid var(--line)',
            borderRight: c === 8 ? '3px solid var(--brass-soft)' : 'none',
            borderBottom: r === 8 ? '3px solid var(--brass-soft)' : 'none',
            outline: 'none',
          }}
        />
      )
    })}
  </div>
)

const Leaderboard = ({
  rows,
  source,
  myAddress,
  attested,
}: {
  rows: LeaderboardRow[]
  source: string
  myAddress?: viem.Hex
  attested: Set<string>
}) => (
  <div className="card">
    <h3>Leaderboard</h3>
    {rows.length === 0 ? (
      <p className="muted">No solves logged yet — be the first to post a time.</p>
    ) : (
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left' }}>
            <th className="muted">#</th>
            <th className="muted">player</th>
            <th className="muted">time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const addr = playerAddr(row.player)
            const mine = myAddress && addr.toLowerCase() === myAddress.toLowerCase()
            return (
              <tr key={row.nullifier.toString()}>
                <td>{row.rank}</td>
                <td className="mono">
                  {short(addr)}
                  {mine && <span className="tag ok" style={{ marginLeft: '0.4rem' }}>you</span>}
                  {attested.has(row.nullifier.toString()) && (
                    <span className="tag gold" style={{ marginLeft: '0.4rem' }} title="also recorded as an EAS attestation (proof-gated by the on-chain resolver)">
                      EAS
                    </span>
                  )}
                </td>
                <td>{fmtElapsed(row.elapsed)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    )}
    <p className="card-meta muted">source: {source === 'indexer' ? 'games indexer' : source === 'logs' ? 'chain logs' : '—'}</p>
  </div>
)

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

  // ── gates ──
  if (!deployment.sudokuLog) {
    return (
      <div className="card">
        <h3>ZK Sudoku</h3>
        <p className="muted">No SudokuLog contract is configured for {deployment.label}. Switch to PulseChain or the v4 testnet to play.</p>
      </div>
    )
  }

  return (
    <div>
      <div className="card">
        <h3>
          ZK Sudoku — puzzle #{PUZZLE_ID.toString()}
          <InfoDot>
            <strong>Solve the live on-chain puzzle, prove it in your browser, post your time.</strong> The board's
            hash is pinned on-chain; your browser proves you hold a valid solution (a PLONK proof, generated in a
            Web Worker — never revealing the solution) and submits it. The leaderboard ranks solvers by elapsed time
            since the puzzle opened.
          </InfoDot>
        </h3>

        {sudoku.loading && !sudoku.puzzle && <p className="muted">Loading puzzle…</p>}
        {sudoku.error && <p className="bad">chain read failed: {sudoku.error}</p>}

        {sudoku.puzzle && !sudoku.puzzle.opened && (
          <p className="muted">Puzzle #{PUZZLE_ID.toString()} is not open yet on {deployment.label}.</p>
        )}
        {sudoku.puzzle?.gridProblem && <p className="bad">{sudoku.puzzle.gridProblem}</p>}

        {grid && work.length === 81 && (
          <>
            <p className="card-meta muted">
              board verified against on-chain hash <span className="mono">{sudoku.puzzle?.puzzleHash?.slice(0, 10)}…</span>
              {sudoku.puzzle?.openedAt ? ` · opened ${new Date(sudoku.puzzle.openedAt * 1000).toLocaleString()}` : ''}
            </p>
            <div style={{ margin: '0.75rem 0' }}>
              <Board grid={work} clues={clues} conflicts={conflicts} disabled={busy} onCell={setCell} />
            </div>
            <div className="row">
              <button onClick={() => void submit()} disabled={!walletClient || !myAddress || wrongChain || !complete || busy}>
                {status === 'proving'
                  ? 'Proving… (~15s)'
                  : status === 'checking'
                    ? 'Checking…'
                    : status === 'submitting'
                      ? 'Submitting…'
                      : 'Prove & submit'}
              </button>
              <button className="secondary" onClick={() => setWork([...grid])} disabled={busy}>
                Reset
              </button>
              {!walletClient && <span className="muted">connect a wallet to submit</span>}
              {walletClient && wrongChain && <span className="bad">switch your wallet to {deployment.label}</span>}
              {walletClient && !wrongChain && !trustAcknowledged && (
                <span className="muted">solving is trustless — no acknowledgement needed</span>
              )}
            </div>
            <p className="muted">
              {!complete && conflicts.size > 0 && <span className="bad">fix the highlighted conflicts · </span>}
              {!complete && conflicts.size === 0 && <span>fill every cell to enable submit</span>}
              {complete && <span className="ok">valid solution — ready to prove</span>}
            </p>
            {status === 'proving' && (
              <p className="muted">
                Generating the PLONK proof in a Web Worker. First run also downloads the ~66 MB proving key (cached
                after); proving itself is a few seconds and never blocks this tab.
              </p>
            )}
            {message && <p className={status === 'done' ? 'ok' : 'bad'}>{message}</p>}
            {lastSolve && sudokuEasReady(deployment) && (
              <div className="row">
                <button
                  className="secondary"
                  onClick={() => void attest()}
                  disabled={attestStatus === 'attesting' || attestStatus === 'done' || wrongChain}
                >
                  {attestStatus === 'attesting' ? 'Attesting…' : attestStatus === 'done' ? 'Attested ✓' : 'Record to EAS'}
                </button>
                <InfoDot label="what an EAS attestation is">
                  Optionally record the same proven solve as an <strong>EAS attestation</strong> — a standard,
                  composable credential other apps can read. It is gated by an on-chain resolver that re-verifies
                  your PLONK proof, so the attestation can only exist because the solve is real, and it can never
                  be revoked. Same proof, second canonical record; the leaderboard entry above stands either way.
                </InfoDot>
                {attestMessage && <span className={attestStatus === 'done' ? 'ok' : 'bad'}>{attestMessage}</span>}
                {attestUid && <span className="mono muted">{attestUid.slice(0, 14)}…</span>}
              </div>
            )}
            {txHash && (
              <p className="card-meta muted">
                tx{' '}
                {deployment.explorer ? (
                  <a href={`${deployment.explorer}/tx/${txHash}`} target="_blank" rel="noreferrer" className="mono">
                    {short(txHash)}
                  </a>
                ) : (
                  <span className="mono">{short(txHash)}</span>
                )}
              </p>
            )}
          </>
        )}
      </div>

      <Leaderboard rows={sudoku.leaderboard} source={sudoku.source} myAddress={myAddress} attested={attestedRows} />
    </div>
  )
}
