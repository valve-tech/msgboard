import { useMemo, useState } from 'react'
import type * as viem from 'viem'
import {
  startFirewalk, firewalkResolveStep, verifyFirewalk, firewalkMultiplierX100, firewalkMaxMultiplierX100,
  type FirewalkConfig,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useLadderSession, type LadderAdapter } from '../hooks/useLadderSession'
import { parseStake } from './StakeInput'
import { LadderShell, fmtMult } from './ladderShared'

const TILES = 8

export const FirewalkScreen = ({ deployment, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const session = useLadderSession({ walletClient, boardRpc: deployment.boardRpc, chainId: deployment.chainId })

  const config: FirewalkConfig = { tiles: TILES }
  const adapter: LadderAdapter = useMemo(() => ({
    gameLabel: 'firewalk',
    maxSteps: config.tiles,
    start: (seed) => startFirewalk(config, seed),
    resolveStep: (seed, step, choice) => firewalkResolveStep(seed)(step, choice),
    verify: (claim, seed) => verifyFirewalk(claim, seed),
  }), []) // eslint-disable-line react-hooks/exhaustive-deps

  const stake = parseStake(amount)
  const canStart = walletClient !== undefined && trustAcknowledged && stake !== undefined && session.status !== 'playing'

  return (
    <LadderShell
      title="FIREWALK" subtitle="walk the coals · the heat escalates" noun="walk" startLabel="New walk"
      amount={amount} setAmount={setAmount} session={session} stake={stake}
      canStart={canStart} onStart={() => stake !== undefined && session.newGame(adapter, stake)}
      walletClient={walletClient} trustAcknowledged={trustAcknowledged} myAddress={myAddress}
      steps={config.tiles}
      summit={fmtMult(firewalkMaxMultiplierX100(config))}
      multAt={(i) => fmtMult(firewalkMultiplierX100(i + 1))}
      markAt={() => '🔥 survived'}
      currentLabel={`tile ${session.step + 1} — cross the coals`}
      nextHint={session.step < config.tiles ? <> · next {fmtMult(firewalkMultiplierX100(session.step + 1))}</> : undefined}
      choices={<button type="button" onClick={() => session.takeStep(0)}>Step onto tile {session.step + 1} 🔥</button>}
    />
  )
}
