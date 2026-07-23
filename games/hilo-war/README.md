# @msgboard/hilo-war

Heads-up Hi-Lo War: players hold private cards, post simultaneous raise/hold commitments,
may fold without revealing their hand, and split into a war pot on ties — all state-channel turns.

## Structure

- **`rules.ts`** — pure game logic (ante, bet resolution, showdown, war-pot carry, pot
  conservation). This module is intentionally mirrored later by an on-chain rules contract
  (`HiLoWarRules`) so the off-chain engine and the settlement contract share identical semantics.
- **`session.ts`** — two-client session driver built on top of `@msgboard/zk-cards-core`:
  keygen, double-shuffle, genesis channel co-sign, private card deals via withheld own-shares,
  simultaneous salted bet commitments applied in seat order, fold path (no reveal shares sent),
  and settlement with war-carry splitting (odd unit goes to seat A).

## Design spec

`valve-tech/msgboard` `docs/superpowers/specs/2026-06-11-zk-card-games-design.md`

## Testing

```
pnpm --filter @msgboard/hilo-war test
```
