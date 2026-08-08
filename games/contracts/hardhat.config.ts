import { type HardhatUserConfig } from 'hardhat/config'
import '@solidstate/hardhat-4byte-uploader'
import { HARDHAT_NETWORK_MNEMONIC, defaultHdAccountsConfigParams } from 'hardhat/internal/core/config/default-config'
import '@nomicfoundation/hardhat-toolbox-viem'
import '@nomicfoundation/hardhat-viem'
import '@nomicfoundation/hardhat-chai-matchers'
import 'hardhat-tracer'
import 'solidity-coverage'
import 'hardhat-gas-reporter'
import 'hardhat-dependency-compiler'

Error.stackTraceLimit = Infinity

const { env } = process

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'cancun',
          optimizer: {
            enabled: true,
            runs: 1_000,
          },
        },
      },
    ],
    // CoinFlip deploys to PulseChain testnet v4 (chain 943), which is pre-Cancun: it supports
    // Shanghai opcodes (PUSH0) but rejects MCOPY/TSTORE. viaIR + cancun emits MCOPY, which
    // reverts on 943 as "invalid opcode: MCOPY". Target Shanghai so the deployed bytecode runs
    // there. (Core Random was compiled cancun but happens not to emit MCOPY in its live paths.)
    overrides: {
      // Generated UltraHonk verifiers: need solc >= 0.8.26 + viaIR:false (mirrors foundry zkverify).
      // DiceSettle is the per-game M2 verifier; TableSettle is the generic table-driven one that
      // collapses the whole pure-RNG family into a single verifier (games/zk-table-settle). Both
      // ~50KiB bytecode (over EIP-170) — deferred from HouseChannel wiring, but must still compile.
      'contracts/zk/generated/DiceSettleHonkVerifier.sol': {
        version: '0.8.27',
        settings: {
          viaIR: false,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      'contracts/zk/generated/TableSettleHonkVerifier.sol': {
        version: '0.8.27',
        settings: {
          viaIR: false,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      'contracts/CoinFlip.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      // CoinFlipTables deploys to 943 like the other games contracts — pin Shanghai so the emitted
      // bytecode has no MCOPY (943 is pre-Cancun and reverts on it as "invalid opcode: MCOPY").
      'contracts/games/CoinFlipTables.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/GameBase.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/Raffle.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/test/GameBaseHarness.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      // ZkTable family targets 943 like the other games contracts — Shanghai, no MCOPY.
      //
      // EIP-170 SIZE FIX (2026-08-08): every override below down through PetitionSignatures.sol
      // shares this exact settings shape (0.8.25 / viaIR:true / shanghai / runs) — they mirror
      // foundry.toml's [profile.default], per that file's header comment, and get compiled
      // together. HoldemTableN.sol grew to 25,203 deployed bytes (627 over EIP-170's 24,576
      // limit) after a full library-extraction pass (heavy dispute-machine logic already lives in
      // the external HoldemShowdownLib — see that file's header); further calldata-struct
      // externalization was proven net-negative. The only remaining lever was optimizer runs:
      // lowered 1000 -> 700 for the whole shanghai family (empirically the highest value that
      // gets HoldemTableN under the 24,300-byte safety-margin ceiling — see
      // test/foundry/HoldemTableNSize.t.sol / test/ZkTableSize.test.ts). Tradeoff: slightly less
      // inlining/aggressive optimization across this whole family = marginally higher gas on
      // hot repeat-call paths, in exchange for both HoldemTableN and ZkTable staying deployable.
      // Bump this back toward 1000 only alongside a fresh size-budget review of both contracts.
      'contracts/zk/ChannelState.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/zk/IGameRules.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/zk/ZkTable.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/zk/HiLoWarRules.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      // MCOPY FIX (2026-08-08): these deployed zk libs/contracts were missing a Shanghai override
      // and fell through to the default cancun block, which emits MCOPY — REVERTS on 943/369
      // (pre-Cancun) as "invalid opcode: MCOPY". HoldemShowdownLib was confirmed broken live
      // (postShowdownReveals delegatecall reverted on 943); HoldemRules had a latent MCOPY; the
      // ZkTable decode libs (DeckChallengeLib/DeckConstants/ShowdownDecodeLib) are deployed but were
      // never exercised on live 943 (HiLoWar hit disputes, not showdown-decode) — pinned defensively
      // so no deployed zk bytecode can ever carry MCOPY. Same settings shape as the family above.
      'contracts/zk/HoldemRules.sol': {
        version: '0.8.25',
        settings: { viaIR: true, evmVersion: 'shanghai', optimizer: { enabled: true, runs: 700 } },
      },
      'contracts/zk/HoldemShowdownLib.sol': {
        version: '0.8.25',
        settings: { viaIR: true, evmVersion: 'shanghai', optimizer: { enabled: true, runs: 700 } },
      },
      'contracts/zk/CardTableSecp.sol': {
        version: '0.8.25',
        settings: { viaIR: true, evmVersion: 'shanghai', optimizer: { enabled: true, runs: 700 } },
      },
      'contracts/zk/DeckChallengeLib.sol': {
        version: '0.8.25',
        settings: { viaIR: true, evmVersion: 'shanghai', optimizer: { enabled: true, runs: 700 } },
      },
      'contracts/zk/DeckConstants.sol': {
        version: '0.8.25',
        settings: { viaIR: true, evmVersion: 'shanghai', optimizer: { enabled: true, runs: 700 } },
      },
      'contracts/zk/ChannelTableBase.sol': {
        version: '0.8.25',
        settings: { viaIR: true, evmVersion: 'shanghai', optimizer: { enabled: true, runs: 700 } },
      },
      'contracts/zk/SignedIntentBase.sol': {
        version: '0.8.25',
        settings: { viaIR: true, evmVersion: 'shanghai', optimizer: { enabled: true, runs: 700 } },
      },
      'contracts/vendor/uzkge/ShowdownDecodeLib.sol': {
        version: '0.8.25',
        settings: { viaIR: true, evmVersion: 'shanghai', optimizer: { enabled: true, runs: 700 } },
      },
      'contracts/games/SessionState.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/games/Chips.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/games/HouseBankroll.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/games/HouseChannel.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      // ZK SKILL games (Sudoku timed leaderboard + Wordle house game) — deploy to 943/369 like the
      // other games contracts, so pin Shanghai (no MCOPY/TSTORE) to match foundry.toml and the
      // HouseChannel/Chips overrides. The current bytecode is MCOPY-free even under the cancun
      // default, but pinning keeps a later edit from silently emitting MCOPY that reverts on 943.
      'contracts/zk/generated/SudokuSolvePlonkVerifier.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/zk/generated/WordleCluePlonkVerifier.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/zk/generated/WordleSolvePlonkVerifier.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/zk/SudokuRules.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/zk/WordleRules.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/games/SkillPayouts.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/games/SudokuLog.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/games/WordleLog.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/games/SkillSettle.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/games/FlipBookX.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      // EAS solve resolvers — deploy to 943/369 like the games, so pin Shanghai (no MCOPY/TSTORE).
      'contracts/eas/SudokuSolveResolver.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/eas/WordleSolveResolver.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/test/SessionStateHarness.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/test/MockGameRules.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/test/MockRevealVerifier.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      // N-party Hold'em channel family — Shanghai like the ZkTable siblings.
      'contracts/zk/ChannelStateN.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/zk/IGameRulesN.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/zk/HoldemTableN.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      'contracts/test/MockGameRulesN.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      // Task 6: 5-of-7 hand evaluator, Solidity mirror of @msgboard/holdem handEval.ts. Shanghai
      // + viaIR like its ZkTable siblings (the 21-combo scan needs viaIR to avoid stack-too-deep).
      'contracts/zk/HoldemHandEval.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      // Test-only reentrancy probe in the ZkTable family — Shanghai like its siblings.
      'contracts/test/ReenteringReceiver.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
      // ShuffleVerifier52 wraps the vendored verifier — must share its compiler settings so
      // the function-pointer type for _verifyKey resolves identically across the call boundary.
      'contracts/zk/ShuffleVerifier52.sol': {
        version: '0.8.25',
        settings: {
          viaIR: false,
          evmVersion: 'shanghai',
          optimizer: { enabled: true, runs: 200 },
        },
      },
      // uzkge vendored verifiers — viaIR:false reproduces spike-measured gas and avoids
      // slow viaIR compile of the ~100KB PlonkVerifier; runs:200 matches spike gas measurements
      // (repo default elsewhere is 1_000).
      'contracts/vendor/uzkge/shuffle/ShuffleVerifier.sol': {
        version: '0.8.25',
        settings: {
          viaIR: false,
          evmVersion: 'shanghai',
          optimizer: { enabled: true, runs: 200 },
        },
      },
      'contracts/vendor/uzkge/shuffle/ExternalTranscript.sol': {
        version: '0.8.25',
        settings: {
          viaIR: false,
          evmVersion: 'shanghai',
          optimizer: { enabled: true, runs: 200 },
        },
      },
      'contracts/vendor/uzkge/shuffle/VerifierKey_20.sol': {
        version: '0.8.25',
        settings: {
          viaIR: false,
          evmVersion: 'shanghai',
          optimizer: { enabled: true, runs: 200 },
        },
      },
      'contracts/vendor/uzkge/shuffle/VerifierKey_52.sol': {
        version: '0.8.25',
        settings: {
          viaIR: false,
          evmVersion: 'shanghai',
          optimizer: { enabled: true, runs: 200 },
        },
      },
      'contracts/vendor/uzkge/shuffle/VerifierKeyExtra1_52.sol': {
        version: '0.8.25',
        settings: {
          viaIR: false,
          evmVersion: 'shanghai',
          optimizer: { enabled: true, runs: 200 },
        },
      },
      'contracts/vendor/uzkge/shuffle/VerifierKeyExtra2_52.sol': {
        version: '0.8.25',
        settings: {
          viaIR: false,
          evmVersion: 'shanghai',
          optimizer: { enabled: true, runs: 200 },
        },
      },
      'contracts/vendor/uzkge/shuffle/RevealVerifier.sol': {
        version: '0.8.25',
        settings: {
          viaIR: false,
          evmVersion: 'shanghai',
          optimizer: { enabled: true, runs: 200 },
        },
      },
      'contracts/vendor/uzkge/verifier/PlonkVerifier.sol': {
        version: '0.8.25',
        settings: {
          viaIR: false,
          evmVersion: 'shanghai',
          optimizer: { enabled: true, runs: 200 },
        },
      },
      'contracts/vendor/uzkge/verifier/Groth16Verifier.sol': {
        version: '0.8.25',
        settings: {
          viaIR: false,
          evmVersion: 'shanghai',
          optimizer: { enabled: true, runs: 200 },
        },
      },
      'contracts/vendor/uzkge/verifier/ChaumPedersenDLVerifier.sol': {
        version: '0.8.25',
        settings: {
          viaIR: false,
          evmVersion: 'shanghai',
          optimizer: { enabled: true, runs: 200 },
        },
      },
      'contracts/vendor/uzkge/libraries/EdOnBN254.sol': {
        version: '0.8.25',
        settings: {
          viaIR: false,
          evmVersion: 'shanghai',
          optimizer: { enabled: true, runs: 200 },
        },
      },
      'contracts/vendor/uzkge/libraries/BN254.sol': {
        version: '0.8.25',
        settings: {
          viaIR: false,
          evmVersion: 'shanghai',
          optimizer: { enabled: true, runs: 200 },
        },
      },
      'contracts/vendor/uzkge/libraries/Transcript.sol': {
        version: '0.8.25',
        settings: {
          viaIR: false,
          evmVersion: 'shanghai',
          optimizer: { enabled: true, runs: 200 },
        },
      },
      'contracts/vendor/uzkge/libraries/BytesLib.sol': {
        version: '0.8.25',
        settings: {
          viaIR: false,
          evmVersion: 'shanghai',
          optimizer: { enabled: true, runs: 200 },
        },
      },
      'contracts/vendor/uzkge/libraries/Utils.sol': {
        version: '0.8.25',
        settings: {
          viaIR: false,
          evmVersion: 'shanghai',
          optimizer: { enabled: true, runs: 200 },
        },
      },
      // PetitionSignatures deploys to 943/369 like the other games contracts — pin Shanghai (no
      // MCOPY/TSTORE) so the deployed bytecode runs there. OZ is pinned to 5.0.2 in package.json
      // precisely so its EIP712/ECDSA sources stay Shanghai-compatible (see the `eas` foundry
      // profile note in foundry.toml).
      'contracts/PetitionSignatures.sol': {
        version: '0.8.25',
        settings: {
          viaIR: true,
          evmVersion: 'shanghai',
          optimizer: {
            enabled: true,
            runs: 700,
          },
        },
      },
    },
  },
  paths: {
    sources: './contracts',
    artifacts: './artifacts',
  },
  networks: {
    hardhat: {
      accounts: {
        ...defaultHdAccountsConfigParams,
        accountsBalance: (10n ** 18n * 10n ** 9n).toString(),
        mnemonic: env.MNEMONIC || HARDHAT_NETWORK_MNEMONIC,
        count: 20, // 512
        // path:
      },
      enableTransientStorage: true,
      allowUnlimitedContractSize: false,
      // forking: {
      //   url: 'https://rpc-pulsechain.g4mm4.io',
      //   blockNumber: 21_074_800,
      // },
      hardfork: 'cancun',
      chainId: 1,
    },
    pulsechainV4: {
      url: 'https://rpc.v4.testnet.pulsechain.com',
      accounts: {
        mnemonic: env.MNEMONIC || HARDHAT_NETWORK_MNEMONIC,
      },
    },
    pulsechain: {
      url: 'https://rpc.pulsechain.com',
      accounts: {
        mnemonic: env.MNEMONIC || HARDHAT_NETWORK_MNEMONIC,
      },
    },
  },
  mocha: {
    // Coverage instrumentation makes the heavy parity/fuzz suites several-fold slower (the whole
    // instrumented run is ~1h in CI) — give them room there instead of failing on the clock.
    timeout: process.env.SOLIDITY_COVERAGE === 'true' ? 1_200_000 : 180_000,
  },
  fourByteUploader: {
    runOnCompile: process.env.BYTE4 === 'true',
  },
  dependencyCompiler: {
    paths: [
      'multicaller/src/MulticallerEtcher.sol',
      'multicaller/src/MulticallerWithSender.sol',
      'multicaller/src/MulticallerWithSigner.sol',
      // The Random protocol, consumed from the published package (post-extraction the sources
      // live in gibsfinance/random): the test fixture deploys these alongside the games. The
      // default compiler block (0.8.25/viaIR/cancun) matches the protocol's own build.
      '@gibs/random/contracts/Random.sol',
      '@gibs/random/contracts/Reader.sol',
      '@gibs/random/contracts/Consumer.sol',
      '@gibs/random/contracts/Constants.sol',
      '@gibs/random/contracts/test/ConsumerIncomplete.sol',
      '@gibs/random/contracts/test/ConsumerEmitter.sol',
    ],
  },
  etherscan: {
    enabled: true,
    customChains: [
      {
        network: 'pulsechain',
        chainId: 369,
        urls: {
          apiURL: 'https://api.scan.pulsechain.com/api',
          browserURL: 'https://scan.pulsechain.com/#',
        },
      },
      {
        network: 'pulsechainV4',
        chainId: 943,
        urls: {
          apiURL: 'https://api.scan.v4.testnet.pulsechain.com/api',
          browserURL: 'https://scan.v4.testnet.pulsechain.com/#',
        },
      },
    ],
    apiKey: {
      mainnet: env.ETHERSCAN_API_KEY!,
      pulsechainV4: 'abc',
      pulsechain: 'abc',
    },
  },
  sourcify: {
    enabled: true,
    apiUrl: 'https://sourcify.dev/server',
    browserUrl: 'https://repo.sourcify.dev',
  },
  gasReporter: {
    enabled: true,
    currency: 'USD',
    L1: 'ethereum',
    coinmarketcap: env.GAS_COINMARKETCAP,
    L1Etherscan: env.ETHERSCAN_API_KEY,
    L2Etherscan: env.ETHERSCAN_API_KEY,
    gasPrice: 100_000,
    baseFee: 100_000,
    tokenPrice: '0.00004',
    currencyDisplayPrecision: 8,
    reportFormat: 'terminal',
    // showMethodSig: true,
    trackGasDeltas: true,
  },
}

export default config
