import { useMemo, useState } from 'react'
import * as viem from 'viem'
import { startFirewalk, firewalkResolveStep, verifyFirewalk, type FirewalkConfig } from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useLadderSession, type LadderAdapter } from '../hooks/useLadderSession'
import { parseStake } from './StakeInput'
import { LadderShell } from './ladderShared'

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
  }), [])

  const stake = parseStake(amount)
  const canStart = walletClient !== undefined && trustAcknowledged && stake !== undefined && session.status !== 'playing'

  const controls = (
    <button type="button" onClick={() => session.takeStep(0)}>Step onto tile {session.step + 1} 🔥</button>
  )

  return (
    <LadderShell
      title="Firewalk" noun="walk" startLabel="New walk"
      info={<><strong>Walk the coals.</strong> Each tile you survive multiplies your prize — but the heat
        ESCALATES, so every step is riskier than the last and the payouts steepen. Bank before you burn.
        Each tile's outcome is sealed before you start; re-checkable after.</>}
      amount={amount} setAmount={setAmount} configRow={null} controls={controls}
      session={session} canStart={canStart} onStart={() => stake !== undefined && session.newGame(adapter, stake)}
      walletClient={walletClient} trustAcknowledged={trustAcknowledged} myAddress={myAddress} stake={stake}
    />
  )
}
