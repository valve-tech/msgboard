# Waku box deploy — nwaku exposed over WSS (+ optional MsgBoard relay)

Stands up an **nwaku node reachable over secure WebSocket** so browser / js-waku light clients
("friends") can connect, on the dedicated waku box **88.99.62.98**. The Waku→MsgBoard mirror is an
opt-in second stage.

It runs a **standalone network** — `--cluster-id=0` (the main Waku Network is cluster 1), so there is
**no RLN membership** requirement. Friends + the relay just share cluster 0 and the same content topic.

## DNS + TLS (do this first) — behind Cloudflare, no Let's Encrypt

The IP is **never exposed in public DNS**: the record stays **proxied through Cloudflare** and Caddy
serves the Cloudflare **`*.msgboard.xyz` origin cert** (the same one the msgboard box uses) — no ACME,
no grey-cloud, no public-facing IP.

1. Create **one** A record:

   | name | type | value | proxy |
   | --- | --- | --- | --- |
   | `waku.msgboard.xyz` | A | `88.99.62.98` | **Proxied (orange cloud)** |

2. Cloudflare SSL/TLS mode → **Full (strict)**. WebSockets are proxied by default.
3. Copy the Cloudflare origin cert pair onto the box, into THIS directory (gitignored, never committed):
   `packages/waku-relay/ops/origin.pem` and `origin.key` (the same `*.msgboard.xyz` pair from the
   msgboard box's `deploy/caddy/`).
4. Only **:443** needs to be reachable — ideally firewall it to Cloudflare's IP ranges only, so the box
   answers nothing but Cloudflare.

> The separate `cosign.msgboard.xyz` record (for the cosign UI) points at the **msgboard** box
> `88.99.192.187`, proxied like the other `*.msgboard.xyz` records — see the repo root deploy.

## Bring up the exposed node

```bash
# on 88.99.62.98, in this directory (packages/waku-relay/ops)
cp .env.example .env
openssl rand -hex 32          # paste into WAKU_NODEKEY in .env (generate ONCE; keep it stable)
cp /path/to/origin.pem ./origin.pem && cp /path/to/origin.key ./origin.key   # the *.msgboard.xyz pair

# pin the image first: replace `wakuorg/nwaku:latest` in docker-compose.yml with a real release tag
# (check https://hub.docker.com/r/wakuorg/nwaku/tags), then:
docker compose up -d nwaku caddy
docker compose logs -f nwaku        # wait for it to report its listening/announced multiaddrs
```

## Get the multiaddr friends dial

From the nwaku logs (or `curl -s http://127.0.0.1:8645/debug/v1/info` via the REST API), read the node's
**peer id**. Friends connect their js-waku light node to:

```
/dns4/waku.msgboard.xyz/tcp/443/wss/p2p/<PEER_ID>
```

Friend-side js-waku must use the **same standalone network** — create the light node with
`networkConfig: { clusterId: 0, shards: [0] }`, the bootstrap peer above, and the shared content topic
`/msgboard-relay/1/lobby/proto` (app name `msgboard-relay`, channel `lobby`). ⚠ Verify the
clusterId/shard pairing against your installed `@waku/sdk` version — the sharding API has changed across
releases; this is the one bit to confirm interactively when the first friend connects.

## Smoke test the WSS endpoint

```bash
# TLS + WebSocket upgrade reachable (expect HTTP/1.1 101 Switching Protocols or a 400 from nwaku,
# NOT a connection failure / cert error):
curl -sS -i -N -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://waku.msgboard.xyz/ | head -5
```

## (Stage 2) Enable the MsgBoard relay

The relay subscribes to the content topic on this node and re-posts every message to MsgBoard
(PoW-stamped, off-thread). It needs the peer id from above:

```bash
# in .env, set the internal dial (plain ws over the compose network):
#   WAKU_BOOTSTRAP=/dns4/nwaku/tcp/8001/ws/p2p/<PEER_ID>
# and confirm MSGBOARD_RPC_URL / RELAY_CHANNELS.
docker compose --profile relay up -d relay
docker compose logs -f relay     # expect "subscribed" then "relayed" per message
```

⚠ The relay's js-waku light node currently joins via `bootstrap` only; for the standalone cluster it may
need the same `networkConfig: { clusterId: 0, shards: [0] }` added in
`packages/waku-relay/src/waku.ts` (`createWakuSource`). If the relay connects but never sees messages,
that's the first thing to add. The exposed node (above) works independently of the relay.

## Notes / what to verify on-box

- **Pin the nwaku image** to a real release tag (don't ship `:latest` in prod).
- **`--ext-multiaddr-only`** makes nwaku advertise only the WSS address; the internal relay still dials
  `nwaku:8001` directly over the compose network, so that's fine.
- **PoW throughput** caps the relay: each MsgBoard post is a stamp (~1–2s native, much slower pure-JS).
  Don't point it at a high-volume topic without measuring `msgboard_status` difficulty first.
- **Cloudflare WS idle timeout** (~100s on lower plans) closes quiet WebSockets; libp2p's own keepalive
  pings normally keep them open — watch for unexpected drops if a connection sits fully idle.
- Keep `.env`, `origin.pem`, `origin.key` (and the nodekey) off git — the ops/.gitignore covers them.
