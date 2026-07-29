import type { ReactNode } from 'react'
import type { GameDeployment } from '../../config'
import { Rail } from './Rail'
import { WinTicker } from './WinTicker'

export const AppShell = ({ deployment, games, active, onPick, topRight, children }: {
  deployment: GameDeployment
  games: { id: string; label: string }[]
  active: string
  onPick: (id: string) => void
  topRight: ReactNode
  children: ReactNode // the [stage-col, tray-col] pair
}) => (
  <div className="app">
    <Rail games={games} active={active} onPick={onPick} />
    <div className="main">
      <WinTicker deployment={deployment} />
      <div className="row shell-top">{topRight}</div>
      <div className="stagewrap">{children}</div>
    </div>
  </div>
)
