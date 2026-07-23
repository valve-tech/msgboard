# ZK skill-game proving keys — publishing & in-browser proving

The ZK skill games (Sudoku / Wordle) prove with **snarkjs PLONK** circuits. Proving needs two artifacts
per circuit:

| artifact | what it is | size |
| --- | --- | --- |
| `<circuit>_plonk.zkey` | the **proving key** (PLONK setup output) | 6–66 MB |
| `<circuit>.wasm` | the witness generator | 0.2–2 MB |

They are produced by `src/harness.ts` (`setupCircuit`) and live **gitignored** under `build/`:

```
build/sudoku_solve/sudoku_solve_plonk.zkey           (~66 MB)
build/sudoku_solve/sudoku_solve_js/sudoku_solve.wasm (~4 MB)
build/wordle_solve/wordle_solve_plonk.zkey           (~31 MB, real 12,972-word dict at depth 14)
build/wordle_solve/wordle_solve_js/wordle_solve.wasm
build/wordle_clue/wordle_clue_plonk.zkey             (~6 MB)
build/wordle_clue/wordle_clue_js/wordle_clue.wasm
```

`build/` stays out of git. The **GitHub Release is the artifact channel**; the committed record is
`proving-keys.manifest.json` (hashes + sizes + release tag).

## Security model — availability, not integrity

**A PLONK proving key needs availability, not integrity, for soundness.** The on-chain verifier
contract is the real, immutable commitment to the trusted setup. A proof is only worth anything if that
verifier accepts it — and a corrupted, swapped, or outright **malicious** zkey **cannot forge a proof
the on-chain verifier accepts**. It can only *fail* to produce a valid proof.

Consequences:

- We may host these files **anywhere untrusted** — a GitHub Release, an S3 bucket, a CDN such as
  `one.valve.city` fronting any of the above — with **zero soundness risk to funds**.
- We publish a **sha256 per artifact only to DETECT CORRUPTION** (a CDN bit-flip, a truncated download,
  a stale asset after a re-setup). That is a **denial-of-service / UX** guard: without it the prover
  would burn seconds/minutes on bad bytes and then emit a proof the chain rejects. **It is not a trust
  boundary for funds** — do not market it as one. The guarantee lives in the verifier bytecode on chain.

(Contrast the Hermez ptau in `src/harness.ts`, whose blake2b is checked against an *independent
published* digest for provenance — but even there the ultimate trust bottoms out in the verifier.)

## Publishing

Default is a **dry run** — it hashes every artifact, (re)writes `proving-keys.manifest.json`, and prints
the exact `gh release` command it *would* run. It uploads nothing.

```bash
cd examples/games/zk-skill
tsx scripts/publishProvingKeys.ts            # DRY RUN: hash + write manifest + print plan
tsx scripts/publishProvingKeys.ts --publish  # actually create the Release + upload assets (gated)
tsx scripts/publishProvingKeys.ts --tag=proving-keys-v2   # override the release tag
```

The script streams each file through sha256 (1 MiB at a time) so the 66 MB zkey never lands in memory
whole — mirroring the streaming blake2b in `src/harness.ts`. Missing artifacts are warned about and
skipped, not fatal. After a real `--publish`, **commit `proving-keys.manifest.json`** so the browser
loader ships with the current hashes.

## Browser consumption

Import from the package's browser subpath (kept separate from the node-only root export so DOM code and
the node harness never mix):

```ts
import manifest from '@msgboard/zk-skill/proving-keys.manifest.json'
import { proveInWorker } from '@msgboard/zk-skill/browser'

const circuit = manifest.circuits.find((c) => c.circuit === 'sudoku_solve')!
const { proof, publicSignals } = await proveInWorker(
  circuit,
  manifest.release.assetBaseUrl,          // GitHub Release asset base, or a CDN fronting it
  input,                                   // the circuit witness input
  () => new Worker(new URL('@msgboard/zk-skill/browser/prover.worker.js', import.meta.url), { type: 'module' }),
)
```

What happens, and where the heavy bytes go:

1. `loadArtifact` (main thread — I/O only) fetches `${assetBaseUrl}/${file}`, **verifies sha256 against
   the manifest**, and caches the bytes in **IndexedDB keyed by the sha256**. Re-visits are instant; a
   re-setup that changes a key writes under a new key, so a **changed key busts the cache for free**.
   A hash mismatch throws before any proving starts.
2. The verified zkey + wasm bytes are handed to a **Web Worker** as **transferable** ArrayBuffers — a
   zero-copy ownership move, so the **66 MB zkey leaves the main-thread heap**.
3. `prover.worker.ts` runs `snarkjs.plonk.fullProve` **inside the worker** — never on the UI thread
   (hard project rule: heavy crypto never blocks the main thread, same as the PoW grinder). Only the
   small `{ proof, publicSignals }` travels back.

`snarkjs` resolves to its browser ESM build (`package.json` `"exports": { "browser": ".../browser.esm.js" }`)
under a bundler with the browser condition (Vite does this for worker bundles).

### Typechecking

The browser modules use DOM/WebWorker globals and no node types, so they are checked by a dedicated
config:

```bash
tsc --noEmit                          # node side (publish script, harness, tests)
tsc -p tsconfig.browser.json --noEmit # browser side (loader + worker + prover)
# or both at once:
pnpm --filter @msgboard/zk-skill typecheck
```
