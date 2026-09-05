// Has the reference implementation moved under us?
//
// msgboard's protocol is defined by erigon-pulse, and the branch that carries
// it — `pulse-v3.4.4` — is a BRANCH, so it moves silently. That has already
// cost real findings twice: the msg/1 wire format change and the board
// comparator guard were both discovered by a person, not by a check. It
// happened a third time while this package was being written: a routine fetch
// moved the branch from 4fc50455ef to 78fbcffb8b and nothing said so.
//
// The pin below turns the next move into a reviewable diff.

export interface WatchedObject {
  /** `tree` for a directory, `blob` for a file. The distinction decides how
   *  the path must be queried — see planQueries. */
  type: 'tree' | 'blob'
  /** The git object id we last reviewed. */
  oid: string
  why?: string
}

export interface UpstreamPin {
  remote: string
  branch: string
  commit: string
  reviewed: string
  watched: Record<string, WatchedObject>
}

/**
 * What upstream holds right now, as a fetch reports it.
 *
 * Injected so every decision in this file is testable without a network.
 */
export interface UpstreamState {
  commit: string
  objects: Record<string, string>
}

export type UpstreamFetcher = (pin: UpstreamPin) => Promise<UpstreamState>

/**
 * Distinct exits, because "it did not pass" is not one thing.
 *
 * A drift and an unreachable remote need different human responses, and
 * collapsing them is how an unreachable remote gets ignored.
 */
export const DriftExit = {
  Ok: 0,
  Drift: 1,
  CannotCheck: 2,
  PinInvalid: 3,
  PathVanished: 4,
} as const

export type DriftExitCode = (typeof DriftExit)[keyof typeof DriftExit]

export interface DriftResult {
  exit: DriftExitCode
  report: string
  changed: string[]
}

/**
 * Split the watched paths into `git ls-tree` calls that answer honestly.
 *
 * `ls-tree` given a directory pathspec AND a file inside it expands the
 * directory into its children and never emits the tree row itself. The first
 * real run of this check hit exactly that and reported the watched `msgboard`
 * tree as deleted upstream. Directories therefore go one per call, and the
 * files go together in one more.
 */
export const planQueries = (watched: Record<string, WatchedObject>): string[][] => {
  const trees = Object.entries(watched).filter(([, s]) => s.type === 'tree').map(([p]) => p).sort()
  const blobs = Object.entries(watched).filter(([, s]) => s.type !== 'tree').map(([p]) => p).sort()
  const groups = trees.map((tree) => [tree])
  if (blobs.length > 0) groups.push(blobs)
  return groups
}

/** Read `<mode> <type> <oid>\t<path>` rows into path -> object id. */
export const parseLsTree = (listing: string): Record<string, string> => {
  const objects: Record<string, string> = {}
  for (const line of listing.split('\n')) {
    if (!line.trim()) continue
    const tab = line.indexOf('\t')
    if (tab === -1) continue
    const parts = line.slice(0, tab).trim().split(/\s+/)
    const path = line.slice(tab + 1).trim()
    if (parts.length >= 3 && path) objects[path] = parts[2]!
  }
  return objects
}

/** Why this pin cannot be used, or null when it can. */
export const validatePin = (pin: UpstreamPin): string | null => {
  if (!pin.remote) return 'the pin names no remote'
  if (!pin.branch) return 'the pin names no branch'
  if (!pin.commit) return 'the pin names no commit'
  // A pin that watches nothing compares nothing and reports success forever.
  // That is the exact failure this file exists to prevent, so it is refused
  // rather than run.
  if (Object.keys(pin.watched).length === 0) return 'the pin watches no paths'
  return null
}

/**
 * Compare the pin against upstream.
 *
 * The one property that matters more than the rest: a run that could not look
 * NEVER reports ok. If the remote is unreachable, the branch renamed, or the
 * ref gone, this returns CannotCheck — because the naive alternative reports
 * "no drift" and looks healthy while the blindness it was built to remove has
 * quietly returned.
 */
export const checkDrift = async (
  pin: UpstreamPin,
  fetchUpstream: UpstreamFetcher,
): Promise<DriftResult> => {
  const invalid = validatePin(pin)
  if (invalid) {
    return { exit: DriftExit.PinInvalid, report: `PIN INVALID: ${invalid}`, changed: [] }
  }

  let state: UpstreamState
  try {
    state = await fetchUpstream(pin)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return {
      exit: DriftExit.CannotCheck,
      report: `CANNOT CHECK: ${pin.remote} ${pin.branch} could not be read — ${why}`,
      changed: [],
    }
  }

  const vanished: string[] = []
  const changed: string[] = []
  for (const [path, spec] of Object.entries(pin.watched)) {
    const observed = state.objects[path]
    if (observed === undefined) vanished.push(path)
    else if (observed !== spec.oid) changed.push(path)
  }

  if (vanished.length > 0) {
    return {
      exit: DriftExit.PathVanished,
      report:
        `PATH VANISHED: upstream no longer has ${vanished.join(', ')}.\n` +
        'A rename upstream breaks this check silently, so it is reported as its own failure.',
      changed,
    }
  }

  if (changed.length > 0) {
    const lines = [
      `DRIFT: ${pin.branch} is at ${state.commit} and these watched paths changed:`,
      ...changed.map((p) => `  - ${p}`),
      '',
      `  git -C <erigon> diff ${pin.commit}..${state.commit} -- ${changed.join(' ')}`,
      '',
      'Read the diff, port what matters, then update the pin in one commit.',
    ]
    return { exit: DriftExit.Drift, report: lines.join('\n'), changed }
  }

  return {
    exit: DriftExit.Ok,
    report: `OK: ${pin.branch} is at ${state.commit} and all ${Object.keys(pin.watched).length} watched paths match.`,
    changed: [],
  }
}
