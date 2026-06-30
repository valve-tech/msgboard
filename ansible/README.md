# Deploy runbook (Ansible)

Idempotent deploys for the two apps, run from your machine (which has SSH to the boxes):

- **`deploy-cosign.yml`** → the cosign UI on the **msgboard** box, with a **safe Caddy reload**
  (backup → add the `cosign.msgboard.xyz` block → `caddy adapt` → reload → positive **and** negative
  smoke → **auto-rollback** on any failure; encodes the valve-caddy-config discipline).
- **`deploy-waku.yml`** → the **nwaku WSS node** (+ optional MsgBoard relay) on the **waku** box
  (`88.99.62.98`), behind Cloudflare with **no Let's Encrypt** and **no exposed IP**.

## Manual prerequisites (yours — dashboard / secrets / box)

These can't be automated from here and gate the deploy:

1. **Boxes:** docker + docker-compose-v2 installed; each box can `git clone` this repo (deploy key or
   forwarded agent); your SSH user can run docker (or use `become`).
2. **Cloudflare — cosign:** DNS `cosign.msgboard.xyz` → the msgboard box, **proxied (orange)**.
3. **Cloudflare — waku (tunnel edge, recommended):** Zero Trust → Networks → Tunnels → create a tunnel;
   add a Public Hostname `waku.msgboard.xyz` → **HTTP** → `caddy:80`; copy the tunnel **token**.
   (For the `caddy` edge instead: proxied A record `waku.msgboard.xyz` → `88.99.62.98`, SSL **Full
   (strict)**, and point `origin_cert_src`/`origin_key_src` at your `*.msgboard.xyz` cert pair.)

## Setup

```bash
cd ansible
cp inventory.example.ini inventory.ini            # fill in hosts/users/keys (msgboard box IP too)
cp group_vars/all/vault.example.yml group_vars/all/vault.yml
# edit vault.yml: WAKU_NODEKEY (openssl rand -hex 32) + the Cloudflare tunnel token
ansible-vault encrypt group_vars/all/vault.yml
echo 'your-vault-password' > .vault_pass && chmod 600 .vault_pass
# review group_vars/waku/main.yml — PIN nwaku_image to a real tag, set waku_edge (tunnel|caddy)
```

`inventory.ini`, `.vault_pass`, and `group_vars/all/vault.yml` are gitignored.

## Run

```bash
ansible-playbook deploy-cosign.yml                 # cosign UI + safe Caddy reload
ansible-playbook deploy-waku.yml                   # nwaku node (exposed); relay off
ansible-playbook deploy-waku.yml -e waku_relay_enabled=true   # also start the MsgBoard mirror
ansible-playbook site.yml                          # both
```

`deploy-waku.yml` prints the node info at the end; read the **peer id** from it — friends dial
`/dns4/waku.msgboard.xyz/tcp/443/wss/p2p/<PEER_ID>` with js-waku `networkConfig {clusterId:0, shards:[0]}`.

## Notes

- **Safety:** the cosign play wraps the Caddy change in `block`/`rescue` — if `caddy adapt`, the reload,
  or the positive/negative smoke fails, it restores the timestamped backup and reloads, then fails the
  run. The negative smoke guards against the empty-body-500 matcher bug from the 2026-05-19 incident.
- **Relay stage-2:** enabling the relay needs the node's peer id in `WAKU_BOOTSTRAP`
  (`/dns4/nwaku/tcp/8001/ws/p2p/<PEER_ID>`) — set `-e waku_bootstrap=...` once you've read it, and note
  the relay's js-waku may need the standalone `networkConfig` added in `createWakuSource` (see the ops
  README). The exposed node works without the relay.
- This dir is under the repo (not the gitignored `deploy/`) so the runbook is version-controlled; only
  the secrets/inventory are ignored.
