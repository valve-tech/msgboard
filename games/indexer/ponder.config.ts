import { createConfig } from 'ponder'
import { http, type Abi } from 'viem'
// The CoinFlip/Raffle ABIs come from games-core (it resolves the @gibs/random artifacts reliably).
import { coinFlipAbi, raffleAbi } from '@msgboard/games-core'
import { PETITION_SIGNATURES_ABI } from '@msgboard/petition'
// SudokuLog isn't re-exported by games-core, so its ABI comes straight from the compiled artifact —
// same source games-core uses for CoinFlip/Raffle (`Artifact.abi as viem.Abi`).
import SudokuLogArtifact from '../contracts/artifacts/contracts/games/SudokuLog.sol/SudokuLog.json'
import FlipBookArtifact from '../contracts/artifacts/contracts/games/FlipBook.sol/FlipBook.json'

const sudokuLogAbi = SudokuLogArtifact.abi as Abi
const flipBookAbi = FlipBookArtifact.abi as Abi

// The CoinFlip + Raffle game contracts, pinned per chain (deployed by the gate runs, not ignition —
// examples/games/e2e/scripts/{943,369}-deployment.json). startBlock matches the web config's
// deployBlock on each chain, so the indexer and the browser fallback count from the same origin.
const COIN_FLIP_943 = '0x8d3a58d77d22636026066200f8868cd653ec2b2a'
const RAFFLE_943 = '0x33f506fafe4f05c8de9a07e1c8a7f73f50f1da36'
const START_BLOCK_943 = 24_645_214
const COIN_FLIP_369 = '0x66bdacfdd918f9d4c29f0a7d26609912ab478f4d'
const RAFFLE_369 = '0x004564d44E6921FFA68936F44ae58988Cd146b10'
const START_BLOCK_369 = 26_757_758

// FlipBook — the P2P guessing-game coin flip offer book (matching pennies). Deployed 2026-07-20 on
// both chains; startBlock pinned via eth_getCode binary search (matches web flipBookDeployBlock).
const FLIP_BOOK_943 = '0xb009bd8b849dd33d9c5081ec6e53f29a947f6832'
const FLIP_BOOK_369 = '0x603e32ddaf5f4b6ada77e04bb7c44c4603f59eee'
const FLIP_BOOK_START_943 = 24_921_235
const FLIP_BOOK_START_369 = 27_080_922

// The ZK-Sudoku on-chain leaderboard (SudokuLog) is deployed on both PulseChain testnet v4 (943) and
// PulseChain mainnet (369). Addresses are pinned per network; startBlock is the exact SudokuLog
// deploy block on each chain, found via an eth_getCode binary search (first block with contract code).
const SUDOKU_LOG_943 = '0xf700e0c1fd235719738cca1cdef6f41bfaef163c'
const SUDOKU_LOG_369 = '0x939cbb0f10b5f9e76861a179fbe666e1cae50ba7'
const SUDOKU_START_BLOCK_943 = 24_898_763
const SUDOKU_START_BLOCK_369 = 27_063_003

// PetitionSignatures — unlike the contracts above, this one is NOT deployed yet
// (`@msgboard/petition`'s `deployments` map is still `{}`), so there's no address to pin at build
// time. Addresses + start blocks are read from env instead, and filled in post-deploy by whoever runs
// this indexer. Only build a per-chain network entry when its address env var is actually set, so
// `ponder codegen`/`tsc` succeed with no env at all — the indexer simply doesn't index petitions until
// then, rather than pointing at a bogus placeholder address.
const PETITION_ADDR_943 = process.env.PETITION_ADDR_943
const PETITION_START_943 = process.env.PETITION_START_943
const PETITION_ADDR_369 = process.env.PETITION_ADDR_369
const PETITION_START_369 = process.env.PETITION_START_369

// Parses a required startBlock env var for a chain whose address IS set. Fails loud rather than
// defaulting to 0 — a missing/invalid startBlock would otherwise make Ponder backfill that chain from
// genesis, which is a serious operational footgun on PulseChain (not a quiet degrade).
function requireStartBlock(addrVarName: string, startVarName: string, value: string | undefined): number {
  const n = value ? Number(value) : Number.NaN
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `${addrVarName} is set but ${startVarName} is missing/invalid — refusing to backfill from genesis`,
    )
  }
  return n
}

const petitionNetwork: Record<string, { address: `0x${string}`; startBlock: number }> = {}
if (PETITION_ADDR_943) {
  petitionNetwork.pulsechainV4 = {
    address: PETITION_ADDR_943 as `0x${string}`,
    startBlock: requireStartBlock('PETITION_ADDR_943', 'PETITION_START_943', PETITION_START_943),
  }
}
if (PETITION_ADDR_369) {
  petitionNetwork.pulsechain = {
    address: PETITION_ADDR_369 as `0x${string}`,
    startBlock: requireStartBlock('PETITION_ADDR_369', 'PETITION_START_369', PETITION_START_369),
  }
}

export default createConfig({
  networks: {
    pulsechainV4: {
      chainId: 943,
      transport: http(process.env.PONDER_RPC_URL_943),
    },
    pulsechain: {
      chainId: 369,
      transport: http(process.env.PONDER_RPC_URL_369),
    },
  },
  contracts: {
    CoinFlip: {
      abi: coinFlipAbi,
      network: {
        pulsechainV4: { address: COIN_FLIP_943, startBlock: START_BLOCK_943 },
        pulsechain: { address: COIN_FLIP_369, startBlock: START_BLOCK_369 },
      },
    },
    Raffle: {
      abi: raffleAbi,
      network: {
        pulsechainV4: { address: RAFFLE_943, startBlock: START_BLOCK_943 },
        pulsechain: { address: RAFFLE_369, startBlock: START_BLOCK_369 },
      },
    },
    FlipBook: {
      abi: flipBookAbi,
      network: {
        pulsechainV4: { address: FLIP_BOOK_943, startBlock: FLIP_BOOK_START_943 },
        pulsechain: { address: FLIP_BOOK_369, startBlock: FLIP_BOOK_START_369 },
      },
    },
    // Multi-network contract: the same SudokuLog leaderboard indexed on both chains. The per-network
    // object overrides address + startBlock; handlers read `context.network.chainId` to tag rows.
    SudokuLog: {
      abi: sudokuLogAbi,
      network: {
        pulsechainV4: {
          address: SUDOKU_LOG_943,
          startBlock: SUDOKU_START_BLOCK_943,
        },
        pulsechain: {
          address: SUDOKU_LOG_369,
          startBlock: SUDOKU_START_BLOCK_369,
        },
      },
    },
    // Registered only when at least one PETITION_ADDR_{943,369} env var is set (see petitionNetwork
    // above) — pre-deploy, this contract simply isn't part of the config.
    ...(Object.keys(petitionNetwork).length > 0
      ? {
          PetitionSignatures: {
            abi: PETITION_SIGNATURES_ABI,
            network: petitionNetwork,
          },
        }
      : {}),
  },
})
