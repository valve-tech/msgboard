import { describe, it, expect } from 'vitest'
import {
  GAME_ID,
  MinesPhase,
  start,
  reveal,
  cashOut,
  applyMove,
  verify,
  hashBoard,
  fairMultiplierX100,
  multiplierX100At,
  applyMinesEdgeX100,
  playerDelta,
  encodeGameState,
  hashGameState,
  encodeMove,
  type MinesBoard,
  type MinesState,
  type MinesClaim,
} from '../src/games/mines'

const SALT = `0x${'11'.repeat(32)}` as `0x${string}`

// A concrete 25-tile / 3-mine board. Mines at {0, 5, 24}; everything else safe.
const board25_3: MinesBoard = {
  config: { tiles: 25, mines: 3 },
  mineTiles: [0, 5, 24],
  salt: SALT,
}
const commit25_3 = hashBoard(board25_3)

function play(board: MinesBoard, tiles: number[]): MinesState {
  let s = start(board.config, hashBoard(board))
  for (const t of tiles) {
    const res = reveal(s, t, board.mineTiles.includes(t))
    if ('error' in res) throw new Error(res.error)
    s = res.state
  }
  return s
}

describe('mines (stateful, co-signed reveals)', () => {
  it('uses gameId 5 (distinct from dice=1, limbo=2, plinko=3, keno=4)', () => {
    expect(GAME_ID).toBe(5)
  })

  it('starts PLAYING at 1.00x with no reveals', () => {
    const s = start(board25_3.config, commit25_3)
    expect(s.phase).toBe(MinesPhase.PLAYING)
    expect(s.multiplierX100).toBe(100n) // 1.00x before any reveal
    expect(s.revealed).toEqual([])
    expect(s.bustTile).toBeNull()
  })

  it('fair multiplier follows Π (N-i)/(S-i) = C(N,k)/C(S,k); edge then applied', () => {
    // 25 tiles, 3 mines -> 22 safe.
    expect(fairMultiplierX100({ tiles: 25, mines: 3 }, 0)).toBe(100n)
    expect(fairMultiplierX100({ tiles: 25, mines: 3 }, 1)).toBe(113n) // 25/22 == 1.136..
    expect(fairMultiplierX100({ tiles: 25, mines: 3 }, 2)).toBe(129n) // 25*24/(22*21)
    expect(fairMultiplierX100({ tiles: 25, mines: 3 }, 3)).toBe(149n)
    // 1% edge: floor(fair*99/100)
    expect(applyMinesEdgeX100(113n)).toBe(111n)
    expect(multiplierX100At({ tiles: 25, mines: 3 }, 1)).toBe(111n)
    expect(multiplierX100At({ tiles: 25, mines: 3 }, 2)).toBe(127n)
    expect(multiplierX100At({ tiles: 25, mines: 3 }, 3)).toBe(147n)
  })

  it('accrues the running multiplier per safe reveal', () => {
    let s = start(board25_3.config, commit25_3)
    s = (reveal(s, 1, false) as { state: MinesState }).state
    expect(s.revealed).toEqual([1])
    expect(s.multiplierX100).toBe(111n) // edged k=1
    s = (reveal(s, 2, false) as { state: MinesState }).state
    expect(s.revealed).toEqual([1, 2])
    expect(s.multiplierX100).toBe(127n) // edged k=2
    s = (reveal(s, 3, false) as { state: MinesState }).state
    expect(s.multiplierX100).toBe(147n) // edged k=3
    expect(s.phase).toBe(MinesPhase.PLAYING)
  })

  it('cash-out banks the running multiplier and pays stake*(mult-1)', () => {
    const s = cashOut(play(board25_3, [1, 2, 3]) /* edged 147 */)
    expect('state' in s).toBe(true)
    const st = (s as { state: MinesState }).state
    expect(st.phase).toBe(MinesPhase.CASHED_OUT)
    expect(st.multiplierX100).toBe(147n)
    // stake 100 -> 100*147/100 - 100 = 47
    expect(playerDelta(st, 100n)).toBe(47n)
  })

  it('hitting a mine busts and loses the stake', () => {
    const s = play(board25_3, [1, 2]) // safe
    const res = reveal(s, 5, true) // 5 is a mine
    expect('state' in res).toBe(true)
    const st = (res as { state: MinesState }).state
    expect(st.phase).toBe(MinesPhase.BUSTED)
    expect(st.bustTile).toBe(5)
    expect(st.multiplierX100).toBe(0n)
    expect(playerDelta(st, 100n)).toBe(-100n)
  })

  it('rejects illegal moves (terminal, out-of-range, duplicate, empty cash-out)', () => {
    const busted = (reveal(start(board25_3.config, commit25_3), 0, true) as { state: MinesState }).state
    expect('error' in reveal(busted, 1, false)).toBe(true) // terminal
    expect('error' in cashOut(busted)).toBe(true)

    const s = start(board25_3.config, commit25_3)
    expect('error' in reveal(s, 25, false)).toBe(true) // out of range
    expect('error' in reveal(s, -1, false)).toBe(true)
    expect('error' in cashOut(s)).toBe(true) // no reveals yet

    const s1 = (reveal(s, 1, false) as { state: MinesState }).state
    expect('error' in reveal(s1, 1, false)).toBe(true) // duplicate
  })

  it('applyMove routes REVEAL through the board and enforces the commitment', () => {
    const s = start(board25_3.config, commit25_3)
    const r = applyMove(s, { kind: 'REVEAL', tile: 5 }, board25_3) // 5 is a mine
    expect((r as { state: MinesState }).state.phase).toBe(MinesPhase.BUSTED)
    // wrong board (different salt) is rejected against the commitment
    const wrong: MinesBoard = { ...board25_3, salt: `0x${'22'.repeat(32)}` }
    expect('error' in applyMove(s, { kind: 'REVEAL', tile: 1 }, wrong)).toBe(true)
    expect('error' in applyMove(s, { kind: 'REVEAL', tile: 1 })).toBe(true) // missing board
  })
})

describe('mines verify (dispute / adjudication)', () => {
  const honestCashOut: MinesClaim = {
    config: board25_3.config,
    commit: commit25_3,
    reveals: [1, 2, 3],
    cashedOut: true,
    claimedMultiplierX100: 147n,
  }
  const honestBust: MinesClaim = {
    config: board25_3.config,
    commit: commit25_3,
    reveals: [1, 2, 5], // 5 is a mine
    cashedOut: false,
    claimedMultiplierX100: 0n,
  }

  it('accepts an honest cash-out sequence', () => {
    const v = verify(honestCashOut, board25_3)
    expect(v.ok).toBe(true)
    expect(v.state?.phase).toBe(MinesPhase.CASHED_OUT)
    expect(v.state?.multiplierX100).toBe(147n)
  })

  it('accepts an honest bust sequence', () => {
    const v = verify(honestBust, board25_3)
    expect(v.ok).toBe(true)
    expect(v.state?.phase).toBe(MinesPhase.BUSTED)
  })

  it('rejects an inflated multiplier claim', () => {
    const v = verify({ ...honestCashOut, claimedMultiplierX100: 1000n }, board25_3)
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/multiplier/)
  })

  it('rejects a mine claimed as a safe cash-out', () => {
    // player reveals tile 5 (a mine) but claims to have cashed out
    const v = verify(
      { ...honestCashOut, reveals: [1, 5], claimedMultiplierX100: 111n },
      board25_3,
    )
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/mine/)
  })

  it('rejects a board that does not match the commitment (tampered layout/salt)', () => {
    const tampered: MinesBoard = { ...board25_3, mineTiles: [1, 2, 3] }
    const v = verify(honestCashOut, tampered)
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/commitment/)
  })

  it('rejects an out-of-range / duplicate reveal in the sequence', () => {
    expect(verify({ ...honestCashOut, reveals: [1, 1, 3] }, board25_3).ok).toBe(false) // duplicate
    expect(verify({ ...honestCashOut, reveals: [1, 99] }, board25_3).ok).toBe(false) // out of range
  })

  it('rejects a bust claim where no revealed tile was a mine', () => {
    const v = verify({ ...honestBust, reveals: [1, 2, 3], claimedMultiplierX100: 0n }, board25_3)
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/no revealed tile was a mine/)
  })
})

describe('mines encoding (on-chain mirror)', () => {
  it('encodeGameState / hashGameState are deterministic hex', () => {
    const s = (cashOut(play(board25_3, [1, 2, 3])) as { state: MinesState }).state
    const enc = encodeGameState(s)
    expect(enc).toMatch(/^0x/)
    expect(encodeGameState(s)).toBe(enc) // deterministic
    const h = hashGameState(s)
    expect(h).toMatch(/^0x[0-9a-f]{64}$/)
    expect(hashGameState(s)).toBe(h)
  })

  it('distinct states hash differently (bust vs cash-out vs reveal-count)', () => {
    const cashed = (cashOut(play(board25_3, [1, 2, 3])) as { state: MinesState }).state
    const busted = (reveal(play(board25_3, [1, 2]), 5, true) as { state: MinesState }).state
    const fewer = (cashOut(play(board25_3, [1, 2])) as { state: MinesState }).state
    expect(hashGameState(cashed)).not.toBe(hashGameState(busted))
    expect(hashGameState(cashed)).not.toBe(hashGameState(fewer))
  })

  it('encodeMove tags kind + payload', () => {
    expect(encodeMove({ kind: 'REVEAL', tile: 7 })).toMatch(/^0x/)
    expect(encodeMove({ kind: 'CASH_OUT' })).toMatch(/^0x/)
    expect(encodeMove({ kind: 'REVEAL', tile: 7 })).not.toBe(encodeMove({ kind: 'CASH_OUT' }))
  })

  it('hashBoard binds layout + salt (different salt -> different commit)', () => {
    const other: MinesBoard = { ...board25_3, salt: `0x${'99'.repeat(32)}` }
    expect(hashBoard(other)).not.toBe(commit25_3)
    const otherLayout: MinesBoard = { ...board25_3, mineTiles: [1, 2, 3] }
    expect(hashBoard(otherLayout)).not.toBe(commit25_3)
  })
})
