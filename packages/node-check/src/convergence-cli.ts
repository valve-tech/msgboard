/**
 * Does our board agree with the network's?
 *
 *   npm run convergence --workspace=@msgboard/node-check
 *
 * msgboard gossips, so a node's board should overlap heavily with every other node
 * serving the same chain. A board that shares nothing with anyone is partitioned, and
 * everything written to it is invisible to the rest of the network — which is exactly
 * what happened to a mainnet replica for weeks with no alarm of any kind.
 *
 * Exit 1 when OUR endpoint is partitioned or cannot be read. A public node's failure is
 * printed and does not fail the run: it is theirs to fix. Exit 1 also when we cannot
 * check at all, because a check that stopped looking must never read as a pass.
 *
 * Set `CONVERGENCE_<chain>` to a comma-separated list of per-replica URLs to compare our
 * OWN replicas instead. That is the stronger check and it needs endpoints that reach
 * different nodes — from outside, the gateway pins every request to one of them. It is
 * also the ONLY way to check a chain with no public msgboard node, which is every chain
 * except PulseChain mainnet as of 2026-09-08.
 *
 * A group is only shipped when it can actually be checked from here. A check that can
 * never pass teaches people to ignore it, which is worse than not having it.
 */
import { checkConvergence, endpointsDiffer } from './convergence.js'
import { CONVERGENCE_GROUPS, groupFromEnv } from './targets.js'

const main = async (): Promise<void> => {
  const fetcher = (u: string, i?: RequestInit) => fetch(u, i)
  let failed = 0

  const extra = Object.keys(process.env)
    .filter((k) => k.startsWith('CONVERGENCE_'))
    .map((k) => k.slice('CONVERGENCE_'.length))
    .filter((chain) => !CONVERGENCE_GROUPS.some((g) => g.chain === chain))
    .map((chain) => ({ chain, ours: '', peers: [] as string[] }))

  for (const base of [...CONVERGENCE_GROUPS, ...extra]) {
    const group = groupFromEnv(base, process.env)
    if (!group.ours || group.peers.length === 0) {
      console.error(
        `\nchain ${group.chain} — CONVERGENCE_${group.chain} needs at least two comma-separated URLs`,
      )
      failed += 1
      continue
    }
    console.log(`\nchain ${group.chain} — our board against ${group.peers.length} other node(s)`)

    if (!endpointsDiffer([group.ours, ...group.peers])) {
      console.error('  FAIL  the same URL is listed twice; this would compare a node with itself')
      failed += 1
      continue
    }

    let agreedWithSomeone = false
    let anyPeerAnswered = false
    // Set when OUR board could not be read. That is already counted, and reporting
    // "no peer answered" on top of it double-counts one fault as two.
    let ourBoardUnreadable = false

    for (const peer of group.peers) {
      // requireNonEmpty: two empty boards are identical, so accepting them would pass
      // hardest when there is nothing to compare.
      const r = await checkConvergence({
        fetcher,
        endpoints: [group.ours, peer],
        requireNonEmpty: true,
        // Public endpoints are load-balanced pools and the backends are not uniform:
        // rpc.pulsechain.com served msgboard on 3 of 8 consecutive samples. Three
        // samples would report "nobody answered" about a quarter of the time, so the
        // hourly job would flap between two different failure messages for one
        // condition. Sample more; each one is a single cheap POST.
        samples: 8,
        // The pool picks a backend per REQUEST, so spacing samples out buys nothing
        // here and only makes the job slow. The default 4s interval exists for
        // propagation lag between replicas, which is a different question.
        intervalMs: 400,
      })
      const ourSnapshot = r.snapshots[0]!
      if (!ourSnapshot.ok) {
        // A quota refusal is not a partition, and saying so saves the next person
        // chasing a network problem that is really a rate limit.
        const quota = /429|rate limit/i.test(ourSnapshot.reason ?? '')
        console.error(
          quota
            ? `  FAIL  our endpoint is rate limited (${ourSnapshot.reason}) — convergence unverified, NOT a partition`
            : `  FAIL  we could not read our own board: ${ourSnapshot.reason}`,
        )
        failed += 1
        ourBoardUnreadable = true
        break
      }
      const peerSnapshot = r.snapshots[1]!
      if (!peerSnapshot.ok) {
        console.log(`  skip  ${peer}: ${peerSnapshot.reason}`)
        continue
      }
      anyPeerAnswered = true
      const pct = (r.overlap * 100).toFixed(0)
      if (r.verdict === 'converged') {
        agreedWithSomeone = true
        console.log(`  ok    ${peer}: ${r.shared}/${r.union} shared (${pct}%)`)
      } else if (r.verdict === 'cannot-check') {
        // Both boards empty. Not agreement, not a partition — nothing was learned.
        console.log(`  ????  ${peer}: both boards empty, convergence unproven`)
      } else {
        console.log(`  DIFF  ${peer}: ${r.shared}/${r.union} shared (${pct}%)`)
      }
    }

    if (ourBoardUnreadable) {
      continue
    }
    if (!anyPeerAnswered) {
      // Nobody to compare against is not a pass. It is a check that did not run.
      console.error('  FAIL  no other node on this chain answered; convergence is unverified')
      failed += 1
    } else if (!agreedWithSomeone) {
      console.error('  FAIL  our board shares nothing with any node that answered — partitioned')
      failed += 1
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} chain group(s) failed.`)
    process.exit(1)
  }
  console.log('\nOur board agrees with the network on every chain checked.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
