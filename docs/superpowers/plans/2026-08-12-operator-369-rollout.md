# Operator substrate + validator-forfeit rollout to 369 (mainnet, real money)

Status: DRAFT for review. Nothing touches 369 until you approve the open decisions in §7.

The validator-forfeit OperatorCoinFlip is airtight on 943 (Foundry 25/25, anvil-vs-real-Random 3/3,
fix review SHIP-verdict + whole-branch audit, live 943 MODE=all 42/42). This plan takes that exact
code to PulseChain mainnet 369, where the stakes are real PLS-value.

## 1. What already exists on 369

- Random (validator entropy): `0x87fc31413534733a09df5dc5aa33b4dba1f64b61` — live, real.
- Validators (canonical subset), same as 943, mnemonic indices 1-3:
  `0xAe96b0748f933914867d59486251043790cB2896`, `0x2a638D7135966a5cA1973c930bD0317cd7d6874c`,
  `0x0D3148A85608708Fe944EE71E13B4C9181b7cc83`.
- poolSize 64. Existing games: CoinFlip `0x66bdacfdd918f9d4c29f0a7d26609912ab478f4d` (+ raffle).
- Deployer/owner valve_deployer `0x5182…` holds ~50.2M PLS on 369 — ample for gas.
- There is NO operator substrate on 369 yet → this is a full deploy, not a game-only redeploy.

## 2. Deploy order (full substrate)

Use the existing `contracts/scripts/deploy-operator-substrate.ts` (NOT redeploy-operator-coinflip,
which assumes an existing substrate). It deploys Registry → GameEscrow → OperatorBond →
OperatorVault(impl) → OperatorVaultFactory → OperatorCoinFlip, then allowlists the validators.

```
# dry run
PRIVATE_KEY="$(op read op://valve/valve_deployer/pk)" CHAIN_ID=369 \
  RANDOM=0x87fc31413534733a09df5dc5aa33b4dba1f64b61 \
  VALIDATORS=0xAe96b0748f933914867d59486251043790cB2896,0x2a638D7135966a5cA1973c930bD0317cd7d6874c,0x0D3148A85608708Fe944EE71E13B4C9181b7cc83 \
  OUT_JSON=deployments/369-operator-substrate.json \
  RPC_URL=<369 rpc> npx tsx scripts/deploy-operator-substrate.ts
# broadcast: add DEPLOY_EXECUTE=1
```

Pre-deploy gates (all already green for this bytecode on 943, re-confirm on the 369 build):
- deployability guard: MCOPY/TSTORE/TLOAD-free, under 24576B (OperatorCoinFlip 9272B). 369 is pre-Cancun
  like 943 — the shanghai pin in hardhat.config.ts/foundry.toml covers it.
- read-back verification is built into the deploy script (owner/random/escrow/registry/validatorCount).

Use the valve RPC for 369 (`https://one.valve.city/rpc/<key>/evm/369`), NOT a public RPC — the public
PulseChain RPC quotes a bogus eth_gasPrice (the 943 trap almost certainly repeats on 369). The deploy
script uses resolveLegacyFee (baseFee-based), which is safe either way, but the caster/QA use flooredFees
(getGasPrice-based) and MUST run against the valve RPC.

## 3. Operator onboarding + real bankroll (per operator, NOT part of deploy)

For the house/valve operator (valve_deployer plays operator):
1. `registry.register()`
2. `escrow.authorizeGame(game, true)`
3. Fund bankroll: approve escrow + `escrow.depositBankroll(op, TOKEN, BANKROLL)` — REAL value (§7).
4. Fund the fee pool: approve game + `game.depositFees(op, TOKEN, FEES)` — REAL value (§7).
5. `createTable(TOKEN, mult, minStake, maxStake)` — the stake-tier ladder.

Player side (per player, on first play): `escrow.setPlayerGame(game, true)` + approve escrow for stakes.

## 4. Validator staking on 369

Each validator must ink a staked (TOKEN, tierPrice) pool from its OWN key so the stake is its own capital.
On 943 the QA/caster did this via the validators' mnemonic keys, funding stake with the deployer's Chips.
On 369 the staked token has REAL value, so:
- The validators need real TOKEN to stake (poolSize × tierPrice per pool per tier they serve).
- DECISION (§7): who funds validator stakes on mainnet, and how much. Options: the validators self-fund
  from their own holdings; or valve seeds them (then they are valve-controlled — weakens the "one honest
  validator" story unless independent validators join).

## 5. Fleet cutover (ongoing operation)

The always-on cast-watcher must run the new `operatorPass()` for 369, or operator rounds won't be cast or
chopped automatically. Ship via the ansible runbook (per the deploys-via-ansible-runbook rule), NOT an
ad-hoc script:
- Update the 369 actors `.env`/config: `operatorCoinFlip` = the new 369 game, `SEEDS0`, `VALVE_RPC_KEY`.
- Deploy the updated `games-actors` stack (cast-watcher) to the production box.
- Confirm the price-0 games (CoinFlip/Raffle/CoinFlipTables) keep running — operatorPass is additive and
  gated on config.operatorCoinFlip; heatsSince stays separate from heatsSincePriced (proven on 943).

Note: the live forfeit PROOF (§6) does not require the fleet — the QA harness drives cast+chop itself. The
fleet cutover is for steady-state operation and can follow the proof.

## 6. Go/no-go: a live 369 forfeit proof at minimal stakes

Before opening real tables, run the QA harness against 369 at the SMALLEST viable tier (real value, kept
tiny), mirroring the 943 proof:
```
KEY=<369 valve rpc key> \
PRIVATE_KEY=<valve_deployer> MNEMONIC=<op://valve/randomness/recovery phrase> \
SEEDS0=<op://valve/randomness/seeds0> TIER=<tiny, e.g. 1e15> \
RPC_URL=https://one.valve.city/rpc/$KEY/evm/369 \
GAME=<369 game> ESCROW=<369 escrow> REGISTRY=<369 registry> \
MODE=all npx tsx scripts/qa-operator-coinflip.ts
```
(qa-operator-coinflip reads addresses from 369-operator-substrate.json once written; TOKEN comes from the
table — on 369 there is no CoinFlipTables.chips() source, so the harness needs a 369 TOKEN env or a small
edit to read the token from an env instead of CFT. Minor harness tweak, listed in §8.)
Expect the same 42/42: ladder tier rounding, settle (parity matches seed), forfeit (chopAndRoute banks
forfeit==tierPrice, player refunded, fee restored), matrix reverts.

## 7. OPEN DECISIONS (yours — real money)

1. **Token.** Which ERC-20 backs the house operator table on 369? (Real Chips? WPLS? a stable?) The forfeit
   is denominated in this token; validators stake it.
2. **Bankroll + fee-pool size.** How much real value to commit as operator bankroll and fee pool at launch.
3. **Stake tiers.** minStake / maxStake / maxMultiplier for the launch table(s).
4. **Validator stake funding.** Self-funded vs valve-seeded (see §4) — affects the trust story.
5. **Launch scope.** House-operator-only at first, or open operator registration to third parties from day 1.

## 8. Small code items before 369

- qa-operator-coinflip.ts: allow a 369 TOKEN via env (369 has no CoinFlipTables.chips() to read).
- Confirm the valve RPC key for 369 (`.../evm/369`) and rate limits for the caster's polling.
- Optionally harden flooredFees to derive from baseFee (immune to the bogus eth_gasPrice) so the fleet is
  robust even if pointed at a public RPC — currently mitigated by using the valve RPC.

## 9. Rollback / kill switches (no fund lock)

- `game.setOpen(tableId, false)` — stop new rounds on a table (operator-only).
- `escrow.authorizeGame(game, false)` — halt all opens for the operator instantly (the C1 lever).
- `escrow.withdrawBankroll(...)` / `game.withdrawFees(...)` — pull idle operator capital back out.
- In-flight rounds always resolve: settle via cast/claim, or forfeit/refund via chopAndRoute/refundStale —
  no path locks player or operator funds (proven).
