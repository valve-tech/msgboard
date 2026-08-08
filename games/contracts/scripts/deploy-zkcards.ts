/**
 * Deploy the ZK cards stack — ZkTable + its uzkge verifiers/libs + HiLoWarRules + HoldemTableN.
 *
 * Mirrors ignition/modules/ZkCards.ts's deploy ORDER and constructor wiring exactly (that module is
 * the authority this script follows), but runs standalone via viem + legacy PulseChain gas — same
 * shape as deploy-coinfliptables.ts / deploy-skill.ts — so it can be driven from the CLI without an
 * Ignition deployment run, and so its dry-run plan can be reviewed before spending a single wei.
 *
 * ARTIFACT SOURCE: hardhat's `artifacts/contracts/...` — NOT forge-out. hardhat.config.ts applies
 * per-file compiler overrides (see its `overrides` block): ShuffleVerifier52 + VerifierKeyExtra1_52 +
 * VerifierKeyExtra2_52 + RevealVerifier compile viaIR:FALSE (matches the vendored uzkge verifiers'
 * spike-measured gas), while ZkTable/DeckChallengeLib/DeckConstants/ShowdownDecodeLib/HiLoWarRules/
 * HoldemTableN compile viaIR:TRUE (stack-too-deep otherwise). A single forge-out profile cannot
 * reproduce both settings at once — hardhat's artifacts/ directory is the one place each contract's
 * bytecode already reflects ITS OWN correct override. Run `hardhat compile` before this script.
 *
 * LIBRARY LINKING: hardhat does NOT auto-link external libraries for a bare bytecode deploy (only
 * hre.viem.deployContract / Ignition do, and only when told). This script implements the same manual
 * placeholder-patch dance as test/x402.ts's `deployDeckChallengeLib` — read each artifact's
 * `linkReferences` (byte offsets of the `__$<hash>$__` placeholder within the creation bytecode),
 * and splice in the deployed dependency's address. Two libraries need it:
 *   - DeckChallengeLib links DeckConstants (transitive — DeckConstants must exist FIRST)
 *   - ZkTable links BOTH ShowdownDecodeLib and DeckChallengeLib
 * `linkLibraries()` below throws if a placeholder is left unresolved (`__$` found post-link) — the
 * dry run below actually performs this splice (against the PREDICTED CREATE addresses) and asserts
 * cleanliness, so a broken link is caught before EXECUTE, not after a wasted broadcast.
 *
 * Deploy order (10 contracts — see ignition/modules/ZkCards.ts):
 *   1. VerifierKeyExtra1_52()                                    no args
 *   2. VerifierKeyExtra2_52()                                    no args
 *   3. ShuffleVerifier52(vk1, vk2)
 *   4. RevealVerifier()                                          no args
 *   5. ShowdownDecodeLib()                          [library]    no args
 *   6. DeckConstants()                              [library]    no args
 *   7. DeckChallengeLib()                           [library]    linked: DeckConstants
 *   8. ZkTable(wrapperFactory, shuffleVerifier)                  linked: ShowdownDecodeLib, DeckChallengeLib
 *   9. HiLoWarRules(revealVerifier, shuffleVerifier)
 *  10. HoldemTableN(holdemTreasury, wrapperFactory)
 *
 *   # dry run (prints the plan incl. resolved library links + gas — nothing sent)
 *   PRIVATE_KEY=<valve_deployer> CHAIN_ID=943 npx tsx scripts/deploy-zkcards.ts
 *   # broadcast
 *   PRIVATE_KEY=<valve_deployer> CHAIN_ID=943 DEPLOY_EXECUTE=1 npx tsx scripts/deploy-zkcards.ts
 *
 * Env (943 defaults baked in; override for other chains):
 *   PRIVATE_KEY | MNEMONIC — the deployer. REQUIRED.
 *   RPC_URL   (default https://rpc.v4.testnet.pulsechain.com)
 *   CHAIN_ID  (default 943)
 *   WRAPPER_FACTORY (default 0xB10A088ea04B261371Edc9Fe9e6121B8355aDe70 — the real ValveWrapperFactory,
 *             deployed at the SAME address on both 369 and 943). NEVER default this to the zero
 *             address for a real deploy — that disables ZkTable's/HoldemTableN's create()-time
 *             clone-check, letting create() accept ANY ERC-20 as the escrow token.
 *   HOLDEM_TREASURY (default = the deployer address — override if the rake recipient differs).
 *   DEPLOY_OUT (default ../deployments/<chainId>-zkcards.json) — where addresses are written on a
 *             successful EXECUTE. See the header note below on config-sync: this file is NOT known
 *             to be read by anything yet — confirm the real sync target before relying on it.
 */
import * as viem from 'viem'
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts'
import { resolveLegacyFee } from './gas'

// ── Artifact loading (hardhat only — see header) ────────────────────────────

interface LinkRef {
  length: number
  start: number
}
type LinkReferences = Record<string, Record<string, LinkRef[]>>

interface Artifact {
  abi: viem.Abi
  bytecode: viem.Hex
  linkReferences: LinkReferences
}

function loadArtifact(relPath: string): Artifact {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('node:path') as typeof import('node:path')
  const p = path.resolve(__dirname, '../artifacts', relPath)
  if (!fs.existsSync(p)) {
    throw new Error(`deploy-zkcards: missing artifact ${relPath} — run \`hardhat compile\` first`)
  }
  const a = JSON.parse(fs.readFileSync(p, 'utf8'))
  return { abi: a.abi as viem.Abi, bytecode: a.bytecode as viem.Hex, linkReferences: (a.linkReferences ?? {}) as LinkReferences }
}

const ARTIFACT_PATHS = {
  vk1: 'contracts/vendor/uzkge/shuffle/VerifierKeyExtra1_52.sol/VerifierKeyExtra1_52.json',
  vk2: 'contracts/vendor/uzkge/shuffle/VerifierKeyExtra2_52.sol/VerifierKeyExtra2_52.json',
  shuffleVerifier: 'contracts/zk/ShuffleVerifier52.sol/ShuffleVerifier52.json',
  revealVerifier: 'contracts/vendor/uzkge/shuffle/RevealVerifier.sol/RevealVerifier.json',
  showdownDecodeLib: 'contracts/vendor/uzkge/ShowdownDecodeLib.sol/ShowdownDecodeLib.json',
  deckConstants: 'contracts/zk/DeckConstants.sol/DeckConstants.json',
  deckChallengeLib: 'contracts/zk/DeckChallengeLib.sol/DeckChallengeLib.json',
  zkTable: 'contracts/zk/ZkTable.sol/ZkTable.json',
  hiLoWarRules: 'contracts/zk/HiLoWarRules.sol/HiLoWarRules.json',
  holdemTableN: 'contracts/zk/HoldemTableN.sol/HoldemTableN.json',
} as const

// fully-qualified name → the key used in the `libs` map passed to linkLibraries().
const FQ_DECK_CONSTANTS = 'contracts/zk/DeckConstants.sol:DeckConstants'
const FQ_SHOWDOWN_DECODE_LIB = 'contracts/vendor/uzkge/ShowdownDecodeLib.sol:ShowdownDecodeLib'
const FQ_DECK_CHALLENGE_LIB = 'contracts/zk/DeckChallengeLib.sol:DeckChallengeLib'

/**
 * Splice deployed library addresses into a creation bytecode's `__$<hash>$__` placeholders, using
 * the artifact's own `linkReferences` (byte offsets — hardhat gives these for the CREATION bytecode,
 * matching `bytecode`, not `deployedBytecode`). Mirrors solc/hardhat's own link algorithm. Throws if
 * any placeholder remains unresolved after patching (`__$` still present) — never returns a bytecode
 * that would revert-on-deploy from a stray placeholder.
 */
export function linkLibraries(bytecode: viem.Hex, linkReferences: LinkReferences, libs: Record<string, viem.Hex>): viem.Hex {
  let code = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode
  for (const [sourceName, refs] of Object.entries(linkReferences)) {
    for (const [libName, positions] of Object.entries(refs)) {
      const fq = `${sourceName}:${libName}`
      const addr = libs[fq]
      if (!addr) throw new Error(`deploy-zkcards: missing library address for ${fq} (needed to link this bytecode)`)
      const addrHex = addr.toLowerCase().replace(/^0x/, '')
      for (const { start, length } of positions) {
        const from = start * 2
        const to = from + length * 2
        code = code.slice(0, from) + addrHex.padStart(length * 2, '0') + code.slice(to)
      }
    }
  }
  const linked = `0x${code}` as viem.Hex
  if (linked.includes('__$')) {
    throw new Error('deploy-zkcards: unresolved library placeholder (__$) remains after linking — link map incomplete')
  }
  return linked
}

// ── Generic legacy-fee deploy (mirrors deploy-skill.ts's deployContractLegacy) ──────────────────

interface DeployOpts {
  walletClient: viem.WalletClient
  publicClient: viem.PublicClient
  abi: viem.Abi
  bytecode: viem.Hex
  args: readonly unknown[]
  gasPrice: bigint
  label: string
}

async function deployLegacy(opts: DeployOpts): Promise<viem.Hex> {
  const { walletClient, publicClient, abi, bytecode, args, gasPrice, label } = opts
  const account = walletClient.account
  if (!account) throw new Error('walletClient must have an account set')
  const hash = await walletClient.deployContract({
    abi, bytecode, args: args as unknown[],
    account, chain: walletClient.chain,
    gasPrice, type: 'legacy',
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${label} deploy reverted (tx ${hash})`)
  if (!receipt.contractAddress) throw new Error(`${label} deploy receipt has no contractAddress`)
  return receipt.contractAddress
}

// ── Defaults ─────────────────────────────────────────────────────────────────

// The real ValveWrapperFactory, deployed at the SAME address on both 369 (mainnet) and 943
// (testnet) — see monorepo/packages/contracts/deployments/{369,943}.json. NEVER default this to
// address(0) for a real deploy: that disables create()'s clone-check, letting any ERC-20 in.
export const DEFAULT_WRAPPER_FACTORY = '0xB10A088ea04B261371Edc9Fe9e6121B8355aDe70' as viem.Hex

export interface ZkCardsAddresses {
  vk1: viem.Hex
  vk2: viem.Hex
  shuffleVerifier: viem.Hex
  revealVerifier: viem.Hex
  showdownDecodeLib: viem.Hex
  deckConstants: viem.Hex
  deckChallengeLib: viem.Hex
  zkTable: viem.Hex
  hiLoWarRules: viem.Hex
  holdemTableN: viem.Hex
}

interface PlanStep {
  key: keyof ZkCardsAddresses
  label: string
  args: readonly unknown[]
  argsLabel: string
  bytecode: viem.Hex // FINAL (already-linked where applicable) creation bytecode
  linkedLibs: string[]
}

/** Build the deploy plan in dependency order. Requires the PREDICTED addresses for anything a later
 *  step links against (vk1/vk2 for the verifier, deckConstants for deckChallengeLib, showdownDecodeLib
 *  + deckChallengeLib for zkTable, shuffleVerifier for hiLoWarRules, wrapperFactory/shuffleVerifier
 *  for zkTable/holdemTableN) so the SAME linking code path runs identically in dry-run and execute. */
function buildPlan(predicted: ZkCardsAddresses, wrapperFactory: viem.Hex, holdemTreasury: viem.Hex): PlanStep[] {
  const art = {
    vk1: loadArtifact(ARTIFACT_PATHS.vk1),
    vk2: loadArtifact(ARTIFACT_PATHS.vk2),
    shuffleVerifier: loadArtifact(ARTIFACT_PATHS.shuffleVerifier),
    revealVerifier: loadArtifact(ARTIFACT_PATHS.revealVerifier),
    showdownDecodeLib: loadArtifact(ARTIFACT_PATHS.showdownDecodeLib),
    deckConstants: loadArtifact(ARTIFACT_PATHS.deckConstants),
    deckChallengeLib: loadArtifact(ARTIFACT_PATHS.deckChallengeLib),
    zkTable: loadArtifact(ARTIFACT_PATHS.zkTable),
    hiLoWarRules: loadArtifact(ARTIFACT_PATHS.hiLoWarRules),
    holdemTableN: loadArtifact(ARTIFACT_PATHS.holdemTableN),
  }

  const deckChallengeLibLinked = linkLibraries(art.deckChallengeLib.bytecode, art.deckChallengeLib.linkReferences, {
    [FQ_DECK_CONSTANTS]: predicted.deckConstants,
  })
  const zkTableLinked = linkLibraries(art.zkTable.bytecode, art.zkTable.linkReferences, {
    [FQ_SHOWDOWN_DECODE_LIB]: predicted.showdownDecodeLib,
    [FQ_DECK_CHALLENGE_LIB]: predicted.deckChallengeLib,
  })

  return [
    { key: 'vk1', label: 'VerifierKeyExtra1_52', args: [], argsLabel: '(none)', bytecode: art.vk1.bytecode, linkedLibs: [] },
    { key: 'vk2', label: 'VerifierKeyExtra2_52', args: [], argsLabel: '(none)', bytecode: art.vk2.bytecode, linkedLibs: [] },
    {
      key: 'shuffleVerifier', label: 'ShuffleVerifier52', args: [predicted.vk1, predicted.vk2],
      argsLabel: `vk1=${predicted.vk1}, vk2=${predicted.vk2}`, bytecode: art.shuffleVerifier.bytecode, linkedLibs: [],
    },
    { key: 'revealVerifier', label: 'RevealVerifier', args: [], argsLabel: '(none)', bytecode: art.revealVerifier.bytecode, linkedLibs: [] },
    {
      key: 'showdownDecodeLib', label: 'ShowdownDecodeLib [library]', args: [], argsLabel: '(none)',
      bytecode: art.showdownDecodeLib.bytecode, linkedLibs: [],
    },
    {
      key: 'deckConstants', label: 'DeckConstants [library]', args: [], argsLabel: '(none)',
      bytecode: art.deckConstants.bytecode, linkedLibs: [],
    },
    {
      key: 'deckChallengeLib', label: 'DeckChallengeLib [library]', args: [], argsLabel: '(none)',
      bytecode: deckChallengeLibLinked, linkedLibs: [`DeckConstants=${predicted.deckConstants}`],
    },
    {
      key: 'zkTable', label: 'ZkTable', args: [wrapperFactory, predicted.shuffleVerifier],
      argsLabel: `wrapperFactory=${wrapperFactory}, shuffleVerifier=${predicted.shuffleVerifier}`,
      bytecode: zkTableLinked,
      linkedLibs: [`ShowdownDecodeLib=${predicted.showdownDecodeLib}`, `DeckChallengeLib=${predicted.deckChallengeLib}`],
    },
    {
      key: 'hiLoWarRules', label: 'HiLoWarRules', args: [predicted.revealVerifier, predicted.shuffleVerifier],
      argsLabel: `revealVerifier=${predicted.revealVerifier}, shuffleVerifier=${predicted.shuffleVerifier}`,
      bytecode: art.hiLoWarRules.bytecode, linkedLibs: [],
    },
    {
      key: 'holdemTableN', label: 'HoldemTableN', args: [holdemTreasury, wrapperFactory],
      argsLabel: `treasury=${holdemTreasury}, factory=${wrapperFactory}`,
      bytecode: art.holdemTableN.bytecode, linkedLibs: [],
    },
  ]
}

function abiFor(key: keyof ZkCardsAddresses): viem.Abi {
  const map: Record<keyof ZkCardsAddresses, string> = {
    vk1: ARTIFACT_PATHS.vk1,
    vk2: ARTIFACT_PATHS.vk2,
    shuffleVerifier: ARTIFACT_PATHS.shuffleVerifier,
    revealVerifier: ARTIFACT_PATHS.revealVerifier,
    showdownDecodeLib: ARTIFACT_PATHS.showdownDecodeLib,
    deckConstants: ARTIFACT_PATHS.deckConstants,
    deckChallengeLib: ARTIFACT_PATHS.deckChallengeLib,
    zkTable: ARTIFACT_PATHS.zkTable,
    hiLoWarRules: ARTIFACT_PATHS.hiLoWarRules,
    holdemTableN: ARTIFACT_PATHS.holdemTableN,
  }
  return loadArtifact(map[key]).abi
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  /* eslint-disable no-console */
  const fs = await import('node:fs')
  const path = await import('node:path')

  const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
  const CHAIN_ID = Number(process.env.CHAIN_ID ?? 943)
  const EXECUTE = process.env.DEPLOY_EXECUTE === '1'
  const WRAPPER_FACTORY = viem.getAddress((process.env.WRAPPER_FACTORY ?? DEFAULT_WRAPPER_FACTORY) as viem.Hex)

  const pk = process.env.PRIVATE_KEY
  const mnemonic = process.env.MNEMONIC
  if (!pk && !mnemonic) throw new Error('set PRIVATE_KEY or MNEMONIC in the environment')
  const deployer = pk
    ? privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as viem.Hex)
    : mnemonicToAccount(mnemonic!)

  const HOLDEM_TREASURY = viem.getAddress((process.env.HOLDEM_TREASURY as viem.Hex | undefined) ?? deployer.address)

  const chain = {
    id: CHAIN_ID,
    name: `chain-${CHAIN_ID}`,
    nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  } as const
  const publicClient = viem.createPublicClient({ chain, transport: viem.http(RPC) })
  const walletClient = viem.createWalletClient({ account: deployer, chain, transport: viem.http(RPC) })

  const fee = await resolveLegacyFee(publicClient)
  const balance = await publicClient.getBalance({ address: deployer.address })
  const nonce = await publicClient.getTransactionCount({ address: deployer.address })
  const at = (offset: number) => viem.getContractAddress({ from: deployer.address, nonce: BigInt(nonce + offset) })

  // Predicted CREATE addresses in deploy order — used both to display the plan AND to actually link
  // library placeholders (dry-run and execute share this exact code path; see buildPlan's header).
  const predicted: ZkCardsAddresses = {
    vk1: at(0),
    vk2: at(1),
    shuffleVerifier: at(2),
    revealVerifier: at(3),
    showdownDecodeLib: at(4),
    deckConstants: at(5),
    deckChallengeLib: at(6),
    zkTable: at(7),
    hiLoWarRules: at(8),
    holdemTableN: at(9),
  }

  const plan = buildPlan(predicted, WRAPPER_FACTORY, HOLDEM_TREASURY)

  console.log('── deploy ZK cards stack (ZkTable + verifiers/libs + HiLoWarRules + HoldemTableN) ──')
  console.log('chain:', CHAIN_ID, RPC)
  console.log('deployer:', deployer.address, '| balance', viem.formatEther(balance), 'PLS | nonce', nonce)
  console.log('wrapperFactory:', WRAPPER_FACTORY, '| holdemTreasury:', HOLDEM_TREASURY)
  console.log('gas: legacy', viem.formatGwei(fee.gasPrice), 'gwei (base fee + tip, type-0 — see scripts/gas.ts)')

  console.log('\ndeploy plan (dependency order, predicted CREATE addresses):')
  let totalGasEstimate = 0n
  const gasEstimates: bigint[] = []
  for (const [i, step] of plan.entries()) {
    const initBytes = (step.bytecode.length - 2) / 2
    const predictedAddr = predicted[step.key]
    console.log(`  ${i + 1}. ${step.label.padEnd(28)} ${initBytes.toString().padStart(6)}B init → ${predictedAddr}`)
    console.log(`       args: ${step.argsLabel}`)
    if (step.linkedLibs.length) console.log(`       linked: ${step.linkedLibs.join(', ')}`)

    // Estimate creation gas against the FINAL (linked) bytecode + encoded ctor args — a pure read
    // (eth_estimateGas), never a broadcast. Library placeholders are already resolved at this point
    // (buildPlan linked against the predicted addresses), so this also doubles as the "no __$ left"
    // check for every library-linked step (linkLibraries() already throws if one remains).
    try {
      const data = viem.encodeDeployData({ abi: abiFor(step.key), bytecode: step.bytecode, args: step.args as unknown[] })
      const gas = await publicClient.estimateGas({ account: deployer.address, data })
      gasEstimates.push(gas)
      totalGasEstimate += gas
      console.log(`       est gas: ${gas.toString()}`)
    } catch (e) {
      gasEstimates.push(0n)
      console.log(`       est gas: (estimate failed — ${e instanceof Error ? e.message : e})`)
    }
  }
  const totalCost = totalGasEstimate * fee.gasPrice
  console.log(`\ntotal est gas: ${totalGasEstimate.toString()} @ ${viem.formatGwei(fee.gasPrice)} gwei ≈ ${viem.formatEther(totalCost)} PLS`)
  console.log('deployer balance sufficient:', balance > totalCost ? 'YES' : 'NO — TOP UP BEFORE EXECUTE')

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing sent. Re-run with DEPLOY_EXECUTE=1 to broadcast.')
    return
  }

  console.log('\nEXECUTING…')
  const addresses: Partial<ZkCardsAddresses> = {}
  const deployed: Record<string, viem.Hex> = {}

  // Re-derive the plan AFTER each real deploy so later steps link against the REAL address (which,
  // barring an intervening tx from this account, matches the prediction — but we use the real
  // receipt address, never the guess, once it's known).
  const vk1 = await deployLegacy({ walletClient, publicClient, abi: abiFor('vk1'), bytecode: plan[0].bytecode, args: [], gasPrice: fee.gasPrice, label: 'VerifierKeyExtra1_52' })
  console.log('  VerifierKeyExtra1_52:', vk1)
  const vk2 = await deployLegacy({ walletClient, publicClient, abi: abiFor('vk2'), bytecode: plan[1].bytecode, args: [], gasPrice: fee.gasPrice, label: 'VerifierKeyExtra2_52' })
  console.log('  VerifierKeyExtra2_52:', vk2)
  const shuffleVerifier = await deployLegacy({ walletClient, publicClient, abi: abiFor('shuffleVerifier'), bytecode: plan[2].bytecode, args: [vk1, vk2], gasPrice: fee.gasPrice, label: 'ShuffleVerifier52' })
  console.log('  ShuffleVerifier52:', shuffleVerifier)
  const revealVerifier = await deployLegacy({ walletClient, publicClient, abi: abiFor('revealVerifier'), bytecode: plan[3].bytecode, args: [], gasPrice: fee.gasPrice, label: 'RevealVerifier' })
  console.log('  RevealVerifier:', revealVerifier)
  const showdownDecodeLib = await deployLegacy({ walletClient, publicClient, abi: abiFor('showdownDecodeLib'), bytecode: plan[4].bytecode, args: [], gasPrice: fee.gasPrice, label: 'ShowdownDecodeLib' })
  console.log('  ShowdownDecodeLib:', showdownDecodeLib)
  const deckConstants = await deployLegacy({ walletClient, publicClient, abi: abiFor('deckConstants'), bytecode: plan[5].bytecode, args: [], gasPrice: fee.gasPrice, label: 'DeckConstants' })
  console.log('  DeckConstants:', deckConstants)

  // Re-link DeckChallengeLib against the REAL DeckConstants address (not the prediction).
  const deckChallengeLibArt = loadArtifact(ARTIFACT_PATHS.deckChallengeLib)
  const deckChallengeLibBytecode = linkLibraries(deckChallengeLibArt.bytecode, deckChallengeLibArt.linkReferences, {
    [FQ_DECK_CONSTANTS]: deckConstants,
  })
  const deckChallengeLib = await deployLegacy({ walletClient, publicClient, abi: deckChallengeLibArt.abi, bytecode: deckChallengeLibBytecode, args: [], gasPrice: fee.gasPrice, label: 'DeckChallengeLib' })
  console.log('  DeckChallengeLib:', deckChallengeLib)

  // Re-link ZkTable against the REAL ShowdownDecodeLib + DeckChallengeLib addresses.
  const zkTableArt = loadArtifact(ARTIFACT_PATHS.zkTable)
  const zkTableBytecode = linkLibraries(zkTableArt.bytecode, zkTableArt.linkReferences, {
    [FQ_SHOWDOWN_DECODE_LIB]: showdownDecodeLib,
    [FQ_DECK_CHALLENGE_LIB]: deckChallengeLib,
  })
  const zkTable = await deployLegacy({ walletClient, publicClient, abi: zkTableArt.abi, bytecode: zkTableBytecode, args: [WRAPPER_FACTORY, shuffleVerifier], gasPrice: fee.gasPrice, label: 'ZkTable' })
  console.log('  ZkTable:', zkTable)

  const hiLoWarRules = await deployLegacy({ walletClient, publicClient, abi: abiFor('hiLoWarRules'), bytecode: plan[8].bytecode, args: [revealVerifier, shuffleVerifier], gasPrice: fee.gasPrice, label: 'HiLoWarRules' })
  console.log('  HiLoWarRules:', hiLoWarRules)
  const holdemTableN = await deployLegacy({ walletClient, publicClient, abi: abiFor('holdemTableN'), bytecode: plan[9].bytecode, args: [HOLDEM_TREASURY, WRAPPER_FACTORY], gasPrice: fee.gasPrice, label: 'HoldemTableN' })
  console.log('  HoldemTableN:', holdemTableN)

  const deployBlock = await publicClient.getBlockNumber()
  Object.assign(addresses, { vk1, vk2, shuffleVerifier, revealVerifier, showdownDecodeLib, deckConstants, deckChallengeLib, zkTable, hiLoWarRules, holdemTableN })
  Object.assign(deployed, addresses)

  console.log('\n✓ deployed ZK cards stack')
  for (const [k, v] of Object.entries(deployed)) console.log(`  ${k.padEnd(20)} ${v}`)
  console.log('  deployBlock:', deployBlock.toString())

  // ── write deployment record ────────────────────────────────────────────────
  // CONFIG-SYNC NOTE (see this file's own header + memory: a past `deploy-games-actors` run NEVER
  // synced <chain>-deployment.json and the box ran stale config for months — a 10-day settlement
  // outage). games/e2e/scripts/943-deployment.json is scoped to the validator-POOL games (coinFlip/
  // raffle/coinFlipTables read by session-bots + ink-pools) — ZkTable/HiLoWarRules/HoldemTableN are
  // NOT pool/validator-settled (on-chain showdown adjudication + EIP-712 co-signed state instead), so
  // they do NOT belong in that file. The established pattern for non-pool games (flipBook, sudokuLog,
  // wordleLog, …) is an optional field on `GameDeployment` in games/web/src/config.ts's 943 entry —
  // but this script does not blind-edit a TS source file in a sibling package. Instead it writes this
  // JSON snapshot; CONFIRM the sync target and hand-add the fields to config.ts before players can
  // reach these contracts from the web app.
  const outPath = process.env.DEPLOY_OUT ?? path.resolve(__dirname, `../deployments/${CHAIN_ID}-zkcards.json`)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        chainId: CHAIN_ID,
        deployBlock: deployBlock.toString(),
        wrapperFactory: WRAPPER_FACTORY,
        holdemTreasury: HOLDEM_TREASURY,
        ...addresses,
      },
      null,
      2,
    ) + '\n',
  )
  console.log('\nwrote deployment record:', outPath)
  console.log('\nNext (config-sync — see note above, NOT done automatically by this script):')
  console.log('  1. Confirm whether games/web/src/config.ts (GameDeployment, 943 entry) is really the')
  console.log('     right sync target for zkTable/hiLoWarRules/holdemTableN, then add those fields there')
  console.log('     (mirroring the existing flipBook/sudokuLog optional-field pattern).')
  console.log('  2. Anything reading a "deck challenge" / "shuffle verifier" address off-chain (bots,')
  console.log('     indexer) needs the same addresses — grep for existing zkTable/hiLoWar config reads')
  console.log('     before assuming none exist yet.')
  /* eslint-enable no-console */
}

const invokedDirectly = typeof require !== 'undefined' && require.main === module
if (invokedDirectly) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e)
    process.exit(1)
  })
}
