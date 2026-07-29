import type { GameDeployment } from '../../config'
import { useBoardFeed } from '../../hooks/useBoardFeed'
import { summarizeWin } from '../../model/ticker'

export const WinTicker = ({ deployment }: { deployment: GameDeployment }) => {
  const notices = useBoardFeed(deployment)
  const lines = notices.map(summarizeWin).filter((l): l is NonNullable<typeof l> => l !== null).slice(0, 12)
  return (
    <div className="ticker">
      {lines.length === 0 && <span className="muted">the board is quiet — settlements will scroll here</span>}
      {lines.map((l, i) => (
        <span key={i}>
          {l.icon} <b>{l.game}</b> {l.outcome}{l.who && <> — <span className="who">{l.who}</span></>}
        </span>
      ))}
    </div>
  )
}
