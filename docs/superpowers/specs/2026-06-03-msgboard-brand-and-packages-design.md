# MsgBoard Brand and Package Architecture — Design

Date: 2026-06-03
Status: Architecture decided; open details flagged for review before planning.

## Summary

Move the MsgBoard developer tooling onto its own brand, the npm scope **`@msgboard`**
(confirmed available, including the bare name `msgboard`), and restructure it into a
clear four-part lineup plus a Foundry offering:

- **`@msgboard/core`** — the proof-of-work engine ("msgpow"): pure primitives, no network.
- **`@msgboard/sdk`** — the board client (`MsgBoardClient`) on top of `core`.
- **`@msgboard/hardhat`** — the Hardhat plugin (provider + tasks) for Hardhat developers.
- **Foundry library** — for Foundry developers, doing **both**: a `forge`-installable Solidity
  cheatcode wrapper for the `msgboard_*` JSON-RPC methods, and a pure-Solidity `msgpow`
  verifier.

The existing published package `@pulsechain/msgboard` (v0.0.28) becomes `@msgboard/sdk`
(+ the extracted `@msgboard/core`); the old name is deprecated with a pointer, not deleted.
Finally, an automated **publish stream** (CI) ships new versions on a release tag.

This supersedes the earlier "publish stream for @pulsechain/msgpow/msgboard/hardhat-msgpow"
framing: the brand is `@msgboard`, and `msgpow` is the `@msgboard/core` package.

## Context (current state, discovered on-machine)

- `packages/client` = `@pulsechain/msgboard` v0.0.28 (public; the package improved earlier
  today with an OpenRPC spec + canonical README + on-site docs portal). `src/index.ts` is the
  client; `src/utils.ts` is the pure PoW/encoding engine; `src/types.ts` shared types.
- `packages/hardhat` = `@pulsechain/hardhat-msgboard` v0.0.1, **private**, never published. It
  imports `@pulsechain/msgboard` in `index.ts`, `provider.ts`, `tasks.ts`.
- `packages/ui` (`msgboard-ui`), `packages/sponsor` (`msgboard-sponsor`) — private apps, not
  part of this lineup.
- `packages/faucet` — Go app, not npm.
- An older standalone `craftsmanfounder_gitlab/msgboard/msgboard-npmpackage` = `@pulsechain/msgboard`
  v0.0.24 (predecessor of `packages/client`; not the source of truth).
- The protocol itself lives in the reth fork: `reth-msgboard` + `reth-msgboard-types` crates.
- Git remotes: `origin` = gitlab.com/pulsechaincom/msgboard, `github` = github.com/3commascapital/msgboard.
- No CI/release config exists in this repo. A reusable GitLab CI template exists at the sibling
  `msgboard-ui/.gitlab-ci.yml`; `forge-std` provides the canonical Foundry-library GitHub Actions.

## Decided architecture

### Brand and npm scope

- Scope: **`@msgboard`** (own brand). All published TypeScript packages live under it.
- The currently published `@pulsechain/msgboard` is **deprecated** via `npm deprecate` with a
  message directing users to `@msgboard/sdk`. It is not unpublished (existing installs keep working).
- `@pulsechain/hardhat-msgboard` was never published, so it is simply renamed (no deprecation needed).

### Package lineup and dependency graph

```
@msgboard/core  (TS, pure PoW/encoding — "msgpow")
      ▲
@msgboard/sdk   (TS, MsgBoardClient: JSON-RPC + doPoW orchestration)
      ▲
@msgboard/hardhat (TS, Hardhat plugin: provider + tasks)

Foundry library (Solidity, standalone — installed via `forge install`)
  ├─ cheatcode wrapper: read/post msgboard_* via vm.rpc in tests/scripts
  └─ msgpow verifier:    pure-Solidity verification of the proof of work
```

### What moves where (from `packages/client`)

- **`@msgboard/core`**: `src/utils.ts` (`checkWork`, `getChallenge`, `difficulty`,
  `difficultyDigest`, `categoryHash`, `encodeData`, `toRLP`, `fromRLP`, `fromRPCMessage`,
  `toRPCMessage`, `wrapLegacySend`), `src/logger.ts`, and the PoW/encoding types from
  `src/types.ts` (`MessageSeed`, `Message`, `WorkStats`, `WorkResult`, `DifficultyFactors`,
  `Provider`, `LegacyProvider`, `Logger`, `Config`). Depends only on `viem`, `bn.js`, `elliptic`,
  `debug`. No JSON-RPC method calls.
- **`@msgboard/sdk`**: `src/index.ts` (`MsgBoardClient`: `status`/`categories`/`content`/
  `addMessage`/`getMessage`, plus `doPoW` orchestration — which needs a provider for block
  polling, so it stays in the client). The RPC types (`RPCMessage`, `Categories`, `Content`,
  `ContentFilter`, `Status`). Depends on `@msgboard/core`. Re-exports `core` for convenience.
  Carries the OpenRPC spec (`openrpc.json`), the canonical README, and the reference generator
  produced earlier today — all updated to the `@msgboard/sdk` name.
- **`@msgboard/hardhat`**: `packages/hardhat` un-privated and renamed; its three
  `import * as msgboard from '@pulsechain/msgboard'` lines become `@msgboard/sdk`; dependency
  bumped accordingly.

### Foundry library (both forms)

A single Solidity package (one `foundry.toml`, forge-installable), containing two modules:

- **`MsgBoard.sol`** — a test/script helper library that calls the node's `msgboard_*` methods
  through Foundry's `vm.rpc(string method, string params)` cheatcode, returning typed structs.
  The Foundry analog of the Hardhat plugin: Foundry developers read board state and submit
  messages from `forge test`/`forge script`.
- **`MsgPow.sol`** — a pure-Solidity implementation of the msgboard proof-of-work
  verification (mirroring `@msgboard/core`'s `checkWork`/`difficulty`/`getChallenge`), so
  contracts and tests can verify (and, where feasible, produce) stamps. This is heavier
  (secp256k1 point multiplication + sha256 in Solidity) and is the riskier of the two;
  see Risks.

## Repository and monorepo layout

This monorepo (`gitlab.com/pulsechaincom/msgboard`) is the consolidation point. Proposed
directory changes:

- `packages/client` → `packages/sdk` (`@msgboard/sdk`).
- New `packages/core` (`@msgboard/core`), extracted from the SDK.
- `packages/hardhat` stays in place; identity changes to `@msgboard/hardhat` (public).
- New Solidity package for the Foundry library (proposed `packages/foundry`, with its own
  `foundry.toml` and `src/`), **or** a dedicated sibling repo — see Open Decisions.
- `packages/ui`, `packages/sponsor`, `packages/faucet` unchanged (internal/app, not published).

## Publish stream (CI)

- Platform: **GitLab CI** (`.gitlab-ci.yml` on `origin`), modeled after `msgboard-ui/.gitlab-ci.yml`.
- Trigger: a semver **git tag** (e.g. `v1.2.3`) on the default branch. The job builds the
  workspace, then runs `npm publish --access public` for each public `@msgboard/*` package whose
  version is not already on the registry (publish is idempotent/guarded so re-runs are safe).
- The Foundry library is released by the tag itself (forge installs from a git ref); the CI job
  additionally creates a GitLab release for the tag.
- Auth: an npm **automation token** for the `@msgboard` org, stored as a masked CI variable
  (`NPM_TOKEN`).

## Human prerequisites (cannot be done from the repo)

1. Create the **`@msgboard` organization on npmjs.com** and add the publishing account.
2. Generate an npm **automation token** with publish rights to `@msgboard` and add it as a
   masked GitLab CI variable `NPM_TOKEN`.
3. Decide the canonical home for the Foundry library if it is to be a separate repo (Open Decisions).

## Decisions (confirmed 2026-06-03)

1. **Deprecation of `@pulsechain/msgboard`** — `npm deprecate @pulsechain/msgboard
   "moved to @msgboard/sdk"`; keep it installable (not unpublished).
2. **Directory renames** — CONFIRMED: rename `packages/client` → `packages/sdk` and add
   `packages/core`. Folder names match package names.
3. **Foundry library home** — CONFIRMED: `packages/foundry` inside this monorepo (validate the
   `forge install` subdirectory/remapping path during its plan).
4. **`core`/`sdk` boundary for `doPoW`** — `doPoW` (block-polling orchestration) lives in
   `@msgboard/sdk`; `@msgboard/core` exposes the pure work primitives it calls.
5. **Versioning at launch** — CONFIRMED: continue `0.0.x`. The SDK carries forward its current
   version line; `@msgboard/core` and `@msgboard/hardhat` start at `0.0.1`.

## Plan decomposition

Per writing-plans guidance (separate plans per independent subsystem), this spec produces **two**
implementation plans, each shippable on its own:

- **Plan A — TypeScript brand restructure + publish stream** (this is written first): extract
  `@msgboard/core`, rename the SDK to `@msgboard/sdk`, un-private/rename `@msgboard/hardhat`,
  add the GitLab CI publish stream, deprecate the old name. Produces the published `@msgboard/*`
  TypeScript packages.
- **Plan B — Foundry library** (written next): `packages/foundry` with the `vm.rpc` cheatcode
  wrapper (`MsgBoard.sol`) and the Solidity `msgpow` verifier (`MsgPow.sol`) + a Forge test
  suite. The verifier requires research (a Solidity secp256k1 scalar-multiplication approach and
  gas profiling), which is why it is its own plan.

## Out of scope / deferred

- Zod validation upgrade (previously deferred).
- The chain 943/1 default RPC fallbacks (previously deferred).
- Consolidating the older `craftsmanfounder_gitlab/msgboard` layers (`msgboard-ui4`, etc.) into
  this monorepo.
- Any change to the reth node crates (`reth-msgboard`).
- Publishing or changing `packages/ui`, `packages/sponsor`, `packages/faucet`.

## Build order (becomes the implementation plan)

1. **Extract `@msgboard/core`** from the SDK (move PoW primitives + types + logger; SDK imports it). Tests green.
2. **Rename SDK** `@pulsechain/msgboard` → `@msgboard/sdk`, depend on `core`, update `openrpc.json`/README/docs references and the UI's import. Tests + UI build green.
3. **Un-private + rename Hardhat plugin** to `@msgboard/hardhat`; update its SDK import. Tests green.
4. **Foundry library**: `packages/foundry` with `MsgBoard.sol` (cheatcode wrapper) and
   `MsgPow.sol` (verifier) + a Forge test suite (`forge test`).
5. **Publish stream**: `.gitlab-ci.yml` that publishes public `@msgboard/*` on a version tag.
6. **Deprecate** `@pulsechain/msgboard` (manual `npm deprecate`, post-launch).

## Risks and mitigations

- **Solidity `msgpow` verifier feasibility/cost** — secp256k1 + sha256 in Solidity is expensive
  and intricate. Mitigation: implement and gas-profile `MsgPow.sol` behind a Forge test suite
  first; if on-chain verification proves impractical, ship the cheatcode wrapper (the higher-value
  Foundry deliverable) and scope the verifier to test-only/view usage.
- **Brand migration breaking existing users** — Mitigation: deprecate (don't unpublish) the old
  name; the deprecation message points to `@msgboard/sdk`.
- **`forge install` from a monorepo subdirectory** — Mitigation: validate the remapping/path
  install works in a scratch project; fall back to a dedicated repo if ergonomics are poor.
- **npm org/token prerequisites are human-gated** — the publish stream can be authored and
  tested in dry-run, but real publishes wait on the `@msgboard` org + token.
