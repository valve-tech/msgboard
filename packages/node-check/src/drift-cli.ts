/**
 * Ask whether erigon-pulse has moved under us.
 *
 *   npm run drift --workspace=@msgboard/node-check
 *
 * Exit codes are distinct on purpose: 0 ok, 1 drift, 2 cannot check, 3 pin
 * invalid, 4 a watched path vanished. A run that could not look never exits 0.
 */
import { checkDrift } from './drift.js'
import { fetchUpstream } from './drift-fetch.js'
import { UPSTREAM_PIN } from './upstream-pin.js'

const result = await checkDrift(UPSTREAM_PIN, fetchUpstream)
if (result.exit === 0) console.log(result.report)
else console.error(result.report)
process.exit(result.exit)
