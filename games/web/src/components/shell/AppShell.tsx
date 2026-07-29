import type { ReactNode } from 'react'
import type { GameDeployment } from '../../config'
import { Rail } from './Rail'
import { WinTicker } from './WinTicker'

export const AppShell = ({ deployment, games, active, onPick, topRight, chrome, footer, children }: {
  deployment: GameDeployment
  games: { id: string; label: string }[]
  active: string
  onPick: (id: string) => void
  topRight: ReactNode
  /** Slim per-table chrome (error banners + the trust strip), pinned above the scrolling stage. */
  chrome?: ReactNode
  /** Slim footer (colophon), pinned at the bottom of the frame. */
  footer?: ReactNode
  children: ReactNode // the [stage-col, tray-col] pair
}) => (
  <div className="app">
    <Rail games={games} active={active} onPick={onPick} />
    <div className="main">
      <WinTicker deployment={deployment} />
      <div className="row shell-top">{topRight}</div>
      {chrome && <div className="shell-chrome">{chrome}</div>}
      <div className="stagewrap">{children}</div>
      {footer}
    </div>
  </div>
)
