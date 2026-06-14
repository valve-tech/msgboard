import { readFileSync } from 'node:fs'

/** Validation/ordering adapter selector. `kind: "none"` = accept every decodable record. */
export type TeamAdapterConfig = {
  kind: string
  config?: Record<string, unknown>
}

/** A single served team — a cosign `scope` under the file's `namespace`. `"*"` matches any scope. */
export type TeamEntry = {
  scope: string
  label?: string
}

/** The raw on-disk team-file shape (Registry v1). No `store` block — v1 is stateless. */
export type TeamFileInput = {
  version: number
  namespace: string
  /** Default + clamp for the rolling window; defaults to 7 when omitted. */
  windowDays?: number
  teams: TeamEntry[]
  /** Board node to read from (optional here; the server is handed the board client directly). */
  chain?: { chainId?: number; rpcUrl?: string }
  adapter: TeamAdapterConfig
}

/** A loaded, validated team-file with resolution + clamp helpers. */
export type TeamFile = {
  version: number
  namespace: string
  windowDays: number
  teams: TeamEntry[]
  chain?: { chainId?: number; rpcUrl?: string }
  adapter: TeamAdapterConfig
  /** Returns the served team for (namespace, scope), or undefined when unknown. */
  resolve(namespace: string, scope: string): TeamEntry | undefined
  /** Clamps a requested days to [1, windowDays]; NaN/undefined → windowDays. */
  clampDays(days: number | undefined): number
}

const DEFAULT_WINDOW_DAYS = 7

/**
 * Loads + validates a team-file from a JSON path or an in-memory object, returning a
 * {@link TeamFile} with `resolve` / `clampDays`. Throws on a malformed file.
 */
export const loadTeamFile = (source: string | TeamFileInput): TeamFile => {
  const raw: TeamFileInput =
    typeof source === 'string'
      ? (JSON.parse(readFileSync(source, 'utf8')) as TeamFileInput)
      : source

  if (raw.version !== 1)
    throw new Error(`loadTeamFile: unsupported version ${raw.version} (expected 1)`)
  if (typeof raw.namespace !== 'string' || raw.namespace.length === 0)
    throw new Error('loadTeamFile: namespace is required')
  if (!Array.isArray(raw.teams) || raw.teams.length === 0)
    throw new Error('loadTeamFile: teams must list at least one team (or a "*" wildcard)')
  if (!raw.adapter || typeof raw.adapter.kind !== 'string')
    throw new Error('loadTeamFile: adapter.kind is required')

  const windowDays =
    typeof raw.windowDays === 'number' && Number.isFinite(raw.windowDays) && raw.windowDays >= 1
      ? Math.floor(raw.windowDays)
      : DEFAULT_WINDOW_DAYS

  const teams = raw.teams
  const namespace = raw.namespace

  const resolve = (ns: string, scope: string): TeamEntry | undefined => {
    if (ns !== namespace) return undefined
    return teams.find((t) => t.scope === scope || t.scope === '*')
  }

  const clampDays = (days: number | undefined): number => {
    if (days === undefined || !Number.isFinite(days)) return windowDays
    const floored = Math.floor(days)
    if (floored < 1) return 1
    return Math.min(floored, windowDays)
  }

  return {
    version: 1,
    namespace,
    windowDays,
    teams,
    chain: raw.chain,
    adapter: raw.adapter,
    resolve,
    clampDays,
  }
}
