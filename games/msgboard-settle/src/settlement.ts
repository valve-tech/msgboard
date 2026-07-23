import { type Hex } from 'viem'
import { type SessionState } from '@msgboard/games'

/** A both-signed state pulled from a retained transcript. */
export interface CoSignedState {
  state: SessionState
  sigPlayer: Hex
  sigHouse: Hex
}

/** A viem-ready contract call: address + abi + functionName + args. The caller simulates then
 *  writes (the @msgboard/games-core operator.ts pattern); we only build the request shape. */
export interface TxRequest {
  address: Hex
  abi: unknown
  functionName: string
  args: readonly unknown[]
}

/** The settlement seam (spec §6): three interchangeable backends behind one interface. Plan 2
 *  ships optimistic + escrowed; open() is a no-op for optimistic (no per-table lock). */
export interface Settlement {
  /** Build the on-chain call that settles a finished session from its retained transcript JSON. */
  buildSettle(transcriptJson: string): Promise<TxRequest>
}
