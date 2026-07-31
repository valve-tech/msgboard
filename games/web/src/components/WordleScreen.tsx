import { Toggle } from './Toggle'
import { useMemo, useState, type ReactNode } from 'react'
import * as viem from 'viem'
import { createMsgBoardClient, post } from '@msgboard/games'
import { wordleCommit, wordToIndices } from '@msgboard/zk-skill/wordle'
import { WORDLE_VALID_GUESSES } from '@msgboard/zk-skill/wordleSolve'
import type { GameDeployment } from '../config'
import { useWordle, saveSecret, loadSecret, type WordleRole, type GuessRow, type WordleSecret } from '../hooks/useWordle'
import { wordleCategory } from '../hooks/useWordleBoard'
import { wordleLogAbi } from '../lib/wordleContract'
import { attestWordleSolve, wordleEasReady } from '../lib/easAttest'
import type { SolveProof } from '../lib/wordleProving'
import { sendGameTx } from '../tx'
import { InfoDot } from './Meta'
import { GameStage } from './shell/GameStage'
import { HowItWorksLink } from './HowItWorks'
import { ControlTray } from './shell/ControlTray'
import { MetaPanel } from './shell/MetaPanel'
import { PuzzleBoard } from './stages/PuzzleBoard'

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const short = (a?: viem.Hex) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')
const idxToWord = (idx: number[]) => idx.map((i) => LETTERS[i] ?? '?').join('')
const validGuesses = new Set(WORDLE_VALID_GUESSES)

/** Cryptographically-random field-safe salt (31 bytes < bn128 scalar field). */
const randomSalt = (): bigint => {
  const b = new Uint8Array(31)
  crypto.getRandomValues(b)
  return BigInt('0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join(''))
}
/** A random uint256-range challenge id (decimal string) — the shareable challenge code + on-chain id. */
const randomChallengeId = (): string => randomSalt().toString()

// ── the Wordle tiles (restyled onto .wg-* — was inline styles) ─────────────────────────────────────
const WordleGrid = ({ rows, maxRows = 6 }: { rows: GuessRow[]; maxRows?: number }) => (
  <div className="wg-grid">
    {Array.from({ length: maxRows }).map((_, r) => {
      const row = rows[r]
      return (
        <div className="wg-row" key={r}>
          {Array.from({ length: 5 }).map((_, ci) => {
            if (!row) return <div className="wg-tile" key={ci} />
            const letter = LETTERS[row.guess[ci] ?? -1] ?? ''
            const clue = row.clue?.[ci]
            const cls = [
              'wg-tile',
              row.status === 'cheat' ? 'cheat' : clue === 2 ? 'g2' : clue === 1 ? 'g1' : clue === 0 ? 'g0' : '',
              row.status === 'pending' ? 'pending' : '',
              letter ? 'filled' : '',
            ]
              .filter(Boolean)
              .join(' ')
            return (
              <div className={cls} key={ci}>
                {letter}
              </div>
            )
          })}
        </div>
      )
    })}
  </div>
)

// ── setter activity log: who guessed what, and whether we proved the clue ──
const ActivityLog = ({ game, me }: { game: ReturnType<typeof useWordle>; me?: viem.Hex }) => {
  const guesses = game.messages.filter((m) => m.t === 'guess')
  if (guesses.length === 0) return <p className="puz-wait muted">No guesses yet. Waiting for a friend to join…</p>
  const clueFor = (guesser: string, n: number) =>
    game.messages.find(
      (m) => m.t === 'clue' && (m as { guesser: string }).guesser.toLowerCase() === guesser.toLowerCase() && (m as { n: number }).n === n,
    ) as { clue: number[] } | undefined
  return (
    <table className="wg-log">
      <thead>
        <tr>
          <th className="muted">player</th>
          <th className="muted">#</th>
          <th className="muted">guess</th>
          <th className="muted">clue</th>
        </tr>
      </thead>
      <tbody>
        {guesses.map((g) => {
          const gg = g as { guesser: viem.Hex; n: number; guess: number[]; id: string }
          const clue = clueFor(gg.guesser, gg.n)
          const mine = me && gg.guesser.toLowerCase() === me.toLowerCase()
          return (
            <tr key={gg.id}>
              <td className="mono">
                {short(gg.guesser)}
                {mine && <span className="tag">you</span>}
              </td>
              <td>{gg.n + 1}</td>
              <td className="mono" style={{ textTransform: 'uppercase' }}>{idxToWord(gg.guess)}</td>
              <td>{clue ? clue.clue.map((c) => (c === 2 ? '🟩' : c === 1 ? '🟨' : '⬛')).join('') : <span className="muted">proving…</span>}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// Fresh transport just for the one-shot `open` notice (keeps openChallenge synchronous with the UI).
const postOpenNotice = async (deployment: GameDeployment, id: string, commit: bigint, setter: viem.Hex) => {
  // Mint PoW in a throwaway worker (never on the UI thread).
  const worker = new Worker(new URL('../workers/powWorker.ts', import.meta.url), { type: 'module' })
  try {
    const board = createMsgBoardClient(deployment.boardRpc!)
    const notice = { v: 1 as const, t: 'open' as const, id: `${id}-open`, challengeId: id, commit: commit.toString(), setter, at: Date.now() }
    await post({
      board,
      category: wordleCategory(deployment.chainId, id),
      notice,
      stamp: (input) =>
        new Promise((resolve, reject) => {
          const jobId = 1
          worker.onmessage = (e: MessageEvent<{ id: number; packed?: Uint8Array; error?: string }>) => {
            const { packed, error } = e.data
            if (error || !packed) return reject(new Error(error ?? 'stamp failed'))
            resolve({
              nonce: BigInt(viem.bytesToHex(packed.slice(0, 8))),
              hash: viem.bytesToHex(packed.slice(8)) as viem.Hex,
            })
          }
          worker.onerror = () => reject(new Error('grinder worker error'))
          worker.postMessage({
            id: jobId,
            category: viem.hexToBytes(input.category),
            data: viem.hexToBytes(input.data),
            wm: Number(input.workMultiplier),
            wd: Number(input.workDivisor),
            blockHash: viem.hexToBytes(input.blockHash),
            maxIters: 50_000_000,
          })
        }),
    })
  } finally {
    worker.terminate()
  }
}

/**
 * ZK Wordle — a P2P setter/guesser game, on the shared PuzzleBoard surface. A setter commits
 * Poseidon(word, salt) then proves every clue honest with a wordle_clue PLONK proof (generated in a
 * Web Worker) posted over MsgBoard; your browser verifies each proof, so no one can cheat the colours.
 * Non-wagered. This is a PRESENTATION-ONLY reframe: every hook, proof handler, on-chain anchor and EAS
 * attestation is preserved verbatim — only the board (tiles / activity log) moves onto the immersive
 * surface and the controls into the docked ControlTray.
 */
export const WordleScreen = ({
  deployment,
  walletClient,
  myAddress,
}: {
  deployment: GameDeployment
  walletClient?: viem.WalletClient
  trustAcknowledged: boolean
  myAddress?: viem.Hex
}) => {
  const [role, setRole] = useState<WordleRole>('setter')

  // Setter state
  const [wordInput, setWordInput] = useState('')
  const [setterChallengeId, setSetterChallengeId] = useState<string | null>(null)
  const [secret, setSecret] = useState<WordleSecret | undefined>()
  const [openOnChain, setOpenOnChain] = useState(false)
  const [openStatus, setOpenStatus] = useState<'idle' | 'committing' | 'posting' | 'chain' | 'done' | 'error'>('idle')
  const [openError, setOpenError] = useState<string>()
  const [openTx, setOpenTx] = useState<viem.Hex>()

  // Guesser state
  const [joinInput, setJoinInput] = useState('')
  const [guesserChallengeId, setGuesserChallengeId] = useState<string | null>(null)
  const [guessInput, setGuessInput] = useState('')

  // Guesser EAS-attest state (hoisted from the old GuesserPanel).
  const [attestStatus, setAttestStatus] = useState<'idle' | 'attesting' | 'done' | 'error'>('idle')
  const [attestMessage, setAttestMessage] = useState<string>()
  const [attestUid, setAttestUid] = useState<viem.Hex>()

  const challengeId = role === 'setter' ? setterChallengeId : guesserChallengeId
  const wrongChain = walletClient?.chain !== undefined && walletClient.chain.id !== deployment.chainId

  // on-chain anchor callback for the guesser (WordleLog.logSolve). Undefined on the wrong chain so the
  // win falls back to the msgboard-only proof rather than attempting a doomed cross-chain submit.
  const onChainAnchor = useMemo(() => {
    if (!deployment.wordleLog || !walletClient || !challengeId || wrongChain) return undefined
    return async (proof: SolveProof): Promise<viem.Hex> => {
      const receipt = await sendGameTx(deployment, walletClient, {
        address: deployment.wordleLog!,
        abi: wordleLogAbi as viem.Abi,
        functionName: 'logSolve',
        args: [BigInt(challengeId), proof.calldata, proof.guessesCommit, proof.dictRoot, BigInt(proof.guessesUsed)],
      })
      return receipt.transactionHash
    }
  }, [deployment, walletClient, challengeId, wrongChain])

  const game = useWordle({
    deployment,
    myAddress,
    walletClient,
    role,
    challengeId,
    secret: role === 'setter' ? secret : undefined,
    onChainAnchor,
  })

  const wordClean = wordInput.trim().toLowerCase()
  const wordValid = /^[a-z]{5}$/.test(wordClean) && validGuesses.has(wordClean)

  const openChallenge = async () => {
    if (!wordValid || !myAddress) return
    setOpenError(undefined)
    setOpenTx(undefined)
    try {
      setOpenStatus('committing')
      const word = wordToIndices(wordClean)
      const salt = randomSalt()
      const commit = await wordleCommit(word, salt)
      const id = randomChallengeId()
      const sec: WordleSecret = { word, salt: salt.toString() }
      saveSecret(deployment.chainId, id, sec)
      setSecret(sec)
      setSetterChallengeId(id)

      // Optional: open the challenge on-chain first (required for friends to anchor their win later).
      if (openOnChain) {
        if (!walletClient || wrongChain) throw new Error(`connect a wallet on ${deployment.label} to open on-chain`)
        if (!deployment.wordleLog) throw new Error(`no WordleLog on ${deployment.label}`)
        setOpenStatus('chain')
        const receipt = await sendGameTx(deployment, walletClient, {
          address: deployment.wordleLog,
          abi: wordleLogAbi as viem.Abi,
          functionName: 'openChallenge',
          args: [BigInt(id), commit],
        })
        setOpenTx(receipt.transactionHash)
      }

      // Announce the challenge on the board (the guesser needs the commit to verify clue proofs). Posted
      // through a fresh throwaway transport so the flow stays synchronous with the button; the game
      // hook (bound to the new challengeId) then polls it back like any other message.
      setOpenStatus('posting')
      await postOpenNotice(deployment, id, commit, myAddress!)
      setOpenStatus('done')
    } catch (e) {
      setOpenStatus('error')
      setOpenError(e instanceof Error ? e.message : String(e))
    }
  }

  const resumeSetter = () => {
    const id = joinInput.trim()
    if (!id) return
    const sec = loadSecret(deployment.chainId, id)
    if (!sec) {
      setOpenError('no saved word for that challenge id on this device')
      return
    }
    setSecret(sec)
    setSetterChallengeId(id)
    setOpenStatus('done')
    setOpenError(undefined)
  }

  const join = () => {
    const id = joinInput.trim()
    if (id) setGuesserChallengeId(id)
  }

  const submitGuess = async () => {
    await game.submitGuess(guessInput)
    setGuessInput('')
  }

  // Record the proven solve as an EAS attestation (proof-gated by the on-chain resolver; the
  // resolver requires recipient == attester, mirroring WordleLog's msg.sender binding).
  const attest = async () => {
    const proof = game.solve.proof
    if (!walletClient?.account || !myAddress || !proof || !challengeId) return
    setAttestMessage(undefined)
    setAttestUid(undefined)
    try {
      setAttestStatus('attesting')
      const { txHash, uid } = await attestWordleSolve(deployment, walletClient, {
        challengeId: BigInt(challengeId),
        guessesUsed: BigInt(proof.guessesUsed),
        guessesCommit: proof.guessesCommit,
        proof: proof.calldata,
        recipient: myAddress,
      })
      setAttestUid(uid)
      setAttestStatus('done')
      setAttestMessage(`attested — uid ${uid ? `${uid.slice(0, 10)}…` : txHash}`)
    } catch (e) {
      setAttestStatus('error')
      const raw = e instanceof Error ? e.message : String(e)
      setAttestMessage(raw.includes('AlreadyAttested') ? 'this solve is already attested' : raw)
    }
  }

  // ── gate: no MsgBoard RPC (the setter↔guesser exchange can't run) ──
  if (!deployment.boardRpc) {
    return (
      <div className="card">
        <h3>ZK Wordle</h3>
        <p className="muted">
          No MsgBoard RPC is configured for {deployment.label}, so the setter↔guesser exchange can't run. Switch to
          PulseChain or the v4 testnet.
        </p>
      </div>
    )
  }

  const busyOpen = openStatus === 'committing' || openStatus === 'posting' || openStatus === 'chain'
  const canGuess = !!myAddress && !game.solved && game.rows.every((r) => r.status !== 'pending')
  const canAnchor = deployment.wordleLog && !!walletClient && !wrongChain && !!game.reveal

  // ── the board on the surface: tile grid for the guesser, activity log for the setter, else idle ──
  const surface =
    role === 'guesser' && challengeId ? (
      <WordleGrid rows={game.rows} />
    ) : role === 'setter' && challengeId ? (
      <ActivityLog game={game} me={myAddress} />
    ) : (
      <p className="puz-wait muted">
        {role === 'setter'
          ? 'commit a hidden 5-letter word — friends join with the code and guess it'
          : 'paste the challenge code a friend shared to join their board'}
      </p>
    )

  // ── the header line above the board ──
  const head =
    challengeId && role === 'guesser' ? (
      game.cheatDetected ? (
        <span className="bad">⚠ a clue proof FAILED verification — the setter is cheating the colours. Stop playing.</span>
      ) : (
        <span className="muted">
          joined <span className="mono">{challengeId.slice(0, 10)}…</span> · board {game.boardReady ? 'connected' : 'connecting…'}
          {game.commit ? '' : ' · waiting for the setter’s commitment…'}
        </span>
      )
    ) : challengeId && role === 'setter' ? (
      <span className="muted">
        board {game.boardReady ? 'connected' : 'connecting…'} · clues proven {game.cluesAnswered} · pending {game.pendingGuesses}
        {game.setterStatus === 'proving' && ' · proving a clue…'}
      </span>
    ) : (
      <span className="muted">ZK Wordle — a setter hides a word, friends prove-fairly guess it</span>
    )

  // ── the docked control panel: role toggle + role/state-specific controls + primary action ──
  const roleToggle = (
    <div className="acts" style={{ marginTop: 0 }}>
      <button className={role === 'setter' ? 'b-double' : 'secondary'} onClick={() => setRole('setter')}>Set a word</button>
      <button className={role === 'guesser' ? 'b-double' : 'secondary'} onClick={() => setRole('guesser')}>Join & guess</button>
    </div>
  )

  let action: ReactNode
  let controls: ReactNode

  if (role === 'setter' && !setterChallengeId) {
    action = (
      <button className="primary" onClick={() => void openChallenge()} disabled={!wordValid || !myAddress || busyOpen || (openOnChain && wrongChain)}>
        {openStatus === 'committing' ? 'Committing…' : openStatus === 'chain' ? 'Opening on-chain…' : openStatus === 'posting' ? 'Posting to board…' : 'Open challenge'}
      </button>
    )
    controls = (
      <>
        {roleToggle}
        <input
          className="puz-input"
          value={wordInput}
          onChange={(e) => setWordInput(e.target.value.replace(/[^a-zA-Z]/g, '').slice(0, 5))}
          placeholder="e.g. crane"
          maxLength={5}
        />
        <Toggle checked={openOnChain} onChange={setOpenOnChain}>also open on-chain (lets friends anchor their win)</Toggle>
        <p className="tray-hint">
          {wordClean.length === 5 && !wordValid && <span className="bad">not in the Wordle dictionary</span>}
          {wordValid && <span className="ok">valid word</span>}
          {openOnChain && !deployment.wordleLog && <span className="bad"> · no WordleLog on {deployment.label}</span>}
          {openOnChain && wrongChain && <span className="bad"> · switch to {deployment.label}</span>}
        </p>
        {!myAddress && <p className="tray-hint">connect a wallet — your address is your player identity</p>}
        {openError && <p className="bad">{openError}</p>}
        <details>
          <summary className="muted">Resume a challenge you set on this device</summary>
          <div className="row" style={{ marginTop: 6 }}>
            <input className="puz-input" style={{ flex: 1 }} value={joinInput} onChange={(e) => setJoinInput(e.target.value)} placeholder="challenge id" />
            <button className="secondary" onClick={resumeSetter}>Resume</button>
          </div>
        </details>
      </>
    )
  } else if (role === 'setter' && setterChallengeId) {
    action = (
      <button className="primary" onClick={() => void navigator.clipboard?.writeText(setterChallengeId)}>Copy challenge code</button>
    )
    controls = (
      <>
        {roleToggle}
        <p className="ok" style={{ margin: '4px 0' }}>Challenge open — share this code so a friend can guess:</p>
        <code className="puz-code">{setterChallengeId}</code>
        {openTx && (
          <p className="card-meta muted">
            opened on-chain · tx{' '}
            {deployment.explorer ? (
              <a href={`${deployment.explorer}/tx/${openTx}`} target="_blank" rel="noreferrer" className="mono">{short(openTx)}</a>
            ) : (
              <span className="mono">{short(openTx)}</span>
            )}
          </p>
        )}
        {game.setterError && <p className="bad">clue proof failed: {game.setterError}</p>}
      </>
    )
  } else if (role === 'guesser' && !guesserChallengeId) {
    action = <button className="primary" onClick={join} disabled={!joinInput.trim()}>Join</button>
    controls = (
      <>
        {roleToggle}
        <input className="puz-input" value={joinInput} onChange={(e) => setJoinInput(e.target.value)} placeholder="paste challenge id" />
      </>
    )
  } else {
    // guesser, joined
    if (!game.solved) {
      action = (
        <button className="primary" onClick={() => void submitGuess()} disabled={!canGuess || guessInput.length !== 5 || game.submitting}>
          {game.submitting ? 'Posting…' : game.rows.some((r) => r.status === 'pending') ? 'Awaiting clue…' : 'Guess'}
        </button>
      )
      controls = (
        <>
          {roleToggle}
          <input
            className="puz-input"
            value={guessInput}
            onChange={(e) => setGuessInput(e.target.value.replace(/[^a-zA-Z]/g, '').slice(0, 5))}
            placeholder="your guess"
            maxLength={5}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canGuess && guessInput.length === 5) void submitGuess()
            }}
          />
          {!myAddress && <p className="tray-hint">connect a wallet to guess</p>}
          {game.submitError && <p className="bad">{game.submitError}</p>}
        </>
      )
    } else {
      action = game.reveal ? (
        <button className="primary" onClick={() => void game.anchorWin()} disabled={game.solve.status === 'proving' || game.solve.status === 'submitting'}>
          {game.solve.status === 'proving'
            ? 'Proving solve… (~10-30s)'
            : game.solve.status === 'submitting'
              ? 'Submitting…'
              : canAnchor
                ? 'Prove & anchor win on-chain'
                : 'Prove my win (msgboard only)'}
        </button>
      ) : (
        <button className="primary" disabled>Solved — awaiting reveal…</button>
      )
      controls = (
        <>
          {roleToggle}
          <p className="ok" style={{ margin: '4px 0' }}>Solved in {game.guessesUsed} {game.guessesUsed === 1 ? 'guess' : 'guesses'}! Every clue proof verified.</p>
          {!game.reveal && <p className="tray-hint">waiting for the setter to reveal the word so you can build a solve proof…</p>}
          {game.solve.status === 'proving' && (
            <p className="tray-hint">Building the wordle_solve witness + PLONK proof in a Web Worker (first run downloads the ~33 MB key, cached after).</p>
          )}
          {game.solve.message && <p className={game.solve.status === 'done' ? 'ok' : 'bad'}>{game.solve.message}</p>}
          {game.solve.txHash && (
            <p className="card-meta muted">
              tx{' '}
              {deployment.explorer ? (
                <a href={`${deployment.explorer}/tx/${game.solve.txHash}`} target="_blank" rel="noreferrer" className="mono">{short(game.solve.txHash)}</a>
              ) : (
                <span className="mono">{short(game.solve.txHash)}</span>
              )}
            </p>
          )}
          {deployment.wordleLog && !walletClient && <p className="tray-hint">connect a wallet to anchor on-chain</p>}
          {deployment.wordleLog && walletClient && wrongChain && <p className="bad">switch to {deployment.label} to anchor</p>}
          {game.solve.proof && wordleEasReady(deployment) && !!walletClient && !wrongChain && (
            <div className="row" style={{ marginTop: 8 }}>
              <button className="secondary" onClick={() => void attest()} disabled={attestStatus === 'attesting' || attestStatus === 'done'}>
                {attestStatus === 'attesting' ? 'Attesting…' : attestStatus === 'done' ? 'Attested ✓' : 'Record to EAS'}
              </button>
              <InfoDot label="what an EAS attestation is">
                Optionally record the same proven win as an <strong>EAS attestation</strong> — a standard, composable
                credential other apps can read. An on-chain resolver re-verifies your solve proof before the attestation
                can exist, and it can never be revoked.
              </InfoDot>
              {attestMessage && <span className={attestStatus === 'done' ? 'ok' : 'bad'}>{attestMessage}</span>}
              {attestUid && <span className="mono muted">{attestUid.slice(0, 14)}…</span>}
            </div>
          )}
        </>
      )
    }
  }

  return (
    <>
      <GameStage title="ZK WORDLE" subtitle="set a word · friends prove-fairly guess it" action={<HowItWorksLink />}>
        <PuzzleBoard tone="wordle" head={head}>
          {surface}
        </PuzzleBoard>
      </GameStage>

      <div className="tray-col">
        <ControlTray title={role === 'setter' ? 'Set a word' : 'Join & guess'} action={action}>
          {controls}
        </ControlTray>

        <MetaPanel tabs={['Challenge', 'Proofs']}>
          <span>
            {challengeId ? (
              <>
                <span className="mono">{challengeId.slice(0, 10)}…</span> · board {game.boardReady ? 'connected' : '…'}
                {role === 'setter' && <span className="muted"> · {game.cluesAnswered} clues proven</span>}
                {role === 'guesser' && <span className="muted"> · {game.guessesUsed} guess{game.guessesUsed === 1 ? '' : 'es'}</span>}
              </>
            ) : (
              <span className="muted">no challenge yet — {role === 'setter' ? 'set a word' : 'join with a code'}</span>
            )}
          </span>
        </MetaPanel>
      </div>
    </>
  )
}
