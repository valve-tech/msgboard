import type { BoardNotice } from '../hooks/useBoardFeed'

export type TickerLine = { icon: string; game: string; outcome: string; who: string }

const ICON: Record<string, string> = {
  dice: '🎲', limbo: '🚀', crash: '🚀', mines: '💣', blackjack: '🂡', roulette: '🎯', wheel: '🎡', keno: '🔢',
}
const short = (a?: unknown): string =>
  typeof a === 'string' && a.startsWith('0x') && a.length >= 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''

/** A one-line social-proof summary of a SETTLEMENT notice, or null if it isn't one worth showing. */
export const summarizeWin = (n: BoardNotice): TickerLine | null => {
  if (n.kind !== 'summary') return null
  const game = typeof n.game === 'string' ? n.game : 'game'
  const net = typeof n.delta !== 'undefined' ? String(n.delta) : ''
  let outcome = ''
  if (typeof n.reveals !== 'undefined' && 'busted' in n) {
    outcome = n.busted ? 'hit a mine' : `cashed ${n.reveals} safe${net ? ` · ${net}` : ''}`
  } else if (typeof n.detail === 'string') {
    outcome = `${n.detail}${net ? ` · ${net}` : ''}`
  } else if (net) {
    outcome = `settled ${net}`
  } else {
    outcome = 'settled'
  }
  return { icon: ICON[game] ?? '🎰', game, outcome, who: short(n.player) }
}
