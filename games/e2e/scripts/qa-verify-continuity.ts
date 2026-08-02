/**
 * Slot-continuity gate for a CoinFlipTables redeploy. The caster's heatsSince counts RoundOpened from
 * the table address to keep the shared-pool slot counter aligned; swapping to a new address MUST keep
 * counting the old one (via coinFlipTablesRetired) or the count drops by the old contract's rounds →
 * SecretMismatch. This computes heatsSince BOTH ways at the same chain head and asserts the new
 * (NEW + retired[OLD]) config yields the SAME slot sequence as the old (OLD-only) config.
 *
 *   OLD=0x… NEW=0x… npx tsx scripts/qa-verify-continuity.ts
 */
import { loadDeployment, heatsSince, type Deployment } from './actor-common'
import { makePublicClient } from '@msgboard/games-core'

async function main() {
  /* eslint-disable no-console */
  const OLD = process.env.OLD as `0x${string}`
  const NEW = process.env.NEW as `0x${string}`
  if (!OLD || !NEW) throw new Error('set OLD and NEW table addresses')
  const base = loadDeployment(943)
  const pc = makePublicClient(943, process.env.RPC_URL)

  const oldCfg: Deployment = { ...base, coinFlipTables: OLD, coinFlipTablesRetired: undefined }
  const newCfg: Deployment = { ...base, coinFlipTables: NEW, coinFlipTablesRetired: [OLD] }

  // Same head for both (heatsSince reads getBlockNumber internally; run back-to-back, tolerate a small
  // organic tail from coinflip/raffle heats landing between the two scans).
  const before = await heatsSince(pc, oldCfg)
  const after = await heatsSince(pc, newCfg)

  const oldKeys = before.map((h) => h.key)
  const newKeys = after.map((h) => h.key)
  const prefixMatch = oldKeys.every((k, i) => newKeys[i] === k)
  const delta = newKeys.length - oldKeys.length

  console.log(`OLD-only config:      ${oldKeys.length} heats`)
  console.log(`NEW + retired[OLD]:   ${newKeys.length} heats  (delta ${delta >= 0 ? '+' : ''}${delta})`)
  console.log(`old sequence is a prefix of new: ${prefixMatch}`)
  // Continuity holds when the new config counts AT LEAST as many (never fewer — fewer = dropped slots)
  // and the old slot order is preserved as a prefix. A small positive delta is organic heats between
  // the two scans; a NEGATIVE delta means the swap dropped the old contract's slots → NOT SAFE.
  const safe = delta >= 0 && prefixMatch && delta <= 4
  console.log(safe ? '\n✅ CONTINUOUS — safe to point the caster at the new config.' : '\n❌ NOT CONTINUOUS — do NOT deploy; the slot counter would jump.')
  process.exit(safe ? 0 : 1)
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1) })
