/**
 * petition-bot-logic.ts — pure decision helpers for the petition bot actor, extracted so they're
 * unit-testable WITHOUT a live board or chain (see petition-bot-logic.test.ts).
 *
 * `derivePetitionId` (from @msgboard/petition) is pure keccak arithmetic — no I/O — so it's safe to
 * call directly here alongside the set-difference logic.
 */
import type { Hex } from 'viem'
import { type Petition, derivePetitionId } from '@msgboard/petition'

/** A petition the bot still needs to create, with its derived id + salt. */
export interface PetitionToCreate {
  statement: string
  id: Hex
  salt: Hex
}

/**
 * Which of `wanted` statements have no matching petition in `existing` yet (matched by statement
 * text — the same statement re-run through this bot always derives the same id via `saltFor`, so a
 * restart is idempotent and never double-creates). `creator` + `saltFor(statement)` derive the id
 * each missing petition WILL have once created.
 */
export function petitionsNeedingCreation(
  existing: Petition[],
  wanted: string[],
  creator: Hex,
  saltFor: (statement: string) => Hex,
): PetitionToCreate[] {
  const have = new Set(existing.map((p) => p.statement))
  return wanted
    .filter((statement) => !have.has(statement))
    .map((statement) => {
      const salt = saltFor(statement)
      return { statement, salt, id: derivePetitionId(statement, creator, salt) }
    })
}

/**
 * Case-insensitive set difference: `capturedSigners` (signers whose board-captured signature already
 * VERIFIED) minus `settledSigners` (signers the on-chain PetitionSignatures contract already has
 * recorded) — the outstanding batch to `submitBatch`. Also dedupes `capturedSigners` against itself
 * (case-insensitive), preserving first-seen order/casing.
 */
export function outstandingToSettle(capturedSigners: Hex[], settledSigners: Hex[]): Hex[] {
  const settled = new Set(settledSigners.map((s) => s.toLowerCase()))
  const seen = new Set<string>()
  const out: Hex[] = []
  for (const signer of capturedSigners) {
    const lc = signer.toLowerCase()
    if (settled.has(lc) || seen.has(lc)) continue
    seen.add(lc)
    out.push(signer)
  }
  return out
}
