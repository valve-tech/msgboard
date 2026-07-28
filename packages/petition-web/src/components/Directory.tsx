import { Icon } from '@iconify/react'
import type { Petition } from '@msgboard/petition'
import { type PetitionSummary } from '../lib/petition-client.js'
import { short } from './ui.js'

/**
 * `Directory` — the list of captured petitions (from the read-side index). Each row shows the
 * statement and the CAPTURED count only (labeled as such) — the trustless verified count is a
 * per-petition, on-open computation (`VerifyPanel`), too expensive to run for every row up front.
 */
export function Directory(props: {
  summaries: PetitionSummary[] | null
  loading: boolean
  error: string | null
  onOpen: (petition: Petition) => void
  onCreate: () => void
  onReload: () => void
}) {
  const { summaries, loading, error } = props
  return (
    <div>
      <div className="btnrow" style={{ marginTop: 0 }}>
        <button type="button" className="btn brass" onClick={props.onCreate}>
          <Icon icon="mdi:plus" /> New petition
        </button>
        <button type="button" className="btn" onClick={props.onReload} disabled={loading}>
          <Icon icon={loading ? 'mdi:loading' : 'mdi:refresh'} className={loading ? 'spin' : undefined} /> Reload
        </button>
      </div>

      {error && <div className="notice err">{error}</div>}

      {!loading && summaries && summaries.length === 0 && (
        <div className="notice info">No petitions captured yet on this board. Be the first to create one.</div>
      )}

      {summaries?.map(({ petition, capturedCount }) => (
        <button key={petition.id} type="button" className="pick" onClick={() => props.onOpen(petition)}>
          <Icon icon="mdi:script-text-outline" />
          <span className="trunc" style={{ flex: 1, textAlign: 'left' }}>
            {petition.statement}
          </span>
          <span className="pill" title="captured (posted, unverified)">
            {capturedCount} captured
          </span>
          <span className="pill" style={{ marginLeft: 6 }}>
            {short(petition.id)}
          </span>
        </button>
      ))}

      {loading && !summaries && <div className="hint">loading the directory…</div>}
    </div>
  )
}
