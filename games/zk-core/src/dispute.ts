import type { CoSignedState } from './channel'
import type { ChannelState } from './stateSig'
import type { Envelope, Transcript } from './transcript'
import type { Hex } from 'viem'

export interface Demand {
  from: 'A' | 'B'
  kind: string
  detail: string
}

export interface DisputeEvidence {
  tableId: Hex           // anchors this slice to a specific table
  transcriptHead: Hex    // anchors this slice to a specific chain position
  state: ChannelState
  sigA: string
  sigB: string
  messages: Envelope[]  // signed protocol messages after the co-signed state
  demand: Demand        // what the counterparty owes next (drives the chess clock)
  serialized: string    // JSON for transport/mirroring (bigints as strings)
}

export function buildEvidence(args: {
  coSigned: CoSignedState
  transcript: Transcript
  sinceSeq: number
  demand: Demand
}): DisputeEvidence {
  const { coSigned, transcript, sinceSeq, demand } = args
  if (!Number.isInteger(sinceSeq) || sinceSeq < 0 || sinceSeq > transcript.entries.length)
    throw new Error('dispute: sinceSeq out of range')
  if (!coSigned.sigA || !coSigned.sigB)
    throw new Error('dispute: latest state must be fully co-signed')
  const messages = transcript.entries.filter((e) => e.seq >= sinceSeq)
  const body = {
    tableId: transcript.tableId,
    transcriptHead: transcript.head,
    state: coSigned.state,
    sigA: coSigned.sigA,
    sigB: coSigned.sigB,
    messages,
    demand,
  }
  return {
    tableId: transcript.tableId,
    transcriptHead: transcript.head,
    state: coSigned.state,
    sigA: coSigned.sigA,
    sigB: coSigned.sigB,
    messages,
    demand,
    serialized: JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  }
}
