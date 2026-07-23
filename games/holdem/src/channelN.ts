import type { Hex } from 'viem'
import {
  signStateN, verifyStateSigN, hashStateN, totalLocked,
  type ChannelDomainN, type ChannelStateN, type StateSigner,
} from './stateSigN'

/// A state plus the per-seat signatures collected so far. `sigs[i]` is seat i's
/// signature (or undefined until it has co-signed). Fully signed iff every entry set.
export interface CoSignedStateN { state: ChannelStateN; sigs: (Hex | undefined)[] }
export type LegalityN = (prev: ChannelStateN | null, proposed: ChannelStateN) => string | null

export interface ChannelNConfig {
  domain: ChannelDomainN
  tableId: Hex
  me: StateSigner
  seat: number          // my seat index in [0, nSeats)
  seatKeys: Hex[]       // channel signing keys for every seat (length nSeats)
  escrow: bigint        // total locked on-chain for this table (Σ per-seat escrow)
}

const MAX_UINT64 = (1n << 64n) - 1n

/// N-party co-signing channel. Generalizes the 2-party Channel: a state is only adopted
/// once ALL live seats have signed it (N-of-N). Each seat runs one ChannelN with its own
/// seat index; propose → every peer countersign → finalize when sigs.length == N and all set.
export class ChannelN {
  latest: CoSignedStateN | null = null
  private legality: LegalityN = () => null
  private pendingHash: Hex | null = null
  private cfg: ChannelNConfig

  constructor(cfg: ChannelNConfig) {
    if (cfg.seat < 0 || cfg.seat >= cfg.seatKeys.length)
      throw new Error('channelN: seat out of range')
    this.cfg = { ...cfg, seatKeys: [...cfg.seatKeys] }
  }

  get nSeats(): number { return this.cfg.seatKeys.length }

  setLegality(fn: LegalityN): void { this.legality = fn }

  private validate(proposed: ChannelStateN): void {
    const prev = this.latest?.state ?? null
    if (proposed.tableId !== this.cfg.tableId) throw new Error('channelN: wrong tableId')
    if (proposed.nonce > MAX_UINT64) throw new Error('channelN: nonce exceeds uint64')
    if (!Number.isInteger(proposed.phase) || proposed.phase < 0 || proposed.phase > 255)
      throw new Error('channelN: phase exceeds uint8')
    if (proposed.balances.length !== this.nSeats)
      throw new Error(`channelN: balances length must be ${this.nSeats}, got ${proposed.balances.length}`)
    if (proposed.pot < 0n || proposed.rakeAccrued < 0n)
      throw new Error('channelN: negative amount')
    for (const b of proposed.balances) if (b < 0n) throw new Error('channelN: negative balance')
    for (const sp of proposed.sidePots) if (sp.amount < 0n) throw new Error('channelN: negative side-pot')
    if (totalLocked(proposed) !== this.cfg.escrow)
      throw new Error('channelN: conservation violated (Σbalances+pot+ΣsidePots+rake != escrow)')
    if (prev === null) {
      if (proposed.nonce !== 0n) throw new Error('channelN: genesis nonce must be 0')
    } else if (proposed.nonce !== prev.nonce + 1n) {
      throw new Error(`channelN: nonce must be ${prev.nonce + 1n}, got ${proposed.nonce}`)
    }
    const veto = this.legality(prev, proposed)
    if (veto) throw new Error(veto)
  }

  private emptySigs(): (Hex | undefined)[] { return new Array(this.nSeats).fill(undefined) }

  /**
   * I author the next state and sign it into my seat slot.
   * caller must not propose again until finalize succeeds or the proposal is abandoned.
   */
  async propose(state: ChannelStateN): Promise<CoSignedStateN> {
    this.validate(state)
    this.pendingHash = hashStateN(this.cfg.domain, state)
    const sig = await signStateN(this.cfg.me, this.cfg.domain, state)
    const sigs = this.emptySigs()
    sigs[this.cfg.seat] = sig
    return { state, sigs }
  }

  /**
   * A peer proposed (or partially co-signed); validate every present signature against the
   * matching seat key, add mine, and return the augmented co-signed state. Does NOT adopt as
   * latest until it is fully signed (finalize / countersign-to-complete does that).
   */
  async countersign(partial: CoSignedStateN): Promise<CoSignedStateN> {
    this.validate(partial.state)
    if (partial.sigs.length !== this.nSeats) throw new Error('channelN: sigs length mismatch')
    for (let i = 0; i < this.nSeats; i++) {
      const sig = partial.sigs[i]
      if (sig === undefined) continue
      if (!(await verifyStateSigN(this.cfg.seatKeys[i]!, this.cfg.domain, partial.state, sig)))
        throw new Error(`channelN: bad signature for seat ${i}`)
    }
    const sigs = [...partial.sigs]
    sigs[this.cfg.seat] = await signStateN(this.cfg.me, this.cfg.domain, partial.state)
    const full: CoSignedStateN = { state: partial.state, sigs }
    if (this.fullySigned(full)) this.latest = full
    return full
  }

  /** The proposer adopts the fully-countersigned state. */
  async finalize(countersigned: CoSignedStateN): Promise<void> {
    this.validate(countersigned.state)
    if (this.pendingHash === null || hashStateN(this.cfg.domain, countersigned.state) !== this.pendingHash)
      throw new Error('channelN: finalize state does not match pending proposal')
    if (!this.fullySigned(countersigned)) throw new Error('channelN: finalize state not fully signed')
    if (!(await this.verifyAll(countersigned)))
      throw new Error('channelN: finalize has a bad signature')
    const expectedNonce = this.latest === null ? 0n : this.latest.state.nonce + 1n
    if (countersigned.state.nonce !== expectedNonce) throw new Error('channelN: finalize nonce mismatch')
    this.latest = countersigned
    this.pendingHash = null
  }

  /**
   * Adopt a fully-signed state broadcast by another seat (the final fan-out of an
   * N-of-N co-sign). Every honest seat ends a round holding the same `latest`. Idempotent
   * if already adopted; rejects a non-full or badly-signed or non-monotone state.
   */
  async adopt(full: CoSignedStateN): Promise<void> {
    if (!this.fullySigned(full)) throw new Error('channelN: adopt state not fully signed')
    if (!(await this.verifyAll(full))) throw new Error('channelN: adopt has a bad signature')
    // idempotent: re-adopting the state already held (same nonce) is a no-op
    if (this.latest !== null && full.state.nonce === this.latest.state.nonce) {
      if (hashStateN(this.cfg.domain, full.state) !== hashStateN(this.cfg.domain, this.latest.state))
        throw new Error('channelN: adopt conflicts with held state at same nonce')
      return
    }
    this.validate(full.state)
    const expectedNonce = this.latest === null ? 0n : this.latest.state.nonce + 1n
    if (full.state.nonce !== expectedNonce) throw new Error('channelN: adopt nonce mismatch')
    this.latest = full
    this.pendingHash = null
  }

  fullySigned(s: CoSignedStateN): boolean {
    return s.sigs.length === this.nSeats && s.sigs.every((x) => x !== undefined)
  }

  /** Verify every present signature against its seat key. */
  async verifyAll(s: CoSignedStateN): Promise<boolean> {
    if (s.sigs.length !== this.nSeats) return false
    for (let i = 0; i < this.nSeats; i++) {
      const sig = s.sigs[i]
      if (sig === undefined) return false
      if (!(await verifyStateSigN(this.cfg.seatKeys[i]!, this.cfg.domain, s.state, sig))) return false
    }
    return true
  }

  /** Mirror of HoldemTableN.topUp (per-seat escrow add): bumps the conservation target. */
  applyTopUp(amount: bigint): void {
    if (amount <= 0n) throw new Error('channelN: top-up must be positive')
    this.cfg.escrow += amount
  }
}
