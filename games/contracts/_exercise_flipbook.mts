/**
 * On-chain exercise of a deployed FlipBook (test artifact, not committed). Runs all four paths:
 *   R1 taker-wins reveal · R2 maker-wins reveal · R3 forfeit (real reveal-window wait) · R4 cancel
 * Maker = mnemonic account 0, taker = account 1 (funded from 0 if needed).
 *
 *   MNEMONIC=... RPC_URL=... CHAIN_ID=943 FLIPBOOK=0x... [SKIP_FORFEIT=1] npx tsx _exercise_flipbook.mts
 */
import * as viem from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import fbArtifact from './artifacts/contracts/games/FlipBook.sol/FlipBook.json' with { type: 'json' }

const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 943)
const FLIPBOOK = process.env.FLIPBOOK as viem.Hex
if (!FLIPBOOK) throw new Error('set FLIPBOOK')
const mnemonic = process.env.MNEMONIC
if (!mnemonic) throw new Error('set MNEMONIC')

const abi = fbArtifact.abi as viem.Abi
const chain = { id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const
const pc = viem.createPublicClient({ chain, transport: viem.http(RPC) })
const maker = mnemonicToAccount(mnemonic)
const taker = mnemonicToAccount(mnemonic, { addressIndex: 1 })
const wcMaker = viem.createWalletClient({ account: maker, chain, transport: viem.http(RPC) })
const wcTaker = viem.createWalletClient({ account: taker, chain, transport: viem.http(RPC) })

const STAKE = viem.parseEther('0.5')
const BOND = viem.parseEther('0.1')
const WINDOW = 300 // MIN_REVEAL_WINDOW — keeps the forfeit wait short
const gasPrice = (await pc.getGasPrice()) * 3n || viem.parseGwei('1')
const legacy = { gasPrice: gasPrice < viem.parseGwei('0.1') ? viem.parseGwei('1') : gasPrice, type: 'legacy' as const }

const bal = (a: viem.Hex) => pc.getBalance({ address: a })
const fmt = (x: bigint) => viem.formatEther(x)
const wait = (hash: viem.Hex) => pc.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 3_000 })

const write = async (wc: typeof wcMaker, functionName: string, args: unknown[], value?: bigint) => {
  const hash = await wc.writeContract({ address: FLIPBOOK, abi, functionName, args, value, ...legacy })
  const r = await wait(hash)
  if (r.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`)
  console.log(`  ${functionName} ✓ ${hash} (block ${r.blockNumber}, gas ${r.gasUsed})`)
  return r
}
const nextId = () => pc.readContract({ address: FLIPBOOK, abi, functionName: 'nextOfferId' }) as Promise<bigint>
const commitFor = (choice: boolean, salt: viem.Hex) =>
  viem.keccak256(viem.encodeAbiParameters([{ type: 'address' }, { type: 'bool' }, { type: 'bytes32' }], [maker.address, choice, salt]))
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 3600)

console.log('FlipBook exercise on', CHAIN_ID, '@', FLIPBOOK)
console.log('maker:', maker.address, fmt(await bal(maker.address)), 'PLS')
console.log('taker:', taker.address, fmt(await bal(taker.address)), 'PLS')

// fund the taker if needed (stake + gas headroom for 2 takes)
if ((await bal(taker.address)) < viem.parseEther('2')) {
  console.log('funding taker with 5 PLS…')
  const hash = await wcMaker.sendTransaction({ to: taker.address, value: viem.parseEther('5'), ...legacy })
  await wait(hash)
  console.log('  funded ✓', fmt(await bal(taker.address)), 'PLS')
}

// ── R1: taker wins (guess matches) ────────────────────────────────────────────
{
  const salt = viem.keccak256(viem.toHex(`exercise-r1-${CHAIN_ID}`))
  const id = await nextId()
  console.log(`\nR1 taker-wins — offer #${id}: maker choice=true, taker guess=true`)
  await write(wcMaker, 'post', [commitFor(true, salt), BOND, deadline(), WINDOW], STAKE + BOND)
  const takerBefore = await bal(taker.address)
  const makerBefore = await bal(maker.address)
  const takeR = await write(wcTaker, 'take', [id, true], STAKE)
  const takeGas = takeR.gasUsed * takeR.effectiveGasPrice
  const revealR = await write(wcMaker, 'reveal', [id, true, salt])
  const revealGas = revealR.gasUsed * revealR.effectiveGasPrice
  const takerDelta = (await bal(taker.address)) - takerBefore // -stake -takeGas +2*stake
  const makerDelta = (await bal(maker.address)) - makerBefore // -revealGas +bond
  const takerOk = takerDelta === STAKE - takeGas
  const makerOk = makerDelta === BOND - revealGas
  console.log(`  taker net ${fmt(takerDelta)} (expect +stake−gas) ${takerOk ? '✓' : '✗ MISMATCH'}`)
  console.log(`  maker net ${fmt(makerDelta)} (expect +bond−gas) ${makerOk ? '✓' : '✗ MISMATCH'}`)
  if (!takerOk || !makerOk) process.exit(1)
}

// ── R2: maker wins (guess misses) ─────────────────────────────────────────────
{
  const salt = viem.keccak256(viem.toHex(`exercise-r2-${CHAIN_ID}`))
  const id = await nextId()
  console.log(`\nR2 maker-wins — offer #${id}: maker choice=true, taker guess=false`)
  const makerBefore = await bal(maker.address)
  const postR = await write(wcMaker, 'post', [commitFor(true, salt), BOND, deadline(), WINDOW], STAKE + BOND)
  await write(wcTaker, 'take', [id, false], STAKE)
  const revealR = await write(wcMaker, 'reveal', [id, true, salt])
  const gas = postR.gasUsed * postR.effectiveGasPrice + revealR.gasUsed * revealR.effectiveGasPrice
  const makerDelta = (await bal(maker.address)) - makerBefore // -(stake+bond) -gas +(2*stake+bond) = +stake -gas
  const ok = makerDelta === STAKE - gas
  console.log(`  maker net ${fmt(makerDelta)} (expect +stake−gas) ${ok ? '✓' : '✗ MISMATCH'}`)
  if (!ok) process.exit(1)
}

// ── R3: forfeit (maker bails; REAL reveal-window wait) ────────────────────────
if (process.env.SKIP_FORFEIT !== '1') {
  const salt = viem.keccak256(viem.toHex(`exercise-r3-${CHAIN_ID}`))
  const id = await nextId()
  console.log(`\nR3 forfeit — offer #${id}: maker never reveals; waiting out the ${WINDOW}s window…`)
  await write(wcMaker, 'post', [commitFor(true, salt), BOND, deadline(), WINDOW], STAKE + BOND)
  const takeR = await write(wcTaker, 'take', [id, true], STAKE)
  const takeBlock = await pc.getBlock({ blockNumber: takeR.blockNumber })
  const takerBefore = await bal(taker.address)
  const target = Number(takeBlock.timestamp) + WINDOW + 15
  while (Math.floor(Date.now() / 1000) < target) await new Promise((r) => setTimeout(r, 10_000))
  const claimR = await write(wcTaker, 'claim', [id])
  const claimGas = claimR.gasUsed * claimR.effectiveGasPrice
  const takerDelta = (await bal(taker.address)) - takerBefore // +2*stake+bond −claimGas
  const ok = takerDelta === STAKE * 2n + BOND - claimGas
  console.log(`  taker net ${fmt(takerDelta)} (expect +2·stake+bond−gas) ${ok ? '✓' : '✗ MISMATCH'}`)
  if (!ok) process.exit(1)
}

// ── R4: cancel (untaken) ──────────────────────────────────────────────────────
{
  const salt = viem.keccak256(viem.toHex(`exercise-r4-${CHAIN_ID}`))
  const id = await nextId()
  console.log(`\nR4 cancel — offer #${id}: post then cancel untaken`)
  const makerBefore = await bal(maker.address)
  const postR = await write(wcMaker, 'post', [commitFor(true, salt), BOND, deadline(), WINDOW], STAKE + BOND)
  const cancelR = await write(wcMaker, 'cancel', [id])
  const gas = postR.gasUsed * postR.effectiveGasPrice + cancelR.gasUsed * cancelR.effectiveGasPrice
  const makerDelta = (await bal(maker.address)) - makerBefore // full refund − gas
  const ok = makerDelta === -gas
  console.log(`  maker net ${fmt(makerDelta)} (expect −gas only) ${ok ? '✓' : '✗ MISMATCH'}`)
  if (!ok) process.exit(1)
}

const finalContractBal = await bal(FLIPBOOK)
console.log(`\ncontract balance after all rounds: ${fmt(finalContractBal)} PLS ${finalContractBal === 0n ? '✓ (no dust)' : '✗ FUNDS STUCK'}`)
if (finalContractBal !== 0n) process.exit(1)
console.log('✅ all paths exercised and verified')
