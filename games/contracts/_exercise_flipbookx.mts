/**
 * On-chain exercise of a deployed FlipBookX (test artifact, not committed): the variant-B cycle
 * with REAL off-chain signed authorizations over the REAL x402PLS wrapper.
 *   R1 full flip (taker wins)  · R2 full flip (maker wins) · R3 maker default (real window wait)
 * Maker = mnemonic account 0, taker = account 1, relayer/crank = account 2 (proves relayability).
 *
 *   MNEMONIC=... RPC_URL=... CHAIN_ID=943 FLIPBOOKX=0x... [SKIP_DEFAULT=1] npx tsx _exercise_flipbookx.mts
 */
import * as viem from 'viem'
import { mnemonicToAccount } from 'viem/accounts'

const RPC = process.env.RPC_URL ?? 'https://games.msgboard.xyz/rpc/evm/943'
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 943)
const BOOK = process.env.FLIPBOOKX as viem.Hex
if (!BOOK) throw new Error('set FLIPBOOKX')
const mnemonic = process.env.MNEMONIC
if (!mnemonic) throw new Error('set MNEMONIC')
const X402PLS = '0xeb274050cb029288B8A4F232Da8d23F393d54A1E' as const

const tokenAbi = viem.parseAbi([
  'function wrap() payable',
  'function unwrap(uint256 amount)',
  'function balanceOf(address) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
])
const bookAbi = viem.parseAbi([
  'struct Offer { address maker; bytes32 commit; uint256 stake; uint256 makerBond; uint256 takerBond; uint64 takeDeadline; uint32 makerRevealWindow; uint32 takerRevealWindow; }',
  'function offerId(Offer o) view returns (bytes32)',
  'function takerNonce(bytes32 id, address taker) pure returns (bytes32)',
  'function take(Offer o, bytes makerSig, address taker, bytes32 guessCommit, bytes takerSig) returns (bytes32)',
  'function revealChoice(bytes32 id, bool choice, bytes32 salt)',
  'function revealGuess(bytes32 id, bool guess, bytes32 salt2)',
  'function claimMakerDefault(bytes32 id)',
])

const chain = { id: CHAIN_ID, name: `c${CHAIN_ID}`, nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const
const pc = viem.createPublicClient({ chain, transport: viem.http(RPC) })
const maker = mnemonicToAccount(mnemonic)
const taker = mnemonicToAccount(mnemonic, { addressIndex: 1 })
const crank = mnemonicToAccount(mnemonic, { addressIndex: 2 })
const wc = (a: typeof maker) => viem.createWalletClient({ account: a, chain, transport: viem.http(RPC) })
const quoted = (await pc.getGasPrice()) * 3n
const legacy = { gasPrice: quoted < viem.parseGwei('0.1') ? viem.parseGwei('3') : quoted, type: 'legacy' as const }

const STAKE = viem.parseEther('0.5')
const BOND = viem.parseEther('0.1')
const W = 300 // MIN windows — keeps the default wait short

const bal = (a: viem.Hex) => pc.readContract({ address: X402PLS, abi: tokenAbi, functionName: 'balanceOf', args: [a] })
const fmt = viem.formatEther
const send = async (account: typeof maker, fn: string, args: unknown[], value?: bigint, address: viem.Hex = BOOK, abi: viem.Abi = bookAbi as viem.Abi) => {
  const hash = await wc(account).writeContract({ address, abi, functionName: fn, args, value, ...legacy })
  const r = await pc.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 3_000 })
  if (r.status !== 'success') throw new Error(`${fn} reverted: ${hash}`)
  console.log(`  ${fn} ✓ ${hash} (block ${r.blockNumber})`)
  return r
}

const RECEIVE_TYPEHASH = viem.keccak256(viem.toBytes('ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'))
const domain = await pc.readContract({ address: X402PLS, abi: tokenAbi, functionName: 'DOMAIN_SEPARATOR' })
const authDigest = (from: viem.Hex, value: bigint, validBefore: bigint, nonce: viem.Hex) =>
  viem.keccak256(viem.concatHex([
    '0x1901', domain,
    viem.keccak256(viem.encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
      [RECEIVE_TYPEHASH, from, BOOK, value, 0n, validBefore, nonce],
    )),
  ]))
const signAuth = async (account: typeof maker, value: bigint, validBefore: bigint, nonce: viem.Hex) =>
  account.sign({ hash: authDigest(account.address, value, validBefore, nonce) })

console.log(`FlipBookX exercise on ${CHAIN_ID} @ ${BOOK} (x402PLS ${X402PLS})`)

// the crank pays every transaction's gas — fund it once from the maker. Mainnet gas runs
// hundreds of PLS per tx (base fee ~3e5 gwei), so the float is chain-sized.
const GAS_FLOAT = CHAIN_ID === 369 ? viem.parseEther('3000') : viem.parseEther('3')
if ((await pc.getBalance({ address: crank.address })) < GAS_FLOAT / 2n) {
  const h = await wc(maker).sendTransaction({ to: crank.address, value: GAS_FLOAT, ...legacy })
  await pc.waitForTransactionReceipt({ hash: h, timeout: 120_000 })
  console.log('  crank funded for gas')
}

// wrap enough for the rounds (maker + taker); crank needs only gas.
for (const [who, a] of [['maker', maker], ['taker', taker]] as const) {
  const have = await bal(a.address)
  if (have < viem.parseEther('2')) {
    await send(a, 'wrap', [], viem.parseEther('3'), X402PLS, tokenAbi as viem.Abi)
    console.log(`  ${who} wrapped → ${fmt(await bal(a.address))} x402PLS`)
  }
}

const round = async (label: string, choice: boolean, guess: boolean, makerDefaults: boolean) => {
  const salt = viem.keccak256(viem.toHex(`${label}-salt-${CHAIN_ID}-${Date.now()}`))
  const salt2 = viem.keccak256(viem.toHex(`${label}-salt2-${CHAIN_ID}-${Date.now()}`))
  const offer = {
    maker: maker.address,
    commit: viem.keccak256(viem.encodeAbiParameters([{ type: 'address' }, { type: 'bool' }, { type: 'bytes32' }], [maker.address, choice, salt])),
    stake: STAKE, makerBond: BOND, takerBond: BOND,
    takeDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    makerRevealWindow: W, takerRevealWindow: W,
  }
  const id = await pc.readContract({ address: BOOK, abi: bookAbi, functionName: 'offerId', args: [offer] }) as viem.Hex
  const tNonce = await pc.readContract({ address: BOOK, abi: bookAbi, functionName: 'takerNonce', args: [id, taker.address] }) as viem.Hex
  // The OFF-CHAIN part: two signatures, zero transactions, zero locked capital.
  const makerSig = await signAuth(maker, STAKE + BOND, offer.takeDeadline, id)
  const takerSig = await signAuth(taker, STAKE + BOND, offer.takeDeadline, tNonce)
  const guessCommit = viem.keccak256(viem.encodeAbiParameters([{ type: 'address' }, { type: 'bool' }, { type: 'bytes32' }], [taker.address, guess, salt2]))

  console.log(`\n${label} — offer ${id.slice(0, 10)}… choice=${choice} guess=${guess}${makerDefaults ? ' (maker will bail)' : ''}`)
  const m0 = await bal(maker.address); const t0 = await bal(taker.address)
  // the CRANK submits — neither player pays gas for the take
  const takeR = await send(crank, 'take', [offer, makerSig, taker.address, guessCommit, takerSig])
  if ((await bal(BOOK)) !== 2n * STAKE + 2n * BOND) throw new Error('escrow mismatch')

  if (makerDefaults) {
    const takeBlock = await pc.getBlock({ blockNumber: takeR.blockNumber })
    const target = Number(takeBlock.timestamp) + W + 15
    console.log(`  waiting out the real ${W}s maker window…`)
    while (Math.floor(Date.now() / 1000) < target) await new Promise((r) => setTimeout(r, 10_000))
    await send(crank, 'claimMakerDefault', [id])
    const tD = (await bal(taker.address)) - t0
    console.log(`  taker net ${fmt(tD)} (expect +stake+makerBond) ${tD === STAKE + BOND ? '✓' : '✗ MISMATCH'}`)
    if (tD !== STAKE + BOND) process.exit(1)
  } else {
    await send(crank, 'revealChoice', [id, choice, salt])
    await send(crank, 'revealGuess', [id, guess, salt2])
    const mD = (await bal(maker.address)) - m0
    const tD = (await bal(taker.address)) - t0
    const takerWins = guess === choice
    const mOk = mD === (takerWins ? -STAKE : STAKE)
    const tOk = tD === (takerWins ? STAKE : -STAKE)
    console.log(`  maker net ${fmt(mD)} ${mOk ? '✓' : '✗'} | taker net ${fmt(tD)} ${tOk ? '✓' : '✗'} (gasless for both — crank paid)`)
    if (!mOk || !tOk) process.exit(1)
  }
  if ((await bal(BOOK)) !== 0n) throw new Error('DUST LEFT')
  console.log('  book balance 0 ✓')
}

await round('R1 taker-wins', true, true, false)
await round('R2 maker-wins', true, false, false)
if (process.env.SKIP_DEFAULT !== '1') await round('R3 maker-default', false, true, true)
console.log('\n✅ variant B exercised and verified — off-chain offers, real wrapper, exact balances')
