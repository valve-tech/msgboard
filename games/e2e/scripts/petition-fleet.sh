#!/usr/bin/env bash
#
# petition-fleet.sh — launch 3 testnet bots that CONTINUOUSLY send petitions (GAS-FREE) on chain 943.
#
# Each bot, every cycle, creates ONE fresh unique petition and co-signs it with SIGNER_COUNT keys —
# both are gas-free msgboard board posts (PoW only). The on-chain settle (submitBatch, which needs
# 943 gas + a funded creator) is SKIPPED via NO_SETTLE, so NO key ever needs a balance.
#
# Why relaunch per cycle with ONCE=true + a fresh statement: the bot dedups petitions by statement
# TEXT (petition-bot-logic.ts / saltFor), so a fixed statement list creates once then idles. Feeding
# a timestamp+counter-unique statement each cycle is the only way to keep it CREATING continuously.
#
# Secrets are NOT in this file. Drop them in games/e2e/.env.petition-fleet (gitignored):
#     MNEMONIC=...            # 12/24-word test mnemonic; bot keys are addressIndex-derived from it
#     VALVE_RPC_KEY=...       # the valve one.valve.city RPC key
#
# Usage:
#     # dry run first — posts NOTHING, just logs what each bot WOULD create/sign:
#     DRY_RUN=1 games/e2e/scripts/petition-fleet.sh
#
#     # go live (continuous gas-free sending; Ctrl-C stops all three):
#     games/e2e/scripts/petition-fleet.sh
#
# Index map (disjoint blocks so the 3 bots never collide on a key):
#     Bot A: CREATOR_INDEX=60  SIGNER_START_INDEX=61  (signers 61..65)
#     Bot B: CREATOR_INDEX=70  SIGNER_START_INDEX=71  (signers 71..75)
#     Bot C: CREATOR_INDEX=80  SIGNER_START_INDEX=81  (signers 81..85)
#
set -euo pipefail

# ── resolve paths ────────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$E2E_DIR/.env.petition-fleet}"

# ── load secrets from the env file (agent never reads these; the human drops them in) ─────────────
if [[ ! -f "$ENV_FILE" ]]; then
  echo "petition-fleet: missing env file $ENV_FILE" >&2
  echo "  cp $E2E_DIR/.env.petition-fleet.example $ENV_FILE   # then fill MNEMONIC + VALVE_RPC_KEY" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${MNEMONIC:?petition-fleet: MNEMONIC is unset — add it to $ENV_FILE}"
: "${VALVE_RPC_KEY:?petition-fleet: VALVE_RPC_KEY is unset — add it to $ENV_FILE}"

# ── fixed fleet config ────────────────────────────────────────────────────────────────────────────
CHAIN=943
PETITION_VERIFIER="0x4e1c2e17fd4b9200654081a6f47a9b34ce498024"  # deployed PetitionSignatures on 943
RPC="https://one.valve.city/rpc/${VALVE_RPC_KEY}/evm/${CHAIN}"
SIGNER_COUNT="${SIGNER_COUNT:-5}"
SETTLE_INTERVAL_MS="${SETTLE_INTERVAL_MS:-60000}"   # lively; the per-cycle ONCE run mostly ignores it
PETITION_WINDOW_DAYS="${PETITION_WINDOW_DAYS:-30}"
CYCLE_SLEEP_SECS="${CYCLE_SLEEP_SECS:-60}"          # pause between a bot's cycles
DRY_RUN="${DRY_RUN:-}"                              # empty = live; the bot treats "" as false

if [[ ! -f "$E2E_DIR/scripts/petition-bot.ts" ]]; then
  echo "petition-fleet: cannot find scripts/petition-bot.ts under $E2E_DIR" >&2
  exit 1
fi

echo "petition-fleet: chain=$CHAIN verifier=$PETITION_VERIFIER"
echo "petition-fleet: rpc=https://one.valve.city/rpc/****/evm/$CHAIN  signers/bot=$SIGNER_COUNT  cycle=${CYCLE_SLEEP_SECS}s"
echo "petition-fleet: mode=$([[ -n "$DRY_RUN" ]] && echo DRY_RUN || echo LIVE)  settle=SKIPPED(gas-free)"
echo "petition-fleet: index map  A[60/61]  B[70/71]  C[80/81]   (Ctrl-C stops all)"
echo

# ── one bot: forever create+sign a fresh unique petition, gas-free, then sleep ────────────────────
run_bot() {
  local label="$1" creator="$2" signer="$3"
  local n=0
  while true; do
    n=$((n + 1))
    local ts stmt
    ts="$(date +%s)"
    # Only letters/digits/spaces/dashes → safe to embed straight into the JSON array below.
    stmt="Testnet petition fleet - bot ${label} - cycle ${ts}-${n} - we the bots petition for more entropy"
    (
      cd "$E2E_DIR"
      env \
        CHAIN="$CHAIN" \
        MNEMONIC="$MNEMONIC" \
        RPC="$RPC" \
        PETITION_VERIFIER="$PETITION_VERIFIER" \
        PETITION_STATEMENTS="[\"$stmt\"]" \
        SIGNER_COUNT="$SIGNER_COUNT" \
        CREATOR_INDEX="$creator" \
        SIGNER_START_INDEX="$signer" \
        SETTLE_INTERVAL_MS="$SETTLE_INTERVAL_MS" \
        PETITION_WINDOW_DAYS="$PETITION_WINDOW_DAYS" \
        NO_SETTLE=1 \
        ONCE=true \
        DRY_RUN="$DRY_RUN" \
        npx tsx scripts/petition-bot.ts
    ) 2>&1 | while IFS= read -r line; do printf '[%s] %s\n' "$label" "$line"; done
    sleep "$CYCLE_SLEEP_SECS"
  done
}

# ── run all three concurrently; Ctrl-C / SIGTERM stops the fleet ──────────────────────────────────
pids=()
run_bot A 60 61 & pids+=($!)
run_bot B 70 71 & pids+=($!)
run_bot C 80 81 & pids+=($!)

cleanup() {
  echo
  echo "petition-fleet: stopping bots…"
  kill "${pids[@]}" 2>/dev/null || true
  pkill -P $$ 2>/dev/null || true   # best-effort reap of direct children
  exit 0
}
trap cleanup INT TERM

wait
