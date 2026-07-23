import { useMemo, useState } from 'react'
import * as viem from 'viem'
import { startGreedDice, greedDiceResolveStep, verifyGreedDice, type GreedDiceConfig } from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useLadderSession, type LadderAdapter } from '../hooks/useLadderSession'
import { parseStake } from './StakeInput'
import { LadderShell } from './ladderShared'

const ROLLS = 10
const BUST_OPTIONS = [1, 2, 3] as const // bust faces: greedier = more bust faces, bigger growth

export const GreedDiceScreen = ({ deployment, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [bustFaces, setBustFaces] = useState<number>(2)
  const session = useLadderSession({ walletClient, boardRpc: deployment.boardRpc, chainId: deployment.chainId })

  const config: GreedDiceConfig = { rolls: ROLLS, bustFaces }
  const adapter: LadderAdapter = useMemo(() => ({
    gameLabel: 'greed-dice',
    maxSteps: config.rolls,
    start: (seed) => startGreedDice(config, seed),
    resolveStep: (seed, step, choice) => greedDiceResolveStep(seed, config)(step, choice),
    verify: (claim, seed) => verifyGreedDice(claim, seed, config),
  }), [bustFaces])

  const stake = parseStake(amount)
  const canStart = walletClient !== undefined && trustAcknowledged && stake !== undefined && session.status !== 'playing'

  const configRow = (
    <label className="threshold-label">
      bust faces
      <span className="row" style={{ gap: '0.25rem' }}>
        {BUST_OPTIONS.map((b) => (
          <button key={b} type="button" className={`chip${bustFaces === b ? ' active' : ''}`}
            onClick={() => setBustFaces(b)} disabled={session.status === 'playing'} aria-label={`bust faces ${b}`}>
            {b}
          </button>
        ))}
      </span>
    </label>
  )

  const controls = (
    <button type="button" onClick={() => session.takeStep(0)}>Roll #{session.step + 1} 🎲</button>
  )

  return (
    <LadderShell
      title="Greed Dice" noun="run" startLabel="New run"
      info={<><strong>Push your luck.</strong> Re-roll to grow the multiplier — but roll a bad face and
        you bust, losing it all. More bust faces means faster growth and bigger risk. Bank any time. Each
        roll is sealed before you start; re-checkable after.</>}
      amount={amount} setAmount={setAmount} configRow={configRow} controls={controls}
      session={session} canStart={canStart} onStart={() => stake !== undefined && session.newGame(adapter, stake)}
      walletClient={walletClient} trustAcknowledged={trustAcknowledged} myAddress={myAddress} stake={stake}
    />
  )
}
