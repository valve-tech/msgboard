import { useMemo, useState } from 'react'
import type * as viem from 'viem'
import {
  startHiLo, hiloResolveStep, verifyHiLo, hiloMaxMultiplierX100, cardName, shuffleDeck,
  HILO_HIGHER, HILO_LOWER, type HiLoConfig,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useLadderSession, type LadderAdapter } from '../hooks/useLadderSession'
import { parseStake } from './StakeInput'
import { LadderShell, fmtMult } from './ladderShared'

const CONFIG: HiLoConfig = { steps: 12, capX100: 100_000n } // up to 12 guesses, capped at 1000x

/** Render a card-name string (e.g. "K♠") as a small play-card chip. */
const MiniCard = ({ name }: { name?: string }) => {
  if (!name) return <span className="playcard" aria-hidden />
  const suit = name.slice(-1)
  const rank = name.slice(0, -1)
  const red = suit === '♥' || suit === '♦'
  return (
    <span className={`playcard${red ? ' red' : ''}`} aria-label={name}>
      <span className="corner">{rank}<br />{suit}</span><span className="pip">{suit}</span>
    </span>
  )
}

export const HiLoScreen = ({ deployment, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const session = useLadderSession({ walletClient, boardRpc: deployment.boardRpc, chainId: deployment.chainId })

  const adapter: LadderAdapter = useMemo(() => ({
    gameLabel: 'hilo-ladder',
    maxSteps: CONFIG.steps,
    start: (seed) => startHiLo(CONFIG, seed),
    resolveStep: (seed, step, choice, mult) => hiloResolveStep(seed, CONFIG)(step, choice, mult),
    verify: (claim, seed) => verifyHiLo(claim, seed, CONFIG),
    label: (seed, step) => cardName(shuffleDeck(seed)[step]!),
  }), [])

  const stake = parseStake(amount)
  const canStart = walletClient !== undefined && trustAcknowledged && stake !== undefined && session.status !== 'playing'
  const marks = session.state?.choices ?? []

  return (
    <LadderShell
      title="HI-LO" subtitle="higher or lower · up to 1000x" noun="run" startLabel="New run"
      amount={amount} setAmount={setAmount} session={session} stake={stake}
      canStart={canStart} onStart={() => stake !== undefined && session.newGame(adapter, stake)}
      walletClient={walletClient} trustAcknowledged={trustAcknowledged} myAddress={myAddress}
      steps={CONFIG.steps}
      summit={fmtMult(hiloMaxMultiplierX100(CONFIG))}
      markAt={(i) => (marks[i] === HILO_HIGHER ? '↑ higher' : '↓ lower')}
      currentLabel={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <MiniCard name={session.label} /> next is…
        </span>
      }
      choices={
        <>
          <button type="button" onClick={() => session.takeStep(HILO_HIGHER)}>Higher ↑</button>
          <button type="button" onClick={() => session.takeStep(HILO_LOWER)}>Lower ↓</button>
        </>
      }
    />
  )
}
