/**
 * gen-recompute-vectors.ts — print fixed-seed parity vectors from the REAL TS game reference.
 * The numbers it prints are hardcoded into packages/contracts/test/foundry/GamePayouts.t.sol so the
 * Solidity port is checked against the canonical math (not a re-derivation).
 *
 * Run with a tsx that actually resolves (tsx is NOT a dep of @msgboard/settle; borrow the
 * house-service binary):
 *   cd examples/games/msgboard-settle && ../house-service/node_modules/.bin/tsx scripts/gen-recompute-vectors.ts
 */
import {
  dice, limbo, crash, monte, dicex2, roundRandom,
  baccarat, dragonTiger, andarBahar, dealBaccarat, dealDragonTiger, dealAndarBahar,
  cascade, resolveCascade,
  plinko, pachinko, wheel, keno,
  plinkoFairTableX100, pachinkoFairTableX100, BASE_PAYTABLE_X100,
} from '@msgboard/games'
import { keccak256, encodeAbiParameters, hexToBigInt } from 'viem'

// Two fixed (serverSeed, clientSeed, nonce) triples chosen to land a WIN and a LOSS for each game.
// Adjust the seeds until both outcomes appear (the script prints win/loss so you can tune).
const stake = 200n

function show(label: string, serverSeed: `0x${string}`, clientSeed: `0x${string}`, nonce: bigint,
             game: typeof dice | typeof limbo, targetX100: bigint) {
  const r = roundRandom(serverSeed, clientSeed, nonce)
  const outcome = game.settleRound(stake, { targetX100 } as never, r)
  const payout = outcome.win ? outcome.playerDelta + stake : 0n // playerDelta = payout - stake
  console.log(JSON.stringify({
    label, gameId: game.gameId, serverSeed, clientSeed, nonce: nonce.toString(),
    targetX100: targetX100.toString(), r: r.toString(),
    win: outcome.win, payout: payout.toString(),
  }))
}

const s = (n: number) => (`0x${n.toString(16).padStart(64, '0')}`) as `0x${string}`

// dice (gameId 1), target 5000 (50.00% roll-under)
show('dice-win',  s(1), s(2), 1n, dice, 5000n)
show('dice-loss', s(3), s(4), 1n, dice, 5000n)
// limbo (gameId 2), target 200 (2.00x)
// NOTE (Task 2 review fix): at target 200 / nonce 1, the s(5)/s(6) pair LOSES and s(7)/s(8) WINS.
// The labels were originally swapped; the seeds below are picked so each label matches its real
// outcome at nonce 1 (verified by running this script).
show('limbo-win',  s(7), s(8), 1n, limbo, 200n)
show('limbo-loss', s(5), s(6), 1n, limbo, 200n)

// ---- Phase-1 free reskins: crash (6), monte (9), dicex2 (10) ----
// For each, scan seed pairs s(2k-1)/s(2k) at nonce 1 until a WIN and a LOSS are found, then print
// both with their r + payout so they can be hardcoded into the foundry test.
type Found = { serverSeed: `0x${string}`; clientSeed: `0x${string}`; r: bigint; payout: bigint }

function scan(
  label: string,
  gameId: number,
  settle: (r: bigint) => { win: boolean; playerDelta: bigint },
): void {
  let win: Found | undefined
  let loss: Found | undefined
  for (let k = 100; k < 100_000 && (!win || !loss); k++) {
    const serverSeed = s(2 * k - 1)
    const clientSeed = s(2 * k)
    const r = roundRandom(serverSeed, clientSeed, 1n)
    const o = settle(r)
    const payout = o.win ? o.playerDelta + stake : 0n
    if (o.win && !win) win = { serverSeed, clientSeed, r, payout }
    if (!o.win && !loss) loss = { serverSeed, clientSeed, r, payout }
  }
  for (const [kind, f] of [['win', win], ['loss', loss]] as const) {
    if (!f) { console.log(JSON.stringify({ label: `${label}-${kind}`, gameId, error: 'not found' })); continue }
    console.log(JSON.stringify({
      label: `${label}-${kind}`, gameId,
      serverSeed: f.serverSeed, clientSeed: f.clientSeed, nonce: '1',
      r: f.r.toString(), win: kind === 'win', payout: f.payout.toString(),
    }))
  }
}

// crash (gameId 6), auto-cashout 200 (2.00x) — same curve as limbo
scan('crash', crash.gameId, (r) => crash.settleRound(stake, { autoCashoutX100: 200n }, r))
// monte (gameId 9), pick 0 — wins iff r % 3 == 0, pays 2.97x
scan('monte', monte.gameId, (r) => monte.settleRound(stake, { pick: 0 }, r))
// dicex2 (gameId 10), target 5000 mode 'both' — wins iff both derived rolls < 5000, pays 3.96x
scan('dicex2', dicex2.gameId, (r) => dicex2.settleRound(stake, { targetX100: 5000n, mode: 'both' }, r))

// ---- Pure-RNG games on-chain milestone: baccarat (11), dragon tiger (12), andar bahar (13), cascade (24) ----
// These are hardcoded into packages/contracts/test/foundry/CardCascadePayouts.t.sol. The card vectors scan
// s(2k-1)/s(2k) at nonce 1 for a specific WINNER, then print r + payout for a chosen bet; cascade uses a
// keccak(uint64 i) raw stream (same as the foundry test) and selects a zero/small/big total.
function findCard(
  label: string,
  pred: (r: bigint) => boolean,
  settle: (r: bigint) => { win: boolean; playerDelta: bigint },
): void {
  for (let k = 2; k < 200_000; k++) {
    const r = roundRandom(s(2 * k - 1), s(2 * k), 1n)
    if (!pred(r)) continue
    const o = settle(r)
    console.log(JSON.stringify({ label, serverSeed: s(2 * k - 1), clientSeed: s(2 * k), nonce: '1', r: r.toString(), payout: (o.playerDelta + stake).toString() }))
    return
  }
  console.log(JSON.stringify({ label, error: 'not found' }))
}

findCard('bacc-player', (r) => dealBaccarat(r).winner === 'player', (r) => baccarat.settleRound(stake, { bet: 'player' }, r))
findCard('bacc-banker', (r) => dealBaccarat(r).winner === 'banker', (r) => baccarat.settleRound(stake, { bet: 'banker' }, r))
findCard('bacc-tie-betTie', (r) => dealBaccarat(r).winner === 'tie', (r) => baccarat.settleRound(stake, { bet: 'tie' }, r))
findCard('bacc-tie-betPlayer(push)', (r) => dealBaccarat(r).winner === 'tie', (r) => baccarat.settleRound(stake, { bet: 'player' }, r))
findCard('dt-dragon', (r) => dealDragonTiger(r).winner === 'dragon', (r) => dragonTiger.settleRound(stake, { bet: 'dragon' }, r))
findCard('dt-tie-betTie', (r) => dealDragonTiger(r).winner === 'tie', (r) => dragonTiger.settleRound(stake, { bet: 'tie' }, r))
findCard('dt-tie-betDragon(half)', (r) => dealDragonTiger(r).winner === 'tie', (r) => dragonTiger.settleRound(stake, { bet: 'dragon' }, r))
findCard('ab-andar', (r) => dealAndarBahar(r).winner === 'andar', (r) => andarBahar.settleRound(stake, { bet: 'andar' }, r))
findCard('ab-bahar', (r) => dealAndarBahar(r).winner === 'bahar', (r) => andarBahar.settleRound(stake, { bet: 'bahar' }, r))

const rawAt = (i: number): bigint => hexToBigInt(keccak256(encodeAbiParameters([{ type: 'uint64' }], [BigInt(i)])))
function findCascade(label: string, pred: (total: bigint) => boolean): void {
  for (let i = 0; i < 200_000; i++) {
    const raw = rawAt(i)
    const total = resolveCascade(raw).totalX100
    if (!pred(total)) continue
    const o = cascade.settleRound(stake, {}, raw)
    console.log(JSON.stringify({ label, gameId: cascade.gameId, raw: raw.toString(), totalX100: total.toString(), payout: (o.playerDelta + stake).toString() }))
    return
  }
  console.log(JSON.stringify({ label, error: 'not found' }))
}
findCascade('cascade-zero', (t) => t === 0n)
findCascade('cascade-pay-small', (t) => t > 0n && t < 500n)
findCascade('cascade-pay-big', (t) => t >= 1000n)

// ---- Table games on-chain milestone: plinko (3), keno (4), pachinko (7), wheel (8) ----
// The packed PLINKO/PACHINKO/KENO hex below is embedded VERBATIM into packages/contracts/contracts/
// games/GameTables.sol; the vectors are hardcoded into test/foundry/TablePayouts.t.sol. Wheel's table
// is recomputed on-chain (uniform weights), so only its settle vectors are emitted, no packed data.
const tableRisks = ['low', 'medium', 'high'] as const
const packU24 = (vals: bigint[]): string => '0x' + vals.map((v) => v.toString(16).padStart(6, '0')).join('')
console.log('GameTables.PLINKO  ', packU24(tableRisks.flatMap((r) => [...plinkoFairTableX100(r, 16)])))
console.log('GameTables.PACHINKO', packU24(tableRisks.flatMap((r) => [...pachinkoFairTableX100(r, 12)])))
const kenoVals: bigint[] = []
for (let p = 1; p <= 10; p++) kenoVals.push(...BASE_PAYTABLE_X100[p]!)
console.log('GameTables.KENO    ', packU24(kenoVals))

const bucketRaw = (bucket: number): bigint => (1n << BigInt(bucket)) - 1n
for (const [ri, r] of tableRisks.entries()) for (const bucket of [0, 8, 16]) {
  const o = plinko.settleRound(stake, { risk: r, rows: 16 }, bucketRaw(bucket))
  console.log(JSON.stringify({ label: 'plinko', gameId: plinko.gameId, riskIdx: ri, rows: 16, bucket, raw: bucketRaw(bucket).toString(), payout: (o.playerDelta + stake).toString() }))
}
for (const [ri, r] of tableRisks.entries()) for (const slot of [0, 6, 12]) {
  const o = pachinko.settleRound(stake, { risk: r, rows: 12 }, bucketRaw(slot))
  console.log(JSON.stringify({ label: 'pachinko', gameId: pachinko.gameId, riskIdx: ri, rows: 12, slot, raw: bucketRaw(slot).toString(), payout: (o.playerDelta + stake).toString() }))
}
for (const seg of [10, 50] as const) for (const [ri, r] of tableRisks.entries()) {
  for (let n = 1; n < 8000; n++) {
    const raw = roundRandom(s(2 * n - 1), s(2 * n), 1n)
    const o = wheel.settleRound(stake, { risk: r, segments: seg }, raw)
    if (o.playerDelta + stake > 0n) {
      console.log(JSON.stringify({ label: 'wheel-win', gameId: wheel.gameId, riskIdx: ri, segments: seg, segment: Number(raw % BigInt(seg)), raw: raw.toString(), payout: (o.playerDelta + stake).toString() }))
      break
    }
  }
}
for (const picks of [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [3, 11, 22, 33], [7]] as number[][]) {
  for (let n = 1; n < 30000; n++) {
    const raw = roundRandom(s(2 * n - 1), s(2 * n), 1n)
    const o = keno.settleRound(stake, { picks }, raw)
    if (o.playerDelta + stake > 0n) {
      console.log(JSON.stringify({ label: 'keno-win', gameId: keno.gameId, picks, raw: raw.toString(), payout: (o.playerDelta + stake).toString() }))
      break
    }
  }
}

// ==================================================================================================
// STATEFUL / decision games on-chain milestone: dispute-replay mirrors.
//   MINES (5) + the LADDER family (towers 14, chicken 15, greed-dice 19).
// These are NOT a pure function of the round random `r`: their outcome depends on a co-signed move
// sequence over a committed hidden layout. The on-chain mirror (MinesRules.sol / LadderRules.sol)
// replays the revealed layout + claimed moves and recomputes the conserved (balancePlayer,
// balanceHouse). The vectors below are hardcoded into test/foundry/MinesRules.t.sol and
// LadderRules.t.sol so the Solidity port is checked against the canonical @msgboard/games math.
// All uniquely-named exports (survive the barrel's `export *`).
import {
  hashBoard, multiplierX100At, type MinesBoard,
  safeTilesOnFloor, towersMultiplierX100, towersMaxMultiplierX100, commitLayout,
  laneSafe, chickenMultiplierX100, chickenMaxMultiplierX100,
  rollSurvives, greedDiceMultiplierX100, greedDiceMaxMultiplierX100,
} from '@msgboard/games'

console.log('\n===== stateful dispute-replay vectors =====')

// ---- MINES (gameId 5) ----
// A concrete 25-tile / 3-mine board (5x5, 3 mines). Mines at {5,12,20} (strictly sorted). salt = 0x22..
{
  const config = { tiles: 25, mines: 3 }
  const safe = config.tiles - config.mines // 22
  const salt = (`0x${'22'.repeat(32)}`) as `0x${string}`
  const mineTiles = [5, 12, 20]
  const board: MinesBoard = { config, mineTiles, salt }
  const commit = hashBoard(board)
  const ceilingMultX100 = multiplierX100At(config, safe) // escrow ceiling: all safe tiles cleared
  const emit = (label: string, reveals: number[], cashedOut: boolean) => {
    const mineSet = new Set(mineTiles)
    let count = 0
    let busted = false
    for (const t of reveals) { if (mineSet.has(t)) { busted = true; break } count++ }
    const multX100 = busted ? 0n : multiplierX100At(config, count)
    const payout = (cashedOut && !busted) ? (stake * multX100) / 100n : 0n
    console.log(JSON.stringify({
      label, gameId: 5, tiles: config.tiles, mines: config.mines,
      salt, mineTiles, commit, reveals, cashedOut,
      claimedMultiplierX100: multX100.toString(), payout: payout.toString(),
      ceilingMultX100: ceilingMultX100.toString(),
      escrowHouse: ((stake * (ceilingMultX100 - 100n)) / 100n).toString(), stake: stake.toString(),
    }))
  }
  emit('mines-win', [0, 1, 2, 3, 4], true)   // 5 safe reveals then cash out
  emit('mines-bust', [0, 1, 12], false)       // tile 12 is a mine -> bust
}

// ---- LADDER: TOWERS (gameId 14) ----
// floors=6, tilesPerFloor=3, safePerFloor=2 (Dragon-tower shape). Layout derived from the sealed seed.
{
  const config = { floors: 6, tilesPerFloor: 3, safePerFloor: 2 }
  const seed = 0x7357n
  const commit = commitLayout(seed)
  const ceilingMultX100 = towersMaxMultiplierX100(config)
  // climb `k` floors, at each floor picking the SMALLEST safe tile (guaranteed safe from the seed layout)
  const climbChoices = (k: number): number[] => {
    const out: number[] = []
    for (let f = 0; f < k; f++) out.push(Math.min(...safeTilesOnFloor(seed, config, f)))
    return out
  }
  const unsafeTile = (floor: number): number => {
    const safeSet = safeTilesOnFloor(seed, config, floor)
    for (let t = 0; t < config.tilesPerFloor; t++) if (!safeSet.has(t)) return t
    throw new Error('no unsafe tile')
  }
  const emit = (label: string, choices: number[], cashedOut: boolean, safeCount: number, busted: boolean) => {
    const multX100 = busted ? 0n : towersMultiplierX100(config, safeCount)
    const payout = (cashedOut && !busted) ? (stake * multX100) / 100n : 0n
    console.log(JSON.stringify({
      label, gameId: 14, floors: config.floors, tilesPerFloor: config.tilesPerFloor,
      safePerFloor: config.safePerFloor, seed: seed.toString(), commit, choices, cashedOut,
      claimedMultiplierX100: multX100.toString(), payout: payout.toString(),
      ceilingMultX100: ceilingMultX100.toString(),
      escrowHouse: ((stake * (ceilingMultX100 - 100n)) / 100n).toString(), stake: stake.toString(),
    }))
  }
  emit('towers-win', climbChoices(4), true, 4, false)                   // climb 4, cash out
  emit('towers-top', climbChoices(6), true, 6, false)                   // climb all 6 -> forced cash out
  emit('towers-bust', [...climbChoices(2), unsafeTile(2)], false, 2, true) // climb 2, then unsafe pick
}

// ---- LADDER: CHICKEN (gameId 15) — single forced path, choice always 0, seed-derived crash region ----
{
  const difficulty = 'medium' as const // CRASH=3 of 25
  const crashCount = 3
  const lanes = 12
  const config = { difficulty, lanes }
  // find a seed whose first 4 lanes are safe (win) and one whose lanes 0..1 safe, lane 2 crashes (bust)
  let winSeed: bigint | undefined, bustSeed: bigint | undefined
  for (let k = 1n; k < 100000n && (!winSeed || !bustSeed); k++) {
    const safe = (n: number) => laneSafe(k, difficulty, n)
    if (!winSeed && safe(0) && safe(1) && safe(2) && safe(3)) winSeed = k
    if (!bustSeed && safe(0) && safe(1) && !safe(2)) bustSeed = k
  }
  const ceilingMultX100 = chickenMaxMultiplierX100(config)
  const emit = (label: string, seed: bigint, choices: number[], cashedOut: boolean, safeCount: number, busted: boolean) => {
    const multX100 = busted ? 0n : chickenMultiplierX100(difficulty, safeCount)
    const payout = (cashedOut && !busted) ? (stake * multX100) / 100n : 0n
    console.log(JSON.stringify({
      label, gameId: 15, crashCount, lanes, seed: seed!.toString(), commit: commitLayout(seed!),
      choices, cashedOut, claimedMultiplierX100: multX100.toString(), payout: payout.toString(),
      ceilingMultX100: ceilingMultX100.toString(),
      escrowHouse: ((stake * (ceilingMultX100 - 100n)) / 100n).toString(), stake: stake.toString(),
    }))
  }
  emit('chicken-win', winSeed!, [0, 0, 0, 0], true, 4, false)
  emit('chicken-bust', bustSeed!, [0, 0, 0], false, 2, true)
}

// ---- LADDER: GREED DICE (gameId 19) — 6-face die, first bustFaces faces bust, seed-derived ----
{
  const bustFaces = 2
  const rolls = 10
  const config = { rolls, bustFaces }
  let winSeed: bigint | undefined, bustSeed: bigint | undefined
  for (let k = 1n; k < 100000n && (!winSeed || !bustSeed); k++) {
    const ok = (n: number) => rollSurvives(k, config, n)
    if (!winSeed && ok(0) && ok(1) && ok(2)) winSeed = k
    if (!bustSeed && ok(0) && ok(1) && !ok(2)) bustSeed = k
  }
  const ceilingMultX100 = greedDiceMaxMultiplierX100(config)
  const emit = (label: string, seed: bigint, choices: number[], cashedOut: boolean, safeCount: number, busted: boolean) => {
    const multX100 = busted ? 0n : greedDiceMultiplierX100(config, safeCount)
    const payout = (cashedOut && !busted) ? (stake * multX100) / 100n : 0n
    console.log(JSON.stringify({
      label, gameId: 19, bustFaces, rolls, seed: seed!.toString(), commit: commitLayout(seed!),
      choices, cashedOut, claimedMultiplierX100: multX100.toString(), payout: payout.toString(),
      ceilingMultX100: ceilingMultX100.toString(),
      escrowHouse: ((stake * (ceilingMultX100 - 100n)) / 100n).toString(), stake: stake.toString(),
    }))
  }
  emit('greeddice-win', winSeed!, [0, 0, 0], true, 3, false)
  emit('greeddice-bust', bustSeed!, [0, 0, 0], false, 2, true)
}
