import * as viem from 'viem'
import type { GamesChainId } from '@msgboard/games-core'

/** A chain the app can play on: the game deployments plus the canonical validator subset. */
export type GameDeployment = {
  chainId: GamesChainId
  label: string
  coinFlip: viem.Hex
  raffle: viem.Hex
  random: viem.Hex
  /** The recommended subset fed to makePresets — the spec's liquidity nudge, not a whitelist. */
  canonicalSubset: viem.Hex[]
  /** Per-provider BASE pool offsets; pools chain at base + n*poolSize (model/pools.ts). */
  poolOffsets: Record<string, string>
  /** Preimages per pool — the rotation modulus shared with the off-chain actors. */
  poolSize: number
  /** Scan events from here (the deploy block) to keep live-chain scans cheap. */
  deployBlock: string
  /** Override the read RPC (e.g. the valve.city fleet endpoint); defaults to the core registry's. */
  rpc?: string
  explorer?: string
  /** MsgBoard archive (GraphiQL) base URL — the venue's coordination-notice trail. */
  archive?: string
  /** RPC whose node runs the `msgboard_` module (valve.city) — used to read the live session-game
   *  feed (and, later, to broadcast play). Reads need no proof-of-work; the demo key is fine. */
  boardRpc?: string
  /** GraphQL URL of the games Ponder indexer (@msgboard/games-indexer). When set, the frontend reads
   *  rounds from it instead of scraping eth_getLogs. Unset → incremental/chunked getLogs fallback. */
  gamesIndexer?: string
  /** Chips ERC-20 token address — the currency used by the session-game escrow. */
  chips?: viem.Hex
  /** HouseChannel contract address — the EIP-712 `verifyingContract` for session-state co-signatures.
   *  Sessions use `makeDomain(chainId, houseChannel)` so co-signed states bind to the on-chain
   *  settlement contract (the player's worst case is always "reclaim my stake" via disputeFromOpen). */
  houseChannel?: viem.Hex
  /** SudokuLog contract — the ZK skill-game leaderboard (append-only best-time log per puzzle). */
  sudokuLog?: viem.Hex
  /** SudokuRules contract — the on-chain Sudoku validity/scoring rules the leaderboard defers to. */
  sudokuRules?: viem.Hex
  /** PLONK verifier for the Sudoku solve proof (proves a valid solution without revealing it). */
  sudokuSolveVerifier?: viem.Hex
  /** WordleLog contract — the non-wagered "play with friends" ZK-Wordle record (challenge + solve
   *  leaderboard by guesses-used; no Chips, no house, no escrow — the retired wager was SkillSettle). */
  wordleLog?: viem.Hex
  /** WordleRules contract — the on-chain Wordle validity/scoring rules (Chips-chain only). */
  wordleRules?: viem.Hex
  /** PLONK verifier for the Wordle clue proof (proves the per-guess colouring is honest). */
  wordleClueVerifier?: viem.Hex
  /** PLONK verifier for the Wordle solve proof (proves knowledge of the secret word). */
  wordleSolveVerifier?: viem.Hex
  /** Scan skill-game events from here (the skill contracts' deploy block) to keep scans cheap. */
  skillDeployBlock?: string
  /** FlipBook contract — the P2P guessing-game coinflip offer book (matching pennies; no house,
   *  no validators — see examples/games/P2P_COINFLIP_DESIGN.md). Native-PLS stakes. */
  flipBook?: viem.Hex
  /** Scan FlipBook offer events from here (its deploy block) to keep scans cheap. */
  flipBookDeployBlock?: string
  /** FlipBookX — VARIANT B of the P2P coin flip: fully off-chain signed offers (EIP-3009/7598
   *  receiveWithAuthorization over the x402PLS wrapper), hidden guesses both sides, two-phase
   *  reveal. Offers cost nothing to post; funds move only on take. */
  flipBookX?: viem.Hex
  /** Scan FlipBookX events from here (its deploy block). */
  flipBookXDeployBlock?: string
  /** The x402PLS wrapper (EIP-3009+7598 wrapped native PLS; valve's canonical deployment). */
  x402Pls?: viem.Hex
  /** The Provex-controlled EAS instance (EAS has no canonical PulseChain deployment; @provex/eas). */
  eas?: viem.Hex
  /** Proof-gated EAS resolver for sudoku_solve attestations (contracts/eas/SudokuSolveResolver.sol). */
  sudokuSolveResolver?: viem.Hex
  /** The registered sudoku-solve schema UID on THIS chain's SchemaRegistry (revocable=false). */
  sudokuSchemaUid?: viem.Hex
  /** Proof-gated EAS resolver for wordle_solve attestations (contracts/eas/WordleSolveResolver.sol). */
  wordleSolveResolver?: viem.Hex
  /** The registered wordle-solve schema UID on THIS chain's SchemaRegistry (revocable=false). */
  wordleSchemaUid?: viem.Hex
}

/**
 * The local deployment is written by `pnpm dev:seed` (scripts/dev-local.ts) into
 * src/generated/local.json — absent until the harness runs, hence the guarded glob import.
 */
const generated = import.meta.glob('./generated/local.json', { eager: true }) as Record<
  string,
  { default: Omit<GameDeployment, 'label'> }
>
const local = Object.values(generated)[0]?.default

export const deployments: GameDeployment[] = [
  ...(local ? [{ ...local, label: 'Local (anvil)' }] : []),
  // Deployed by the 2026-06-10 live parity-gate run + ink-pools (e2e/scripts/943-deployment.json).
  {
    chainId: 943,
    label: 'PulseChain testnet v4',
    coinFlip: '0x8d3a58d77d22636026066200f8868cd653ec2b2a',
    raffle: '0x33f506fafe4f05c8de9a07e1c8a7f73f50f1da36',
    random: '0x775AF72d62c85d2F7f0Bcc05BAa4Be0830087217',
    // Read 943 through the domain-scoped games.msgboard.xyz/rpc proxy: Caddy on the box rewrites to
    // our valve.city node with the REAL key server-side, so the bundle no longer ships the shared
    // vk_demo demo key (which was getting rate-limited into 429s).
    rpc: 'https://games.msgboard.xyz/rpc/evm/943',
    canonicalSubset: [
      '0xAe96b0748f933914867d59486251043790cB2896',
      '0x2a638D7135966a5cA1973c930bD0317cd7d6874c',
      '0x0D3148A85608708Fe944EE71E13B4C9181b7cc83',
    ],
    poolOffsets: {
      '0xae96b0748f933914867d59486251043790cb2896': '34',
      '0x2a638d7135966a5ca1973c930bd0317cd7d6874c': '34',
      '0x0d3148a85608708fe944ee71e13b4c9181b7cc83': '18',
    },
    deployBlock: '24645214',
    poolSize: 64,
    explorer: 'https://scan.v4.testnet.pulsechain.com/#',
    archive: 'https://archive.msgboard.xyz',
    boardRpc: 'https://games.msgboard.xyz/rpc/evm/943',
    // Ponder indexer (deploy/games-indexer on the msgboard box) — CoinFlip+Raffle logs served as
    // GraphQL under the already-resolving games host, so the lobby/round views read from one indexed
    // query per poll instead of scanning the chain (was hammering the RPC into 429s). Full GraphQL URL.
    gamesIndexer: 'https://games.msgboard.xyz/games-indexer/graphql',
    // Chips ERC-20 token (deployed 2026-06-10 gate run).
    chips: '0xA5276259e544C86438566cB28cc87daCce060910',
    // patched HouseChannel (gameId-binding + disputeFromOpen + gameId-in-Opened), deployed 943 @ block 24708662
    houseChannel: '0x74bbc31e77c02593c0a7aad0cadadb5b6bff3948',
    // ZK skill games — full real-dictionary set (Sudoku leaderboard + Wordle over Chips escrow).
    sudokuLog: '0xf700e0c1fd235719738cca1cdef6f41bfaef163c',
    sudokuRules: '0x6f9045512ddd9d5a8db4c90377cb4eb052fd940f',
    sudokuSolveVerifier: '0x713885e0b207f617af1c5c8b9a9d2e65f331883f',
    wordleLog: '0xcd57eee1c31045d0d63153cf1d7c74a69402a8cb',
    wordleRules: '0x85b9e49a762b7ab7263205d120737f0daa8228c0',
    wordleClueVerifier: '0xa80c8388defd3de0d36b3146fc05a32a7f77fcdc',
    wordleSolveVerifier: '0x68550dd2163ced8676bdf5a920dafe09052808ca',
    // SudokuLog deploy block, pinned via getCode binary search (code first present @ 24898763).
    skillDeployBlock: '24898763',
    // P2P guessing-game coinflip offer book (deployed + all 4 paths exercised on-chain 2026-07-20).
    flipBook: '0xb009bd8b849dd33d9c5081ec6e53f29a947f6832',
    flipBookDeployBlock: '24921235',
    // Variant-B flip book over x402PLS (deployed + live-exercised 2026-07-21).
    flipBookX: '0x9e232e84E80FCaC3c78dE0820dABccf660511275',
    flipBookXDeployBlock: '24932217',
    x402Pls: '0xeb274050cb029288B8A4F232Da8d23F393d54A1E',
    // EAS leaderboard layer (deployed + schemas registered 2026-07-20; SolveResolvers.t.sol).
    eas: '0x9e84Aa4BD0C1931A34B14C1EC918A53C33e2B0F8',
    sudokuSolveResolver: '0x0e58f22a9fd1c7260d0add6eea809f49bf6fc75c',
    sudokuSchemaUid: '0x0de9a3bb2e72a1116f44d1a4a5e612d315143af9916e27572d073663e9877fc5',
    wordleSolveResolver: '0x603e32ddaf5f4b6ada77e04bb7c44c4603f59eee',
    wordleSchemaUid: '0x68880687b7c28fa1618ad4f612173b23aef8443fc5df354d2e6693f6df243f37',
  },
  // Deployed by the 2026-06-11 mainnet bring-up (gate run + ink-pools; e2e/scripts/369-deployment.json).
  // deployBlock = the web pools' ink block so the site and the cast watcher count heats
  // from the same origin (the gate's own bring-up games predate it on purpose).
  {
    chainId: 369,
    label: 'PulseChain',
    coinFlip: '0x66bdacfdd918f9d4c29f0a7d26609912ab478f4d',
    raffle: '0x004564d44E6921FFA68936F44ae58988Cd146b10',
    random: '0x87fc31413534733a09df5dc5aa33b4dba1f64b61',
    // Read mainnet through the domain-scoped keyed proxy (same reasoning as 943 above).
    rpc: 'https://games.msgboard.xyz/rpc/evm/369',
    canonicalSubset: [
      '0xAe96b0748f933914867d59486251043790cB2896',
      '0x2a638D7135966a5cA1973c930bD0317cd7d6874c',
      '0x0D3148A85608708Fe944EE71E13B4C9181b7cc83',
    ],
    poolOffsets: {
      '0xae96b0748f933914867d59486251043790cb2896': '4',
      '0x2a638d7135966a5ca1973c930bd0317cd7d6874c': '2',
      '0x0d3148a85608708fe944ee71e13b4c9181b7cc83': '2',
    },
    deployBlock: '26757758',
    poolSize: 64,
    explorer: 'https://scan.pulsechain.com/#',
    archive: 'https://archive.msgboard.xyz',
    boardRpc: 'https://games.msgboard.xyz/rpc/evm/369',
    // Same Ponder instance as 943 (it indexes both chains + the flipbook now); the frontend filters
    // by chainId + game. Kills the ~68-call getLogs first-load burst mainnet used to fire.
    gamesIndexer: 'https://games.msgboard.xyz/games-indexer/graphql',
    // ZK skill games — both live on mainnet, both non-wagered. Sudoku timed leaderboard (SudokuLog) +
    // Wordle "play with friends" (WordleLog: open a hidden-word challenge, friends submit ZK solve
    // proofs, ranked by guesses-used). No Chips/house/escrow.
    sudokuLog: '0x939cbb0f10b5f9e76861a179fbe666e1cae50ba7',
    sudokuRules: '0x76b357071bb2d0ede364365d3a4e2055ceb0ee02',
    sudokuSolveVerifier: '0xf700e0c1fd235719738cca1cdef6f41bfaef163c',
    wordleLog: '0x202255faa269a3d59ed45bd583539b9bd759b32b',
    wordleRules: '0xcd57eee1c31045d0d63153cf1d7c74a69402a8cb',
    wordleClueVerifier: '0x7ab56dc2921cf6de7552278237bb8b4c63e423e1',
    wordleSolveVerifier: '0x2cf3a381ae662a06e478491d73bf5d7fd4ebca0e',
    // Skill contracts' deploy block, pinned via getCode binary search (Sudoku code first present @ 27063003).
    skillDeployBlock: '27063003',
    // P2P guessing-game coinflip offer book (deployed + exercised on-chain 2026-07-20; Sourcify exact_match).
    flipBook: '0x603e32ddaf5f4b6ada77e04bb7c44c4603f59eee',
    flipBookDeployBlock: '27080922',
    // Variant-B flip book over x402PLS (deployed 2026-07-21; Sourcify exact_match).
    flipBookX: '0x28EfA8fA6c956C0b49f6Cdc6273b1eBe76382CD8',
    flipBookXDeployBlock: '27091482',
    x402Pls: '0xeb274050cb029288B8A4F232Da8d23F393d54A1E',
    // EAS leaderboard layer (deployed + schemas registered 2026-07-20; SolveResolvers.t.sol).
    eas: '0x9e84Aa4BD0C1931A34B14C1EC918A53C33e2B0F8',
    sudokuSolveResolver: '0x9e232e84e80fcac3c78de0820dabccf660511275',
    sudokuSchemaUid: '0x3a8ce1bd299f82fb7f25a88386fbf6320fa066db643f5bb995c67ec46b6a129e',
    wordleSolveResolver: '0x921bfc21e69c65ed295dbdb7ed69c8c5161b1b1f',
    wordleSchemaUid: '0xd827ebf0849a1328cb1527195b426db2a8c65a2e18102fd79cdb39fff358fde8',
  },
]
