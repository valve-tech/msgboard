#!/usr/bin/env bash
# Serve the games indexer under games.msgboard.xyz/games-indexer/* instead of a standalone
# games-943.msgboard.xyz host. games-943 was never given a public DNS record (msgboard subdomains
# are added by hand in Cloudflare and there's no API token here), whereas games.msgboard.xyz already
# resolves and is fronted by this same Caddy — so a path route needs zero DNS work.
#
# Also installs the domain-scoped RPC proxy /rpc/evm/{943,369}: the real one.valve.city key stays
# SERVER-SIDE (read from /opt/msgboard/.env's PONDER_RPC_URL_943 and spliced into the rewrite), so
# the browser stops shipping with the shared vk_demo demo key baked into its bundle.
#
# And /proving-keys/*: the ZK games' PLONK artifacts (zkeys + witness wasms), mirrored on the box at
# /opt/msgboard/deploy/caddy/graphiql/proving-keys (sha256-verified against the zk-skill manifest;
# GitHub release downloads send no CORS headers, so browsers can't fetch them from github.com).
# Same-origin for prod; ACAO * for localhost dev; immutable-cached (content-addressed by manifest).
# The dir sits OUTSIDE the SPA root on purpose — the games rsync --delete can't wipe it.
#
# Safety: back up the live Caddyfile, rewrite it, `caddy validate` before reload, then healthcheck
# the SPA, the indexer AND both rpc routes. Any failure restores the backup and reloads, so the
# user-facing games site can never be left broken by this script.
set -euo pipefail

CF=/opt/msgboard/deploy/caddy/Caddyfile
BAK="$CF.bak.gamesidx.$(date +%s)"
cp "$CF" "$BAK"
echo "backed up Caddyfile -> $BAK"

# The real RPC key, extracted from the URL the indexers already use. Never printed.
RPC_KEY=$(grep -m1 '^PONDER_RPC_URL_943=' /opt/msgboard/.env | sed -E 's|.*/rpc/([^/]+)/evm/.*|\1|')
[ -n "$RPC_KEY" ] && [ "$RPC_KEY" != "vk_demo" ] || { echo "!! no real RPC key in /opt/msgboard/.env (PONDER_RPC_URL_943)"; exit 1; }

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
# sees /graphql, /health, …), then the keyed RPC proxy routes, SPA catch-all last. The heredoc is
# UNQUOTED so $RPC_KEY interpolates; Caddy placeholders ({path}) contain no `$` and pass through.
cat >> "$TMP" <<EOF

games.msgboard.xyz {
	tls /etc/caddy/origin.pem /etc/caddy/origin.key
	encode gzip zstd
	handle_path /games-indexer/* {
		reverse_proxy games-indexer-943:42069
	}
	handle /rpc/evm/943 {
		rewrite * /rpc/$RPC_KEY/evm/943
		reverse_proxy https://one.valve.city {
			header_up Host one.valve.city
		}
	}
	handle /rpc/evm/369 {
		rewrite * /rpc/$RPC_KEY/evm/369
		reverse_proxy https://one.valve.city {
			header_up Host one.valve.city
		}
	}
	handle_path /proving-keys/* {
		root * /srv/graphiql/proving-keys
		header Access-Control-Allow-Origin "*"
		header Cache-Control "public, max-age=31536000, immutable"
		file_server
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
[ "$SPA" = "200" ] || restore "SPA healthcheck returned $SPA"
# The indexer container may have just been recreated by `compose up --build` and ponder takes a
# moment to boot — retry up to 60s before declaring the route broken. (/health is up before the
# backfill finishes, so 200 here doesn't mean synced, just serving.)
IDX=000
for _ in $(seq 1 20); do
  IDX=$(curl -sS -o /dev/null -w '%{http_code}' https://games.msgboard.xyz/games-indexer/health || echo 000)
  [ "$IDX" = "200" ] && break
  sleep 3
done
echo "post-reload health: SPA=$SPA  indexer=$IDX"
[ "$IDX" = "200" ] || restore "indexer healthcheck returned $IDX after 60s"

# The rpc routes must answer a real JSON-RPC call with the right chain id (body-aware — a 200 with
# the wrong body means the rewrite or key is broken).
rpc_chain() { curl -sS -m 15 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "https://games.msgboard.xyz/rpc/evm/$1" | grep -o '"result":"[^"]*"' || echo none; }
C943=$(rpc_chain 943); C369=$(rpc_chain 369)
echo "rpc probes: 943=$C943  369=$C369"
[ "$C943" = '"result":"0x3af"' ] || restore "rpc/evm/943 returned $C943 (want 0x3af)"
[ "$C369" = '"result":"0x171"' ] || restore "rpc/evm/369 returned $C369 (want 0x171)"

# Proving keys must serve with CORS (skip if the mirror dir hasn't been populated yet).
if [ -f /opt/msgboard/deploy/caddy/graphiql/proving-keys/wordle_clue.wasm ]; then
  PKH=$(curl -sSI -m 15 -H 'Origin: http://localhost:4188' https://games.msgboard.xyz/proving-keys/wordle_clue.wasm || echo fail)
  PKC=$(printf '%s' "$PKH" | head -1 | grep -o '[0-9][0-9][0-9]' | head -1)
  echo "proving-keys probe: $PKC"
  [ "$PKC" = "200" ] || restore "proving-keys route returned $PKC"
  printf '%s' "$PKH" | grep -qi '^access-control-allow-origin' || restore "proving-keys route missing CORS header"
fi
echo "ok: games.msgboard.xyz/games-indexer/* -> games-indexer-943:42069 ; /rpc/evm/{943,369} -> one.valve.city (key server-side)"
