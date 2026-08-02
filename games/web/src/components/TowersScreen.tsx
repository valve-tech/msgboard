import { useMemo, useState } from 'react'
import {
  startTowers, towersResolveStep, verifyTowers, towersMultiplierX100, towersMaxMultiplierX100,
  type TowersConfig,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useLadderSession, type LadderAdapter } from '../hooks/useLadderSession'
import { parseStake } from './StakeInput'
import { LadderShell, DiffChips, fmtMult } from './ladderShared'

const DIFFICULTIES = {
  easy: { tilesPerFloor: 3, safePerFloor: 2 },
  medium: { tilesPerFloor: 3, safePerFloor: 1 },
  hard: { tilesPerFloor: 4, safePerFloor: 1 },
} as const
type Difficulty = keyof typeof DIFFICULTIES
const OPTIONS = Object.keys(DIFFICULTIES) as Difficulty[]
const FLOORS = 8

export const TowersScreen = ({ deployment, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: import('viem').WalletClient; trustAcknowledged: boolean; myAddress?: import('viem').Hex
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
  }), [difficulty]) // eslint-disable-line react-hooks/exhaustive-deps

  const stake = parseStake(amount)
  const playing = session.status === 'playing'
  const canStart = walletClient !== undefined && trustAcknowledged && stake !== undefined && !playing
  const marks = session.state?.choices ?? []

  return (
    <LadderShell
      title="TOWERS" subtitle={`climb ${FLOORS} floors · ${difficulty}`} noun="climb" startLabel="New climb"
      amount={amount} setAmount={setAmount} session={session} stake={stake}
      canStart={canStart} onStart={() => stake !== undefined && session.newGame(adapter, stake)}
      walletClient={walletClient} trustAcknowledged={trustAcknowledged} myAddress={myAddress}
      steps={config.floors}
      summit={fmtMult(towersMaxMultiplierX100(config))}
      multAt={(i) => fmtMult(towersMultiplierX100(config, i + 1))}
      markAt={(i) => (marks[i] !== undefined ? `tile ${marks[i]! + 1} ✓` : '✓')}
      currentLabel={`floor ${session.step + 1} · pick a tile`}
      nextHint={session.step < config.floors ? <> · next {fmtMult(towersMultiplierX100(config, session.step + 1))}</> : undefined}
      configTray={<DiffChips options={OPTIONS} value={difficulty} onChange={setDifficulty} disabled={playing} />}
      choices={Array.from({ length: config.tilesPerFloor }, (_, t) => (
        <button key={t} type="button" onClick={() => session.takeStep(t)} aria-label={`tile ${t + 1}`}>{t + 1}</button>
      ))}
    />
  )
}
