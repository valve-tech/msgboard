import { createConfig } from 'ponder'
// `as const` abis (abis.ts) so Ponder derives the event-name types and the registry is populated —
// a generic `as Abi` cast erases the events and `ponder.on('CoinFlip:Entered')` fails at runtime.
import { coinFlipAbi, houseChannelAbi, raffleAbi } from './abis'

// Vendored, self-contained snapshot (mirrors deploy/random-indexer, which runs ponder 0.16): the
// CoinFlip + Raffle ABIs are bundled in ./abis so the image builds with no workspace deps. Source of
// truth for the indexer logic is gibsfinance/random examples/games/indexer (@gibs/games-indexer).
const COIN_FLIP = '0x8d3a58d77d22636026066200f8868cd653ec2b2a'
const RAFFLE = '0x33f506fafe4f05c8de9a07e1c8a7f73f50f1da36'
const START_BLOCK = 24_645_214

// ⚠️ pending: replace with the redeployed PATCHED HouseChannel address
// (gameId-binding + disputeFromOpen + gameId-in-Opened) before indexing real data.
const HOUSE_CHANNEL = '0x57876609E4fEDDEeB83e46A1b3A20140998f0e46'
// TODO: set to the redeployed HouseChannel block once the patched contract is live.
const HOUSE_CHANNEL_START_BLOCK = START_BLOCK

export default createConfig({
  ordering: 'omnichain',
  chains: {
    pulsechainV4: {
      id: 943,
      rpc: process.env.PONDER_RPC_URL_943,
    },
  },
  contracts: {
    CoinFlip: {
      chain: 'pulsechainV4',
      abi: coinFlipAbi,
      address: COIN_FLIP,
      startBlock: START_BLOCK,
    },
    Raffle: {
      chain: 'pulsechainV4',
      abi: raffleAbi,
      address: RAFFLE,
      startBlock: START_BLOCK,
    },
    HouseChannel: {
      chain: 'pulsechainV4',
      abi: houseChannelAbi,
      address: HOUSE_CHANNEL,
      startBlock: HOUSE_CHANNEL_START_BLOCK,
    },
  },
})
