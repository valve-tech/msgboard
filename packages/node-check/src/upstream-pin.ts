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
  watched: {
    msgboard: {
      type: 'tree',
      oid: '4f47bf0ecfeddc3117e5026ec1af2fda04c1ee69',
      why: 'The whole package. A tree oid also catches a file that did not exist when this pin was written, which per-file entries alone would miss.',
    },
    'msgboard/message_index.go': {
      type: 'blob',
      oid: '3b7b812834d9a0d770a8825be03faf5d39c8a8cb',
      why: 'Holds MsgIndex.Insert, the board ordering comparator. A change here reorders every board and changes which message is evicted.',
    },
    'msgboard/message_id.go': { type: 'blob', oid: '56826cb7d289109164e4817cc2082c44a88bf9d2' },
    'msgboard/fetch.go': { type: 'blob', oid: 'b273eee400682b9150aae28eb0afae09ae6e7519' },
    'msgboard/board.go': { type: 'blob', oid: '2c9e9847fbdea9e755107154f123a7b509920669' },
    'rpc/jsonrpc/msgboard_api.go': {
      type: 'blob',
      oid: '871568e85d48580bd192bf9d71441415e790f9b8',
      why: 'The JSON-RPC surface this package checks against. ContentFilter lives here.',
    },
    'cmd/rpcdaemon/rpcservices/eth_msgboard.go': {
      type: 'blob',
      oid: '3872648fda3b189aaeb06027bbee79ba78dc6ff8',
    },
  },
}
