import * as viem from 'viem'

/**
 * Commit-salt custody. The raffle commitment is keccak256(abi.encode(guess, salt, player)); a
 * player who loses (guess, salt) before revealing forfeits the stake to the pot. Salts are kept
 * in localStorage keyed by chain + contract + ticket, with an export/import backup string so a
 * player can move browsers. The store is injected so tests run on a Map-backed fake.
 */
export type SaltStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type SaltRecord = { guess: bigint; salt: viem.Hex }

const PREFIX = 'msgboard-games'
const key = (chainId: number, raffle: viem.Hex, ticketId: bigint) =>
  `${PREFIX}:${chainId}:${raffle.toLowerCase()}:ticket:${ticketId}`
const manifestKey = (chainId: number, raffle: viem.Hex) => `${PREFIX}:${chainId}:${raffle.toLowerCase()}:tickets`

const loadManifest = (store: SaltStore, chainId: number, raffle: viem.Hex): string[] =>
  JSON.parse(store.getItem(manifestKey(chainId, raffle)) ?? '[]') as string[]

// browser-safe base64 for arbitrary UTF-8 (btoa alone chokes on non-latin1)
const toBase64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
const fromBase64 = (b: string) => new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)))

export const saveSalt = (store: SaltStore, chainId: number, raffle: viem.Hex, ticketId: bigint, record: SaltRecord) => {
  store.setItem(key(chainId, raffle, ticketId), JSON.stringify({ guess: record.guess.toString(), salt: record.salt }))
  const manifest = new Set(loadManifest(store, chainId, raffle))
  manifest.add(ticketId.toString())
  store.setItem(manifestKey(chainId, raffle), JSON.stringify([...manifest]))
}

export const loadSalt = (store: SaltStore, chainId: number, raffle: viem.Hex, ticketId: bigint): SaltRecord | null => {
  const raw = store.getItem(key(chainId, raffle, ticketId))
  if (!raw) return null
  const parsed = JSON.parse(raw) as { guess: string; salt: viem.Hex }
  return { guess: BigInt(parsed.guess), salt: parsed.salt }
}

type Backup = { v: 1; chainId: number; raffle: viem.Hex; tickets: Record<string, { guess: string; salt: viem.Hex }> }

/** Export every stored ticket for one chain+contract as a single base64 string. */
export const exportBackup = (store: SaltStore, chainId: number, raffle: viem.Hex): string => {
  const tickets: Backup['tickets'] = {}
  for (const id of loadManifest(store, chainId, raffle)) {
    const record = loadSalt(store, chainId, raffle, BigInt(id))
    if (record) tickets[id] = { guess: record.guess.toString(), salt: record.salt }
  }
  const backup: Backup = { v: 1, chainId, raffle, tickets }
  return toBase64(JSON.stringify(backup))
}

/** Import a backup string, returning how many tickets were restored. Throws on garbage. */
export const importBackup = (store: SaltStore, encoded: string): number => {
  let backup: Backup
  try {
    backup = JSON.parse(fromBase64(encoded)) as Backup
  } catch {
    throw new Error('not a valid backup string')
  }
  if (backup?.v !== 1 || typeof backup.chainId !== 'number' || !backup.raffle || typeof backup.tickets !== 'object') {
    throw new Error('not a valid backup string')
  }
  let count = 0
  for (const [id, record] of Object.entries(backup.tickets)) {
    saveSalt(store, backup.chainId, backup.raffle, BigInt(id), { guess: BigInt(record.guess), salt: record.salt })
    count++
  }
  return count
}
