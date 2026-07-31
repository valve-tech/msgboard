import { useMemo, useState } from 'react'
import type * as viem from 'viem'
import {
  startChicken, chickenResolveStep, verifyChicken, chickenMultiplierX100, chickenMaxMultiplierX100,
  type ChickenConfig, type ChickenDifficulty,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useLadderSession, type LadderAdapter } from '../hooks/useLadderSession'
import { parseStake } from './StakeInput'
import { LadderShell, DiffChips, fmtMult } from './ladderShared'

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
  }), [difficulty]) // eslint-disable-line react-hooks/exhaustive-deps

  const stake = parseStake(amount)
  const playing = session.status === 'playing'
  const canStart = walletClient !== undefined && trustAcknowledged && stake !== undefined && !playing

  return (
    <LadderShell
      title="CHICKEN" subtitle={`cross ${LANES} lanes · ${difficulty}`} noun="run" startLabel="New run"
      amount={amount} setAmount={setAmount} session={session} stake={stake}
      canStart={canStart} onStart={() => stake !== undefined && session.newGame(adapter, stake)}
      walletClient={walletClient} trustAcknowledged={trustAcknowledged} myAddress={myAddress}
      steps={config.lanes}
      summit={fmtMult(chickenMaxMultiplierX100(config))}
      multAt={(i) => fmtMult(chickenMultiplierX100(difficulty, i + 1))}
      markAt={() => '✓ crossed'}
      currentLabel={`lane ${session.step + 1} — step forward`}
      nextHint={session.step < config.lanes ? <> · next {fmtMult(chickenMultiplierX100(difficulty, session.step + 1))}</> : undefined}
      configTray={<DiffChips options={DIFFICULTIES} value={difficulty} onChange={setDifficulty} disabled={playing} />}
      choices={<button type="button" onClick={() => session.takeStep(0)}>Cross into lane {session.step + 1} →</button>}
    />
  )
}
