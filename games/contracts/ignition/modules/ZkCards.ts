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
  const zkTable = m.contract("ZkTable", [wrapperFactory], {
    libraries: { "contracts/vendor/uzkge/ShowdownDecodeLib.sol:ShowdownDecodeLib": showdownDecodeLib },
  })
  const hiLoWarRules = m.contract("HiLoWarRules", [revealVerifier, shuffleVerifier])
  const holdemTableN = m.contract("HoldemTableN", [holdemTreasury, wrapperFactory])

  return { vk1, vk2, shuffleVerifier, revealVerifier, zkTable, hiLoWarRules, showdownDecodeLib, holdemTableN }
})

export default ZkCardsModule
