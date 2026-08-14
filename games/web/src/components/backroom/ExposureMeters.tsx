import type { GameDeployment } from '../../config'
import type { OperatorTableView, Treasury } from '../../lib/backroomIndex'
import { fmtToken, tokenLabel } from './shared'

/** A meter's fill ratio, clamped to [0, 1.5] so a cap breach still reads as "past full" rather than
 *  wrapping the bar around. `null` denominator (uncapped) never reaches here — callers show "∞". */
const ratio = (numerator: bigint, denominator: bigint): number => {
  if (denominator <= 0n) return 0
  const pct = Number(numerator) / Number(denominator)
  return Math.max(0, Math.min(1.5, pct))
}

const Meter = ({ label, fillRatio, tone, right }: { label: string; fillRatio: number; tone: 'ok' | 'warn' | 'bad'; right: string }) => (
  <div className="brm-meter">
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <span className="muted">{label}</span>
      <span className="mono">{right}</span>
    </div>
    <div className="brm-bar">
      <div className={`brm-bar-fill brm-bar-${tone}`} style={{ width: `${Math.min(1, fillRatio) * 100}%` }} />
    </div>
  </div>
)

const toneFor = (fillRatio: number): 'ok' | 'warn' | 'bad' => (fillRatio >= 1 ? 'bad' : fillRatio >= 0.9 ? 'warn' : 'ok')

/**
 * 4.5 Exposure vs cap meters (SAFE-PRE) — per table, `tableLocked / tableCap` (uncapped shows "∞"),
 * plus a shared-pool bar: Σ exposure vs `bankrollOf`. Uses the corrected `available` formula (2.2)
 * indirectly — the bar reads the same `cap`/`locked`/`bankroll` inputs `available` is built from.
 */
export const ExposureMeters = ({
  deployment,
  tables,
  treasury,
}: {
  deployment: GameDeployment
  tables: OperatorTableView[]
  treasury: Treasury[]
}) => {
  if (tables.length === 0) {
    return (
      <div className="card">
        <h3>Exposure</h3>
        <p className="muted">No tables yet.</p>
      </div>
    )
  }

  const bankrollOf = new Map(treasury.map((t) => [t.token, t.bankroll]))
  const lockedByToken = new Map<`0x${string}`, bigint>()
  for (const t of tables) lockedByToken.set(t.token, (lockedByToken.get(t.token) ?? 0n) + t.locked)

  return (
    <div className="card">
      <h3>Exposure</h3>
      {tables.map((t) => {
        const uncapped = t.cap === 0n
        const r = uncapped ? 0 : ratio(t.locked, t.cap)
        return (
          <Meter
            key={t.tableId}
            label={`${t.tableId.slice(0, 10)}… (${tokenLabel(deployment, t.token)})`}
            fillRatio={r}
            tone={uncapped ? 'ok' : toneFor(r)}
            right={uncapped ? `${fmtToken(deployment, t.token, t.locked)} / ∞` : `${fmtToken(deployment, t.token, t.locked)} / ${fmtToken(deployment, t.token, t.cap)}`}
          />
        )
      })}
      <h3 style={{ marginTop: '1rem' }}>Shared pool</h3>
      {[...lockedByToken.entries()].map(([token, locked]) => {
        const bankroll = bankrollOf.get(token) ?? 0n
        const total = locked + bankroll
        const r = ratio(locked, total)
        return (
          <Meter
            key={token}
            label={`${tokenLabel(deployment, token)} — exposure vs bankroll`}
            fillRatio={r}
            tone={toneFor(r)}
            right={`${fmtToken(deployment, token, locked)} locked / ${fmtToken(deployment, token, bankroll)} idle`}
          />
        )
      })}
    </div>
  )
}
