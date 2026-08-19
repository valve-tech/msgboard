# Dependabot triage and remediation plan — 2026-08-17

Repo: `valve-tech/msgboard` (default branch `master`). This is a plan only. No
package.json, no lockfile, no install, and no build changed in this pass.

## Summary

GitHub reports 33 open Dependabot alerts: 1 critical, 20 high, 3 low, 9 moderate.
Every alert is a **transitive** dependency. None is a direct entry in a
`package.json`. So most alerts do not map to a single Dependabot PR. The fastest
safe fix for most of them is a set of `overrides` that pins the patched
transitive version. The risky bumps are the framework majors — hardhat 3, vite 6,
and vitest 2→3.

Two alerts look **stale** (already fixed on `master`, not yet re-scanned):

- `socket.io-parser` (#30, high) — the package is absent from the committed
  `package-lock.json`. Nothing pulls it in.
- `@babel/core` (#12, low) — the committed lockfile holds `7.29.7`, which is
  above the patched `7.29.6`.

Re-run the Dependabot scan first. That should drop the open count before any code
change.

## Manifests

- Root `package-lock.json` — one npm workspace tree. Holds 31 of the 33 alerts.
- `packages/faucet/web/package-lock.json` — a standalone legacy faucet UI
  (ethers 5, svelte 3, rollup 2). Holds 2 alerts: `brace-expansion` (#25) and
  `ws` (#6).

## Ownership of the vulnerable packages (who pulls each in)

- `markdown-it` (#3) → `packages/ui` (runtime). This ships. It renders board
  messages. `linkify-it` (#15, #19) sits under `markdown-it`.
- `vite` (#13, #14) → `games/web` dev build (vite 5.4), `ponder` (indexer),
  and every game workspace. `postcss` (#27, #28, #38) sits under `vite`.
  `nanoid` (#39, #41) sits under `postcss`.
- `vitest` (#1, critical) → all 28 workspaces. 15 `games/*` use vitest 2.1.9;
  13 `packages/*` use vitest 3.2.4.
- `immutable` (#20, #21), `adm-zip` (#18), `undici` (#9, #10, #11, #31, #32, #33)
  → `hardhat` 2.28.6 and hardhat plugins (dev, contracts toolchain).
- `js-yaml` (#16, #17, #22, #23, #36, #37) → eslint, `solidity-coverage`
  (sc-istanbul), nyc (dev).
- `brace-expansion` (#24 root, #25 faucet) → eslint, nyc, rimraf, glob (dev).
- `ws` (#4, #7 root; #6 faucet) → viem, hardhat-tracer, circomlibjs.

## Contracts build constraint (why hardhat 3 is dangerous)

`games/contracts/hardhat.config.ts` and `games/contracts/foundry.toml` both pin
`evmVersion: 'shanghai'` with `viaIR`. A comment in the config states that
`viaIR + cancun` emits `MCOPY`, which reverts on chain 943 as
"invalid opcode: MCOPY". The zkverify path pins solc 0.8.27 with `viaIR:false`,
also shanghai. foundry pins solc 0.8.25, evm_version shanghai.

The EVM target is set **explicitly**, so a routine hardhat patch will not flip it.
The danger is a **major** toolchain jump. Hardhat 3 (PR #23) is a rewrite with a
new config format and a new compile engine (EDR). It would need
`@nomicfoundation/hardhat-network-helpers` 3.x (PR #21) and a full re-verify that
the shanghai target and the deployed bytecode do not change. Treat #23 and #21 as
a dedicated migration, never as a security merge. The dev-only alerts under
hardhat (immutable, adm-zip, undici) do not justify that jump.

## Alert-to-action table

Severity uses the GitHub label (moderate = medium). "Target" is the first patched
version. Scope "runtime" means the alert ships in a product; "dev" means it lives
in test or build tooling only.

| Package | Alert(s) | Sev | Scope | Current → target | Manifest | Existing PR? | Risk | Tests to run |
|---|---|---|---|---|---|---|---|---|
| vitest | #1 | critical | dev | 2.1.9 / 3.2.4 → 3.2.6 | root | none | packages/* patch (safe); games/* is 2→3 major | `npm run test` per workspace |
| nanoid | #39, #41 | high | runtime | 3.3.11 → 3.3.18 | root | none | low (semver-compatible override) | web build + games/web tests |
| postcss | #27, #28, #38 | high/med | runtime | 8.5.3 → 8.5.23 | root | none | low (minor override) | web build |
| vite | #13, #14 | high/med | runtime | 5.4.21 → 6.4.3 | root | none | high (vite 5→6 major; dev-server-only bug) | games/web + ponder build |
| markdown-it | #3 | med | runtime | 14.1.1 → 14.2.0 | root | none | low; **ships in ui** | ui build + visual markdown check |
| linkify-it | #15, #19 | high | runtime | 5.0.0 → 5.0.2 | root | none | low; under markdown-it | ui build + visual markdown check |
| ws | #4, #7 | high | runtime | 7.5.10 / 8.18.0 / 8.20.1 → 7.5.11 / 8.21.0 | root | none | low (override) | relayer + games/web smoke |
| ws | #6 | high | runtime | 8.18.0 → 8.21.0 | faucet/web | none (majors #7,#8 unrelated) | low (override) | faucet build |
| brace-expansion | #24 | high | dev | 1.1.11 → 1.1.16 | root | none | low (override) | lint |
| brace-expansion | #25 | high | dev | 1.1.15 → 1.1.16 | faucet/web | none | low (override) | faucet build |
| immutable | #20, #21 | high | dev | 4.3.7 → 4.3.9 | root | none (do NOT use #23) | low (override) | hardhat compile + test |
| adm-zip | #18 | high | dev | 0.4.16 → 0.6.0 | root | none (do NOT use #23) | low-med (override) | hardhat compile + test |
| js-yaml | #22, #36, #16 | high/med | dev | 3.14.1 → 3.15.1 | root | none | low (override) | lint + coverage |
| js-yaml | #23, #37, #17 | high/med | dev | 4.1.0 → 4.3.1 | root | partly via #13/#20 | low (override) | lint + coverage |
| undici | #9,#10,#11,#31,#32,#33 | low/med | dev | 5.29.0 → 6.28.0 | root | none | high (5→6 major; used by hardhat-verify) | hardhat verify + test |
| socket.io-parser | #30 | high | — | absent | root | — | stale — re-scan | none |
| @babel/core | #12 | low | dev | 7.29.7 (already > 7.29.6) | root | — | stale — re-scan | none |

## Open Dependabot PRs and what they cover

| PR | Bump | Helps which alerts | Verdict |
|---|---|---|---|
| #23 | hardhat 2.28.6 → 3.11.1 | immutable/adm-zip/undici (dev) | **Do not merge for security.** Major rewrite; risks the shanghai EVM target. Separate migration only. |
| #21 | hardhat-network-helpers 1→3 | none alone | Pairs with #23. Hold. |
| #22 | @tailwindcss/vite 4.1.4 → 4.3.3 | none (tailwind v4 uses lightningcss, not the flagged postcss/vite) | Safe minor, but not a security fix. Run web build. |
| #20 | typescript-eslint 8.31 → 8.65 | may refresh js-yaml/brace-expansion under eslint | Safe dev minor. Run lint. |
| #13 | solidity-coverage 0.8.15 → 0.8.17 | js-yaml + brace-expansion under sc-istanbul | Safe dev patch. Run coverage. |
| #19 | react-dom + @types/react-dom | none | Safe. Run web build. |
| #17 | eslint-plugin-prettier 5.2.6 → 5.5.6 | none | Safe dev. |
| #15 | @types/debug | none | Safe (types). |
| #10 | pg + @types/pg | none | Safe. Run indexer test. |
| #5 | @iconify/react 5 → 6 | none | Web build; check icons. |
| #18 / #2 | actions/setup-node 5→7, checkout 5→7 | none (CI) | Safe. |
| #9,#8,#7,#4,#3 | faucet/web rollup 4, commonjs 29, ws, ethers 6, svelte 5, prettier-plugin-svelte 4 | ws #6, brace-expansion #25 (as a side effect) | Big legacy majors for a test faucet. Prefer an override for the two alerts; defer the majors. |

The takeaway: no open PR cleanly closes the critical alert or the runtime alerts
that ship (markdown-it, linkify-it, the vite→postcss→nanoid chain). Targeted
`overrides` close those with low risk and avoid the framework majors.

## Ordered action list

1. **Re-run the Dependabot scan.** Confirm #30 (socket.io-parser) and #12
   (@babel/core) drop as stale. This lowers the count before any change.
2. **Critical — vitest.** Bump `packages/*` to vitest 3.2.6 first (patch inside
   ^3; safe). Then move the 15 `games/*` workspaces from 2.1.9 to 3.x and re-run
   each workspace test. Closes #1. Tests: `npm run test` per workspace.
3. **Runtime overrides that ship — one PR.** Add root `overrides`:
   `markdown-it@14.2.0`, `linkify-it@5.0.2`, `postcss@8.5.23`, `nanoid@3.3.18`,
   `ws@8.21.0`. Closes #3, #15, #19, #27, #28, #38, #39, #41, #4, #7. Tests:
   `packages/ui` build plus a visual markdown-render check; `games/web` build;
   relayer smoke.
4. **Dev overrides — one PR.** Add root `overrides`: `brace-expansion@1.1.16`,
   `js-yaml@3.15.1` and `js-yaml@4.3.1`, `immutable@4.3.9`, `adm-zip@0.6.0`.
   Closes #16, #17, #20, #21, #22, #23, #24, #36, #37, #18. Tests: `npm run lint`,
   contracts `npm run test` and `forge test`, coverage run. Verify the shanghai
   target and bytecode do not move.
5. **faucet/web — one small PR.** Add `overrides`: `ws@8.21.0`,
   `brace-expansion@1.1.16` in `packages/faucet/web/package.json`. Closes #6, #25.
   Skip the majors (#3, #4, #7, #8, #9) for now. Test: faucet web build.
6. **Merge the safe Dependabot PRs** after CI: #13, #20, #17, #15, #10, #19, #5,
   #18, #2, #22. Each is a minor/patch or a CI action. Run the matching workspace
   test on merge.
7. **Risky — schedule, do not rush.** (a) vite 5→6 for `games/web` with
   `@vitejs/plugin-react` and vitest 3 (#13, #14 — dev-server-only Windows bug,
   low real risk on the Linux deploy). (b) undici 5→6 (#9–#11, #31–#33 — all
   dev/low-med; a 6.x override can break hardhat-verify, so bump the plugin
   instead or accept the risk). (c) hardhat 3 migration (#23 + #21) as its own
   project with a full shanghai/MCOPY re-verify.

## Constraints honored

Read-only. No file under `package.json`/lockfile changed, no install, no build,
no merge, no push. Searches stayed inside the repo (no recursive scan of `~` or
iCloud paths).
