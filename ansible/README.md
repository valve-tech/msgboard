# Deploy runbook (Ansible)

Idempotent deploys, run from your machine. **Both apps deploy to the SAME box** — the msgboard prod box
(`88.99.62.98`) — reflecting reality: `/opt/msgboard` there is a NON-git snapshot, the live Caddyfile is
hand-maintained on the box, and nwaku is **co-located** on the box's `edge` network (not a separate box).

- **`deploy-cosign.yml`** → the cosign UI (`cosign.msgboard.xyz`): rsync the `cosign-web` source into
  the snapshot, register the workspace, add the service via `docker-compose.cosign.yml`, build + start,
  then add the Caddy route with a **safe reload** (backup → `caddy adapt` → reload → **body + regression
  smoke** → block/rescue auto-rollback).
- **`deploy-waku.yml`** → the **nwaku WSS node** (`waku.msgboard.xyz`) co-located on the box, on the
  `edge` network, route in the shared Caddyfile; persistent nodekey; standalone cluster-0 (no RLN).

> **Caddy reload caveat (handled):** on this box `caddy reload` does NOT reliably apply a *new* host
> block (it serves an empty 200). Both plays probe the result and **restart Caddy** if the reload didn't
> take (all sites are behind Cloudflare, which rides the ~1-3s blip), then re-smoke.

## Prerequisites

1. **Box:** docker + docker-compose-v2 (already present); SSH is **root via the 1Password key
   `msgboard_faucet_box`** — run with `SSH_AUTH_SOCK` pointed at the 1P agent and `-i <that key's pubkey>`
   + `IdentitiesOnly` in the inventory (see inventory.example.ini). Approve the 1P prompt once
   (ControlPersist reuses the connection).
2. **Cloudflare (DNS, done):** `cosign.msgboard.xyz` and `waku.msgboard.xyz` → the box, **proxied
   (orange)**; the box's Caddy serves the `*.msgboard.xyz` origin cert. No Let's Encrypt, IP never in
   public DNS.

## Setup

```bash
cd ansible
cp inventory.example.ini inventory.ini    # set the msgboard_faucet_box pubkey path
# no vault needed for these plays (nwaku's nodekey is generated + kept on the box); a dummy pass avoids
# ansible.cfg's vault_password_file erroring:
printf x > .vault_pass
export SSH_AUTH_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
```

`inventory.ini`, `.vault_pass`, and `group_vars/all/vault.yml` are gitignored.

## Run

```bash
ansible-playbook deploy-cosign.yml     # cosign UI (cosign.msgboard.xyz)
ansible-playbook deploy-waku.yml       # nwaku WSS node (waku.msgboard.xyz)
ansible-playbook site.yml              # both
```

`deploy-waku.yml` prints the node info at the end; read the **peer id** from it — friends dial
`/dns4/waku.msgboard.xyz/tcp/443/wss/p2p/<PEER_ID>` with js-waku `networkConfig {clusterId:0, shards:[0]}`.

## Notes

- **Safety:** the Caddy change is wrapped in `block`/`rescue` — if `caddy adapt`, the reload/restart, or
  the smoke fails, it restores the timestamped backup, restarts Caddy, and fails the run.
- **Body-aware smoke:** cosign asserts `200` **and** a non-empty body (a status-only check passes on the
  empty-200 the reload quirk produces); waku asserts the `101` WSS handshake. Both then re-check
  `msgboard.xyz` (regression).
- **Not yet automated:** the Waku→MsgBoard relay mirror (stage-2) — the exposed node works without it;
  its js-waku may need the standalone `networkConfig` added in `createWakuSource` (see the ops README).
- This dir is under the repo (not the gitignored `deploy/`) so the runbook is version-controlled; only
  the secrets/inventory are ignored.
