# ZK Skill Games — design spec (Sudoku + Wordle)

Status: agreed direction as of 2026-07. Both skill games are **non-wagered** — provably-fair puzzles
you play for a leaderboard / with friends, NOT casino games. (The wagered `SkillSettle` + Chips path is
retired; see [de-wager](#history).)

## Principles

- **Non-wagered.** No stake, no house edge, no escrow. A flat-multiplier bet on a public, automatable
  solve is strictly -EV for the house and the proof can't tell a fast human from a bot — so there is
  nothing to bet on. These are speedruns / friend challenges with a cryptographic finish line.
- **msgboard-first.** The interactive game (challenges, guesses, clue proofs, commit-reveal) lives on
  msgboard — free, fast, PoW-ordered, and every ZK proof is verifiable by any reader. The chain is only
  an **optional canonical anchor** for a permanent leaderboard entry.
- **Trustless via ZK, not via a chain.** A `wordle_clue` / `wordle_solve` / `sudoku_solve` proof is just
  as valid read off msgboard as from calldata. The chain adds permanence + canonical ordering, not trust.

## Two games, one shape

Both are: a puzzle is opened → a solver produces a ZK proof they solved it → the solve is recorded
(msgboard, optionally anchored on-chain) → leaderboard.

### Sudoku (public puzzle)
- The puzzle grid is **public** (`SudokuLog.openPuzzle` stores its hash + `openedAt`). No hidden state.
- Anyone solves it and submits a `sudoku_solve` proof bound to their address via a nullifier
  (`SudokuLog.logSolve`, or an EAS attestation later). Ranked by elapsed time.
- **Global mode is free**: an open puzzle IS a global puzzle. Mainnet puzzle #1 (the Wikipedia grid) is
  live on 369. Global = keep opening puzzles on a cadence.
- Live contracts (verified, Sourcify): 369 SudokuLog `0x939cbb0f…`, 943 SudokuLog `0xf700e0c1…`.

### Wordle (hidden word)
Wordle's clues need the hidden word, so it has a **setter** role and a commit-reveal round.

- **Setter** commits a word: `commit = Poseidon(word, salt)` (on msgboard, optionally `WordleLog`/EAS).
- **Play** — guessers post guesses; the setter scores each and proves the clue honest (`wordle_clue`).
  Real-time, on msgboard. No one can cheat the colors.
- **Commit phase** — when a guesser solves, they post `hash(guessesUsed, guessSequence, nonce)` to
  msgboard. Their result is locked + hidden before any reveal (this is the fairness layer — it stops
  copying and stops "waiting to see the word").
- **Reveal phase** — after everyone's committed (or a deadline), the setter reveals `word, salt`; each
  solver can now build their `wordle_solve` proof and reveal `nonce` + proof. Verified against the
  earlier commit. Because results were locked before the reveal, revealing the word afterward is safe.
- Ranked by guesses-used.

#### Two modes (same protocol, different setter)
| | Friends | Global |
|---|---|---|
| Setter | a friend | a platform **clue-oracle** service (holds the word, serves `wordle_clue` proofs over msgboard, reveals at round end) |
| Word | private to the group | the daily/periodic word |
| Trust note | none (no oracle) | the oracle knows the word (like NYT's server); ZK still guarantees honest clues + real solves |

Live Wordle verifier contracts (verified, Sourcify): `WordleRules` 369 `0xcd57eee1…` / 943 `0x85b9e49a…`
+ the clue/solve PLONK verifiers; dictionary = the full 12,972-word list, root
`3350479244380732130121458266697593225013617640696585361522515229064079345293`.

## Leaderboard = EAS attestation (pending @provex/notary)

The optional canonical leaderboard entry is an **EAS attestation** gated by a **schema resolver** that
verifies the ZK proof — so an attestation only exists if the proof checks out (the resolver does exactly
what a `logSolve` does). Benefits: standard, composable, EAS-native indexing (shrinks the custom-indexer
need), off-chain option.

- **On-chain attestation** runs the resolver → trustless, proof-gated (the anchor).
- **Off-chain attestation** skips the resolver → a signed claim verified by readers (the msgboard path).
- Resolvers (`WordleSolveResolver`, `SudokuSolveResolver`) implement the standard `ISchemaResolver` and
  verify via the existing `WordleRules` / `SudokuRules`. Public `@ethereum-attestation-service/eas-contracts`.
- EAS must be available on 943 + 369 (attest on whichever chain we're on). Addresses + schema
  registration + attestation tooling come from the forthcoming `@provex/notary` package — **on hold**.
- Until then, the on-chain record is `SudokuLog` (live) and `WordleLog` (a simple one-shot anchor); the
  leaderboard reads events / getLogs. EAS migration slots in without changing the game.

## On-chain vs msgboard, summarized

| Layer | Lives on |
|---|---|
| Challenge, guesses, clue proofs, commit-reveal, word reveal | **msgboard** |
| Optional canonical leaderboard entry | **on-chain**: EAS attestation + resolver (pending); `SudokuLog`/`WordleLog` today |

## History / de-wager {#history}

Wordle began as a wagered house game (`SkillSettle` + Chips). It was de-wagered ("a game you play with
friends"): `WordleLog` (non-wagered, permissionless) replaced `SkillSettle`; the SkillSettle + Chips
deploys on 943/369 are orphaned. Sudoku was never a wager (`SudokuLog` timed leaderboard).
