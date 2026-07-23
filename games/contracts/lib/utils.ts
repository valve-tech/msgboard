import * as path from 'path'
import * as fs from 'fs'
import _ from 'lodash'
import promiseLimit from 'promise-limit'
import * as viem from 'viem'
import { hdKeyToAccount } from 'viem/accounts'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'

export const limiters = {
  range: promiseLimit<number>(16),
  signers: promiseLimit<viem.WalletClient>(1),
}

export const byteword = 32n
export const maxContractSize = 24576n
export const maxBytes = maxContractSize - byteword
export const max = maxBytes / byteword
export const folders = {
  data: path.join(__dirname, '..', 'data'),
}

export type Secret = {
  secret: viem.Hex;
  preimage: viem.Hex;
  index: bigint;
}

// Placeholder for mnemonic generation logic
export const masterKey = () => {
  const seed = mnemonicToSeedSync(process.env.RANDOMNESS_MNEMONIC!)
  return HDKey.fromMasterSeed(seed)
}
// corresponds to the private key that you wish to derive
export const generateSecret = (k: viem.HDKey, accountIndex: bigint) => (
  hdKeyToAccount(k, {
    accountIndex: Number(accountIndex),
  }).getHdKey().privateKey! as viem.ByteArray
)

export const originId = (k: viem.HDKey) => {
  return viem.keccak256(k.privateKey!, 'hex')
}

// const preimageIndices =

export const createPreimages = async (
  generate: (i: bigint) => viem.ByteArray,
  offset = 0n, count = max,
) => {
  const range: bigint[] = []
  for (let i = 0n; i < count; i++) {
    range.push(offset + i)
  }
  return range.map((index) => {
    const secretBytes = generate(index)
    return {
      secret: viem.toHex(secretBytes),
      preimage: viem.keccak256(secretBytes, 'hex'),
      index,
    }
  })
}

type SecretInfo = {
  secret: viem.Hex;
  preimage: viem.Hex;
  index: bigint;
}

export const createTestPreimages = async (section = defaultSection, count = max) => {
  const addressFolder = path.join(folders.data, section.provider.toLowerCase())
  const final = section.offset + count
  const iterations = Math.ceil(Number(count) / Number(max))
  await fs.promises.mkdir(addressFolder, {
    recursive: true,
  })
  const range = _.range(0, iterations)
  return await limiters.range.map<Secret[]>(range, async (i) => {
    const start = section.offset + (BigInt(i) * max)
    const exclusiveEnd = start + max >= final ? final : start + max
    const filePath = path.join(addressFolder, `${start}-${exclusiveEnd}.json`)
    const existing = await fs.promises.readFile(filePath).catch(() => ([]))
    if (existing.length) {
      return JSON.parse(existing.toString()).map((val: SecretInfo & {
        index: string;
      }) => ({
        ...val,
        index: BigInt(val.index),
      })) as SecretInfo[]
    }
    const generated = await createPreimages((index) => {
      // a not so secret secret
      return viem.keccak256(viem.concatBytes([
        viem.hexToBytes(section.provider),
        viem.numberToBytes(index),
      ]), 'bytes')
    }, start, exclusiveEnd)
    // stash for next test
    await fs.promises.writeFile(filePath, JSON.stringify(generated.map((val) => ({
      ...val,
      index: val.index.toString(),
    }))))
    return generated
  })

  // const range = _.range(0, iterations)
  // return limiters.range.map<Secret[]>(range, async (i) => {
  //   const start = offset + (BigInt(i) * max)
  //   const end = start + max >= final ? final : start + max
  //   const filePath = path.join(addressFolder, `${start}-${end}.json`)
  //   const existing = await fs.promises.readFile(filePath).catch(() => ([]))
  //   if (existing.length) {
  //     return JSON.parse(existing.toString())
  //   }
  //   console.log('generating randomness %o %o-%o', address, start, end)
  //   const secretsAsBytes = _.range(0, Number(end - start)).map((idx) => {
  //     return viem.keccak256(viem.concatBytes([
  //       viem.hexToBytes(address),
  //       viem.numberToBytes(start + BigInt(idx)),
  //     ]), 'bytes')
  //   })
  //   const generated = _.map(secretsAsBytes, (secretBytes) => ({
  //     secret: viem.toHex(secretBytes),
  //     preimage: viem.keccak256(secretBytes, 'hex'),
  //   }))
  //   await fs.promises.writeFile(filePath, JSON.stringify(generated))
  //   return generated
  // })
}

export const dataToPreimages = (data: viem.Hex) => {
  return _(viem.hexToBytes(data))
    .chunk(32)
    .map((chunk) => viem.bytesToHex(Uint8Array.from(chunk)))
    .value()
}

export type PreimageInfo = {
  provider: viem.Hex;
  callAtChange: boolean;
  durationIsTimestamp: boolean;
  duration: bigint;
  token: viem.Hex;
  price: bigint;
  offset: bigint;
  index: bigint;
}

export type PreimageInfoOptions = Partial<PreimageInfo>

export const defaultSection: PreimageInfo = {
  provider: viem.zeroAddress,
  callAtChange: false,
  durationIsTimestamp: false,
  duration: 12n,
  token: viem.zeroAddress,
  price: viem.parseEther('100'),
  offset: 0n,
  index: 0n,
}

export const encodeToken = (inputs: Partial<PreimageInfo>) => {
  return viem.numberToHex(
    (inputs.durationIsTimestamp ? 1n : 0n) << 255n
    | (inputs.callAtChange ? 1n : 0n) << 254n
    | BigInt.asUintN(38, inputs.duration!) << 160n
    | BigInt(inputs.token!),
    { size: 32 } // encode as a uint256
  )
}

export const parseTimeline = (timeline: bigint) => ({
  owner: viem.numberToHex(BigInt.asUintN(160, timeline >> 96n), { size: 20 }),
  callAtChange: BigInt.asUintN(1, timeline >> 8n) === 1n,
  usesTimestamp: BigInt.asUintN(1, timeline >> 9n) === 1n,
  duration: BigInt.asUintN(38, timeline >> 9n),
  start: BigInt.asUintN(48, timeline >> 48n),
  contributed: BigInt.asUintN(8, timeline),
})

export const section = (inputs: Omit<PreimageInfo, 'index'> = defaultSection) => {
  return viem.keccak256(viem.concatHex([
    viem.padHex(inputs.provider, { size: 32 }),
    encodeToken(inputs),
    viem.numberToHex(inputs.price, { size: 32 }),
    viem.numberToHex(inputs.offset, { size: 32 }),
  ]), 'hex')
}

export const template = (inputs: Omit<PreimageInfo, 'index' | 'offset'> = defaultSection) => (
  section({ ...inputs, offset: 0n })
)

export const location = (section: viem.Hex, index: bigint | number) => {
  return viem.keccak256(viem.concatHex([
    section,
    viem.numberToHex(index, { size: 32 }),
  ]), 'hex')
}

export const sum = (s: PreimageInfo[]) => s.reduce<bigint>((total, { price }) => total + price, 0n)

export const contractName = {
  // Protocol contracts come from the published @gibs/random package (dependencyCompiler paths
  // in hardhat.config.ts) — the games repo never carries protocol sources.
  Consumer: '@gibs/random/contracts/Consumer.sol:Consumer',
  ConsumerIncomplete: '@gibs/random/contracts/test/ConsumerIncomplete.sol:ConsumerIncomplete',
  ConsumerEmitter: '@gibs/random/contracts/test/ConsumerEmitter.sol:ConsumerEmitter',
  Random: '@gibs/random/contracts/Random.sol:Random',
  Reader: '@gibs/random/contracts/Reader.sol:Reader',
  ERC20: 'contracts/test/ERC20.sol:ERC20',
  ERC20Solady: 'solady/src/tokens/ERC20.sol:ERC20',
  Constants: '@gibs/random/contracts/Constants.sol:Errors',
  MulticallerWithSender: 'multicaller/src/MulticallerWithSender.sol:MulticallerWithSender',
  MulticallerWithSigner: 'multicaller/src/MulticallerWithSigner.sol:MulticallerWithSigner',
  CoinFlip: 'contracts/CoinFlip.sol:CoinFlip',
  GameBase: 'contracts/GameBase.sol:GameBase',
  Raffle: 'contracts/Raffle.sol:Raffle',
  GameBaseHarness: 'contracts/test/GameBaseHarness.sol:GameBaseHarness',
  RejectableReceiver: 'contracts/test/RejectableReceiver.sol:RejectableReceiver',
} as const

export type Names = typeof contractName

export const encodeTimeline = ({
  owner,
  callAtChange,
  start,
  duration,
  durationIsTimestamp,
  count = 0n,
}: {
  owner: viem.Hex;
  start: bigint;
  duration: bigint;
  durationIsTimestamp: boolean;
  callAtChange: boolean;
  count?: bigint;
}) => {
  return viem.numberToHex((
    BigInt(owner) << 96n
    | BigInt.asUintN(48, start) << 48n
    | BigInt.asUintN(38, duration) << 10n
    | (durationIsTimestamp ? 1n : 0n) << 9n
    | (callAtChange ? 1n : 0n) << 8n
    | BigInt.asUintN(8, count)
  ), { size: 32 })
}

const slots = [
  'timeline',
  'seed',
  'latest',
  'custodied',
  'count',
] as const

const slotList = Object.values(slots)

export type Slot = typeof slotList[number]

export const slotKeyToFormer = new Map<string, (inputs: SlotInputs, slotIndexBytes: Uint8Array) => viem.Hex>([
  ['timeline', (inputs, index) => {
    const key = inputs.key!
    const keySlot = viem.keccak256(viem.concatBytes([
      viem.hexToBytes(key, { size: 32 }),
      index,
    ]))
    return keySlot
  }],
  ['latest', (inputs, index) => {
    const account = inputs.account!
    const accountSlot = viem.keccak256(viem.concatBytes([
      viem.pad(viem.hexToBytes(account), { size: 32, dir: 'left' }),
      index,
    ]))
    return accountSlot
  }],
  ['count', (inputs, index) => {
    const location = inputs.location!
    const providerKeySlot = viem.keccak256(viem.concatBytes([
      viem.pad(viem.hexToBytes(location.provider!), { size: 32, dir: 'left' }),
      index,
    ]), 'bytes')
    const locationSlot = viem.keccak256(viem.concatBytes([
      viem.toBytes(encodeToken(location)),
      providerKeySlot,
    ]), 'bytes')
    const priceSlot = viem.keccak256(viem.concatBytes([
      viem.numberToBytes(location.price!, { size: 32 }),
      locationSlot,
    ]), 'hex')
    return priceSlot
  }],
  ['custodied', (inputs, index) => {
    const { token, account } = inputs
    const accountSlot = viem.keccak256(viem.concatBytes([
      viem.pad(viem.hexToBytes(account!), { size: 32, dir: 'left' }),
      index,
    ]), 'bytes')
    const tokenSlot = viem.keccak256(viem.concatBytes([
      viem.pad(viem.hexToBytes(token!), { size: 32, dir: 'left' }),
      accountSlot,
    ]))
    return tokenSlot
  }],
])

export type SlotInputs = Partial<{
  key: viem.Hex;
  location: Partial<PreimageInfo>
  account: viem.Hex;
  token: viem.Hex;
}>

export const slot = (slot: Slot, slotInputs: SlotInputs, idx?: number) => {
  const index = _.isUndefined(idx) ? slots.indexOf(slot) : idx
  const indexBytes = viem.numberToBytes(index, { size: 32 })
  const key = slotKeyToFormer.get(slot)?.(slotInputs, indexBytes)
  if (!key) {
    throw new Error('slot not defined')
  }
  return key
}

export const toSeed = (inputs: viem.Hex[]) => (
  viem.keccak256(
    viem.hexToBytes(viem.concatHex(inputs))
  )
)
