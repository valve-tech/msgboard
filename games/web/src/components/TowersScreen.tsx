import { useMemo, useState } from 'react'
import * as viem from 'viem'
import { startTowers, towersResolveStep, verifyTowers, type TowersConfig } from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useLadderSession, type LadderAdapter } from '../hooks/useLadderSession'
import { parseStake } from './StakeInput'
import { LadderShell } from './ladderShared'

const DIFFICULTIES = {
  easy: { tilesPerFloor: 3, safePerFloor: 2 },
  medium: { tilesPerFloor: 3, safePerFloor: 1 },
  hard: { tilesPerFloor: 4, safePerFloor: 1 },
} as const
type Difficulty = keyof typeof DIFFICULTIES
const FLOORS = 8

export const TowersScreen = ({ deployment, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [difficulty, setDifficulty] = useState<Difficulty>('easy')
  const session = useLadderSession({ walletClient, boardRpc: deployment.boardRpc, chainId: deployment.chainId })

  const config: TowersConfig = { floors: FLOORS, ...DIFFICULTIES[difficulty] }
  const adapter: LadderAdapter = useMemo(() => ({
    gameLabel: 'towers',
    maxSteps: config.floors,
    start: (seed) => startTowers(config, seed),
    resolveStep: (seed, step, choice) => towersResolveStep(seed, config)(step, choice),
    verify: (claim, seed) => verifyTowers(claim, seed, config),
  }), [difficulty])

  const stake = parseStake(amount)
  const canStart = walletClient !== undefined && trustAcknowledged && stake !== undefined && session.status !== 'playing'

  const configRow = (
    <label className="threshold-label">
      difficulty
      <span className="row" style={{ gap: '0.25rem' }}>
        {(Object.keys(DIFFICULTIES) as Difficulty[]).map((d) => (
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
      <span className="muted">floor {session.step + 1} — pick a tile:</span>
      {Array.from({ length: config.tilesPerFloor }, (_, t) => (
        <button key={t} type="button" className="tag" onClick={() => session.takeStep(t)} aria-label={`tile ${t + 1}`}>
          {t + 1}
        </button>
      ))}
    </div>
  )

  return (
    <LadderShell
      title="Towers" noun="climb" startLabel="New climb"
      info={<><strong>Climb the tower.</strong> Each floor, pick a tile — most are safe, but one (or more)
        drops you. Each safe floor multiplies your prize; cash out any time. The safe tiles are sealed
        before you start, so the house can't move them under you. Re-checkable after.</>}
      amount={amount} setAmount={setAmount} configRow={configRow} controls={controls}
      session={session} canStart={canStart} onStart={() => stake !== undefined && session.newGame(adapter, stake)}
      walletClient={walletClient} trustAcknowledged={trustAcknowledged} myAddress={myAddress} stake={stake}
    />
  )
}
