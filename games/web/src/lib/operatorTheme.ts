/**
 * Fetch an operator theme manifest JSON from its metadata URI, with a hard timeout. Returns the raw parsed
 * JSON (ThemeProvider re-validates it through parseManifest) or undefined on ANY failure — no URI, timeout,
 * network error, non-2xx, or non-JSON — so a slow or dead URI never blocks the table from rendering (spec
 * §9). The engine is fail-safe: an undefined manifest is the house default.
 */
export const fetchThemeManifest = async (
  uri: string | undefined,
  timeoutMs = 4000,
): Promise<unknown | undefined> => {
  if (!uri) return undefined
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(uri, { signal: ctrl.signal })
    if (!res.ok) return undefined
    return (await res.json()) as unknown
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
