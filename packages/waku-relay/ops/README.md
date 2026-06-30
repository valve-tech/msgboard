# Waku box deploy — nwaku exposed over WSS (+ optional MsgBoard relay)

Stands up an **nwaku node reachable over secure WebSocket** so browser / js-waku light clients
("friends") can connect, on the dedicated waku box **88.99.62.98**. The Waku→MsgBoard mirror is an
opt-in second stage.

It runs a **standalone network** — `--cluster-id=0` (the main Waku Network is cluster 1), so there is
**no RLN membership** requirement. Friends + the relay just share cluster 0 and the same content topic.

## DNS (do this first)

Create **one** A record:

| name | type | value | proxy |
| --- | --- | --- | --- |
| `waku.msgboard.xyz` | A | `88.99.62.98` | **DNS-only (grey cloud)** |

It must be **unproxied** so Caddy on this box can complete the Let's Encrypt ACME challenge and serve a
browser-trusted cert (the Cloudflare origin cert used by the msgboard box is **not** on this box). Ports
**80 and 443** must be open to the internet.

> The separate `cosign.msgboard.xyz` record (for the cosign UI) points at the **msgboard** box
> `88.99.192.187`, proxied like the other `*.msgboard.xyz` records — see the repo root deploy.

## Bring up the exposed node

```bash
# on 88.99.62.98, in this directory (packages/waku-relay/ops)
cp .env.example .env
openssl rand -hex 32          # paste into WAKU_NODEKEY in .env (generate ONCE; keep it stable)
# edit WAKU_DOMAIN / ACME_EMAIL if needed

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
- Keep `.env` (the nodekey especially) off git.
