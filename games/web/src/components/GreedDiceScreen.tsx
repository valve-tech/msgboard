import { useMemo, useState } from 'react'
import type * as viem from 'viem'
import {
  startGreedDice, greedDiceResolveStep, verifyGreedDice, greedDiceMultiplierX100, greedDiceMaxMultiplierX100,
  type GreedDiceConfig,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useLadderSession, type LadderAdapter } from '../hooks/useLadderSession'
import { parseStake } from './StakeInput'
import { LadderShell, DiffChips, fmtMult } from './ladderShared'

const ROLLS = 10
const BUST_OPTIONS = ['1', '2', '3'] as const // bust faces: greedier = more bust faces, bigger growth

export const GreedDiceScreen = ({ deployment, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [bustFaces, setBustFaces] = useState('2')
  const session = useLadderSession({ walletClient, boardRpc: deployment.boardRpc, chainId: deployment.chainId })

  const config: GreedDiceConfig = { rolls: ROLLS, bustFaces: Number(bustFaces) }
  const adapter: LadderAdapter = useMemo(() => ({
    gameLabel: 'greed-dice',
    maxSteps: config.rolls,
    start: (seed) => startGreedDice(config, seed),
    resolveStep: (seed, step, choice) => greedDiceResolveStep(seed, config)(step, choice),
    verify: (claim, seed) => verifyGreedDice(claim, seed, config),
  }), [bustFaces]) // eslint-disable-line react-hooks/exhaustive-deps

  const stake = parseStake(amount)
  const playing = session.status === 'playing'
  const canStart = walletClient !== undefined && trustAcknowledged && stake !== undefined && !playing

  return (
    <LadderShell
      title="GREED DICE" subtitle={`${ROLLS} rolls · ${bustFaces} bust face${bustFaces === '1' ? '' : 's'}`} noun="run" startLabel="New run"
      amount={amount} setAmount={setAmount} session={session} stake={stake}
      canStart={canStart} onStart={() => stake !== undefined && session.newGame(adapter, stake)}
      walletClient={walletClient} trustAcknowledged={trustAcknowledged} myAddress={myAddress}
      steps={config.rolls}
      summit={fmtMult(greedDiceMaxMultiplierX100(config))}
      multAt={(i) => fmtMult(greedDiceMultiplierX100(config, i + 1))}
      markAt={() => '🎲 safe'}
      currentLabel={`roll ${session.step + 1} — push your luck`}
      nextHint={session.step < config.rolls ? <> · next {fmtMult(greedDiceMultiplierX100(config, session.step + 1))}</> : undefined}
      configTray={<DiffChips label="bust faces" options={BUST_OPTIONS} value={bustFaces} onChange={setBustFaces} disabled={playing} />}
      choices={<button type="button" onClick={() => session.takeStep(0)}>Roll #{session.step + 1} 🎲</button>}
    />
  )
}
