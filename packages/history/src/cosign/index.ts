/**
 * @msgboard/history cosign route (v1, stateless) — a cosign-aware HTTP endpoint group
 * mounted on the archive server. Decodes/validates/aggregates cosign records fetched
 * live from the board (recent window) + this server's archive.query() (long tail).
 * No store, no daemon, no prune. See docs/superpowers/specs/2026-06-13-msgboard-cosign-archivist-design.md.
 */
export { loadTeamFile } from './team-file.js'
export type { TeamFile, TeamFileInput, TeamEntry, TeamAdapterConfig } from './team-file.js'
export { resolveCategories } from './categories.js'
export type { ResolvedCategory } from './categories.js'
export { matchCosignRoute } from './router.js'
export type { CosignRoute } from './router.js'
export { fetchRecords } from './fetch.js'
export type { CosignRecordView, FetchRecordsArgs } from './fetch.js'
export { handleCosignRequest } from './handler.js'
export type { CosignDeps, CosignResult } from './handler.js'
