import type { Address } from 'viem'
import { zeroAddress } from 'viem'
import type { GameDeployment } from '../config'
import { useBackroomData } from '../hooks/useBackroomData'

/**
 * The operator's security room: one live read-only view of every table, in-flight round (positions
 * only), bankroll, exposure vs cap, and the settle/forfeit tape. This is the page shell only — Task 6
 * onward composes the Floor/Treasury/Meters/Pit/Tape/Reconciliation panels into it. Never sends a
 * transaction (Global Constraints: read-only only).
 */
export const BackroomScreen = ({ deployment, operator }: { deployment: GameDeployment; operator?: Address }) => {
  const data = useBackroomData(operator ?? zeroAddress)

  return (
    <div className="card">
      <h3>🎥 Backroom — {deployment.label}</h3>
      {!operator && <p className="muted">Connect a wallet to read the operator bankroll.</p>}
      <p>
        status: <span className="mono">{data.status}</span>
      </p>
      <p>
        tables: <span className="mono">{data.tables.length}</span>
      </p>
    </div>
  )
}
