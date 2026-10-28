import { ponder } from 'ponder:registry'
import * as schema from 'ponder:schema'
import { scopedId, upsertBlock, upsertTransaction } from './utils'

ponder.on('Reader:Ok', async ({ event, context }) => {
  await upsertBlock(context, event)
  const tx = await upsertTransaction(context, event)
  await context.db
    .update(schema.Pointer, {
      orderId: scopedId.pointer(context, event.args.section),
    })
    .set({
      lastOkTransactionId: tx.orderId,
    })
})
