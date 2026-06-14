/** A parsed cosign route. */
export type CosignRoute =
  | { kind: 'signatures'; namespace: string; scope: string }
  | { kind: 'digest'; namespace: string; scope: string; digest: string }
  | { kind: 'aggregate'; namespace: string; scope: string; digest: string }
  | { kind: 'owners'; namespace: string; scope: string }

/**
 * Matches `/cosign/:namespace/:scope/...` into a typed route, or null when the path
 * is not a (well-formed) cosign route. Segments are URL-decoded.
 */
export const matchCosignRoute = (pathname: string): CosignRoute | null => {
  const parts = pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s))
  // parts[0] must be 'cosign' (the group prefix)
  if (parts[0] !== 'cosign') return null
  const namespace = parts[1]
  const scope = parts[2]
  if (!namespace || !scope) return null

  // /cosign/:ns/:scope/signatures
  if (parts.length === 4 && parts[3] === 'signatures') return { kind: 'signatures', namespace, scope }
  // /cosign/:ns/:scope/owners
  if (parts.length === 4 && parts[3] === 'owners') return { kind: 'owners', namespace, scope }
  // /cosign/:ns/:scope/digest/:digest
  if (parts.length === 5 && parts[3] === 'digest' && parts[4])
    return { kind: 'digest', namespace, scope, digest: parts[4] }
  // /cosign/:ns/:scope/digest/:digest/aggregate
  if (parts.length === 6 && parts[3] === 'digest' && parts[4] && parts[5] === 'aggregate')
    return { kind: 'aggregate', namespace, scope, digest: parts[4] }

  return null
}
