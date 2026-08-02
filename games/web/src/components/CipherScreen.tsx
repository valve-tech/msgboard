import { useMemo, useState } from 'react'
import type * as viem from 'viem'
import {
  startCipher, cipherResolveStep, verifyCipher, cipherSymbols, cipherMultiplierX100, cipherMaxMultiplierX100,
  type CipherConfig, type CipherDifficulty,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useLadderSession, type LadderAdapter } from '../hooks/useLadderSession'
import { parseStake } from './StakeInput'
import { LadderShell, DiffChips, fmtMult } from './ladderShared'

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
  }), [difficulty]) // eslint-disable-line react-hooks/exhaustive-deps

  const stake = parseStake(amount)
  const playing = session.status === 'playing'
  const canStart = walletClient !== undefined && trustAcknowledged && stake !== undefined && !playing
  const symbols = cipherSymbols(difficulty)
  const marks = session.state?.choices ?? []

  return (
    <LadderShell
      title="CIPHER" subtitle={`crack ${RUNGS} rungs · ${difficulty}`} noun="crack" startLabel="New crack"
      amount={amount} setAmount={setAmount} session={session} stake={stake}
      canStart={canStart} onStart={() => stake !== undefined && session.newGame(adapter, stake)}
      walletClient={walletClient} trustAcknowledged={trustAcknowledged} myAddress={myAddress}
      steps={config.rungs}
      summit={fmtMult(cipherMaxMultiplierX100(config))}
      multAt={(i) => fmtMult(cipherMultiplierX100(config, i + 1))}
      markAt={(i) => (marks[i] !== undefined ? `🔓 ${marks[i]}` : '✓')}
      currentLabel={`rung ${session.step + 1} — crack the digit`}
      nextHint={session.step < config.rungs ? <> · next {fmtMult(cipherMultiplierX100(config, session.step + 1))}</> : undefined}
      configTray={<DiffChips options={DIFFICULTIES} value={difficulty} onChange={setDifficulty} disabled={playing} />}
      choices={Array.from({ length: symbols }, (_, g) => (
        <button key={g} type="button" onClick={() => session.takeStep(g)} aria-label={`digit ${g}`}>🔢{g}</button>
      ))}
    />
  )
}
