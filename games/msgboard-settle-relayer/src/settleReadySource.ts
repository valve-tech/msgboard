import { Transcript } from '@msgboard/games'
import type { RelayerSource } from '@msgboard/relayer'
import type { SettleJob, SettleReadySession } from './types'

export interface SettleReadySourceOptions {
  /** Reports the sessions the worker should consider settling this tick (watches the
   *  board / a co-signed-final feed / an explicit close-out queue). Injected so the
   *  source stays pure and testable; production wires the real watcher here. */
  provider: () => Promise<readonly SettleReadySession[]>
}

/** True iff the retained transcript has at least one co-signed ROUND after the OPEN —
 *  i.e. there is a net delta to land. An OPEN-only session is not settle-ready. */
const hasSettleableRounds = (transcriptJson: string): boolean => {
  try {
    const t = Transcript.fromJSON(transcriptJson)
    return t.entries.some((e) => e.kind === 'ROUND')
  } catch {
    return false // malformed transcript is never settle-ready
  }
}

/**
 * A RelayerSource that turns the provider's reported sessions into settle jobs,
 * dropping any that are not yet settle-ready. Each session is an independent job —
 * parallel sessions never serialize (spec §7).
 */
export const settleReadySource = (options: SettleReadySourceOptions): RelayerSource<SettleJob> => ({
  poll: async () => {
    const sessions = await options.provider()
    return sessions
      .filter((s) => hasSettleableRounds(s.transcriptJson))
      .map((session) => ({ session }))
  },
})
