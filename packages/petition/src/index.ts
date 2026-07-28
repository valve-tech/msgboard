/**
 * @msgboard/petition — shared interface for MsgBoard petitions: descriptor codec,
 * EIP-712 signature digest, category keys, and the on-chain PetitionSignatures ABI.
 * Pure crypto/encoding; zero chain writes.
 */
export {
  type Petition,
  PETITION_ABI,
  derivePetitionId,
  encodePetition,
  decodePetition,
} from './descriptor.js'
export {
  PETITION_DOMAIN_NAME,
  PETITION_DOMAIN_VERSION,
  PETITION_TYPES,
  petitionDigest,
} from './digest.js'
export { PETITION_NS, INDEX_SCOPE, signScope } from './categories.js'
export {
  PETITION_SIGNATURES_ABI,
  buildSubmitArgs,
  buildSubmitBatchArgs,
  type Deployment,
  deployments,
} from './contract.js'
export {
  createPetition,
  signPetition,
  readPetitions,
  readPetitionSignatures,
  tally,
  verifySignature,
} from './petition.js'
