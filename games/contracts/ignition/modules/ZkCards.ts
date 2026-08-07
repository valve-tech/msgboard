import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

// Deploys the full ZK cards family: vendored uzkge verifiers (pinned 2ae729db),
// the calldata-shaped 52-card shuffle wrapper, ZkTable, HiLoWarRules, and HoldemTableN.
// ~11.6M one-time gas (spike-measured) — fine under PulseChain's 45M block limit.
//
// ZkTable's AND HoldemTableN's constructors take the ValveWrapperFactory address used for their
// x402 create() clone-check (see ZkTable.sol's / HoldemTableN.sol's IWrapperFactory). Defaults to
// the REAL factory, deployed at the SAME address on both 369 and 943
// (monorepo/packages/contracts/deployments/{369,943}.json:
// "WrapperFactory": "0xB10A088ea04B261371Edc9Fe9e6121B8355aDe70") — overridable per network via
// an Ignition parameter for anything that isn't 369/943. NEVER default this to address(0) for a
// real deploy: that disables the clone-check entirely, letting create() accept ANY ERC-20 as the
// escrow token.
//
// HoldemTableN also takes a `treasury` (the rake recipient, now paid in whichever wrapper token
// each table is denominated in — see HoldemTableN.sol's `_payoutVector` note on multi-token
// treasury inflow). Defaults to the zero address, which the constructor falls back to
// `msg.sender` (the Ignition deployer) — override `holdemTreasury` for a real deploy where the
// deployer is not the intended rake recipient. HoldemTableN does NOT link ShowdownDecodeLib (or
// any other external library) — unlike ZkTable, no `libraries` option is needed.
//
// ZkTable's constructor also takes `shuffleVerifier_` (deckkey-binding-spec.md Wave-2 — see
// ZkTable.sol's `shuffleVerifier` immutable header): the SAME `shuffleVerifier` this module
// already deploys for HiLoWarRules, wired into ZkTable too so `challengeDeck` can verify real
// shuffle-chain transcripts. ZkTable now link-references TWO external libraries —
// ShowdownDecodeLib (pre-existing) and DeckChallengeLib (new: houses `challengeDeck`'s
// cryptographic verification pipeline, extracted out of ZkTable's own bytecode to stay under
// EIP-170's 24576-byte deployed-code limit — see DeckChallengeLib.sol's header). DeckChallengeLib
// itself link-references DeckConstants (the canonical-deck/on-chain-aggregate derivation — see
// DeckConstants.sol's `initialDeckAndAgg`) — a TRANSITIVE library dependency that must be deployed
// and linked into DeckChallengeLib BEFORE DeckChallengeLib is deployed, exactly like
// hardhat-viem's `deployContract` requires (see games-contracts/test/x402.ts's
// `deployDeckChallengeLib` for the identical pattern) — Ignition does not auto-resolve transitive
// library links any more than hardhat-viem does.
const ZkCardsModule = buildModule("ZkCardsModule", (m) => {
  const wrapperFactory = m.getParameter("wrapperFactory", "0xB10A088ea04B261371Edc9Fe9e6121B8355aDe70")
  const holdemTreasury = m.getParameter("holdemTreasury", "0x0000000000000000000000000000000000000000")
  const vk1 = m.contract("VerifierKeyExtra1_52", [])
  const vk2 = m.contract("VerifierKeyExtra2_52", [])
  const shuffleVerifier = m.contract("ShuffleVerifier52", [vk1, vk2])
  const revealVerifier = m.contract("RevealVerifier", [])
  // ZkTable link-references the EXTERNAL (separately-deployed) ShowdownDecodeLib library (see
  // ShowdownDecodeLib.sol's header) — Ignition, like hardhat-viem's deployContract, does NOT
  // auto-link external libraries; the deploy fails validation (IGN716: "Invalid libraries...")
  // without this deployed and passed explicitly.
  const showdownDecodeLib = m.library("ShowdownDecodeLib")
  // DeckConstants must be deployed + linked into DeckChallengeLib BEFORE DeckChallengeLib itself
  // is deployed (transitive external-library link — see this block's header comment).
  const deckConstants = m.library("DeckConstants")
  const deckChallengeLib = m.library("DeckChallengeLib", {
    libraries: { "contracts/zk/DeckConstants.sol:DeckConstants": deckConstants },
  })
  const zkTable = m.contract("ZkTable", [wrapperFactory, shuffleVerifier], {
    libraries: {
      "contracts/vendor/uzkge/ShowdownDecodeLib.sol:ShowdownDecodeLib": showdownDecodeLib,
      "contracts/zk/DeckChallengeLib.sol:DeckChallengeLib": deckChallengeLib,
    },
  })
  const hiLoWarRules = m.contract("HiLoWarRules", [revealVerifier, shuffleVerifier])
  const holdemTableN = m.contract("HoldemTableN", [holdemTreasury, wrapperFactory])

  return {
    vk1,
    vk2,
    shuffleVerifier,
    revealVerifier,
    zkTable,
    hiLoWarRules,
    showdownDecodeLib,
    deckConstants,
    deckChallengeLib,
    holdemTableN,
  }
})

export default ZkCardsModule
