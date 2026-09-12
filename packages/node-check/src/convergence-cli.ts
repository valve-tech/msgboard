/**
 * Is our board alive, and does it agree with everyone else's?
 *
 *   npm run convergence --workspace=@msgboard/node-check
 *
 * TWO QUESTIONS, AND ONLY ONE OF THEM GATES THE JOB.
 *
 * "Is our board alive" is ours. An empty board means every writer is down or the node
 * stopped accepting. It cannot be explained away as someone else's outage, and we can
 * fix it. That failure has actually happened: a proof-of-work cutover broke every
 * writer on 2026-08-21, all three boards drained to zero inside their ~20 minute
 * retention, and nobody noticed for eighteen days. An hourly run of this catches that
 * within the hour. So it fails the job.
 *
 * "Does our board match the wider network" is real and unowned. Our PulseChain board
 * shares nothing with rpc.pulsechain.com's, which is worth knowing and is nobody's
 * assignment yet. It is REPORTED, never gated. An hourly failure on a finding no one
 * has agreed to act on is exactly how a check trains people to ignore it — and this
 * job has to stay believable for the day the liveness half fires.
 *
 * REPLICA CONVERGENCE GATES WHEN IT CAN BE MEASURED. Set `CONVERGENCE_<chain>` to two
 * or more per-replica URLs and disagreement between OUR OWN nodes fails the run: that
 * is ours as well. From outside the fleet it cannot be measured at all, because the
 * gateway pins each API key to one upstream, so the scheduled job never sees it.
 */
import { checkConvergence, gradeBoardLiveness, snapshotBoard } from './convergence.js'
import { CONVERGENCE_GROUPS, groupFromEnv } from './targets.js'

/** A peer we operate, as opposed to somebody else's public node. */
const isOurs = (url: string): boolean =>
  !/^https?:\/\/(one\.valve\.city|rpc\.|[^/]*publicnode|[^/]*g4mm4)/i.test(url)

const main = async (): Promise<void> => {
  const fetcher = (u: string, i?: RequestInit) => fetch(u, i)
  const env = process.env
  let failed = 0

  const configured = Object.keys(env)
    .filter((k) => k.startsWith('CONVERGENCE_'))
    .map((k) => k.slice('CONVERGENCE_'.length))
    .filter((chain) => !CONVERGENCE_GROUPS.some((g) => g.chain === chain))
    .map((chain) => ({ chain, ours: '', peers: [] as string[] }))

  for (const base of [...CONVERGENCE_GROUPS, ...configured]) {
    const group = groupFromEnv(base, env)
    if (!group.ours) {
      console.error(`\nchain ${group.chain} — CONVERGENCE_${group.chain} needs at least two URLs`)
      failed += 1
      continue
    }
    console.log(`\nchain ${group.chain}`)

    // ── gate 1: our own board is readable and not empty ───────────────────────
    const ours = await snapshotBoard(fetcher, group.ours)
    const life = gradeBoardLiveness(ours)
    if (life.verdict === 'alive') {
      console.log(`  ok    our board holds ${life.count} message(s)`)
    } else {
      console.error(`  FAIL  ${life.reason}`)
      failed += 1
      // Nothing downstream is meaningful once our own board is gone, and reporting
      // "nobody agrees with us" on top of it counts one fault as several.
      continue
    }

    // ── gate 2: our replicas agree, when we can actually address them ─────────
    for (const replica of group.peers.filter(isOurs)) {
      const r = await checkConvergence({
        fetcher,
        endpoints: [group.ours, replica],
        requireNonEmpty: true,
        samples: 4,
        intervalMs: 3_000,
      })
      if (r.verdict === 'converged') {
        console.log(`  ok    replica agrees: ${r.shared}/${r.union} shared`)
      } else {
        console.error(`  FAIL  our replicas disagree: ${r.shared}/${r.union} shared — not gossiping`)
        failed += 1
      }
    }

    // ── information only: how we sit against other people's nodes ─────────────
    for (const peer of group.peers.filter((p) => !isOurs(p))) {
      const r = await checkConvergence({
        fetcher,
        endpoints: [group.ours, peer],
        requireNonEmpty: true,
        // These are load-balanced pools whose backends are not uniform:
        // rpc.pulsechain.com served msgboard on 3 of 8 consecutive samples. The pool
        // picks a backend per REQUEST, so sample often and do not space them out.
        samples: 8,
        intervalMs: 400,
      })
      const peerSnapshot = r.snapshots[1]
      if (!peerSnapshot?.ok) {
        console.log(`  note  ${peer}: ${peerSnapshot?.reason ?? 'no answer'}`)
      } else if (r.verdict === 'converged') {
        console.log(`  note  ${peer}: agrees, ${r.shared}/${r.union} shared`)
      } else {
        console.log(
          `  NOTE  ${peer}: shares ${r.shared}/${r.union} with us — our board may not be ` +
            'reaching the public network. Real, unassigned, deliberately not failing this job.',
        )
      }
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed.`)
    process.exit(1)
  }
  console.log('\nEvery board we own is alive, and every replica we can address agrees.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
