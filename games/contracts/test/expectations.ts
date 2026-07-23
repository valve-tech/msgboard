import * as viem from 'viem'
import _ from 'lodash'
import { confirmTx, type Context } from './utils'
import type { ERC20$Type } from '../artifacts/solady/src/tokens/ERC20.sol/ERC20'

export const revertedWithCustomError = async (
  contract: viem.GetContractReturnType,
  p: Promise<any>,
  errorName: string,
  args?: any[],
) => {
  let threw = false
  let e!: Error
  try {
    await p
  } catch (err: any) {
    threw = true
    e = err
  }
  if (!threw) {
    throw new Error('expected revert, did not')
  }
  // const err = e as viem.SendTransactionErrorType
  const rpcError = e as viem.RpcError
  if (e) {
    // console.dir(rpcError.walk())
    if (rpcError.details && rpcError.details.includes(errorName)) {
      // check args
      if (!args || !args.length) {
        return
      }
      // be sure to implement args check!
    }
  }
  // Collect every candidate revert payload and try to decode each — the error shapes differ by
  // Node version and instrumentation:
  //  - a cause's structured `.data` is USUALLY the revert data, but on some providers the first
  //    `.data` in the chain is the REQUEST calldata (a function selector), so it can't be trusted
  //    alone — a failed decode must fall through to the next candidate, not fail the assertion;
  //  - under solidity-coverage the revert often exists ONLY as prose ("… unrecognized custom
  //    error (return data: 0x…)") somewhere in the cause chain's details/message text.
  const candidates: string[] = []
  try {
    const er = rpcError.walk((err: unknown) => !!(err as any).data)
    const rawData = (er as any)?.data
    if (typeof rawData === 'string' && rawData.startsWith('0x')) candidates.push(rawData)
    else if (typeof rawData === 'object' && rawData !== null && typeof rawData.data === 'string') {
      candidates.push(rawData.data)
    }
  } catch {
    // not a viem error chain — the prose scan below still gets its shot
  }
  {
    let text = ''
    for (let cur: any = rpcError; cur; cur = cur.cause) {
      text += ` ${cur.details ?? ''} ${cur.shortMessage ?? ''} ${cur.message ?? ''}`
    }
    const prose = text.match(/return data: (0x[0-9a-fA-F]+)/)?.[1]
    if (prose && !candidates.includes(prose)) candidates.push(prose)
  }
  for (const hexData of candidates) {
    try {
      const parsed = viem.decodeErrorResult({
        abi: contract.abi,
        data: hexData as `0x${string}`,
      })
      if (parsed.errorName === errorName) {
        if (!parsed.args || _.isEqual(parsed.args, args)) {
          return
        }
      }
      console.log(parsed)
    } catch {
      // this candidate wasn't decodable revert data (or the abi doesn't know it) — try the next
    }
  }
  console.log('failed to check custom error, original error:', e)
  throw new Error('unable to check error')
}

type Filter = any[] | Record<string, any>

const _emit = async (
  ctx: Context,
  _hash: viem.Hex | Promise<viem.Hex>,
  contract: viem.GetContractReturnType,
  eventName: string,
  args?: Filter | Filter[],
): Promise<[(null | Filter)[], viem.Hex, viem.Log[], viem.Log[]]> => {
  const hash = await _hash
  const client = await ctx.hre.viem.getPublicClient()
  const receipt = await client.getTransactionReceipt({
    hash,
  })
  const allEvents = viem.parseEventLogs({
    logs: receipt.logs,
    abi: contract.abi,
  })
  let a!: (null | Filter)[]
  if (!args) {
    a = [null]
  } else if (!Array.isArray(args) || !_.isObjectLike(args[0])) {
    a = [args as any[]]
  } else {
    a = args
  }
  return [
    a,
    contract.address,
    _(a)
      .map((fltr) => {
        let objectArgs!: Record<string, any>
        const filter = {
          eventName,
          address: contract.address,
        } as Partial<viem.ParseEventLogsReturnType<any, any, any, any>[0]>
        if (Array.isArray(fltr)) {
          // no named args, order matters
          const entry = _.find(contract.abi, {
            type: 'event',
            name: eventName,
          }) as viem.AbiEvent
          objectArgs = _.reduce(
            entry.inputs,
            (a, arg, i) => {
              a[arg.name!] = fltr[i]
              return a
            },
            {} as Record<string, any>,
          )
          ;(filter as any).args = objectArgs
        } else if (fltr) {
          // is an object
          ;(filter as any).args = fltr
        } // otherwise don't set the args property so that lodash doesn't filter against it
        return _.find(allEvents, filter) as viem.Log
      })
      .compact()
      .value(),
    allEvents,
  ]
}

export const emit = async (...args: Parameters<typeof _emit>) => {
  const [filters, address, events, all] = await _emit(...args)
  if (filters.length === events.length) {
    return
  }
  console.log('address=%o filters=%o events=%o all=%o', address, filters, events, all)
  throw new Error('unable to find event')
}

export const not = {
  emit: async (...args: Parameters<typeof _emit>) => {
    const [filters, address, events, all] = await _emit(...args)
    if (filters.length === events.length) {
      console.log('address=%o filters=%o events=%o all=%o', address, filters, events, all)
      throw new Error('found event!')
    }
  },
}

const changeBalances = async (
  accounts: (viem.WalletClient | viem.Hex)[],
  deltas: bigint[],
  getter: (addr: viem.Hex) => Promise<bigint>,
) => {
  const addresses = accounts.map((acc) => (_.isString(acc) ? acc : acc.account!.address))
  const actualDeltas = await Promise.all(addresses.map(getter))
  const nonMatch = _.filter(addresses, (addr, index) => {
    const positedDelta = deltas[index]
    const actualDelta = actualDeltas[index]
    if (positedDelta !== actualDelta) {
      console.log('%o expected delta %o, actual %o', addr, positedDelta, actualDelta)
      return true
    }
  })
  if (nonMatch.length) {
    console.log(actualDeltas)
    throw new Error('change check failed')
  }
}

export const changeEtherBalances = async (
  ctx: Context,
  _receipt: Promise<viem.WriteContractReturnType> | viem.WriteContractReturnType,
  accounts: (viem.WalletClient | viem.Hex)[],
  deltas: bigint[],
  excludeGasConsumption = true,
) => {
  const provider = await ctx.hre.viem.getPublicClient()
  const receipt = await confirmTx(ctx, _receipt)
  const consumed = receipt.gasUsed * receipt.effectiveGasPrice
  return await changeBalances(accounts, deltas, async (address) => {
    const before = provider.getBalance({
      address,
      blockNumber: receipt.blockNumber - 1n,
    })
    const after = provider.getBalance({
      address,
      blockNumber: receipt.blockNumber,
    })
    let [b, a] = await Promise.all([before, after])
    if (excludeGasConsumption) {
      if (receipt.from === address) {
        a += consumed
      }
    }
    return a - b
  })
}

export type CheckResultOpts = {
  provider: viem.PublicClient
  address: viem.Hex
  blockNumber: bigint
}

export const changeResults = async (
  ctx: Context,
  _receipt: Promise<viem.WriteContractReturnType> | viem.WriteContractReturnType,
  accounts: (viem.WalletClient | viem.Hex)[],
  deltas: bigint[],
  checker: (opts: CheckResultOpts) => Promise<bigint>,
) => {
  const provider = await ctx.hre.viem.getPublicClient()
  const receipt = await confirmTx(ctx, _receipt)
  return await changeBalances(accounts, deltas, async (address) => {
    const before = checker({ provider, address, blockNumber: receipt.blockNumber - 1n })
    const after = checker({ provider, address, blockNumber: receipt.blockNumber })
    let [b, a] = await Promise.all([before, after])
    return a - b
  })
}

export const changeTokenBalances = async (
  ctx: Context,
  contract: viem.GetContractReturnType<ERC20$Type['abi']>,
  _receipt: Promise<viem.WriteContractReturnType> | viem.WriteContractReturnType,
  accounts: (viem.WalletClient | viem.Hex)[],
  deltas: bigint[],
) => {
  const provider = await ctx.hre.viem.getPublicClient()
  const receipt = await confirmTx(ctx, _receipt)
  const c = viem.getContract({
    ...contract,
    client: provider,
  })
  return await changeBalances(accounts, deltas, async (address) => {
    const before = c.read.balanceOf([address], {
      blockNumber: receipt.blockNumber - 1n,
    })
    const after = c.read.balanceOf([address], {
      blockNumber: receipt.blockNumber,
    })
    let [b, a] = await Promise.all([before, after])
    return a - b
  })
}
