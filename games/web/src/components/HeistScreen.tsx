import { useMemo, useState } from 'react'
import type * as viem from 'viem'
import {
  startHeist, heistResolveStep, verifyHeist, heistMultiplierX100, heistMaxMultiplierX100,
  type HeistConfig,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useLadderSession, type LadderAdapter } from '../hooks/useLadderSession'
import { parseStake } from './StakeInput'
import { LadderShell, DiffChips, fmtMult } from './ladderShared'

const DIFFICULTIES = {
  easy: { rooms: 6, vaults: 4, baseAlarms: 1 },
  medium: { rooms: 6, vaults: 4, baseAlarms: 2 },
  hard: { rooms: 5, vaults: 5, baseAlarms: 3 },
} as const
type Difficulty = keyof typeof DIFFICULTIES
const OPTIONS = Object.keys(DIFFICULTIES) as Difficulty[]

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
  }), [difficulty]) // eslint-disable-line react-hooks/exhaustive-deps

  const stake = parseStake(amount)
  const playing = session.status === 'playing'
  const canStart = walletClient !== undefined && trustAcknowledged && stake !== undefined && !playing
  const marks = session.state?.choices ?? []

  return (
    <LadderShell
      title="HEIST" subtitle={`${config.rooms} rooms · ${difficulty}`} noun="job" startLabel="New job"
      amount={amount} setAmount={setAmount} session={session} stake={stake}
      canStart={canStart} onStart={() => stake !== undefined && session.newGame(adapter, stake)}
      walletClient={walletClient} trustAcknowledged={trustAcknowledged} myAddress={myAddress}
      steps={config.rooms}
      summit={fmtMult(heistMaxMultiplierX100(config))}
      multAt={(i) => fmtMult(heistMultiplierX100(config, i + 1))}
      markAt={(i) => (marks[i] !== undefined ? `🔓 vault ${marks[i]! + 1}` : '✓')}
      currentLabel={`room ${session.step + 1} — crack a vault`}
      nextHint={session.step < config.rooms ? <> · next {fmtMult(heistMultiplierX100(config, session.step + 1))}</> : undefined}
      configTray={<DiffChips options={OPTIONS} value={difficulty} onChange={setDifficulty} disabled={playing} />}
      choices={Array.from({ length: config.vaults }, (_, v) => (
        <button key={v} type="button" onClick={() => session.takeStep(v)} aria-label={`vault ${v + 1}`}>🔒{v + 1}</button>
      ))}
    />
  )
}
