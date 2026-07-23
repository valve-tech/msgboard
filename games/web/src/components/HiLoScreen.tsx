import { useMemo, useState } from 'react'
import * as viem from 'viem'
import {
  startHiLo, hiloResolveStep, verifyHiLo, cardName, shuffleDeck, HILO_HIGHER, HILO_LOWER, type HiLoConfig,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useLadderSession, type LadderAdapter } from '../hooks/useLadderSession'
import { parseStake } from './StakeInput'
import { LadderShell } from './ladderShared'

const CONFIG: HiLoConfig = { steps: 12, capX100: 100_000n } // up to 12 guesses, capped at 1000x

export const HiLoScreen = ({ deployment, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const session = useLadderSession({ walletClient, boardRpc: deployment.boardRpc, chainId: deployment.chainId })

  const adapter: LadderAdapter = useMemo(() => ({
    gameLabel: 'hilo',
    maxSteps: CONFIG.steps,
    start: (seed) => startHiLo(CONFIG, seed),
    resolveStep: (seed, step, choice, mult) => hiloResolveStep(seed, CONFIG)(step, choice, mult),
    verify: (claim, seed) => verifyHiLo(claim, seed, CONFIG),
    label: (seed, step) => cardName(shuffleDeck(seed)[step]!),
  }), [])

  const stake = parseStake(amount)
  const canStart = walletClient !== undefined && trustAcknowledged && stake !== undefined && session.status !== 'playing'

  const controls = (
    <div className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
      <span className="tag" style={{ fontSize: '1.2rem' }}>{session.label ?? '?'}</span>
      <span className="muted">next card is…</span>
      <button type="button" onClick={() => session.takeStep(HILO_HIGHER)}>Higher or same ↑</button>
      <button type="button" onClick={() => session.takeStep(HILO_LOWER)}>Lower or same ↓</button>
    </div>
  )

  return (
    <LadderShell
      title="Hi-Lo" noun="run" startLabel="New run"
      info={<><strong>Guess the next card — higher or lower.</strong> Each correct call chains a
        multiplier priced from the odds; a wrong call busts. Cash out any time. The deck is shuffled from
        a sealed seed before you start (capped at 1000x), and you can re-check the whole run after.</>}
      amount={amount} setAmount={setAmount} configRow={null} controls={controls}
      session={session} canStart={canStart} onStart={() => stake !== undefined && session.newGame(adapter, stake)}
      walletClient={walletClient} trustAcknowledged={trustAcknowledged} myAddress={myAddress} stake={stake}
    />
  )
}
