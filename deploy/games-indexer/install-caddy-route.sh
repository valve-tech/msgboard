#!/usr/bin/env bash
# Serve the games indexer under games.msgboard.xyz/games-indexer/* instead of a standalone
# games-943.msgboard.xyz host. games-943 was never given a public DNS record (msgboard subdomains
# are added by hand in Cloudflare and there's no API token here), whereas games.msgboard.xyz already
# resolves and is fronted by this same Caddy — so a path route needs zero DNS work.
#
# Safety: back up the live Caddyfile, rewrite it, `caddy validate` before reload, then healthcheck
# BOTH the SPA and the indexer. Any failure restores the backup and reloads, so the user-facing
# games site can never be left broken by this script.
set -euo pipefail

CF=/opt/msgboard/deploy/caddy/Caddyfile
BAK="$CF.bak.gamesidx.$(date +%s)"
cp "$CF" "$BAK"
echo "backed up Caddyfile -> $BAK"

# Drop a top-level `host { ... }` block (brace-balanced). Matches only when the host starts at column
# 1, so it never touches indented inner directives or a different host that shares a prefix.
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
strip_block 'games-943.msgboard.xyz' "$CF"  > "$TMP"      # remove the dead standalone host (if present)
strip_block 'games.msgboard.xyz'     "$TMP" > "$TMP.next" # remove the current SPA block; re-add below
mv "$TMP.next" "$TMP"

# Canonical block: indexer route first (handle_path strips the /games-indexer prefix so the upstream
# sees /graphql, /health, …), SPA catch-all second. Mirrors the original SPA block's tls/encode/root.
cat >> "$TMP" <<'EOF'

games.msgboard.xyz {
	tls /etc/caddy/origin.pem /etc/caddy/origin.key
	encode gzip zstd
	handle_path /games-indexer/* {
		reverse_proxy games-indexer-943:42069
	}
	handle {
		root * /srv/graphiql/games
		try_files {path} /index.html
		file_server
	}
}
EOF

cp "$TMP" "$CF"
rm -f "$TMP"

restore() { echo "!! $1 — restoring $BAK"; cp "$BAK" "$CF"; docker exec caddy caddy reload --config /etc/caddy/Caddyfile || true; exit 1; }

docker exec caddy caddy validate --config /etc/caddy/Caddyfile || restore "caddy validate failed"
docker exec caddy caddy reload   --config /etc/caddy/Caddyfile || restore "caddy reload failed"
sleep 3

SPA=$(curl -sS -o /dev/null -w '%{http_code}' https://games.msgboard.xyz/ || echo 000)
IDX=$(curl -sS -o /dev/null -w '%{http_code}' https://games.msgboard.xyz/games-indexer/health || echo 000)
echo "post-reload health: SPA=$SPA  indexer=$IDX"
[ "$SPA" = "200" ] || restore "SPA healthcheck returned $SPA"
# indexer may still be backfilling; /health returns 200 once the server is up, so treat non-200 as fatal too
[ "$IDX" = "200" ] || restore "indexer healthcheck returned $IDX"
echo "ok: games.msgboard.xyz/games-indexer/* -> games-indexer-943:42069"
