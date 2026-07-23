import { createConfig } from 'ponder'
// `as const` abis (abis.ts) so Ponder derives the event-name types and the registry is populated —
// a generic `as Abi` cast erases the events and `ponder.on('CoinFlip:Entered')` fails at runtime.
import { SOLVE_SCHEMAS } from './schemas'
import { coinFlipAbi, easAbi, flipBookAbi, flipBookXAbi, houseChannelAbi, raffleAbi } from './abis'

// Vendored, self-contained snapshot (mirrors deploy/random-indexer, which runs ponder 0.16): the
// game ABIs are bundled in ./abis so the image builds with no workspace deps. Source of
// truth for the indexer logic is games/indexer in this repo (@msgboard/games-indexer).
//
// CoinFlip + Raffle are pinned per chain (deployed by the gate runs; startBlock matches the web
// config's deployBlock on each chain, so the indexer and the browser fallback count from the same
// origin). Indexing 369 exists to kill the browser's mainnet getLogs fallback, which was burning
// the shared vk_demo RPC key (~68 chunked calls per first page load).
const COIN_FLIP_943 = '0x8d3a58d77d22636026066200f8868cd653ec2b2a'
const RAFFLE_943 = '0x33f506fafe4f05c8de9a07e1c8a7f73f50f1da36'
const START_BLOCK_943 = 24_645_214
const COIN_FLIP_369 = '0x66bdacfdd918f9d4c29f0a7d26609912ab478f4d'
const RAFFLE_369 = '0x004564d44E6921FFA68936F44ae58988Cd146b10'
const START_BLOCK_369 = 26_757_758

// FlipBook — the P2P coin flip offer book, deployed 2026-07-20 on both chains; startBlock pinned
// via eth_getCode binary search (matches the web config's flipBookDeployBlock).
const FLIP_BOOK_943 = '0xb009bd8b849dd33d9c5081ec6e53f29a947f6832'
const FLIP_BOOK_369 = '0x603e32ddaf5f4b6ada77e04bb7c44c4603f59eee'
const FLIP_BOOK_START_943 = 24_921_235
const FLIP_BOOK_START_369 = 27_080_922

// FlipBookX — variant B (x402PLS-settled, off-chain offers). Deployed 2026-07-21.
const FLIP_BOOK_X_943 = '0x9e232e84E80FCaC3c78dE0820dABccf660511275'
const FLIP_BOOK_X_369 = '0x28EfA8fA6c956C0b49f6Cdc6273b1eBe76382CD8'
const FLIP_BOOK_X_START_943 = 24_932_217
const FLIP_BOOK_X_START_369 = 27_091_482

// EAS (the Provex instance, same address both chains) — the "facts rail": proof-gated solve
// attestations from the Sudoku/Wordle resolvers. Filtered to OUR schema UIDs (indexed topic), so
// unrelated Provex attestations never enter the store. UIDs are chain-specific; listing all four in
// one filter is safe — a 943 UID simply never fires on 369. startBlock = the FlipBook pin on each
// chain (2026-07-20, hours before the resolvers deployed) — nothing to miss before that.
const EAS = '0x9e84Aa4BD0C1931A34B14C1EC918A53C33e2B0F8'

// patched HouseChannel (gameId-binding + disputeFromOpen + gameId-in-Opened), deployed 943.
const HOUSE_CHANNEL = '0x74bbc31e77c02593c0a7aad0cadadb5b6bff3948'
// exact contract-creation block (binary-searched via eth_getCode).
const HOUSE_CHANNEL_START_BLOCK = 24_708_662

export default createConfig({
  ordering: 'omnichain',
  chains: {
    pulsechainV4: {
      id: 943,
      rpc: process.env.PONDER_RPC_URL_943,
    },
    pulsechain: {
      id: 369,
      rpc: process.env.PONDER_RPC_URL_369,
    },
  },
  contracts: {
    CoinFlip: {
      abi: coinFlipAbi,
      chain: {
        pulsechainV4: { address: COIN_FLIP_943, startBlock: START_BLOCK_943 },
        pulsechain: { address: COIN_FLIP_369, startBlock: START_BLOCK_369 },
      },
    },
    Raffle: {
      abi: raffleAbi,
      chain: {
        pulsechainV4: { address: RAFFLE_943, startBlock: START_BLOCK_943 },
        pulsechain: { address: RAFFLE_369, startBlock: START_BLOCK_369 },
      },
    },
    FlipBook: {
      abi: flipBookAbi,
      chain: {
        pulsechainV4: { address: FLIP_BOOK_943, startBlock: FLIP_BOOK_START_943 },
        pulsechain: { address: FLIP_BOOK_369, startBlock: FLIP_BOOK_START_369 },
      },
    },
    FlipBookX: {
      abi: flipBookXAbi,
      chain: {
        pulsechainV4: { address: FLIP_BOOK_X_943, startBlock: FLIP_BOOK_X_START_943 },
        pulsechain: { address: FLIP_BOOK_X_369, startBlock: FLIP_BOOK_X_START_369 },
      },
    },
    HouseChannel: {
      chain: 'pulsechainV4',
      abi: houseChannelAbi,
      address: HOUSE_CHANNEL,
      startBlock: HOUSE_CHANNEL_START_BLOCK,
    },
    EAS: {
      abi: easAbi,
      chain: {
        pulsechainV4: { address: EAS, startBlock: FLIP_BOOK_START_943 },
        pulsechain: { address: EAS, startBlock: FLIP_BOOK_START_369 },
      },
      filter: {
        event: 'Attested',
        args: { schemaUID: Object.keys(SOLVE_SCHEMAS) as `0x${string}`[] },
      },
    },
  },
})
