# @msgboard/node-check

## Board convergence

msgboard gossips, so every node serving a chain should hold nearly the same board. A node that
shares nothing with anyone is partitioned: everything written to it is invisible to the rest of
the network, and any archive reading it records a private view.

```sh
npm run convergence --workspace=@msgboard/node-check
```

Runs hourly in CI (`.github/workflows/board-convergence.yml`) — hourly because the board keeps a
message for only about twenty minutes, so a daily check would miss whole partitions between runs.

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
