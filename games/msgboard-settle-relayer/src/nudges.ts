import type { Nudge, SettleReadySession, WorkerConfig } from './types'

export interface DetectNudgesArgs {
  /** Sessions currently in progress / awaiting settlement. */
  sessions: readonly SettleReadySession[]
  /** Native-gas balance (wei) by lowercased address, for top-up reminders. */
  gasByAddress: ReadonlyMap<string, bigint>
  /** Current wall-clock ms. */
  now: number
  config: WorkerConfig
}

/**
 * Pure: turn observed staleness / low gas into reminders for the UI. The worker
 * SURFACES these and does nothing else (spec §7 "nudge, don't gate") — it never
 * signs on a participant's behalf, never withholds settlement, never moves funds.
 */
export const detectNudges = (args: DetectNudgesArgs): Nudge[] => {
  const out: Nudge[] = []
  for (const s of args.sessions) {
    if (args.now - s.observedAt > args.config.signStaleMs) {
      out.push({
        tableId: s.tableId,
        kind: 'sign-next-state',
        target: s.player,
        message: `Session ${s.tableId.slice(0, 6)}… is waiting on the next co-signed state. Sign to continue or close out.`,
      })
    }
    if (s.player) {
      const bal = args.gasByAddress.get(s.player.toLowerCase())
      if (bal !== undefined && bal < args.config.minGasWei) {
        out.push({
          tableId: s.tableId,
          kind: 'top-up-gas',
          target: s.player,
          message: `Low gas for ${s.player.slice(0, 6)}… — top up to self-settle session ${s.tableId.slice(0, 6)}….`,
        })
      }
    }
  }
  return out
}
