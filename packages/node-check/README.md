# @msgboard/node-check

## Board convergence

Two questions, and only one of them fails the job.

**Is our board alive?** This gates. An empty board means every writer is down or the node stopped
accepting — nobody else's fault, and fixable by us. A proof-of-work cutover broke every writer on
2026-08-21; all three boards drained to zero inside their ~20 minute retention and nobody noticed
for eighteen days. Hourly, this catches it within the hour.

**Does our board agree with the wider network?** This is reported, never gated. Our PulseChain
board shares nothing with `rpc.pulsechain.com`'s, which is real and currently unassigned. A job
that fails hourly on a finding nobody has agreed to act on is how a check teaches people to
ignore it — and this one has to stay believable for the day the liveness half fires.

**Do our own replicas agree?** This gates too, but only where it can be measured — see below.

```sh
npm run convergence --workspace=@msgboard/node-check
```

Runs hourly in CI (`.github/workflows/board-convergence.yml`) — hourly because the board keeps a
message for only about twenty minutes, so a daily check would miss whole partitions between runs.

**Two empty boards are not agreement.** They are identical, so a check that accepts them passes
hardest exactly when there is nothing to compare — and two replicas whose boards both expire to
zero would read as converged. Pass `requireNonEmpty` whenever the answer is load-bearing (verifying
a fix, gating a deploy) and the verdict becomes `cannot-check`, which is what it is. The CLI always
sets it.

**It grades on overlap, not equality.** Healthy replicas never match exactly: messages expire, and
a message posted a second ago has not propagated. It samples three times and one agreeing sample
settles it, so lag never pages anyone. Only a pair that never overlaps is diverged. Two empty
boards report `idle`, not `converged` — calling that agreement would have graded an 18-day writer
outage green.

### What it cannot see from CI

`one.valve.city` pins each API key to one upstream and strips client routing headers, so from
outside we reach one of our replicas and cannot address the other. **A replica-versus-replica
split is invisible to the scheduled job** — the mainnet split found on 2026-09-08, where two nodes
held completely disjoint boards for weeks, would NOT have been caught by it.

To check that, run from inside the fleet with per-replica URLs:

```sh
CONVERGENCE_1='http://replica-a:8545,http://replica-b:8545' \
  npm run convergence --workspace=@msgboard/node-check
```

Any `CONVERGENCE_<chain>` works, including chains with no shipped group. Only PulseChain mainnet
has a public node serving msgboard, so every other chain is env-only.

### Known signature difference

The erigon-pulse reference takes no arguments for `msgboard_content` and rejects one with "too many
arguments, want at most 0"; our port takes an optional filter object. The check tries the filter
form and falls back, so a node is never recorded as unreachable over an argument count.
