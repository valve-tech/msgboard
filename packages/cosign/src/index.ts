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
export {
  type SafeTx,
  type SafeAdapterConfig,
  type SafePublicClient,
  SAFE_ABI,
  SAFE_TX_TYPEHASH,
  DOMAIN_SEPARATOR_TYPEHASH,
  EIP1271_MAGIC_VALUE,
  safeDomain,
  safeTransactionDigest,
  safeTransactionData,
  encodeSafeMeta,
  decodeSafeMeta,
  makeSafeAdapter,
  buildSignatureBlob,
  buildExecTransactionArgs,
  recoverEffectiveSigner,
  verifyErc1271Against,
} from './adapters/safe.js'
export {
  type Safe4337UserOp,
  type Safe4337AdapterConfig,
  SAFE_OP_TYPEHASH,
  SAFE4337_DOMAIN_SEPARATOR_TYPEHASH,
  safe4337DomainSeparator,
  safe4337OperationDigest,
  safe4337OperationData,
  encodeSafe4337Meta,
  decodeSafe4337Meta,
  makeSafe4337Adapter,
  buildSafe4337Signature,
} from './adapters/safe4337.js'
