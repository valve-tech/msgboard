/**
 * @msgboard/cosign — generic signature-share over MsgBoard, bucketed under rotating,
 * day-granular UTC category keys. Pure board + crypto; zero chain writes.
 */
export { isoDay, categoryKey, currentKey, keysForWindow } from './keys.js'
export {
  SCHEME,
  RECORD_ABI,
  type SignatureRecord,
  encodeRecord,
  decodeRecord,
} from './record.js'
export {
  type BoardClient,
  type PostSignatureArgs,
  type ReadSignaturesArgs,
  postSignature,
  readSignatures,
  groupByDigest,
  aggregate,
} from './client.js'
export type { CosignAdapter } from './adapters/adapter.js'
