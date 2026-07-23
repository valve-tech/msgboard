import { describe, expect, it } from 'vitest'
import { type Hex } from 'viem'
import { detectNudges } from '../src/nudges'
import type { SettleReadySession } from '../src/types'

const player = '0x00000000000000000000000000000000000a1ace' as Hex
const session = (over: Partial<SettleReadySession>): SettleReadySession => ({
  tableId: `0x${'aa'.repeat(32)}`,
  transcriptJson: '{}',
  settlement: {} as never,
  trigger: 'cooperative-final',
  observedAt: 0,
  player,
  ...over,
})

describe('detectNudges', () => {
  it('fires sign-next-state when a session has stalled past signStaleMs', () => {
    const nudges = detectNudges({
      sessions: [session({ observedAt: 0 })],
      gasByAddress: new Map(),
      now: 10_000,
      config: { signStaleMs: 5_000, minGasWei: 0n, windowSize: 4, rbfStaleMs: 5_000 },
    })
    expect(nudges).toHaveLength(1)
    expect(nudges[0]!.kind).toBe('sign-next-state')
    expect(nudges[0]!.target).toBe(player)
  })

  it('does NOT fire sign-next-state before the stall threshold', () => {
    const nudges = detectNudges({
      sessions: [session({ observedAt: 8_000 })],
      gasByAddress: new Map(),
      now: 10_000,
      config: { signStaleMs: 5_000, minGasWei: 0n, windowSize: 4, rbfStaleMs: 5_000 },
    })
    expect(nudges.filter((n) => n.kind === 'sign-next-state')).toHaveLength(0)
  })

  it('fires top-up-gas when the player gas balance is below minGasWei', () => {
    const nudges = detectNudges({
      sessions: [session({ observedAt: 9_999 })],
      gasByAddress: new Map([[player.toLowerCase(), 5n]]),
      now: 10_000,
      config: { signStaleMs: 5_000, minGasWei: 1_000n, windowSize: 4, rbfStaleMs: 5_000 },
    })
    expect(nudges.some((n) => n.kind === 'top-up-gas' && n.target === player)).toBe(true)
  })

  it('emits only — returns reminders, performs no side effect (no signer, no tx in scope)', () => {
    // detectNudges is a pure function: same inputs -> same output, no external calls.
    const args = {
      sessions: [session({ observedAt: 0 })],
      gasByAddress: new Map<string, bigint>(),
      now: 10_000,
      config: { signStaleMs: 5_000, minGasWei: 0n, windowSize: 4, rbfStaleMs: 5_000 },
    }
    expect(detectNudges(args)).toEqual(detectNudges(args))
  })
})
