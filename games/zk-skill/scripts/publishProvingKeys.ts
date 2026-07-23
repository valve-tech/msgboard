// Publish (or dry-run) the PLONK proving artifacts — the per-circuit proving keys (.zkey) and the
// witness-generator wasm — for the ZK skill games, and emit a committed manifest the browser loader
// consumes.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// SECURITY MODEL — READ THIS BEFORE YOU WORRY ABOUT WHERE THESE FILES ARE HOSTED
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A PLONK PROVING KEY NEEDS AVAILABILITY, NOT INTEGRITY, FOR SOUNDNESS.
//
// The on-chain verifier contract is the real, immutable commitment to the trusted setup. A proof is
// only worth anything if that verifier accepts it. A corrupted, swapped, or outright MALICIOUS zkey
// cannot forge a proof the on-chain verifier will accept — it can only FAIL to produce a valid proof.
// So the proving key can be hosted anywhere untrusted (a GitHub Release, an S3 bucket, a CDN like
// one.valve.city fronting any of the above) with zero soundness risk to funds.
//
// Why, then, do we publish a sha256 per artifact? Purely to DETECT CORRUPTION — a bit-flip on the CDN,
// a truncated download, a stale asset after a re-setup. That is a denial-of-service / UX concern (the
// prover would waste minutes then emit a proof the chain rejects), NOT a trust boundary. Do NOT market
// this hash as a security guarantee for user funds: it is not. The guarantee lives in the verifier
// bytecode on chain. The hash just lets the loader fail fast and loudly instead of slow and confusingly.
//
// (Contrast the ptau in src/harness.ts, whose blake2b IS checked against an independent published
// digest — but even there the point is provenance of the ceremony artifact, and the ultimate trust
// still bottoms out in the verifier, not the digest.)
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// USAGE
// ─────────────────────────────────────────────────────────────────────────────────────────────
//   tsx scripts/publishProvingKeys.ts              # DRY RUN (default): hash + write manifest, print plan
//   tsx scripts/publishProvingKeys.ts --publish    # actually create the GitHub Release + upload assets
//   tsx scripts/publishProvingKeys.ts --tag=proving-keys-v2   # override the release tag
//
// The DEFAULT is a dry run. It computes every hash, writes proving-keys.manifest.json, and PRINTS the
// `gh release` commands it WOULD run — it uploads nothing. Real publishing is gated behind --publish.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(__dirname, '..')
const BUILD_DIR = path.join(PACKAGE_ROOT, 'build')
const MANIFEST_PATH = path.join(PACKAGE_ROOT, 'proving-keys.manifest.json')

const REPO = 'gibsfinance/random' // GitHub repo the Release lives under (asset URLs derive from this)
const DEFAULT_TAG = 'proving-keys-v1'

/**
 * The three circuits whose proving artifacts we publish. Paths mirror src/harness.ts's layout:
 *   build/<name>/<name>_plonk.zkey                     (the proving key — big: 6–66 MB)
 *   build/<name>/<name>_js/<name>.wasm                 (the witness generator — ~0.2–2 MB)
 * Asset names are the basenames; they are already unique across circuits, so a flat Release works.
 */
const CIRCUITS = ['sudoku_solve', 'wordle_solve', 'wordle_clue'] as const

interface ArtifactEntry {
  file: string // Release asset name == basename on disk; loader resolves URL as `${assetBaseUrl}/${file}`
  sha256: string // corruption-detection digest (see SECURITY MODEL above) — NOT a funds trust boundary
  bytes: number
}

interface CircuitEntry {
  circuit: string
  zkey: ArtifactEntry
  wasm: ArtifactEntry
  release: string // the Release tag these assets are attached to
}

interface Manifest {
  generatedAt: string
  gitCommit: string
  repo: string
  release: {
    tag: string
    // Where a browser fetches assets from. GitHub Release asset URLs are the source of truth; a CDN
    // (e.g. one.valve.city) may front this — the loader only needs this base + the per-artifact `file`.
    assetBaseUrl: string
  }
  circuits: CircuitEntry[]
}

/** sha256 of a file, streamed 1 MiB at a time so a 66 MB zkey never lands in memory whole. */
function sha256File(p: string): string {
  const h = createHash('sha256')
  const fd = openSync(p, 'r')
  try {
    const buf = Buffer.alloc(1 << 20)
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      h.update(buf.subarray(0, n))
    }
  } finally {
    closeSync(fd)
  }
  return h.digest('hex')
}

function hashArtifact(absPath: string): ArtifactEntry {
  const bytes = statSync(absPath).size
  return { file: path.basename(absPath), sha256: sha256File(absPath), bytes }
}

function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PACKAGE_ROOT }).toString().trim()
  } catch {
    return 'unknown'
  }
}

function parseArgs(argv: string[]): { publish: boolean; tag: string } {
  let publish = false
  let tag = DEFAULT_TAG
  for (const a of argv) {
    if (a === '--publish') publish = true
    else if (a.startsWith('--tag=')) tag = a.slice('--tag='.length)
    else {
      // eslint-disable-next-line no-console
      console.error(`publishProvingKeys: unknown arg ${a}`)
      process.exit(2)
    }
  }
  return { publish, tag }
}

function main() {
  const { publish, tag } = parseArgs(process.argv.slice(2))
  const assetBaseUrl = `https://github.com/${REPO}/releases/download/${tag}`

  const circuits: CircuitEntry[] = []
  const uploadPaths: string[] = [] // absolute paths of every asset to attach to the Release
  const missing: string[] = []

  for (const name of CIRCUITS) {
    const zkeyPath = path.join(BUILD_DIR, name, `${name}_plonk.zkey`)
    const wasmPath = path.join(BUILD_DIR, name, `${name}_js`, `${name}.wasm`)

    const zkeyThere = existsSync(zkeyPath)
    const wasmThere = existsSync(wasmPath)
    if (!zkeyThere) missing.push(zkeyPath)
    if (!wasmThere) missing.push(wasmPath)
    if (!zkeyThere || !wasmThere) {
      // eslint-disable-next-line no-console
      console.warn(`[publish] SKIP ${name}: missing artifact(s) — build it before publishing`)
      continue
    }

    const zkey = hashArtifact(zkeyPath)
    const wasm = hashArtifact(wasmPath)
    circuits.push({ circuit: name, zkey, wasm, release: tag })
    uploadPaths.push(zkeyPath, wasmPath)

    // eslint-disable-next-line no-console
    console.log(
      `[publish] ${name}\n` +
        `           zkey ${zkey.file}  ${zkey.bytes} bytes  sha256:${zkey.sha256}\n` +
        `           wasm ${wasm.file}  ${wasm.bytes} bytes  sha256:${wasm.sha256}`,
    )
  }

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    gitCommit: gitCommit(),
    repo: REPO,
    release: { tag, assetBaseUrl },
    circuits,
  }

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')
  // eslint-disable-next-line no-console
  console.log(`\n[publish] wrote manifest -> ${MANIFEST_PATH}`)
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.warn(`[publish] ${missing.length} artifact(s) missing (excluded from manifest):\n  ` + missing.join('\n  '))
  }

  if (!publish) {
    // eslint-disable-next-line no-console
    console.log(
      `\n[publish] DRY RUN — nothing uploaded. To actually publish, re-run with --publish.\n` +
        `[publish] would create release "${tag}" on ${REPO} and upload ${uploadPaths.length} asset(s):\n` +
        `    gh release create ${tag} --repo ${REPO} --title "ZK proving keys ${tag}" \\\n` +
        `      --notes "PLONK proving keys + wasm. Availability-not-integrity: see PROVING_KEYS.md." \\\n` +
        uploadPaths.map((p) => `      ${p}`).join(' \\\n'),
    )
    return
  }

  // ── real publish path (only reached with --publish) ──────────────────────────────────────────
  if (!uploadPaths.length) {
    // eslint-disable-next-line no-console
    console.error('[publish] refusing to publish: no artifacts present')
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log(`[publish] creating GitHub Release ${tag} and uploading ${uploadPaths.length} asset(s)...`)
  execFileSync(
    'gh',
    [
      'release',
      'create',
      tag,
      '--repo',
      REPO,
      '--title',
      `ZK proving keys ${tag}`,
      '--notes',
      'PLONK proving keys + wasm. Availability-not-integrity: see games/zk-skill/PROVING_KEYS.md.',
      ...uploadPaths,
    ],
    { stdio: 'inherit' },
  )
  // eslint-disable-next-line no-console
  console.log('[publish] done. Commit proving-keys.manifest.json so the browser loader ships with these hashes.')
}

main()
