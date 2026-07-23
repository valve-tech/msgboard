import { useMemo, useState } from 'react'
import * as viem from 'viem'
import { startHeist, heistResolveStep, verifyHeist, type HeistConfig } from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useLadderSession, type LadderAdapter } from '../hooks/useLadderSession'
import { parseStake } from './StakeInput'
import { LadderShell } from './ladderShared'

const DIFFICULTIES = {
  easy: { rooms: 6, vaults: 4, baseAlarms: 1 },
  medium: { rooms: 6, vaults: 4, baseAlarms: 2 },
  hard: { rooms: 5, vaults: 5, baseAlarms: 3 },
} as const
type Difficulty = keyof typeof DIFFICULTIES

export const HeistScreen = ({ deployment, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [difficulty, setDifficulty] = useState<Difficulty>('easy')
  const session = useLadderSession({ walletClient, boardRpc: deployment.boardRpc, chainId: deployment.chainId })

  const config: HeistConfig = DIFFICULTIES[difficulty]
  const adapter: LadderAdapter = useMemo(() => ({
    gameLabel: 'heist',
    maxSteps: config.rooms,
    start: (seed) => startHeist(config, seed),
    resolveStep: (seed, step, choice) => heistResolveStep(seed, config)(step, choice),
    verify: (claim, seed) => verifyHeist(claim, seed, config),
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
      <span className="muted">room {session.step + 1} — crack a vault:</span>
      {Array.from({ length: config.vaults }, (_, v) => (
        <button key={v} type="button" className="tag" onClick={() => session.takeStep(v)} aria-label={`vault ${v + 1}`}>
          🔒{v + 1}
        </button>
      ))}
    </div>
  )

  return (
    <LadderShell
      title="Heist" noun="job" startLabel="New job"
      info={<><strong>Crack the vaults, room by room.</strong> Pick a vault — most hold loot and multiply
        your take, but some trip an alarm and end the job. Guards multiply as you go deeper. Escape (cash
        out) any time. Alarm spots are sealed before you start; re-checkable after.</>}
      amount={amount} setAmount={setAmount} configRow={configRow} controls={controls}
      session={session} canStart={canStart} onStart={() => stake !== undefined && session.newGame(adapter, stake)}
      walletClient={walletClient} trustAcknowledged={trustAcknowledged} myAddress={myAddress} stake={stake}
    />
  )
}
