#!/usr/bin/env bash
# Serve the Safe-owner indexer under cosign.msgboard.xyz/safe-indexer/* (path route), mirroring how
# games-indexer is served under games.msgboard.xyz/games-indexer/*. A path route needs ZERO DNS work:
# cosign.msgboard.xyz already resolves and is fronted by this same Caddy, whereas a brand-new
# safe-indexer.msgboard.xyz host would need a hand-added Cloudflare record (no API token on the box).
#
# The cosign app calls cosign.msgboard.xyz/safe-indexer/owners/{address}/safes?chainId=369 — same path
# shape as the Safe Tx Service (minus its /api/v1 prefix), so the app keeps ONE client.
#
# NOTE: this is documentation-grade / not wired into the Ansible runbook yet. Per repo policy deploys
# MUST go through ansible/ (idempotent, safe caddy reload w/ rollback); prefer adding a deploy-safe-
# indexer.yml play modelled on deploy-cosign.yml over running this by hand. Left here to mirror
# games-indexer and to document the exact route.
#
# Safety: back up the live Caddyfile, rewrite it, `caddy validate` before reload, then healthcheck BOTH
# the cosign SPA and the indexer. Any failure restores the backup and reloads.
set -euo pipefail

CF=/opt/msgboard/deploy/caddy/Caddyfile
BAK="$CF.bak.safeidx.$(date +%s)"
cp "$CF" "$BAK"
echo "backed up Caddyfile -> $BAK"

# Drop a top-level `host { ... }` block (brace-balanced), matched only at column 1.
strip_block() { # $1 host, $2 infile -> stdout
  awk -v host="$1" '
    BEGIN { skip=0; depth=0 }
    {
      if (skip==0 && index($0, host " {")==1) { skip=1; depth=0 }
      if (skip==1) {
        depth += gsub(/{/,"{") - gsub(/}/,"}")
        if (depth<=0) skip=0
        next
      }
      print
    }
  ' "$2"
}

TMP=$(mktemp)
strip_block 'cosign.msgboard.xyz' "$CF" > "$TMP"   # remove the current cosign block; re-add below

# Canonical block: indexer route first (handle_path strips the /safe-indexer prefix so the upstream
# sees /owners/…, /graphql, /health), SPA/app reverse_proxy second. Mirrors the cosign block's tls.
cat >> "$TMP" <<'EOF'

cosign.msgboard.xyz {
	tls /etc/caddy/origin.pem /etc/caddy/origin.key
	encode gzip zstd
	handle_path /safe-indexer/* {
		reverse_proxy safe-indexer:42069
	}
	handle {
		reverse_proxy cosign-web:4173
	}
}
EOF

cp "$TMP" "$CF"
rm -f "$TMP"

restore() { echo "!! $1 — restoring $BAK"; cp "$BAK" "$CF"; docker exec caddy caddy reload --config /etc/caddy/Caddyfile || true; exit 1; }

docker exec caddy caddy validate --config /etc/caddy/Caddyfile || restore "caddy validate failed"
docker exec caddy caddy reload   --config /etc/caddy/Caddyfile || restore "caddy reload failed"
sleep 3

SPA=$(curl -sS -o /dev/null -w '%{http_code}' https://cosign.msgboard.xyz/ || echo 000)
IDX=$(curl -sS -o /dev/null -w '%{http_code}' https://cosign.msgboard.xyz/safe-indexer/health || echo 000)
echo "post-reload health: SPA=$SPA  indexer=$IDX"
[ "$SPA" = "200" ] || restore "cosign SPA healthcheck returned $SPA"
[ "$IDX" = "200" ] || restore "indexer healthcheck returned $IDX"
echo "ok: cosign.msgboard.xyz/safe-indexer/* -> safe-indexer:42069"
