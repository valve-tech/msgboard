/**
 * Client-side display names for player-run tables. A name is an INVITE-SCOPED label: the operator (or
 * anyone sharing) attaches it to a table, it rides in the invite link (`?name=`), and it's remembered
 * per browser in localStorage. It is deliberately NOT on-chain and NOT authenticated — the `tableId`
 * is always the source of truth for funds and play; the name is only a friendly label so an invite
 * reads like "Mike's table" instead of a hash. Keeping it off-chain avoids a contract redeploy and
 * can't desync anything. Names are collapsed to one line and capped.
 */
export const MAX_NAME = 40

const key = (chainId: number, tableId: string) => `cft-name:${chainId}:${tableId.toLowerCase()}`

/** Normalize a raw name for display/storage: single-line, trimmed, length-capped. */
export const cleanTableName = (raw: string): string => raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)

export const getTableName = (chainId: number, tableId: string): string | undefined => {
  try {
    const v = localStorage.getItem(key(chainId, tableId))
    return v ? cleanTableName(v) || undefined : undefined
  } catch {
    return undefined // localStorage unavailable (private mode / disabled) — non-fatal
  }
}

export const setTableName = (chainId: number, tableId: string, name: string): void => {
  try {
    const clean = cleanTableName(name)
    if (clean) localStorage.setItem(key(chainId, tableId), clean)
    else localStorage.removeItem(key(chainId, tableId))
  } catch {
    // localStorage unavailable — the name just won't persist; the invite link still carries it.
  }
}
