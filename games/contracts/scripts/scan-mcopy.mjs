// Opcode-aligned MCOPY (0x5e) scanner. Walks the bytecode honoring PUSH1..PUSH32 (0x60-0x7f)
// immediate-data lengths so a raw 0x5e byte inside PUSH data is never miscounted as an opcode.
import { readFileSync } from 'node:fs';

const targets = [
  ['HoldemShowdownLib', 'artifacts/contracts/zk/HoldemShowdownLib.sol/HoldemShowdownLib.json'],
  ['HoldemRules', 'artifacts/contracts/zk/HoldemRules.sol/HoldemRules.json'],
  ['HoldemTableN', 'artifacts/contracts/zk/HoldemTableN.sol/HoldemTableN.json'],
  ['ZkTable', 'artifacts/contracts/zk/ZkTable.sol/ZkTable.json'],
  ['DeckChallengeLib', 'artifacts/contracts/zk/DeckChallengeLib.sol/DeckChallengeLib.json'],
  ['DeckConstants', 'artifacts/contracts/zk/DeckConstants.sol/DeckConstants.json'],
  ['CardTableSecp', 'artifacts/contracts/zk/CardTableSecp.sol/CardTableSecp.json'],
  ['ShowdownDecodeLib', 'artifacts/contracts/vendor/uzkge/ShowdownDecodeLib.sol/ShowdownDecodeLib.json'],
  ['HiLoWarRules', 'artifacts/contracts/zk/HiLoWarRules.sol/HiLoWarRules.json'],
  ['HoldemHandEval', 'artifacts/contracts/zk/HoldemHandEval.sol/HoldemHandEval.json'],
  ['ShuffleVerifier52', 'artifacts/contracts/zk/ShuffleVerifier52.sol/ShuffleVerifier52.json'],
  ['ChannelTableBase', 'artifacts/contracts/zk/ChannelTableBase.sol/ChannelTableBase.json'],
  ['SignedIntentBase', 'artifacts/contracts/zk/SignedIntentBase.sol/SignedIntentBase.json'],
];

function countMcopy(hex) {
  let code = hex.startsWith('0x') ? hex.slice(2) : hex;
  // Unlinked library placeholders look like __$<34 hex chars>$__ (40 chars = 20 bytes of address
  // data). These are NOT valid hex, so Buffer.from(..., 'hex') would silently truncate at the
  // first placeholder — replace with 40 zero-hex-chars (same byte length) so the walker still
  // correctly skips over them as the PUSH20 immediate data that precedes them.
  code = code.replace(/__\$[0-9a-fA-F]*\$__/g, (m) => '0'.repeat(m.length));
  const bytes = Buffer.from(code, 'hex');
  let i = 0;
  let count = 0;
  const hits = [];
  while (i < bytes.length) {
    const op = bytes[i];
    if (op === 0x5e) {
      count++;
      hits.push(i);
      i += 1;
      continue;
    }
    if (op >= 0x60 && op <= 0x7f) {
      // PUSH1 (0x60) .. PUSH32 (0x7f): skip N immediate bytes
      const n = op - 0x5f;
      i += 1 + n;
      continue;
    }
    i += 1;
  }
  return { count, hits, length: bytes.length };
}

let allZero = true;
const results = [];
for (const [name, relPath] of targets) {
  let art;
  try {
    art = JSON.parse(readFileSync(relPath, 'utf8'));
  } catch (e) {
    results.push([name, 'MISSING ARTIFACT', relPath]);
    continue;
  }
  const deployed = art.deployedBytecode;
  if (!deployed || deployed === '0x') {
    results.push([name, 'NO DEPLOYED BYTECODE (abstract/interface?)', '']);
    continue;
  }
  const { count, hits, length } = countMcopy(deployed);
  if (count > 0) allZero = false;
  results.push([name, count, `len=${length}` + (count > 0 ? ` hits@${hits.slice(0, 10).join(',')}` : '')]);
}

console.log('MCOPY (0x5e) opcode-aligned scan of deployedBytecode:');
console.log('-----------------------------------------------------');
for (const [name, count, info] of results) {
  console.log(`${String(name).padEnd(20)} MCOPY_count=${String(count).padEnd(6)} ${info}`);
}
console.log('-----------------------------------------------------');
console.log(allZero ? 'RESULT: ALL ZERO — no MCOPY in any deployed zk artifact.' : 'RESULT: FAIL — MCOPY found in one or more artifacts.');
process.exit(allZero ? 0 : 1);
