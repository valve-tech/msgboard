import { useMemo, useState } from 'react'
import * as viem from 'viem'
import {
  startCipher, cipherResolveStep, verifyCipher, cipherSymbols,
  type CipherConfig, type CipherDifficulty,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useLadderSession, type LadderAdapter } from '../hooks/useLadderSession'
import { parseStake } from './StakeInput'
import { LadderShell } from './ladderShared'

const DIFFICULTIES: readonly CipherDifficulty[] = ['easy', 'medium', 'hard', 'expert']
const RUNGS = 10

export const CipherScreen = ({ deployment, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [difficulty, setDifficulty] = useState<CipherDifficulty>('easy')
  const session = useLadderSession({ walletClient, boardRpc: deployment.boardRpc, chainId: deployment.chainId })

  const config: CipherConfig = { rungs: RUNGS, difficulty }
  const adapter: LadderAdapter = useMemo(() => ({
    gameLabel: 'cipher',
    maxSteps: config.rungs,
    start: (seed) => startCipher(config, seed),
    resolveStep: (seed, step, choice) => cipherResolveStep(seed, config)(step, choice),
    verify: (claim, seed) => verifyCipher(claim, seed, config),
  }), [difficulty])

  const stake = parseStake(amount)
  const canStart = walletClient !== undefined && trustAcknowledged && stake !== undefined && session.status !== 'playing'
  const symbols = cipherSymbols(difficulty)

  const configRow = (
    <label className="threshold-label">
      difficulty
      <span className="row" style={{ gap: '0.25rem' }}>
        {DIFFICULTIES.map((d) => (
          <button key={d} type="button" className={`chip${difficulty === d ? ' active' : ''}`}
            onClick={() => setDifficulty(d)} disabled={session.status === 'playing'} aria-label={`difficulty ${d}`}>
            {d}
          </button>
        ))}
      </span>
    </label>
  )

  const controls = (
    <div className="row" style={{ gap: '0.3rem' }}>
      <span className="muted">rung {session.step + 1} — crack the code digit:</span>
      {Array.from({ length: symbols }, (_, g) => (
        <button key={g} type="button" className="tag" onClick={() => session.takeStep(g)} aria-label={`digit ${g}`}>
          🔢{g}
        </button>
      ))}
    </div>
  )

  return (
    <LadderShell
      title="Cipher" noun="crack" startLabel="New crack"
      info={<><strong>Crack the code, rung by rung.</strong> On each rung guess one of {symbols} positions —
        exactly one is the correct digit. A hit multiplies your prize and climbs the ladder; a miss trips
        the alarm and busts. More symbols means harder rungs and steeper pay. Cash out before you're caught.
        Each rung's digit is sealed before you start; re-checkable after.</>}
      amount={amount} setAmount={setAmount} configRow={configRow} controls={controls}
      session={session} canStart={canStart} onStart={() => stake !== undefined && session.newGame(adapter, stake)}
      walletClient={walletClient} trustAcknowledged={trustAcknowledged} myAddress={myAddress} stake={stake}
    />
  )
}
