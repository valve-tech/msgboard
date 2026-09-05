import type { UpstreamPin } from './drift.js'

/**
 * The upstream state we last read and understood.
 *
 * Updating this is a HUMAN act, on purpose. Bump `commit` and the `oid`s only
 * after reading the upstream diff, in one commit. The check will not do it for
 * you, so it cannot heal itself past a change nobody looked at.
 */
export const UPSTREAM_PIN: UpstreamPin = {
  remote: 'https://gitlab.com/pulsechaincom/erigon.git',
  branch: 'pulse-v3.4.4',
  commit: '78fbcffb8b23fee20deff3e6c5641f23865f98ff',
  reviewed: '2026-09-04',
  // Only what a CLIENT can see. The whole `msgboard` tree and the p2p fetch
  // path were watched first, and they fire on internal changes that cannot
  // reach us. These four are the wire format and the RPC surface.
  watched: {
    'msgboard/message_index.go': {
      type: 'blob',
      oid: '3b7b812834d9a0d770a8825be03faf5d39c8a8cb',
      why: 'MsgIndex.Insert, the board ordering comparator. A change here reorders every board a client reads.',
    },
    'msgboard/message_id.go': {
      type: 'blob',
      oid: '56826cb7d289109164e4817cc2082c44a88bf9d2',
      why: 'Message identity and its encoding. The client computes the same ids.',
    },
    'rpc/jsonrpc/msgboard_api.go': {
      type: 'blob',
      oid: '871568e85d48580bd192bf9d71441415e790f9b8',
      why: 'The JSON-RPC surface this package calls. ContentFilter lives here.',
    },
    'cmd/rpcdaemon/rpcservices/eth_msgboard.go': {
      type: 'blob',
      oid: '3872648fda3b189aaeb06027bbee79ba78dc6ff8',
      why: 'How the daemon wires that surface up.',
    },
  },
}
