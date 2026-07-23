# Publishing `@msgboard/pow-grinder`

This package mints MsgBoard proof-of-work stamps (`stamp(req) -> nonce_be(8) ‖ hash(32)`) from a
single Rust core, exposed two ways:

| Entry                       | Backend         | Speed        | Portability                          |
| --------------------------- | --------------- | ------------ | ------------------------------------ |
| `@msgboard/pow-grinder`         | native `.node`  | ~0.9–1.2s    | per-platform (built locally, opt-in) |
| `@msgboard/pow-grinder/wasm`    | WASM (`pkg/`)   | ~1.2–1.8s    | **everywhere** (Node, browser, Bun)  |

**WASM is the published, portable path.** The committed `pkg/` (wasm-pack output, ~124 kB `.wasm`)
ships in the npm tarball, so the package works on every platform **without a native build**. Native
is an opt-in, per-platform optimization a consumer can add later — there is **no native prebuild CI /
cross-compilation** set up, and the published tarball intentionally ships **no `.node`** (a single
dev-machine binary would be stale and unusable on linux/browser consumers).

## How consumers import it

Portable WASM stamp (use this everywhere — Node Docker box, browser Web Worker, Bun TUI):

```ts
import init, { stamp } from '@msgboard/pow-grinder/wasm'

// Browser / Web Worker: init() fetches the sibling pow_grinder_bg.wasm.
await init()
// Node / Bun: feed the wasm bytes (init() with no arg tries a file:// fetch and fails):
//   import { readFileSync } from 'node:fs'
//   import { createRequire } from 'node:module'
//   const wasmUrl = new URL('pow_grinder_bg.wasm',
//     'file://' + createRequire(import.meta.url).resolve('@msgboard/pow-grinder/wasm'))
//   await init({ module_or_path: readFileSync(wasmUrl) })

const out = stamp({ category, data, workMultiplier, workDivisor, blockHash, startNonce: 0, maxIters })
// out is a 40-byte Uint8Array: nonce_be(8) ‖ hash(32), or undefined if maxIters exhausted.
```

Optional native fast path (throws if no `.node` for this platform — wrap in try/catch and fall back
to `/wasm`):

```ts
import { stamp } from '@msgboard/pow-grinder'
```

The msgboard repo's `stamper.ts` already implements the native → wasm → none cascade against exactly
these two entries.

## Publish steps (the maintainer runs these)

The package is scoped (`@gibs/...`) and `publishConfig.access` is `"public"`, so it publishes public.

```bash
cd examples/games/pow-grinder

# 1. (Re)build the portable wasm. `prepublishOnly` also runs this automatically on publish, but run it
#    explicitly to confirm a clean build. Needs the Rust toolchain + wasm-pack + wasm32 target:
#      rustup target add wasm32-unknown-unknown
#      cargo install wasm-pack
npm run build:wasm

# 2. Bump the version (creates a git tag by default; use --no-git-tag-version to skip).
npm version patch   # or: minor / major / 0.1.1

# 3. Verify the tarball contents include pkg/ (the wasm) and NOT a .node:
npm pack --dry-run

# 4. Publish.
npm publish --access public
```

### Expected `npm pack --dry-run` contents

```
index.d.ts
index.js
package.json
pkg/package.json
pkg/pow_grinder_bg.wasm        <- the portable engine (~124 kB)
pkg/pow_grinder_bg.wasm.d.ts
pkg/pow_grinder.d.ts
pkg/pow_grinder.js
PUBLISHING.md
```

If `pkg/*` is missing: wasm-pack regenerates `pkg/.gitignore` containing `*`, which npm honors. The
committed `pkg/.npmignore` (empty) overrides it. Keep that file.

## Notes

- The committed `pkg/` is reproducible: `npm run build:wasm` produces a byte-identical `pkg/`.
- The parent package is CommonJS (no `"type"` field — `index.js` uses `require`). `pkg/package.json`
  carries `"type": "module"`, correctly scoping the wasm `.js` as ESM. Do not add `"type": "module"`
  to the parent.
- To add a native fast path on a given platform later: `npm run build:native` writes
  `pow-grinder.<platform>-<arch>.node`, which `index.js` loads. That artifact is gitignored and not
  published.
