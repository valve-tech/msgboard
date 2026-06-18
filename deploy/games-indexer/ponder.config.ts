import { createConfig } from 'ponder'
import { http } from 'viem'
// `as const` abis (abis.ts) so Ponder derives the event-name types and the registry is populated —
// a generic `as Abi` cast erases the events and `ponder.on('CoinFlip:Entered')` fails at runtime.
import { coinFlipAbi, raffleAbi } from './abis'

// Vendored, self-contained snapshot (mirrors deploy/random-indexer): the CoinFlip + Raffle ABIs are
// bundled in ./abis so the image builds with no workspace deps. Source of truth for the indexer logic
// is gibsfinance/random examples/games/indexer (@gibs/games-indexer); keep them in sync.
const COIN_FLIP = '0x8d3a58d77d22636026066200f8868cd653ec2b2a'
const RAFFLE = '0x33f506fafe4f05c8de9a07e1c8a7f73f50f1da36'
const START_BLOCK = 24_645_214

export default createConfig({
  networks: {
    pulsechainV4: {
      chainId: 943,
      transport: http(process.env.PONDER_RPC_URL_943),
    },
  },
  contracts: {
    CoinFlip: {
      network: 'pulsechainV4',
      abi: coinFlipAbi,
      address: COIN_FLIP,
      startBlock: START_BLOCK,
    },
    Raffle: {
      network: 'pulsechainV4',
      abi: raffleAbi,
      address: RAFFLE,
      startBlock: START_BLOCK,
    },
  },
})
