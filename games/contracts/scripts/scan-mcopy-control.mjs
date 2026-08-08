// Positive-control check: run the same scanner against a handful of default-cancun-compiled
// contracts (not shanghai-pinned) to prove the walker actually detects real MCOPY when present.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function countMcopy(hex) {
  let code = hex.startsWith('0x') ? hex.slice(2) : hex;
  code = code.replace(/__\$[0-9a-fA-F]*\$__/g, (m) => '0'.repeat(m.length));
  const bytes = Buffer.from(code, 'hex');
  let i = 0;
  let count = 0;
  while (i < bytes.length) {
    const op = bytes[i];
    if (op === 0x5e) {
      count++;
      i += 1;
      continue;
    }
    if (op >= 0x60 && op <= 0x7f) {
      i += 1 + (op - 0x5f);
      continue;
    }
    i += 1;
  }
  return count;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (entry.endsWith('.json') && !entry.endsWith('.dbg.json')) out.push(p);
  }
}

const files = [];
walk('artifacts/contracts/games', files);
let found = 0;
let scanned = 0;
for (const f of files) {
  let art;
  try {
    art = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    continue;
  }
  const db = art.deployedBytecode;
  if (!db || db === '0x') continue;
  scanned++;
  const c = countMcopy(db);
  if (c > 0) {
    found++;
    console.log(`${f}: MCOPY_count=${c}`);
  }
}
console.log(`Scanned ${scanned} default-cancun game artifacts; ${found} contain real MCOPY opcodes.`);
console.log(found > 0 ? 'POSITIVE CONTROL PASSED: scanner correctly detects real MCOPY when present.' : 'No MCOPY found in this sample (inconclusive control).');
