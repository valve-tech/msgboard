import { ponder } from 'ponder:registry'
import * as schema from 'ponder:schema'
import { and, eq, lt } from 'ponder'
import * as viem from 'viem'
import * as randomUtils from '@gibs/random/lib/utils'
import { abi as randomAbi } from '@gibs/random/artifacts/contracts/Random.sol/Random.json'
import { scopedId, upsertBlock, upsertTransaction } from './utils'

/** The decoded shape of an `ink(info, data)` call's first argument. */
type InkSectionInput = {
  provider: viem.Hex
  callAtChange: boolean
  durationIsTimestamp: boolean
  duration: bigint
  token: viem.Hex
  price: bigint
  offset: bigint
  index: bigint
}

const INK_SELECTOR = viem.toFunctionSelector(
  (randomAbi as viem.Abi).find((x) => x.type === 'function' && (x as { name?: string }).name === 'ink') as viem.AbiFunction,
)

/** Walk a callTracer trace, find the inner ink() call whose reconstructed section matches the
 *  one the contract emitted, and return its decoded [sectionInput, data]. Indirect inks only. */
const inkArgsFromTrace = (
  trace: unknown,
  randomAddress: string,
  expectedSection: viem.Hex,
  provider: viem.Hex,
  offset: bigint,
): [InkSectionInput, viem.Hex] | null => {
  const ra = randomAddress.toLowerCase()
  const inputs: viem.Hex[] = []
  const walk = (frame: { to?: string; input?: string; calls?: unknown[] } | null | undefined): void => {
    if (!frame || typeof frame !== 'object') return
    if ((frame.to ?? '').toLowerCase() === ra && (frame.input ?? '').slice(0, 10).toLowerCase() === INK_SELECTOR) {
      inputs.push(frame.input as viem.Hex)
    }
    for (const sub of frame.calls ?? []) walk(sub as { to?: string; input?: string; calls?: unknown[] })
  }
  walk(trace as { to?: string; input?: string; calls?: unknown[] })
  for (const input of inputs) {
    try {
      const dec = viem.decodeFunctionData({ abi: randomAbi as viem.Abi, data: input })
      if (dec.functionName !== 'ink') continue
      const [sectionInput, data] = dec.args as unknown as [InkSectionInput, viem.Hex]
      if (randomUtils.section({ ...sectionInput, provider, offset }) === expectedSection) {
        return [sectionInput, data]
      }
    } catch {
      // not an ink() call we can decode; keep looking
    }
  }
  return null
}

// Index provider preimage commitments from the Ink EVENT. The section params (token, price,
// duration, ...) and preimage bytes live in the ink(info, data) CALLDATA, not the event:
//  - Direct ink() (the common case): decode event.transaction.input — no trace, no archive.
//  - Indirect ink() (provider/multicaller wraps it — rare): the top-level input is the wrapper,
//    so fire one on-demand debug_traceTransaction through the indexer's RPC and pull the inner call.
ponder.on('Random:Ink', async ({ event, context }) => {
  const { sender, provider, section, offset: packedOffset, pointer } = event.args
  const offset = BigInt.asUintN(128, packedOffset >> 128n)

  let inkArgs: [InkSectionInput, viem.Hex] | null = null
  try {
    const decoded = viem.decodeFunctionData({ abi: randomAbi as viem.Abi, data: event.transaction.input })
    if (decoded.functionName === 'ink') {
      const [si, d] = decoded.args as unknown as [InkSectionInput, viem.Hex]
      if (randomUtils.section({ ...si, provider, offset }) === section) inkArgs = [si, d]
    }
  } catch {
    // not a direct ink() call — fall through to the on-demand trace
  }

  if (!inkArgs) {
    let trace: unknown
    try {
      trace = await context.client.request({
        method: 'debug_traceTransaction',
        params: [event.transaction.hash, { tracer: 'callTracer' }],
      } as never)
    } catch (err) {
      console.warn(`Random:Ink ${section}: on-demand trace failed (${String(err)}); skipping`)
      return
    }
    inkArgs = inkArgsFromTrace(trace, context.contracts.Random.address, section, provider, offset)
    if (!inkArgs) {
      console.warn(`Random:Ink ${section}: no matching ink() call in trace; skipping`)
      return
    }
  }

  const [sectionInput, data] = inkArgs
  const info = { ...sectionInput, provider, offset }
  const preimages = randomUtils.dataToPreimages(data)
  const template = randomUtils.template(info)
  const pointerId = scopedId.pointer(context, section)
  const inkId = scopedId.ink(context, section)

  await upsertBlock(context, event)
  const tx = await upsertTransaction(context, event)

  await context.db.insert(schema.Pointer).values({
    orderId: pointerId,
    section,
    template,
    remaining: BigInt(preimages.length),
    count: BigInt(preimages.length),
    storage: pointer,
    lastOkTransactionId: tx.orderId,
    provider,
    token: sectionInput.token,
    price: sectionInput.price,
    duration: sectionInput.duration,
    usesTimestamp: sectionInput.durationIsTimestamp,
    callAtChange: sectionInput.callAtChange,
    offset,
    chainId: BigInt(context.chain.id),
    address: context.contracts.Random.address,
    inkId,
  })

  await context.db.insert(schema.Preimage).values(
    preimages.map((preimage, index) => ({
      orderId: scopedId.preimage(context, randomUtils.location(section, index)),
      pointerId,
      index: BigInt(index),
      template,
      section,
      accessed: false,
      data: preimage,
    })),
  )

  await context.db.insert(schema.Ink).values({
    orderId: inkId,
    transactionId: tx.orderId,
    pointerId,
    section,
    sender,
    index: BigInt(event.transaction.transactionIndex),
  })
})

ponder.on('Random:Heat', async ({ event, context }) => {
  const {
    // unused outside of indexers scoping their
    // get logs queries to the provider
    // provider,
    section,
    index,
  } = event.args
  const pointerId = scopedId.pointer(context, section)

  const pointer = await context.db.find(schema.Pointer, {
    orderId: pointerId,
  })
  if (!pointer) {
    // The ink for this section was never indexed (e.g. ink() invoked indirectly via a
    // provider/multicaller, so event.transaction.input didn't decode and the Ink handler
    // skipped it). Skip the heat rather than crash-loop the whole indexer. Fully capturing
    // these requires trace-based ink indexing — see relay-trace-method-pinning runbook.
    console.warn(`Random:Heat: no Pointer for section ${section}; skipping (indirect ink not indexed)`)
    return
  }
  const localIndex = index - pointer.offset
  const heatId = scopedId.heat(context, randomUtils.location(section, localIndex))
  const preimageId = scopedId.preimage(context, randomUtils.location(section, localIndex))
  await upsertBlock(context, event)
  const tx = await upsertTransaction(context, event)
  const preimage = await context.db.find(schema.Preimage, {
    orderId: preimageId,
  })
  if (!preimage) {
    console.log(preimageId, event.block, event.transaction, event.transactionReceipt)
  }
  await context.db
    .update(schema.Preimage, {
      orderId: preimageId,
    })
    .set({
      accessed: true,
      heatId,
      timestamp: event.block.timestamp,
    })
  await context.db
    .update(schema.Pointer, {
      orderId: pointerId,
    })
    .set(({ remaining, ...current }) => ({
      ...current,
      remaining: remaining - 1n,
    }))
  await context.db.insert(schema.Heat).values({
    transactionId: tx.orderId,
    index: BigInt(event.log.logIndex),
    startId: undefined,
    preimageId,
    orderId: heatId,
  })
})

ponder.on('Random:Start', async ({ event, context }) => {
  const { owner, key } = event.args
  await upsertBlock(context, event)
  const tx = await upsertTransaction(context, event)
  const startId = scopedId.start(context, key)
  await context.db.insert(schema.Start).values({
    orderId: startId,
    chopped: false,
    transactionId: tx.orderId,
    owner,
    key,
    index: BigInt(event.log.logIndex),
  })
  const heats = await context.db.sql
    .select()
    .from(schema.Heat)
    .where(and(eq(schema.Heat.transactionId, tx.orderId), lt(schema.Heat.index, BigInt(event.log.logIndex))))
    .execute()
  // .where('index', '<', BigInt(event.log.logIndex)).execute()
  // const heats = await context.db.findMany(schema.Heat, {
  //   where: {
  //     transactionId: tx.orderId,
  //     index: { lt: BigInt(event.log.logIndex) },
  //     // startId: { equals: undefined },
  //   },
  // })
  const heatIds = heats.filter((item) => !item.startId).map((item) => item.orderId)
  if (!heatIds.length) {
    return
  }
  const preimageIds = heats.map((item) => item.preimageId)
  for (const preimageId of preimageIds) {
    await context.db
      .update(schema.Preimage, {
        orderId: preimageId,
      })
      .set({
        startId,
      })
  }
  for (const heatId of heatIds) {
    await context.db
      .update(schema.Heat, {
        orderId: heatId,
      })
      .set({
        startId,
      })
  }
})

ponder.on('Random:Link', async ({ event, context }) => {
  const { location, formerSecret } = event.args
  const linkId = scopedId.link(context, location)
  const preimageId = scopedId.preimage(context, location)
  const preimage = await context.db.find(schema.Preimage, { orderId: preimageId })
  if (!preimage) {
    console.warn(`Random:Link: no Preimage for location ${location}; skipping (indirect ink not indexed)`)
    return
  }
  await upsertBlock(context, event)
  const tx = await upsertTransaction(context, event)
  await context.db
    .update(schema.Preimage, {
      orderId: preimageId,
    })
    .set({
      secret: formerSecret,
      linkId,
    })
  await context.db
    .update(schema.Pointer, {
      orderId: preimage.pointerId,
    })
    .set({
      lastOkTransactionId: tx.orderId,
    })
  await context.db.insert(schema.Link).values({
    orderId: linkId,
    index: BigInt(event.log.logIndex),
    preimageId,
    transactionId: tx.orderId,
  })
})

ponder.on('Random:Cast', async ({ event, context }) => {
  const { key, seed } = event.args
  const castId = scopedId.cast(context, key)
  const startId = scopedId.start(context, key)
  await upsertBlock(context, event)
  const tx = await upsertTransaction(context, event)
  const preimageIdsUnderStart = await context.db.sql
    .select()
    .from(schema.Preimage)
    .where(eq(schema.Preimage.startId, startId))
    .execute()
  const preimageIds = preimageIdsUnderStart.map((i) => i.orderId)
  if (!preimageIds.length) {
    console.warn(`Random:Cast: no Preimages under start ${startId}; skipping (indirect ink not indexed)`)
    return
  }
  for (const preimageId of preimageIds) {
    await context.db
      .update(schema.Preimage, {
        orderId: preimageId,
      })
      .set({
        castId,
      })
  }
  await context.db
    .update(schema.Start, {
      orderId: startId,
    })
    .set({
      castId,
    })
  await context.db.insert(schema.Cast).values({
    orderId: castId,
    index: BigInt(event.log.logIndex),
    transactionId: tx.orderId,
    key,
    startId,
    seed,
  })
})

ponder.on('Random:Reveal', async ({ event, context }) => {
  const preimageId = scopedId.preimage(context, event.args.location)
  const preimage = await context.db.find(schema.Preimage, { orderId: preimageId })
  if (!preimage) {
    console.warn(`Random:Reveal: no Preimage for location ${event.args.location}; skipping (indirect ink not indexed)`)
    return
  }
  await upsertBlock(context, event)
  const tx = await upsertTransaction(context, event)
  const revealId = scopedId.reveal(context, event.args.location)
  await context.db.insert(schema.Reveal).values({
    index: BigInt(event.log.logIndex),
    transactionId: tx.orderId,
    preimageId,
    orderId: revealId,
  })
  await context.db
    .update(schema.Preimage, {
      orderId: preimageId,
    })
    .set({
      secret: event.args.formerSecret,
      revealId,
    })
  await context.db
    .update(schema.Pointer, {
      orderId: preimage.pointerId,
    })
    .set({
      lastOkTransactionId: tx.orderId,
    })
})

ponder.on('Random:Expired', async ({ event, context }) => {
  const { key } = event.args
  const startId = scopedId.start(context, key)
  const castId = scopedId.cast(context, key)
  const cast = await context.db.find(schema.Cast, { orderId: castId })
  if (!cast) {
    console.warn(`Random:Expired: no Cast ${castId}; skipping (indirect ink not indexed)`)
    return
  }
  const expiredId = scopedId.expired(context, key)
  await upsertBlock(context, event)
  const tx = await upsertTransaction(context, event)
  await context.db.insert(schema.Expired).values({
    orderId: expiredId,
    index: BigInt(event.log.logIndex),
    transactionId: tx.orderId,
    startId,
    castId,
  })
  await context.db
    .update(schema.Cast, {
      orderId: castId,
    })
    .set({
      expiredId,
    })
})

ponder.on('Random:Bleach', async ({ event, context }) => {
  const { section } = event.args
  const bleachId = scopedId.bleach(context, section)
  const pointerId = scopedId.pointer(context, section)
  const pointer = await context.db.find(schema.Pointer, { orderId: pointerId })
  if (!pointer) {
    console.warn(`Random:Bleach: no Pointer for section ${section}; skipping (indirect ink not indexed)`)
    return
  }
  await upsertBlock(context, event)
  const tx = await upsertTransaction(context, event)
  await context.db.insert(schema.Bleach).values({
    orderId: bleachId,
    index: BigInt(event.log.logIndex),
    transactionId: tx.orderId,
    pointerId,
  })
  await context.db
    .update(schema.Pointer, {
      orderId: pointerId,
    })
    .set({
      bleachId,
    })
})
