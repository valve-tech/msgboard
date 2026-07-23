import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { dice } from '../src/games/dice'
import { buildSeedChain } from '../src/rng'
import { TEST_DOMAIN } from '../src/sessionState'
import type { SessionConfig, PlayInput, VerifyContext } from '../src/session'
import type { DiceParams } from '../src/games/dice'
import type { SessionState } from '../src/sessionState'
import type { CoSignTransport, RoundProof } from '../src/coSignTransport'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const tableId = `0x${'ab'.repeat(32)}` as Hex
const tip = `0x${'77'.repeat(32)}` as Hex

/**
 * Build a linked in-memory CoSignTransport pair. The house side calls `request(state)`;
 * the player side `serve(sign)`s. Requests resolve through shared promise queues — no board,
 * no network — but the round-trip ordering matches a real transport: house parks a pending
 * request, player picks it up, signs, and resolves it.
 */
export function memoryCoSignPair(): { houseT: CoSignTransport; playerT: CoSignTransport } {
  type Pending = {
    state: SessionState
    proof?: RoundProof<unknown>
    resolve: (sig: Hex) => void
    reject: (err: unknown) => void
  }
  const queue: Pending[] = []
  const waiters: Array<(p: Pending) => void> = []

  const push = (p: Pending) => {
    const w = waiters.shift()
    if (w) w(p)
    else queue.push(p)
  }
  const pull = (): Promise<Pending> =>
    new Promise((res) => {
      const q = queue.shift()
      if (q) res(q)
      else waiters.push(res)
    })

  const houseT: CoSignTransport = {
    request: (state, proof) => new Promise<Hex>((resolve, reject) => push({ state, proof, resolve, reject })),
    serve: () => { throw new Error('houseT.serve is not used in this pair') },
  }

  const playerT: CoSignTransport = {
    request: () => { throw new Error('playerT.request is not used in this pair') },
    serve: (sign) => {
      // Park on the shared queue and answer each request as it arrives. After the session's last
      // request (ROUND), the loop simply awaits the next pull forever — harmless; the test resolves
      // via runPlayerSide's own completion latch.
      const loop = async () => {
        for (;;) {
          const p = await pull()
          try {
            p.resolve(await sign(p.state, p.proof))
          } catch (err) {
            // an honest player that refuses to sign rejects the house's pending request too,
            // so the house side fails fast instead of hanging on an unresolved promise.
            p.reject(err)
          }
        }
      }
      void loop()
    },
  }

  return { houseT, playerT }
}

export function fixedDiceConfig(): {
  houseCfg: SessionConfig<DiceParams>
  playerCfg: Omit<SessionConfig<DiceParams>, 'house'> & { houseRemote: true; clientSeed: Hex }
  houseT: CoSignTransport
  playerT: CoSignTransport
  play: PlayInput<DiceParams>
  ctx: VerifyContext<DiceParams>
} {
  const { houseT, playerT } = memoryCoSignPair()

  const base = {
    domain: TEST_DOMAIN,
    tableId,
    game: dice,
    seedTip: tip,
    chainLength: 1,
    openBalances: { player: 1000n, house: 1000n },
    settlementMode: 0,
  }

  const clientSeed = `0x${'33'.repeat(32)}` as Hex

  const houseCfg: SessionConfig<DiceParams> = { ...base, player, house }
  // The player side carries its OWN committed clientSeed; it co-signs a round only if the house used
  // exactly this seed (anti-house-bias binding in verifyProposedState).
  const playerCfg = { ...base, player, houseRemote: true as const, clientSeed }

  const play: PlayInput<DiceParams> = {
    stake: 100n,
    params: { targetX100: 5000n },
    clientSeed,
  }

  const ctx: VerifyContext<DiceParams> = {
    parties: { player: player.address, house: house.address },
    commit: buildSeedChain(tip, base.chainLength).commit,
    game: dice,
    domain: TEST_DOMAIN,
  }

  return { houseCfg, playerCfg, houseT, playerT, play, ctx }
}
