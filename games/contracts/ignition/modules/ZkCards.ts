import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

// Deploys the full ZK cards family: vendored uzkge verifiers (pinned 2ae729db),
// the calldata-shaped 52-card shuffle wrapper, ZkTable, and HiLoWarRules.
// ~11.6M one-time gas (spike-measured) — fine under PulseChain's 45M block limit.
const ZkCardsModule = buildModule("ZkCardsModule", (m) => {
  const vk1 = m.contract("VerifierKeyExtra1_52", [])
  const vk2 = m.contract("VerifierKeyExtra2_52", [])
  const shuffleVerifier = m.contract("ShuffleVerifier52", [vk1, vk2])
  const revealVerifier = m.contract("RevealVerifier", [])
  const zkTable = m.contract("ZkTable", [])
  const hiLoWarRules = m.contract("HiLoWarRules", [revealVerifier, shuffleVerifier])

  return { vk1, vk2, shuffleVerifier, revealVerifier, zkTable, hiLoWarRules }
})

export default ZkCardsModule
