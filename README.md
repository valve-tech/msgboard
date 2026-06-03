# MsgBoard

A censorship-resistant communication network on PulseChain, gated by proof of work.

## Packages

| Package | Description |
|---------|-------------|
| `packages/client` | Core library — PoW engine, RPC client, message types. Published as `@pulsechain/msgboard` |
| `packages/ui` | Svelte 5 + Vite frontend at [msgboard.xyz](https://www.msgboard.xyz) |
| `packages/sponsor` | Gas faucet service — monitors bridge events and sponsors new users |
| `packages/hardhat` | Hardhat plugin for local development and testing |

## Getting Started

```sh
npm install
npm run build
npm run test
```

### Run the UI locally

```sh
npm run ui:dev
```

### Run the sponsor service

Requires PostgreSQL — start it with Docker:

```sh
docker compose up msgboard-postgres
```

Then:

```sh
npm run sponsor:start
```

## Deployment

Production deploys to the Hetzner box via Ansible. See
[`deploy/ansible/README.md`](deploy/ansible/README.md) for the runbook.

## Client Library

```sh
npm i @pulsechain/msgboard
```

```ts
import * as msgboard from '@pulsechain/msgboard'
import { createPublicClient, http } from 'viem'
import { pulsechainV4 } from 'viem/chains'

const provider = createPublicClient({
  chain: pulsechainV4,
  transport: http(),
})

const client = new msgboard.MsgBoardClient(provider)

const work = await client.doPoW('hello', 'world')
await client.addMessage(work)
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MNEMONIC` | Sponsor only | Mnemonic for the gas sponsorship wallet |
| `DATABASE_URL` | Sponsor only | PostgreSQL connection string |
| `VITE_RPC_943` | Build time | RPC URL for PulseChain V4 testnet |
| `VITE_RPC_369` | Build time | RPC URL for PulseChain mainnet |
| `RPC_943` | Sponsor only | RPC URL override for testnet |
| `RPC_369` | Sponsor only | RPC URL override for mainnet |
| `DISABLED_CHAINS` | Optional | Comma-separated chain IDs to skip (e.g. `369`) |
| `FAKE_TRANSFERS` | Optional | Set to skip actual gas transfers (dry run) |
| `WEB3_PROVIDER` | Faucet only | JSON-RPC endpoint the faucet sends from |
| `FAUCET_PRIVATE_KEY` | Faucet only | Private key of the faucet sender wallet (maps to the faucet's `PRIVATE_KEY`) |
| `PAYOUT` | Faucet only | Amount paid out per faucet request |
| `PROXY_COUNT` | Faucet only | Reverse proxies in front of the faucet (set to `1` behind Caddy) |
| `POSTGRES_PASSWORD` | Deployment | PostgreSQL password shared by the database and sponsor |

Production deployment variables are supplied through Ansible Vault — see
[`deploy/ansible/README.md`](deploy/ansible/README.md).
