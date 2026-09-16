/**
 * @msgboard/history petition route (v1, stateless) — a petition-aware HTTP endpoint
 * group mounted on the archive server. Decodes petition descriptors + signatures
 * fetched live from the board (recent window) + this server's archive.query() (long
 * tail). Mirrors ../cosign, minus the team-file/owners concept — petitions have no
 * owner set, so every petition id is servable.
 */
export { resolveIndexCategories, resolveSignatureCategories } from './categories.js'
export type { ResolvedCategory } from './categories.js'
export { matchPetitionRoute } from './router.js'
export type { PetitionRoute } from './router.js'
export { fetchPetitions } from './fetch.js'
export type { PetitionView, FetchPetitionsArgs } from './fetch.js'
export { handlePetitionRequest } from './handler.js'
export type { PetitionDeps, PetitionResult } from './handler.js'
