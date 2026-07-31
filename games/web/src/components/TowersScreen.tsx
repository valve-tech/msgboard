import { useMemo, useState } from 'react'
import * as viem from 'viem'
import {
  startTowers, towersResolveStep, verifyTowers, towersMultiplierX100, towersMaxMultiplierX100,
  type TowersConfig,
} from '@msgboard/games'
import type { GameDeployment } from '../config'
import { useLadderSession, type LadderAdapter } from '../hooks/useLadderSession'
import { parseStake } from './StakeInput'
import { fmtMult, LadderReceipt } from './ladderShared'
import { GameStage } from './shell/GameStage'
import { HowItWorksLink } from './HowItWorks'
import { BetTray } from './shell/BetTray'
import { MetaPanel } from './shell/MetaPanel'
import { LadderPath } from './stages/LadderPath'

const DIFFICULTIES = {
  easy: { tilesPerFloor: 3, safePerFloor: 2 },
  medium: { tilesPerFloor: 3, safePerFloor: 1 },
  hard: { tilesPerFloor: 4, safePerFloor: 1 },
} as const
type Difficulty = keyof typeof DIFFICULTIES
const FLOORS = 8

export const TowersScreen = ({ deployment, walletClient, trustAcknowledged, myAddress }: {
  deployment: GameDeployment; walletClient?: viem.WalletClient; trustAcknowledged: boolean; myAddress?: viem.Hex
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
  const cashOut = stake !== undefined && session.step > 0 ? (stake * session.multiplierX100) / 100n : undefined
  const nextMult = towersMultiplierX100(config, session.step + 1)
  const cashed = session.history.filter((g) => g.status === 'cashed').length
  const net = session.history.reduce((s, g) => s + g.playerDelta, 0n)

  return (
    <>
      <GameStage title="TOWERS" subtitle={`climb ${FLOORS} floors · ${difficulty}`} action={<HowItWorksLink />}>
        <LadderPath
          steps={config.floors}
          current={session.step}
          status={session.status}
          bustedStep={session.state?.bustStep ?? undefined}
          multAt={(i) => fmtMult(towersMultiplierX100(config, i + 1))}
          markAt={(i) => (marks[i] !== undefined ? `tile ${marks[i]! + 1} ✓` : '✓')}
          currentLabel={`floor ${session.step + 1} · pick a tile`}
          summit={fmtMult(towersMaxMultiplierX100(config))}
          choices={Array.from({ length: config.tilesPerFloor }, (_, t) => (
            <button key={t} type="button" onClick={() => session.takeStep(t)} aria-label={`tile ${t + 1}`}>{t + 1}</button>
          ))}
        />
      </GameStage>

      <div className="tray-col">
        <BetTray
          amount={amount}
          onAmount={setAmount}
          action={
            playing ? (
              <button className="primary" onClick={() => session.cashOut()} disabled={!session.canCashOut}>
                Cash out{cashOut !== undefined ? ` · ${viem.formatEther(cashOut)}` : ''}
              </button>
            ) : (
              <button className="primary" onClick={() => stake !== undefined && session.newGame(adapter, stake)} disabled={!canStart}>New climb</button>
            )
          }
        >
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="muted" style={{ fontSize: 12, minWidth: 66 }}>difficulty</span>
            {(Object.keys(DIFFICULTIES) as Difficulty[]).map((d) => (
              <button key={d} type="button" disabled={playing} onClick={() => setDifficulty(d)}
                className={d === difficulty ? 'tag ok' : 'tag'} style={{ cursor: playing ? 'default' : 'pointer', textTransform: 'capitalize' }}>{d}</button>
            ))}
          </div>
          {playing && (
            <p className="tray-hint">
              now <b style={{ color: 'var(--gold-live)' }}>{fmtMult(session.multiplierX100)}</b>
              {session.step < config.floors && <> · next {fmtMult(nextMult)}</>}
              {cashOut !== undefined && <span className="muted"> · cash out {viem.formatEther(cashOut)}</span>}
            </p>
          )}
          {!walletClient && <p className="tray-hint">connect a wallet to play</p>}
          {walletClient && !trustAcknowledged && <p className="tray-hint">tap "Got it" on the fairness note above first</p>}
          {session.lastGame && (
            <p className={session.lastGame.status === 'cashed' ? 'ok' : 'bad'}>
              {session.lastGame.status === 'cashed' ? `cashed ${fmtMult(session.lastGame.multiplierX100)} · +${viem.formatEther(session.lastGame.playerDelta)}` : `busted · ${viem.formatEther(session.lastGame.playerDelta)}`}
            </p>
          )}
          {session.error && <p className="bad">{session.error}</p>}
        </BetTray>

        <MetaPanel tabs={['Recent', 'Stats']}>
          {myAddress && session.history.length > 0 ? (
            <span><b>{net >= 0n ? '+' : ''}{viem.formatEther(net)}</b> net · {cashed}/{session.history.length} cashed</span>
          ) : (
            <span className="muted">{playing ? 'climbing — pick a tile or cash out' : 'no climbs yet'}</span>
          )}
        </MetaPanel>
      </div>

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history">
            <summary>{session.history.length} climb{session.history.length === 1 ? '' : 's'}
              <span className="muted"> · {cashed}/{session.history.length} cashed · {viem.formatEther(net)} net</span>
            </summary>
            {[...session.history].reverse().map((record) => <LadderReceipt key={record.id} record={record} noun="climb" />)}
          </details>
        </>
      )}
    </>
  )
}
