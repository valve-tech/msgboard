import type { Hex } from 'viem'
import {
  signState, verifyStateSig, hashState, type ChannelDomain, type ChannelState, type StateSigner,
} from './stateSig'

export interface CoSignedState { state: ChannelState; sigA?: Hex; sigB?: Hex }
export type Legality = (prev: ChannelState | null, proposed: ChannelState) => string | null

export interface ChannelConfig {
  domain: ChannelDomain
  tableId: Hex
  me: StateSigner
  peer: Hex
  role: 'A' | 'B'
  escrow: bigint            // total locked on-chain for this table
}

const MAX_UINT64 = (1n << 64n) - 1n

export class Channel {
  latest: CoSignedState | null = null
  private legality: Legality = () => null
  private pendingHash: Hex | null = null
  private cfg: ChannelConfig
  constructor(cfg: ChannelConfig) { this.cfg = { ...cfg } }

  setLegality(fn: Legality): void { this.legality = fn }

  private validate(proposed: ChannelState): void {
    const prev = this.latest?.state ?? null
    if (proposed.tableId !== this.cfg.tableId) throw new Error('channel: wrong tableId')
    if (proposed.nonce > MAX_UINT64) throw new Error('channel: nonce exceeds uint64')
    if (!Number.isInteger(proposed.phase) || proposed.phase < 0 || proposed.phase > 255)
      throw new Error('channel: phase exceeds uint8')
    if (proposed.balanceA < 0n || proposed.balanceB < 0n || proposed.pot < 0n)
      throw new Error('channel: negative amount')
    if (proposed.balanceA + proposed.balanceB + proposed.pot !== this.cfg.escrow)
      throw new Error('channel: conservation violated (A+B+pot != escrow)')
    if (prev === null) {
      if (proposed.nonce !== 0n) throw new Error('channel: genesis nonce must be 0')
    } else if (proposed.nonce !== prev.nonce + 1n) {
      throw new Error(`channel: nonce must be ${prev.nonce + 1n}, got ${proposed.nonce}`)
    }
    const veto = this.legality(prev, proposed)
    if (veto) throw new Error(veto)
  }

  private mySigSlot(): 'sigA' | 'sigB' { return this.cfg.role === 'A' ? 'sigA' : 'sigB' }
  private peerSigSlot(): 'sigA' | 'sigB' { return this.cfg.role === 'A' ? 'sigB' : 'sigA' }

  /**
   * I author the next state and sign it.
   * caller must not propose again until finalize succeeds or the proposal is abandoned
   * (pendingHash is overwritten by a second propose)
   */
  async propose(state: ChannelState): Promise<CoSignedState> {
    this.validate(state)
    this.pendingHash = hashState(this.cfg.domain, state)
    const sig = await signState(this.cfg.me, this.cfg.domain, state)
    return { state, [this.mySigSlot()]: sig } as CoSignedState
  }

  /**
   * peer proposed; validate, countersign, adopt.
   * the acceptor's commit point — adopting here is by design; the proposer commits at finalize()
   */
  async accept(proposal: CoSignedState): Promise<CoSignedState> {
    this.validate(proposal.state)
    const peerSig = proposal[this.peerSigSlot()]
    if (!peerSig || !(await verifyStateSig(this.cfg.peer, this.cfg.domain, proposal.state, peerSig)))
      throw new Error('channel: bad peer signature on proposal')
    const mine = await signState(this.cfg.me, this.cfg.domain, proposal.state)
    const full: CoSignedState = { ...proposal, [this.mySigSlot()]: mine }
    this.latest = full
    return full
  }

  /** proposer adopts the countersigned state */
  async finalize(countersigned: CoSignedState): Promise<void> {
    this.validate(countersigned.state)
    if (this.pendingHash === null || hashState(this.cfg.domain, countersigned.state) !== this.pendingHash)
      throw new Error('channel: finalize state does not match pending proposal')
    const { state } = countersigned
    const expectedNonce = this.latest === null ? 0n : this.latest.state.nonce + 1n
    if (state.nonce !== expectedNonce) throw new Error('channel: finalize nonce mismatch')
    const peerSig = countersigned[this.peerSigSlot()]
    const mySig = countersigned[this.mySigSlot()]
    if (!peerSig || !(await verifyStateSig(this.cfg.peer, this.cfg.domain, state, peerSig)))
      throw new Error('channel: bad peer countersignature')
    if (!mySig || !(await verifyStateSig(this.cfg.me.address, this.cfg.domain, state, mySig)))
      throw new Error('channel: my signature missing on finalize')
    this.latest = countersigned
    this.pendingHash = null
  }

  fullySigned(s: CoSignedState): boolean { return Boolean(s.sigA && s.sigB) }

  /** Mirror of ZkTable.topUp: both parties call this when the TopUp event lands;
   *  conservation (A+B+pot == escrow) is checked against the bumped total. */
  applyTopUp(amount: bigint): void {
    if (amount <= 0n) throw new Error('channel: top-up must be positive')
    this.cfg.escrow += amount
  }
}
