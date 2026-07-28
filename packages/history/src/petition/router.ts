/** A parsed petition route. */
export type PetitionRoute =
  { kind: 'index' } | { kind: 'signatures'; id: string } | { kind: 'tally'; id: string }

/**
 * Matches `/petition/...` into a typed route, or null when the path is not a
 * (well-formed) petition route. Segments are URL-decoded. Mirrors `matchCosignRoute`'s
 * segment parsing, minus the team-file/owners concept — petitions have no owner set.
 */
export const matchPetitionRoute = (pathname: string): PetitionRoute | null => {
  const parts = pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s))
  // parts[0] must be 'petition' (the group prefix)
  if (parts[0] !== 'petition') return null

  // /petition/index
  if (parts.length === 2 && parts[1] === 'index') return { kind: 'index' }

  const id = parts[1]
  if (!id) return null

  // /petition/:id/signatures
  if (parts.length === 3 && parts[2] === 'signatures') return { kind: 'signatures', id }
  // /petition/:id/tally
  if (parts.length === 3 && parts[2] === 'tally') return { kind: 'tally', id }

  return null
}
