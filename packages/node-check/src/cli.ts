/**
 * Ask every endpoint in `targets.ts` what it answers to an anonymous caller.
 *
 *   npm run check --workspace=@msgboard/node-check
 *
 * Exit 1 when an endpoint WE operate fails. A public peer's exposure is
 * printed and does not fail the run: it is a finding to report to them, not
 * our outage. Exit 1 also when one of ours cannot be checked at all, because a
 * check that stopped looking must never read as a pass.
 */
import { checkEndpoint, type ExposureReport } from './check.js'
import { ALL_TARGETS } from './targets.js'

const MARK: Record<string, string> = {
  pass: 'ok  ',
  warn: 'WARN',
  fail: 'FAIL',
  inconclusive: '????',
  error: 'ERR ',
}

const line = (r: ExposureReport): string => {
  const owner = r.ours ? 'valve' : 'third'
  const note =
    r.exposed.length > 0
      ? `exposed: ${r.exposed.map((e) => `${e.method}(${e.severity})`).join(' ')}`
      : (r.detail ?? `${r.absent.length} methods absent`)
  return `${MARK[r.status] ?? r.status}  ${owner}  ${r.name.padEnd(38)}${note}`
}

const main = async (): Promise<void> => {
  console.log(`Asking ${ALL_TARGETS.length} endpoints what they answer anonymously.\n`)
  console.log('STATUS OWNER ENDPOINT                              DETAIL')

  const reports: ExposureReport[] = []
  // Sequential on purpose. Most of these are other people's nodes, and a burst
  // of parallel batches is how you get rate limited.
  for (const target of ALL_TARGETS) {
    const report = await checkEndpoint(target, { fetcher: (u, i) => fetch(u, i) })
    reports.push(report)
    console.log(line(report))
  }

  const ours = reports.filter((r) => r.ours)
  const broken = ours.filter((r) => r.status === 'fail' || r.status === 'error')
  if (broken.length > 0) {
    console.error(`\n${broken.length} endpoint(s) we operate failed or could not be checked.`)
    process.exit(1)
  }
  console.log('\nEvery endpoint we operate refuses anonymous callers.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
