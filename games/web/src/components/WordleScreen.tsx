import { Toggle } from './Toggle'
import { useMemo, useState } from 'react'
import * as viem from 'viem'
import { createMsgBoardClient, post } from '@msgboard/games'
import { wordleCommit, wordToIndices, type Clue } from '@msgboard/zk-skill/wordle'
import { WORDLE_VALID_GUESSES } from '@msgboard/zk-skill/wordleSolve'
import type { GameDeployment } from '../config'
import { useWordle, saveSecret, loadSecret, type WordleRole, type GuessRow, type WordleSecret } from '../hooks/useWordle'
import { wordleCategory } from '../hooks/useWordleBoard'
import { wordleLogAbi } from '../lib/wordleContract'
import { attestWordleSolve, wordleEasReady } from '../lib/easAttest'
import type { SolveProof } from '../lib/wordleProving'
import { sendGameTx } from '../tx'
import { InfoDot } from './Meta'

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

// ── the Wordle tiles ──────────────────────────────────────────────────────────────────────────────
const tileColor = (clue?: Clue): { bg: string; fg: string; border: string } => {
  if (clue === 2) return { bg: '#3a8a4e', fg: '#fff', border: '#3a8a4e' } // green
  if (clue === 1) return { bg: '#b59120', fg: '#111', border: '#b59120' } // yellow
  if (clue === 0) return { bg: 'var(--felt-600)', fg: 'var(--cream)', border: 'var(--line)' } // grey
  return { bg: 'transparent', fg: 'var(--brass)', border: 'var(--line)' } // no clue yet
}

const Tile = ({ letter, clue, pending, cheat }: { letter: string; clue?: Clue; pending?: boolean; cheat?: boolean }) => {
  const c = cheat ? { bg: 'var(--bad)', fg: '#fff', border: 'var(--bad)' } : tileColor(clue)
  return (
    <div
      style={{
        width: '2.6rem',
        height: '2.6rem',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textTransform: 'uppercase',
        fontFamily: 'var(--mono)',
        fontSize: '1.3rem',
        fontWeight: 700,
        background: c.bg,
        color: c.fg,
        border: `2px solid ${c.border}`,
        opacity: pending ? 0.6 : 1,
      }}
    >
      {letter}
    </div>
  )
}

const Grid = ({ rows, maxRows = 6 }: { rows: GuessRow[]; maxRows?: number }) => (
  <div style={{ display: 'grid', gap: '0.35rem', width: 'max-content' }}>
    {Array.from({ length: maxRows }).map((_, r) => {
      const row = rows[r]
      return (
        <div key={r} style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 2.6rem)', gap: '0.35rem' }}>
          {Array.from({ length: 5 }).map((_, ci) => {
            if (!row) return <Tile key={ci} letter="" />
            const letter = LETTERS[row.guess[ci] ?? -1] ?? ''
            return (
              <Tile
                key={ci}
                letter={letter}
                clue={row.clue?.[ci]}
                pending={row.status === 'pending'}
                cheat={row.status === 'cheat'}
              />
            )
          })}
        </div>
      )
    })}
  </div>
)

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

  // ── gates ──
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

  return (
    <div>
      <div className="card">
        <h3>
          ZK Wordle — play with friends
          <InfoDot>
            <strong>A setter hides a 5-letter word; friends guess it.</strong> The setter commits{' '}
            <span className="mono">Poseidon(word, salt)</span>, then proves every clue honest with a{' '}
            <span className="mono">wordle_clue</span> PLONK proof (generated in a Web Worker) posted over MsgBoard — so
            no one can cheat the colours. Your browser verifies each proof; a failing verify means a cheating setter.
            On all-green you can build a <span className="mono">wordle_solve</span> proof and optionally anchor the win
            on-chain (WordleLog), ranked by guesses used. Non-wagered — no chips, no house.
          </InfoDot>
        </h3>

        <div className="row" style={{ marginBottom: '0.5rem' }}>
          <button className={role === 'setter' ? '' : 'secondary'} onClick={() => setRole('setter')}>
            Set a word
          </button>
          <button className={role === 'guesser' ? '' : 'secondary'} onClick={() => setRole('guesser')}>
            Join a challenge
          </button>
          {!myAddress && <span className="muted">connect a wallet — your address is your player identity</span>}
        </div>

        {role === 'setter' ? (
          <SetterPanel
            deployment={deployment}
            myAddress={myAddress}
            wordInput={wordInput}
            setWordInput={setWordInput}
            wordClean={wordClean}
            wordValid={wordValid}
            openOnChain={openOnChain}
            setOpenOnChain={setOpenOnChain}
            openChallenge={openChallenge}
            openStatus={openStatus}
            openError={openError}
            openTx={openTx}
            challengeId={setterChallengeId}
            wrongChain={wrongChain}
            game={game}
            joinInput={joinInput}
            setJoinInput={setJoinInput}
            resumeSetter={resumeSetter}
          />
        ) : (
          <GuesserPanel
            deployment={deployment}
            myAddress={myAddress}
            joinInput={joinInput}
            setJoinInput={setJoinInput}
            join={join}
            challengeId={guesserChallengeId}
            guessInput={guessInput}
            setGuessInput={setGuessInput}
            wrongChain={wrongChain}
            walletConnected={!!walletClient}
            walletClient={walletClient}
            game={game}
          />
        )}
      </div>
    </div>
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

// ── setter panel ────────────────────────────────────────────────────────────────────────────────
const SetterPanel = ({
  deployment,
  myAddress,
  wordInput,
  setWordInput,
  wordClean,
  wordValid,
  openOnChain,
  setOpenOnChain,
  openChallenge,
  openStatus,
  openError,
  openTx,
  challengeId,
  wrongChain,
  game,
  joinInput,
  setJoinInput,
  resumeSetter,
}: {
  deployment: GameDeployment
  myAddress?: viem.Hex
  wordInput: string
  setWordInput: (s: string) => void
  wordClean: string
  wordValid: boolean
  openOnChain: boolean
  setOpenOnChain: (b: boolean) => void
  openChallenge: () => void
  openStatus: string
  openError?: string
  openTx?: viem.Hex
  challengeId: string | null
  wrongChain: boolean
  game: ReturnType<typeof useWordle>
  joinInput: string
  setJoinInput: (s: string) => void
  resumeSetter: () => void
}) => {
  const busy = openStatus === 'committing' || openStatus === 'posting' || openStatus === 'chain'
  if (!challengeId) {
    return (
      <div>
        <p className="muted">Pick a 5-letter word from the Wordle dictionary. It stays hidden — only its commitment is posted.</p>
        <div className="row">
          <input
            value={wordInput}
            onChange={(e) => setWordInput(e.target.value.replace(/[^a-zA-Z]/g, '').slice(0, 5))}
            placeholder="e.g. crane"
            maxLength={5}
            style={{ fontFamily: 'var(--mono)', textTransform: 'lowercase', width: '8rem' }}
          />
          <Toggle checked={openOnChain} onChange={setOpenOnChain}>
            also open on-chain (lets friends anchor their win)
          </Toggle>
        </div>
        <p className="muted">
          {wordClean.length === 5 && !wordValid && <span className="bad">not in the Wordle dictionary · </span>}
          {wordValid && <span className="ok">valid word · </span>}
          {openOnChain && !deployment.wordleLog && <span className="bad">no WordleLog on {deployment.label} · </span>}
        </p>
        <div className="row">
          <button onClick={openChallenge} disabled={!wordValid || !myAddress || busy || (openOnChain && wrongChain)}>
            {openStatus === 'committing'
              ? 'Committing…'
              : openStatus === 'chain'
                ? 'Opening on-chain…'
                : openStatus === 'posting'
                  ? 'Posting to board…'
                  : 'Open challenge'}
          </button>
          {openOnChain && wrongChain && <span className="bad">switch your wallet to {deployment.label}</span>}
        </div>
        {openError && <p className="bad">{openError}</p>}
        <details style={{ marginTop: '0.75rem' }}>
          <summary className="muted">Resume a challenge you set on this device</summary>
          <div className="row" style={{ marginTop: '0.4rem' }}>
            <input value={joinInput} onChange={(e) => setJoinInput(e.target.value)} placeholder="challenge id" style={{ width: '14rem', fontFamily: 'var(--mono)' }} />
            <button className="secondary" onClick={resumeSetter}>Resume</button>
          </div>
        </details>
      </div>
    )
  }
  return (
    <div>
      <p className="ok">Challenge open — share this code with a friend so they can join and guess:</p>
      <div className="row">
        <code className="mono" style={{ wordBreak: 'break-all', background: 'var(--felt-700)', padding: '0.4rem 0.6rem', borderRadius: 4 }}>
          {challengeId}
        </code>
        <button className="secondary" onClick={() => void navigator.clipboard?.writeText(challengeId)}>Copy</button>
      </div>
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
      <p className="card-meta muted">
        board {game.boardReady ? 'connected' : 'connecting…'} · clues proven: {game.cluesAnswered} · pending guesses: {game.pendingGuesses}
        {game.setterStatus === 'proving' && ' · proving a clue…'}
      </p>
      {game.setterError && <p className="bad">clue proof failed: {game.setterError}</p>}
      <ActivityLog game={game} me={myAddress} />
    </div>
  )
}

// ── guesser panel ──────────────────────────────────────────────────────────────────────────────
const GuesserPanel = ({
  deployment,
  myAddress,
  joinInput,
  setJoinInput,
  join,
  challengeId,
  guessInput,
  setGuessInput,
  wrongChain,
  walletConnected,
  walletClient,
  game,
}: {
  deployment: GameDeployment
  myAddress?: viem.Hex
  joinInput: string
  setJoinInput: (s: string) => void
  join: () => void
  challengeId: string | null
  guessInput: string
  setGuessInput: (s: string) => void
  wrongChain: boolean
  walletConnected: boolean
  walletClient?: viem.WalletClient
  game: ReturnType<typeof useWordle>
}) => {
  // EAS attest state (hooks before the early return below).
  const [attestStatus, setAttestStatus] = useState<'idle' | 'attesting' | 'done' | 'error'>('idle')
  const [attestMessage, setAttestMessage] = useState<string>()
  const [attestUid, setAttestUid] = useState<viem.Hex>()
  if (!challengeId) {
    return (
      <div>
        <p className="muted">Paste the challenge code your friend shared to join their board.</p>
        <div className="row">
          <input value={joinInput} onChange={(e) => setJoinInput(e.target.value)} placeholder="challenge id" style={{ width: '16rem', fontFamily: 'var(--mono)' }} />
          <button onClick={join} disabled={!joinInput.trim()}>Join</button>
        </div>
      </div>
    )
  }
  const submit = async () => {
    await game.submitGuess(guessInput)
    setGuessInput('')
  }
  const canGuess = !!myAddress && !game.solved && game.rows.every((r) => r.status !== 'pending')
  const canAnchor = deployment.wordleLog && walletConnected && !wrongChain && !!game.reveal

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
  return (
    <div>
      <p className="card-meta muted">
        joined <span className="mono">{challengeId.slice(0, 10)}…</span> · board {game.boardReady ? 'connected' : 'connecting…'}
        {game.commit ? '' : ' · waiting for the setter’s commitment…'}
      </p>
      {game.cheatDetected && (
        <p className="bad">⚠ a clue proof FAILED verification — the setter is cheating the colours. Stop playing.</p>
      )}
      <div style={{ margin: '0.75rem 0' }}>
        <Grid rows={game.rows} />
      </div>
      {!game.solved && (
        <div className="row">
          <input
            value={guessInput}
            onChange={(e) => setGuessInput(e.target.value.replace(/[^a-zA-Z]/g, '').slice(0, 5))}
            placeholder="guess"
            maxLength={5}
            style={{ fontFamily: 'var(--mono)', textTransform: 'lowercase', width: '8rem' }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canGuess && guessInput.length === 5) void submit()
            }}
          />
          <button onClick={() => void submit()} disabled={!canGuess || guessInput.length !== 5 || game.submitting}>
            {game.submitting ? 'Posting…' : game.rows.some((r) => r.status === 'pending') ? 'Awaiting clue…' : 'Guess'}
          </button>
          {!myAddress && <span className="muted">connect a wallet to guess</span>}
        </div>
      )}
      {game.submitError && <p className="bad">{game.submitError}</p>}
      {game.solved && (
        <div>
          <p className="ok">Solved in {game.guessesUsed} {game.guessesUsed === 1 ? 'guess' : 'guesses'}! Every clue proof verified.</p>
          {!game.reveal && <p className="muted">waiting for the setter to reveal the word so you can build a solve proof…</p>}
          {game.reveal && (
            <div className="row">
              <button
                onClick={() => void game.anchorWin()}
                disabled={game.solve.status === 'proving' || game.solve.status === 'submitting'}
              >
                {game.solve.status === 'proving'
                  ? 'Proving solve… (~10-30s)'
                  : game.solve.status === 'submitting'
                    ? 'Submitting…'
                    : canAnchor
                      ? 'Prove & anchor win on-chain'
                      : 'Prove my win (msgboard only)'}
              </button>
              {deployment.wordleLog && !walletConnected && <span className="muted">connect a wallet to anchor on-chain</span>}
              {deployment.wordleLog && walletConnected && wrongChain && <span className="bad">switch to {deployment.label} to anchor</span>}
            </div>
          )}
          {game.solve.status === 'proving' && (
            <p className="muted">
              Building the wordle_solve witness (the full dictionary Merkle tree) in a Web Worker, then the PLONK
              proof. First run also downloads the ~33 MB proving key (cached after).
            </p>
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
          {game.solve.proof && wordleEasReady(deployment) && walletConnected && !wrongChain && (
            <div className="row">
              <button
                className="secondary"
                onClick={() => void attest()}
                disabled={attestStatus === 'attesting' || attestStatus === 'done'}
              >
                {attestStatus === 'attesting' ? 'Attesting…' : attestStatus === 'done' ? 'Attested ✓' : 'Record to EAS'}
              </button>
              <InfoDot label="what an EAS attestation is">
                Optionally record the same proven win as an <strong>EAS attestation</strong> — a standard,
                composable credential other apps can read. An on-chain resolver re-verifies your solve proof
                before the attestation can exist, and it can never be revoked. Your wallet is both attester and
                recipient (same self-claim rule as the on-chain anchor).
              </InfoDot>
              {attestMessage && <span className={attestStatus === 'done' ? 'ok' : 'bad'}>{attestMessage}</span>}
              {attestUid && <span className="mono muted">{attestUid.slice(0, 14)}…</span>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── setter activity log: who guessed what, and whether we proved the clue ──
const ActivityLog = ({ game, me }: { game: ReturnType<typeof useWordle>; me?: viem.Hex }) => {
  const guesses = game.messages.filter((m) => m.t === 'guess')
  if (guesses.length === 0) return <p className="muted">No guesses yet. Waiting for a friend to join…</p>
  const clueFor = (guesser: string, n: number) =>
    game.messages.find((m) => m.t === 'clue' && (m as { guesser: string }).guesser.toLowerCase() === guesser.toLowerCase() && (m as { n: number }).n === n) as
      | { clue: number[] }
      | undefined
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '0.5rem' }}>
      <thead>
        <tr style={{ textAlign: 'left' }}>
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
                {mine && <span className="tag" style={{ marginLeft: '0.4rem' }}>you</span>}
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
