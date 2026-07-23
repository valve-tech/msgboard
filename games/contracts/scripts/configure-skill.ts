/**
 * One-shot SkillSettle (ZK-Wordle house game) configuration — the skill-game analog of
 * configure-house.ts.
 *
 * Runs, in dependency order:
 *   1. SkillSettle.setHouseKey(houseKey)          — registers the house signing EOA (signs open terms)
 *   2. SkillSettle.setWordleDictRoot(dictRoot)    — commits the Wordle dictionary Merkle root; a
 *                                                   wordle_solve proof must verify against THIS root, so
 *                                                   it MUST be set before any Wordle round can settle.
 *   3. Chips.mint(ownerAccount, treasury)         — creates treasury supply for the operator
 *   4. Chips.approve(skillSettle, fund)           — grant SkillSettle the pull allowance fundHouse needs
 *   5. SkillSettle.fundHouse(fund)                — moves `fund` chips into the house pool
 *
 * The approve-before-fundHouse dependency is mandatory: fundHouse calls
 * chips.safeTransferFrom(msg.sender, ...) internally (identical to HouseChannel.fundHouse), so
 * SkillSettle must be approved before fundHouse is called.
 *
 * NOTE — SudokuLog needs NONE of this. It is a Chips-FREE timed leaderboard: no house key, no dict
 * root, no funding. After deploy the owner just calls SudokuLog.openPuzzle(puzzleId, puzzle[81]) to
 * start a puzzle's clock. There is deliberately no configure step for it here.
 *
 * WORDLE DICT ROOT — the committed dictionary is PUBLIC and must be bit-identical to what the browser
 * prover uses. The default here is the Poseidon Merkle root of the REAL production dictionary: the full
 * 12,972-word canonical original-Wordle valid-guess list, at PROD_DICT_DEPTH = 14
 * (examples/games/zk-skill/src/wordleSolve.ts — buildDictTree(WORDLE_VALID_GUESSES, 14)). It is the
 * exact value the foundry fixtures + SkillSettle.t.sol settle against (verified: it equals
 * wordleSolveProof.json's pubSignals[2]). Override via the WORDLE_DICT_ROOT env var only if the browser
 * prover is simultaneously pointed at the matching word list.
 *
 * Each call is simulated with simulateContract first, then written, and the receipt is awaited before
 * the next dependent step. Legacy (type-0) gas is forced when a gasPrice is supplied (PulseChain).
 *
 * @param opts.walletClient  An already-constructed viem WalletClient with an account set (owner).
 * @param opts.chips         Address of the deployed Chips ERC-20 contract.
 * @param opts.skillSettle   Address of the deployed SkillSettle contract.
 * @param opts.houseKey      EOA address to use as the house signing key.
 * @param opts.dictRoot      Committed Wordle dictionary Merkle root (uint256).
 * @param opts.treasury      Total Chips to mint into the operator's own account.
 * @param opts.fund          Amount of the minted treasury to deposit into the house pool.
 * @param opts.gasPrice      Optional LEGACY (type-0) gas price applied to every write (PulseChain).
 *
 * @returns { setHouseKey, setWordleDictRoot, mint, fund } tx hashes (approve is a silent prerequisite).
 */
import * as viem from 'viem'

/** The Poseidon Merkle root of examples/games/zk-skill's REAL production dictionary — the full
 *  12,972-word canonical original-Wordle valid-guess list (WORDLE_VALID_GUESSES), at PROD_DICT_DEPTH=14
 *  (buildDictTree(WORDLE_VALID_GUESSES, 14).root). Verified equal to
 *  test/foundry/fixtures/wordleSolveProof.json → pubSignals[2]. Override via the WORDLE_DICT_ROOT env
 *  var (see the module header). */
export const PROD_WORDLE_DICT_ROOT =
  3350479244380732130121458266697593225013617640696585361522515229064079345293n

// ── Minimal ABIs (only the selectors this script touches) ─────────────────────

const chipsAbi = [
  {
    name: 'mint',
    type: 'function',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'approve',
    type: 'function',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const satisfies viem.Abi

const skillSettleAbi = [
  {
    name: 'setHouseKey',
    type: 'function',
    inputs: [{ name: 'key', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'setWordleDictRoot',
    type: 'function',
    inputs: [{ name: 'root', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'fundHouse',
    type: 'function',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'houseKey',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    name: 'wordleDictRoot',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const satisfies viem.Abi

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConfigureSkillOpts {
  walletClient: viem.WalletClient
  chips: viem.Hex
  skillSettle: viem.Hex
  houseKey: viem.Hex
  dictRoot: bigint
  treasury: bigint
  fund: bigint
  /**
   * Optional LEGACY (type-0) gas price applied to every write. REQUIRED for PulseChain, where default
   * EIP-1559 estimation is unreliable (see scripts/gas.ts). When omitted, viem's default fee
   * estimation is used (fine for normal 1559 chains / anvil / hardhat).
   */
  gasPrice?: bigint
}

export interface ConfigureSkillResult {
  setHouseKey: viem.Hex
  setWordleDictRoot: viem.Hex
  mint: viem.Hex
  fund: viem.Hex
}

// ── Implementation ────────────────────────────────────────────────────────────

export async function configureSkill(opts: ConfigureSkillOpts): Promise<ConfigureSkillResult> {
  const { walletClient, chips, skillSettle, houseKey, dictRoot, treasury, fund, gasPrice } = opts

  const account = walletClient.account
  if (!account) throw new Error('walletClient must have an account set')

  // walletClient.extend(publicActions) gives us simulateContract + waitForTransactionReceipt on the
  // same transport as the wallet, mirroring configure-house.ts.
  const client = walletClient.extend(viem.publicActions)

  // When a legacy gasPrice is supplied (PulseChain), force a type-0 fee on every write so viem never
  // auto-derives an EIP-1559 maxFeePerGas from the chain's ~0 base fee. simulate is still run first
  // purely as a revert check; the write is re-issued explicitly with the legacy fee.
  const fee = gasPrice !== undefined ? ({ gasPrice, type: 'legacy' } as const) : ({} as const)

  // ── Step 1: setHouseKey ───────────────────────────────────────────────────
  await client.simulateContract({ address: skillSettle, abi: skillSettleAbi, functionName: 'setHouseKey', args: [houseKey], account })
  const setHouseKeyHash = await client.writeContract({
    address: skillSettle, abi: skillSettleAbi, functionName: 'setHouseKey', args: [houseKey],
    account, chain: walletClient.chain, ...fee,
  })
  await client.waitForTransactionReceipt({ hash: setHouseKeyHash })

  // ── Step 2: setWordleDictRoot ─────────────────────────────────────────────
  await client.simulateContract({ address: skillSettle, abi: skillSettleAbi, functionName: 'setWordleDictRoot', args: [dictRoot], account })
  const setDictRootHash = await client.writeContract({
    address: skillSettle, abi: skillSettleAbi, functionName: 'setWordleDictRoot', args: [dictRoot],
    account, chain: walletClient.chain, ...fee,
  })
  await client.waitForTransactionReceipt({ hash: setDictRootHash })

  // ── Step 3: mint treasury ─────────────────────────────────────────────────
  await client.simulateContract({ address: chips, abi: chipsAbi, functionName: 'mint', args: [account.address, treasury], account })
  const mintHash = await client.writeContract({
    address: chips, abi: chipsAbi, functionName: 'mint', args: [account.address, treasury],
    account, chain: walletClient.chain, ...fee,
  })
  await client.waitForTransactionReceipt({ hash: mintHash })

  // ── Step 4: approve SkillSettle to pull `fund` chips (required by fundHouse) ──
  await client.simulateContract({ address: chips, abi: chipsAbi, functionName: 'approve', args: [skillSettle, fund], account })
  const approveHash = await client.writeContract({
    address: chips, abi: chipsAbi, functionName: 'approve', args: [skillSettle, fund],
    account, chain: walletClient.chain, ...fee,
  })
  await client.waitForTransactionReceipt({ hash: approveHash })

  // ── Step 5: fundHouse ─────────────────────────────────────────────────────
  await client.simulateContract({ address: skillSettle, abi: skillSettleAbi, functionName: 'fundHouse', args: [fund], account })
  const fundHash = await client.writeContract({
    address: skillSettle, abi: skillSettleAbi, functionName: 'fundHouse', args: [fund],
    account, chain: walletClient.chain, ...fee,
  })
  await client.waitForTransactionReceipt({ hash: fundHash })

  return {
    setHouseKey: setHouseKeyHash,
    setWordleDictRoot: setDictRootHash,
    mint: mintHash,
    fund: fundHash,
  }
}
