import fs from 'node:fs'
const wasmPath = 'node_modules/@msgboard/pow-grinder/pkg/pow_grinder_bg.wasm'
const wasm = fs.readFileSync(wasmPath)
const b64 = wasm.toString('base64')
const header = [
  '// @generated — DO NOT EDIT BY HAND.',
  `// The portable @msgboard/pow-grinder WASM engine (${wasmPath}, ${wasm.length} bytes) embedded as`,
  '// base64 so esbuild --bundle inlines it into pow-worker.mjs. This is what lets the PoW stamp run',
  '// from a SINGLE self-contained .mjs on the box with NO node_modules and NO .wasm on disk — the',
  '// deploy recipe (ansible/deploy-games-actors.yml) carries no .wasm loader flag, so the binary must',
  '// live in the JS. Regenerate with games/e2e/scripts/gen-pow-wasm-b64.mjs after bumping the grinder.',
  '',
  'export const POW_GRINDER_WASM_B64 =',
  '  ' + JSON.stringify(b64),
  '',
].join('\n')
fs.writeFileSync('games/e2e/scripts/pow-grinder-wasm-b64.ts', header)
console.log('wrote pow-grinder-wasm-b64.ts:', wasm.length, 'bytes ->', b64.length, 'b64 chars')
