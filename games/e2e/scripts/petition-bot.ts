/**
 * petition-bot.ts — the actor-fleet entrypoint that SEEDS + DRIVES the `@msgboard/petition`
 * capture→settle loop on chain 943. Mirrors the other fleet actors (chip-faucet, cosign-bot,
 * landing-house): env-driven, mnemonic-indexed keys, a startup banner the deploy greps.
 *
 * Two phases, per the design in `packages/petition`:
 *   1. CAPTURE (once, at start) — ensure each `PETITION_STATEMENTS` entry exists as a petition
 *      (`readPetitions` + `createPetition` if absent, creator = mnemonic CREATOR_INDEX, id derived
 *      from a deterministic per-statement salt so a restart never double-creates); then have
 *      `SIGNER_COUNT` mnemonic-indexed keys (SIGNER_START_INDEX..) `signPetition` each petition they
 *      haven't already signed (dedup via `readPetitionSignatures`).
 *   2. SETTLE (once at start, then every SETTLE_INTERVAL_MS) — per petition, recompute which
 *      captured signatures VERIFY (`verifySignature`) and are not yet recorded on-chain
 *      (`PetitionSignatures.signed`), and `submitBatch` the outstanding set with explicit EIP-1559
 *      fees (`sendAs`/`flooredFees` from actor-common — never the node's ~100k-gwei suggestion).
 *
 * PETITION_VERIFIER (the deployed PetitionSignatures address) is env-driven because
 * `@msgboard/petition`'s `deployments` registry is still `{}`. Signing is domain-bound to
 * `verifyingContract` (see `petitionDigest`), so with no real verifier there is nothing correct to
 * sign OR settle against yet — when it's unset the bot ONLY ensures petitions exist on the board
 * (capture's create step) and skips both signing and settling, logging a loud warning. This avoids
 * ever posting a signature under a placeholder domain that would need re-signing (and could
 * wrongly dedup-block a later correct signature) once the real verifier is configured.
 *
 * Board posting reuses the same MsgBoardClient + `doPoW` cascade (native→WASM→JS) `cosign-bot.ts`
 * uses — fine at this actor's cadence (a handful of posts at start, then an occasional settle tx;
 * no tight co-sign timeout to race like the landing house's real-time flow).
 *
 * Env (defaults in parens):
 *   MNEMONIC              required — bot keys are mnemonic-indexed.
 *   CHAIN (943)           the chain the petition bot serves.
 *   RPC                   required — chain reads + the msgboard_ board module (same valve endpoint
 *                         other 943 actors use serves both).
 *   BOARD_RPC (= RPC)     override if the board module lives on a different endpoint.
 *   PETITION_VERIFIER     the deployed PetitionSignatures address on 943. Unset → capture-only
 *                         (create petitions; no signing, no settle) + a loud warning.
 *   PETITION_STATEMENTS   JSON array of statement strings to ensure exist, e.g. '["Free the whales"]'.
 *   SIGNER_COUNT (5)      how many mnemonic-indexed keys co-sign each petition.
 *   CREATOR_INDEX (0)     mnemonic addressIndex for the petition creator / settle submitter.
 *   SIGNER_START_INDEX(1) first mnemonic addressIndex signers are derived from (SIGNER_COUNT keys,
 *                         contiguous from here).
 *   SETTLE_INTERVAL_MS    settle tick cadence. Default 300000 (5 min).
 *   PETITION_WINDOW_DAYS  rolling read window for petitions/signatures. Default 30.
 *   DRY_RUN               if set, log intended create/sign/settle actions; post/send nothing.
 *   ONCE                  if set, run one capture + one settle tick then exit (smoke / typecheck).
 */
import * as viem from 'viem'
import type { GamesChainId } from '@msgboard/games-core'
import { MsgBoardClient, type Content, type MessageSeed, type Provider } from '@msgboard/sdk'
import type { BoardClient, SignatureRecord } from '@msgboard/cosign'
import {
  type Petition,
  createPetition,
  signPetition,
  readPetitions,
  readPetitionSignatures,
  tally,
  verifySignature,
  buildSubmitBatchArgs,
  PETITION_SIGNATURES_ABI,
} from '@msgboard/petition'
import { makeActor, sendAs } from './actor-common'
import { petitionsNeedingCreation, outstandingToSettle } from './petition-bot-logic'

const env = process.env
const CHAIN = (env.CHAIN ? Number(env.CHAIN) : 943) as GamesChainId
const RPC = env.RPC
const BOARD_RPC = env.BOARD_RPC || RPC
const PETITION_VERIFIER = (env.PETITION_VERIFIER ?? '').trim() as viem.Hex | ''
const STATEMENTS: string[] = JSON.parse(env.PETITION_STATEMENTS ?? '[]')
const SIGNER_COUNT = Number(env.SIGNER_COUNT ?? '5')
const CREATOR_INDEX = Number(env.CREATOR_INDEX ?? '0')
const SIGNER_START_INDEX = Number(env.SIGNER_START_INDEX ?? '1')
const SETTLE_INTERVAL_MS = Number(env.SETTLE_INTERVAL_MS ?? '300000') // 5 min
const WINDOW_DAYS = Number(env.PETITION_WINDOW_DAYS ?? '30')
const DRY_RUN = !!env.DRY_RUN

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-4)}`
const oneLine = (e: unknown) => (e as Error)?.message?.split('\n')[0] ?? String(e)

/** Deterministic per-statement salt, so a restart re-derives the SAME petition id (idempotent). */
const saltFor = (statement: string): viem.Hex => viem.keccak256(viem.toBytes(`petition-bot:${statement}`))

const main = async () => {
  if (!env.MNEMONIC) throw new Error('MNEMONIC required')
  if (!RPC) throw new Error('RPC required')

  const creator = makeActor(CHAIN, env.MNEMONIC, CREATOR_INDEX, RPC)
  const signers = Array.from({ length: SIGNER_COUNT }, (_, i) =>
    makeActor(CHAIN, env.MNEMONIC!, SIGNER_START_INDEX + i, RPC),
  )

  // The deploy greps this banner prefix; the address is the petition creator + settle submitter
  // (needs 943 gas for submitBatch; board posts are gas-free, PoW only).
  console.log(`petition bot on chain ${CHAIN} @ ${creator.account.address}`)

  if (!PETITION_VERIFIER) {
    console.error(
      'petition bot: PETITION_VERIFIER unset — running capture-only (ensuring petitions exist on the ' +
        'board); signing + settle are skipped until a real PetitionSignatures address is configured ' +
        '(signatures are domain-bound to it, so there is nothing correct to sign yet)',
    )
  }
  if (STATEMENTS.length === 0) {
    console.error('petition bot: PETITION_STATEMENTS is empty — nothing to seed')
  }

  // Board client: MsgBoardClient + the SDK's doPoW cascade (native→WASM→JS), mirroring cosign-bot.ts.
  // DRY_RUN posts NOTHING — addMessage short-circuits before any PoW grind or RPC submit.
  const boardProvider = makeActor(CHAIN, env.MNEMONIC!, CREATOR_INDEX, BOARD_RPC).publicClient
  const boardClient = new MsgBoardClient(boardProvider as unknown as Provider)
  const board: BoardClient = {
    async addMessage({ category, data }: { category: viem.Hex; data: viem.Hex }): Promise<unknown> {
      if (DRY_RUN) {
        console.log(`[dry-run] addMessage category=${short(category)} data=${short(data)}`)
        return { dryRun: true }
      }
      const { message } = await boardClient.doPoW(category, data)
      return boardClient.addMessage(message as MessageSeed)
    },
    content({ category }: { category: viem.Hex }): Promise<Content> {
      return boardClient.content({ category })
    },
  }

  try {
    const status = await boardClient.status()
    boardClient.setDifficultyFactors(BigInt(status.workMultiplier), BigInt(status.workDivisor))
  } catch (e) {
    console.error(`petition bot: board status probe failed, using default difficulty: ${oneLine(e)}`)
  }

  /** One action; a failure logs one line and never aborts the tick. */
  const attempt = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (e) {
      console.error(`petition bot: ${label}: ${oneLine(e)}`)
    }
  }

  // ── CAPTURE (once at start): ensure petitions exist, then have SIGNER_COUNT keys sign them ──
  const capture = async () => {
    const existing = await readPetitions(board, WINDOW_DAYS)
    const toCreate = petitionsNeedingCreation(existing, STATEMENTS, creator.account.address, saltFor)
    for (const { statement, id, salt } of toCreate) {
      await attempt(`create petition ${short(id)}`, async () => {
        if (DRY_RUN) {
          console.log(`[dry-run] would create petition ${short(id)}: "${statement}"`)
          return
        }
        const p: Petition = {
          id,
          statement,
          creator: creator.account.address,
          createdAt: Math.floor(Date.now() / 1000),
          chainId: CHAIN,
          salt,
        }
        await createPetition(board, p)
        console.log(`petition bot: created petition ${short(id)}: "${statement}"`)
      })
    }

    if (!PETITION_VERIFIER) return // capture-only: no domain to sign against yet

    // Re-read so newly-created petitions above are included in the signing pass.
    const petitions = await readPetitions(board, WINDOW_DAYS)
    for (const p of petitions) {
      const existingSigs = await readPetitionSignatures(board, p.id, WINDOW_DAYS)
      const already = new Set(existingSigs.map((r) => r.signer.toLowerCase()))
      for (const signer of signers) {
        if (already.has(signer.account.address.toLowerCase())) continue
        await attempt(`sign petition ${short(p.id)} as ${short(signer.account.address)}`, async () => {
          if (DRY_RUN) {
            console.log(`[dry-run] would sign petition ${short(p.id)} as ${signer.account.address}`)
            return
          }
          await signPetition(board, p, PETITION_VERIFIER as viem.Hex, (digest) => signer.account.sign({ hash: digest }))
          console.log(`petition bot: ${short(signer.account.address)} signed petition ${short(p.id)}`)
        })
      }
    }
  }

  // ── SETTLE (once at start + every SETTLE_INTERVAL_MS): submitBatch the outstanding signers ──
  const settle = async () => {
    if (!PETITION_VERIFIER) return // nothing to read/settle against
    const verifier = PETITION_VERIFIER as viem.Hex
    const petitions = await readPetitions(board, WINDOW_DAYS)
    for (const p of petitions) {
      await attempt(`settle petition ${short(p.id)}`, async () => {
        const records = await readPetitionSignatures(board, p.id, WINDOW_DAYS)
        const { count: capturedTotal } = tally(records)

        // Keep only the LATEST record per signer whose signature verifies against the real domain.
        const verifiedBySigner = new Map<string, SignatureRecord>()
        for (const r of records) {
          if (await verifySignature(p, r, verifier)) verifiedBySigner.set(r.signer.toLowerCase(), r)
        }
        const capturedSigners = [...verifiedBySigner.keys()] as viem.Hex[]

        const settledSigners: viem.Hex[] = []
        for (const s of capturedSigners) {
          const isSigned = (await creator.publicClient.readContract({
            address: verifier,
            abi: PETITION_SIGNATURES_ABI,
            functionName: 'signed',
            args: [p.id, s],
          })) as boolean
          if (isSigned) settledSigners.push(s)
        }

        const outstanding = outstandingToSettle(capturedSigners, settledSigners)
        if (outstanding.length === 0) {
          console.log(
            `petition bot: petition ${short(p.id)} — ${capturedTotal} captured, nothing outstanding to settle`,
          )
          return
        }
        if (DRY_RUN) {
          console.log(
            `[dry-run] would submitBatch petition ${short(p.id)} for ${outstanding.length} signer(s): ` +
              outstanding.map(short).join(', '),
          )
          return
        }
        const signatures = outstanding.map((signer) => verifiedBySigner.get(signer.toLowerCase())!.signature)
        const args = buildSubmitBatchArgs(p, outstanding, signatures)
        const receipt = await sendAs(creator.publicClient, creator.wallet, {
          address: verifier,
          abi: PETITION_SIGNATURES_ABI as viem.Abi,
          functionName: 'submitBatch',
          args,
        })
        console.log(
          `petition bot: settled ${outstanding.length} signer(s) for petition ${short(p.id)} (tx ${receipt.transactionHash})`,
        )
      })
    }
  }

  await capture()
  await settle()

  if (env.ONCE === 'true') return

  const settleTimer = setInterval(() => { void settle().catch((e) => console.error(`petition bot: settle tick failed: ${oneLine(e)}`)) }, SETTLE_INTERVAL_MS)

  const shutdown = (sig: string) => {
    console.log(`\n${sig} — stopping petition bot…`)
    clearInterval(settleTimer)
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
