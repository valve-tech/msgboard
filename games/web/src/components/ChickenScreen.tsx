import { useMemo, useState } from 'react'
import * as viem from 'viem'
import { startChicken, chickenResolveStep, verifyChicken, type ChickenConfig, type ChickenDifficulty } from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useLadderSession, type LadderAdapter } from '../hooks/useLadderSession'
import { parseStake } from './StakeInput'
import { LadderShell } from './ladderShared'

const DIFFICULTIES: readonly ChickenDifficulty[] = ['easy', 'medium', 'hard', 'daredevil']
const LANES = 12

export const ChickenScreen = ({ deployment, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [difficulty, setDifficulty] = useState<ChickenDifficulty>('medium')
  const session = useLadderSession({ walletClient, boardRpc: deployment.boardRpc, chainId: deployment.chainId })

  const config: ChickenConfig = { difficulty, lanes: LANES }
  const adapter: LadderAdapter = useMemo(() => ({
    gameLabel: 'chicken',
    maxSteps: config.lanes,
    start: (seed) => startChicken(config, seed),
    resolveStep: (seed, step, choice) => chickenResolveStep(seed, config)(step, choice),
    verify: (claim, seed) => verifyChicken(claim, seed, config),
  }), [difficulty])

  const stake = parseStake(amount)
  const canStart = walletClient !== undefined && trustAcknowledged && stake !== undefined && session.status !== 'playing'

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
    <button type="button" onClick={() => session.takeStep(0)}>Step into lane {session.step + 1} →</button>
  )

  return (
    <LadderShell
      title="Chicken" noun="run" startLabel="New run"
      info={<><strong>Cross the road, lane by lane.</strong> Each step forward multiplies your prize — but
        a lane may be a crash. Higher difficulty crashes more often and pays more. Cash out before your
        luck runs out. Each lane's outcome is sealed before you start; re-checkable after.</>}
      amount={amount} setAmount={setAmount} configRow={configRow} controls={controls}
      session={session} canStart={canStart} onStart={() => stake !== undefined && session.newGame(adapter, stake)}
      walletClient={walletClient} trustAcknowledged={trustAcknowledged} myAddress={myAddress} stake={stake}
    />
  )
}
