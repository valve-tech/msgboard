# MsgBoard Brand Restructure (TypeScript) Implementation Plan — Plan A

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the TypeScript packages onto the `@msgboard` brand — extract `@msgboard/core` (the proof-of-work engine), rename the SDK to `@msgboard/sdk`, un-private/rename the Hardhat plugin to `@msgboard/hardhat` — and add a GitLab CI publish stream that ships them on a version tag.

**Architecture:** A single npm workspace. `@msgboard/core` holds the pure PoW/encoding primitives + types; `@msgboard/sdk` holds `MsgBoardClient` and re-exports `core` (so the public surface matches the old `@pulsechain/msgboard`); `@msgboard/hardhat` depends on the SDK. All in-repo consumers (ui, sponsor, hardhat) are repointed from `@pulsechain/msgboard` to `@msgboard/sdk`. Versions continue the `0.0.x` line.

**Tech Stack:** TypeScript, npm workspaces, tsc, vitest, GitLab CI, npm publish.

**Spec:** `docs/superpowers/specs/2026-06-03-msgboard-brand-and-packages-design.md`

**Scope:** This is Plan A. The Foundry library (`packages/foundry`, `MsgBoard.sol` + `MsgPow.sol`) is **Plan B**, written separately. Deferred: Zod, 943/1 RPC defaults.

**Commit signing:** every commit is signed via the 1Password SSH agent. NEVER `--no-gpg-sign`/`--no-verify`. No AI attribution. If signing fails ("failed to fill whole buffer"), STOP and report BLOCKED — the controller commits.

**Platform note:** macOS. In-place sed is `sed -i '' '…'`.

---

## File Structure

**Create:**
- `packages/core/` — new `@msgboard/core` package: `package.json`, `tsconfig.json`, `src/index.ts`, moved `src/utils.ts`, moved `src/types.ts`.
- `.gitlab-ci.yml` — publish stream.

**Move/rename:**
- `packages/client/` → `packages/sdk/` (becomes `@msgboard/sdk`).
- `packages/client/src/utils.ts` + `src/types.ts` → `packages/core/src/`.

**Modify:**
- Root `package.json` (workspaces: add `packages/core`, `packages/client`→`packages/sdk`).
- `packages/sdk/package.json` (name, deps), `src/index.ts` (import from `@msgboard/core`, re-export it), `openrpc.json`, `README.md`, regenerate docs.
- `packages/hardhat/package.json` (name, un-private, dep), `src/*.ts` + `test/*.ts` (imports).
- `packages/sponsor/package.json` (dep), `index.ts`/`bridge.ts`/`spam.ts` (imports).
- `packages/ui/package.json` (dep), `src/**` imports + regenerated `docs-content.generated.ts`.

---

## Phase 1 — Extract `@msgboard/core`

### Task 1.1: Scaffold the core package and move the engine

**Files:** Create `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`; move `packages/client/src/utils.ts` and `packages/client/src/types.ts` into `packages/core/src/`.

- [ ] **Step 1: Create `packages/core/package.json`**

```json
{
  "name": "@msgboard/core",
  "version": "0.0.1",
  "description": "MsgBoard proof-of-work engine (msgpow): pure primitives and encoding",
  "repository": "gitlab:pulsechaincom/msgboard",
  "author": "MsgBoard",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "keywords": ["ethereum", "pow", "proof-of-work", "msgboard", "msgpow"],
  "scripts": {
    "build": "tsc",
    "watch": "tsc -w",
    "test": "vitest run"
  },
  "files": ["dist/"],
  "dependencies": {
    "bn.js": "^5.2.1",
    "elliptic": "^6.6.1",
    "viem": "^2.25.0"
  },
  "devDependencies": {
    "@types/bn.js": "^5.1.6",
    "@types/elliptic": "^6.4.18",
    "typescript": "^5.8.2",
    "vitest": "^3.1.1"
  }
}
```

- [ ] **Step 2: Create `packages/core/tsconfig.json`** (mirrors the client's, excludes tests)

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "skipLibCheck": true,
    "esModuleInterop": true,
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "exclude": ["dist", "node_modules", "**/*.test.ts"],
  "include": ["./src"]
}
```

- [ ] **Step 3: Move the engine files into core**

```bash
cd /Users/michaelmclaughlin/Documents/3commascapital/gitlab/pulsechaincom/msgboard
mkdir -p packages/core/src
git mv packages/client/src/utils.ts packages/core/src/utils.ts
git mv packages/client/src/types.ts packages/core/src/types.ts
```

- [ ] **Step 4: Create `packages/core/src/index.ts`** (public surface of core)

```ts
export type * from './types.js'
export * from './utils.js'
```

- [ ] **Step 5: Add `packages/core` to the root workspaces**

In root `package.json`, change:
```json
  "workspaces": ["packages/client","packages/hardhat","packages/ui","packages/sponsor"]
```
to:
```json
  "workspaces": ["packages/core","packages/client","packages/hardhat","packages/ui","packages/sponsor"]
```

- [ ] **Step 6: Point the SDK (still `@pulsechain/msgboard`) at core**

In `packages/client/package.json` add `"@msgboard/core": "^0.0.1"` to `dependencies`.

In `packages/client/src/index.ts`, replace the two local imports:
```ts
import { categoryHash, checkWork, difficulty, encodeData, toRLP } from './utils.js'
```
becomes
```ts
import { categoryHash, checkWork, difficulty, encodeData, toRLP } from '@msgboard/core'
```
and the type import block `from './types.js'` becomes `from '@msgboard/core'`, and the re-export lines:
```ts
export type * from './types.js'
export * from './utils.js'
```
become:
```ts
export * from '@msgboard/core'
```
(Note: `render-reference.ts` does not import types/utils, so it is unaffected.)

- [ ] **Step 7: Install + build + test**

```bash
cd /Users/michaelmclaughlin/Documents/3commascapital/gitlab/pulsechaincom/msgboard
npm install
npm run build --workspace @msgboard/core
npm run build --workspace @pulsechain/msgboard
npx vitest run --root packages/core 2>/dev/null || true
cd packages/client && npx vitest run src/openrpc.test.ts src/render-reference.test.ts && cd ..
```
Expected: both builds exit 0; the client's openrpc + render-reference tests pass. (The 3 live-RPC integration tests in `packages/client/test/index.test.ts` fail on network — known/unrelated.)

- [ ] **Step 8: Commit**

```bash
git add -A packages/core packages/client/package.json packages/client/src/index.ts package.json package-lock.json
git commit -m "feat(core): extract @msgboard/core proof-of-work engine"
```

---

## Phase 2 — Rename the SDK to `@msgboard/sdk` and repoint consumers

### Task 2.1: Rename the package directory and identity

**Files:** `packages/client` → `packages/sdk`; `packages/sdk/package.json`; root `package.json`.

- [ ] **Step 1: Move the directory**

```bash
cd /Users/michaelmclaughlin/Documents/3commascapital/gitlab/pulsechaincom/msgboard
git mv packages/client packages/sdk
```

- [ ] **Step 2: Rename the package + bump nothing (keep version line)**

In `packages/sdk/package.json` set `"name": "@msgboard/sdk"` (was `@pulsechain/msgboard`). Keep `version` as-is (0.0.28). Update `description` to `"MsgBoard client SDK for the msgboard_ JSON-RPC module"`.

- [ ] **Step 3: Update the root workspaces entry**

In root `package.json`, change `"packages/client"` to `"packages/sdk"` in the `workspaces` array.

### Task 2.2: Repoint every in-repo consumer

- [ ] **Step 1: Update dependency declarations**

In each of `packages/hardhat/package.json`, `packages/sponsor/package.json`, `packages/ui/package.json`: replace the dependency key `"@pulsechain/msgboard": "^0.0.28"` with `"@msgboard/sdk": "^0.0.28"` (same version range).

- [ ] **Step 2: Update all source imports (deterministic)**

```bash
cd /Users/michaelmclaughlin/Documents/3commascapital/gitlab/pulsechaincom/msgboard
grep -rl "@pulsechain/msgboard" packages/hardhat packages/sponsor packages/ui \
  --include="*.ts" --include="*.svelte" 2>/dev/null \
  | grep -vE "node_modules|/dist/" \
  | xargs sed -i '' 's#@pulsechain/msgboard#@msgboard/sdk#g'
# verify none remain in source:
grep -rn "@pulsechain/msgboard" packages/hardhat packages/sponsor packages/ui \
  --include="*.ts" --include="*.svelte" 2>/dev/null | grep -vE "node_modules|/dist/" || echo "clean"
```
Expected: final line prints `clean`.

### Task 2.3: Update the SDK's own brand references + regenerate docs

- [ ] **Step 1: Update package name references in the SDK docs**

```bash
cd /Users/michaelmclaughlin/Documents/3commascapital/gitlab/pulsechaincom/msgboard/packages/sdk
sed -i '' 's#@pulsechain/msgboard#@msgboard/sdk#g' README.md openrpc.json
```
Then in `openrpc.json`, update `info.title` if it names the old brand (it is "MsgBoard JSON-RPC API" — leave as-is) — only the package name in prose/`description` changes.

- [ ] **Step 2: Regenerate the reference + UI docs module**

```bash
cd /Users/michaelmclaughlin/Documents/3commascapital/gitlab/pulsechaincom/msgboard/packages/sdk
npm run gen:docs
```
This rewrites the README's generated region and `packages/ui/src/lib/docs-content.generated.ts` with the `@msgboard/sdk` name.

- [ ] **Step 3: Install, build everything, test**

```bash
cd /Users/michaelmclaughlin/Documents/3commascapital/gitlab/pulsechaincom/msgboard
npm install
npm run build --workspace @msgboard/core
npm run build --workspace @msgboard/sdk
cd packages/ui && npm run build && cd ..
cd packages/sdk && npx vitest run src/openrpc.test.ts src/render-reference.test.ts && cd ..
```
Expected: all builds exit 0; SDK unit tests pass.

- [ ] **Step 4: Confirm no stray old name remains anywhere in source/config**

```bash
grep -rn "@pulsechain/msgboard" packages package.json --include="*.ts" --include="*.svelte" --include="*.json" 2>/dev/null | grep -vE "node_modules|/dist/|package-lock" || echo "no @pulsechain/msgboard references remain"
```
Expected: prints the "no … remain" line.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sdk): rename @pulsechain/msgboard to @msgboard/sdk"
```

---

## Phase 3 — Un-private and rename the Hardhat plugin

### Task 3.1: `@pulsechain/hardhat-msgboard` → `@msgboard/hardhat` (public)

**Files:** `packages/hardhat/package.json`.

- [ ] **Step 1: Update identity + un-private**

In `packages/hardhat/package.json`:
- set `"name": "@msgboard/hardhat"` (was `@pulsechain/hardhat-msgboard`)
- remove `"private": true` (so it can publish)
- ensure a `"publishConfig": { "access": "public" }` is present
- ensure `"files": ["dist/"]` is present (add if missing)
- the dependency is already `@msgboard/sdk` from Phase 2.

(The source imports were already updated in Phase 2 Task 2.2.)

- [ ] **Step 2: Install, build, test**

```bash
cd /Users/michaelmclaughlin/Documents/3commascapital/gitlab/pulsechaincom/msgboard
npm install
npm run build --workspace @msgboard/hardhat
cd packages/hardhat && npx vitest run 2>&1 | tail -5 && cd ..
```
Expected: build exits 0; the plugin's tests pass (or fail only for pre-existing/network reasons — note any in the report).

- [ ] **Step 3: Commit**

```bash
git add -A packages/hardhat package-lock.json
git commit -m "feat(hardhat): publish plugin as @msgboard/hardhat"
```

---

## Phase 4 — Publish stream (GitLab CI)

### Task 4.1: `.gitlab-ci.yml` that publishes on a version tag

**Files:** Create `.gitlab-ci.yml` at the repo root.

- [ ] **Step 1: Write the pipeline**

Create `.gitlab-ci.yml`:
```yaml
# Publish stream: on a semver tag (vX.Y.Z), build and publish the public
# @msgboard/* packages whose version is not already on the npm registry.
stages:
  - build
  - publish

default:
  image: node:22

build:
  stage: build
  script:
    - npm ci
    - npm run build --workspace @msgboard/core
    - npm run build --workspace @msgboard/sdk
    - npm run build --workspace @msgboard/hardhat
  rules:
    - if: '$CI_COMMIT_TAG =~ /^v\d+\.\d+\.\d+/'

publish:
  stage: publish
  script:
    - echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > ~/.npmrc
    - npm ci
    - npm run build --workspace @msgboard/core
    - npm run build --workspace @msgboard/sdk
    - npm run build --workspace @msgboard/hardhat
    # idempotent: publish only versions not already on the registry
    - |
      for pkg in @msgboard/core @msgboard/sdk @msgboard/hardhat; do
        dir=$(npm pkg get name --workspaces --json | node -e "const m=JSON.parse(require('fs').readFileSync(0));const e=Object.entries(m).find(([k,v])=>v==='$pkg');process.stdout.write(e?e[0]:'')")
        ver=$(node -p "require('./'+'$dir'+'/package.json').version")
        if npm view "$pkg@$ver" version >/dev/null 2>&1; then
          echo "$pkg@$ver already published, skipping"
        else
          echo "publishing $pkg@$ver"
          npm publish --workspace "$pkg" --access public
        fi
      done
  rules:
    - if: '$CI_COMMIT_TAG =~ /^v\d+\.\d+\.\d+/'
```

- [ ] **Step 2: Validate the YAML locally**

```bash
cd /Users/michaelmclaughlin/Documents/3commascapital/gitlab/pulsechaincom/msgboard
node -e "const y=require('fs').readFileSync('.gitlab-ci.yml','utf8'); require('child_process'); console.log('bytes:', y.length)"
python3 -c "import yaml,sys; yaml.safe_load(open('.gitlab-ci.yml')); print('yaml ok')"
```
Expected: `yaml ok`.

- [ ] **Step 3: Commit**

```bash
git add .gitlab-ci.yml
git commit -m "ci: publish stream for @msgboard packages on version tag"
```

> **Human prerequisite (cannot be automated):** create the `@msgboard` org on npmjs.com and add a masked CI variable `NPM_TOKEN` (an npm automation token with publish rights to `@msgboard`). Until then, the pipeline builds but the publish step has no credentials.

---

## Phase 5 — Deprecate the old name (manual, post-launch)

> This runs once, by a human with npm auth, AFTER `@msgboard/sdk` is first published. Not a code change.

- [ ] **Step 1 (manual):** `npm deprecate @pulsechain/msgboard "moved to @msgboard/sdk"`

Document this in `progress.txt` once done.

---

## Self-Review

**Spec coverage:**
- `@msgboard/core` extracted (PoW engine + types) → Phase 1. ✓
- SDK renamed `@pulsechain/msgboard` → `@msgboard/sdk`, re-exports core → Phase 2. ✓
- All consumers (ui/sponsor/hardhat) repointed → Phase 2.2. ✓
- Docs (openrpc/README/UI module) rebranded + regenerated → Phase 2.3. ✓
- Hardhat plugin un-privated + renamed `@msgboard/hardhat` → Phase 3. ✓
- Publish stream on version tag (GitLab CI) → Phase 4. ✓
- Old name deprecated → Phase 5 (manual). ✓
- Versions continue 0.0.x (core/hardhat 0.0.1, sdk keeps its line) ✓
- Foundry library is explicitly Plan B, not here. ✓

**Placeholder scan:** No TBD/TODO; every code step shows the content. The publish-loop shell maps package name→dir at runtime (no hardcoded paths to drift).

**Type/name consistency:** `@msgboard/core` exports `export * from './utils.js'` + types; the SDK imports those names (`categoryHash`/`checkWork`/`difficulty`/`encodeData`/`toRLP`) from `@msgboard/core` and re-exports `@msgboard/core`, preserving the old public surface. Workspace names used in CI (`@msgboard/core`, `@msgboard/sdk`, `@msgboard/hardhat`) match the package.json names set in Phases 1–3.

**Risk note for the implementer:** the bulk `sed` rename (Phase 2.2) is deterministic but verify the `clean`/`no … remain` checks actually print before committing. The single root `package-lock.json` is regenerated by `npm install` after each dependency change — stage it with each commit. If 1Password signing fails mid-phase, STOP and report BLOCKED; do not bypass signing.
