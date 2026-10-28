import { onchainTable, relations } from 'ponder'

export const Block = onchainTable('Block', (t) => ({
  orderId: t.hex().notNull().primaryKey(),
  hash: t.hex().notNull(),
  timestamp: t.bigint().notNull(),
  number: t.bigint().notNull(),
}))

export const Transaction = onchainTable('Transaction', (t) => ({
  orderId: t.hex().notNull().primaryKey(),
  hash: t.hex().notNull(),
  index: t.bigint().notNull(),
  blockId: t.hex().notNull(),
}))

export const TransactionRelations = relations(Transaction, ({ one }) => ({
  block: one(Block, { fields: [Transaction.blockId], references: [Block.orderId] }),
}))

export const Pointer = onchainTable('Pointer', (t) => ({
  orderId: t.hex().notNull().primaryKey(),
  section: t.hex().notNull(),
  template: t.hex().notNull(),
  remaining: t.bigint().notNull(),
  count: t.bigint().notNull(),
  storage: t.hex().notNull(),
  lastOkTransactionId: t.hex().notNull(),
  provider: t.hex().notNull(),
  token: t.hex().notNull(),
  price: t.bigint().notNull(),
  duration: t.bigint().notNull(),
  usesTimestamp: t.boolean().notNull(),
  callAtChange: t.boolean().notNull(),
  offset: t.bigint().notNull(),
  bleachId: t.hex(),
  chainId: t.bigint().notNull(),
  address: t.hex().notNull(),
  inkId: t.hex().notNull(),
}))

export const PointerRelations = relations(Pointer, ({ one, many }) => ({
  lastOkTransaction: one(Transaction, { fields: [Pointer.lastOkTransactionId], references: [Transaction.orderId] }),
  bleach: one(Bleach, { fields: [Pointer.bleachId], references: [Bleach.orderId] }),
  ink: one(Ink, { fields: [Pointer.inkId], references: [Ink.orderId] }),
  preimages: many(Preimage),
}))

export const Bleach = onchainTable('Bleach', (t) => ({
  orderId: t.hex().notNull().primaryKey(),
  index: t.bigint().notNull(),
  transactionId: t.hex().notNull(),
  pointerId: t.hex().notNull(),
}))

export const BleachRelations = relations(Bleach, ({ one }) => ({
  pointer: one(Pointer, { fields: [Bleach.pointerId], references: [Pointer.orderId] }),
  transaction: one(Transaction, { fields: [Bleach.transactionId], references: [Transaction.orderId] }),
}))

export const Ink = onchainTable('Ink', (t) => ({
  orderId: t.hex().notNull().primaryKey(),
  transactionId: t.hex().notNull(),
  pointerId: t.hex().notNull(),
  section: t.hex().notNull(),
  sender: t.hex().notNull(),
  index: t.bigint().notNull(),
}))

export const InkRelations = relations(Ink, ({ one }) => ({
  pointer: one(Pointer, { fields: [Ink.orderId], references: [Pointer.inkId] }),
  transaction: one(Transaction, { fields: [Ink.transactionId], references: [Transaction.orderId] }),
}))

export const Start = onchainTable('Start', (t) => ({
  orderId: t.hex().notNull().primaryKey(),
  owner: t.hex().notNull(),
  key: t.hex().notNull(),
  index: t.bigint().notNull(),
  chopped: t.boolean().notNull(),
  transactionId: t.hex().notNull(),
  expiredId: t.hex(),
  castId: t.hex(),
}))

export const StartRelations = relations(Start, ({ one, many }) => ({
  pointer: one(Pointer, { fields: [Start.orderId], references: [Pointer.inkId] }),
  transaction: one(Transaction, { fields: [Start.transactionId], references: [Transaction.orderId] }),
  heat: many(Heat),
  cast: one(Cast, { fields: [Start.castId], references: [Cast.orderId] }),
  expired: one(Expired, { fields: [Start.expiredId], references: [Expired.orderId] }),
}))

export const Heat = onchainTable('Heat', (t) => ({
  orderId: t.hex().notNull().primaryKey(),
  transactionId: t.hex().notNull(),
  index: t.bigint().notNull(),
  preimageId: t.hex().notNull(),
  startId: t.hex(),
}))

export const HeatRelations = relations(Heat, ({ one }) => ({
  preimage: one(Preimage, { fields: [Heat.preimageId], references: [Preimage.orderId] }),
  start: one(Start, { fields: [Heat.startId], references: [Start.orderId] }),
  transaction: one(Transaction, { fields: [Heat.transactionId], references: [Transaction.orderId] }),
}))

export const Preimage = onchainTable('Preimage', (t) => ({
  orderId: t.hex().notNull().primaryKey(),
  pointerId: t.hex().notNull(),
  index: t.bigint().notNull(),
  template: t.hex().notNull(),
  section: t.hex().notNull(),
  accessed: t.boolean().notNull(),
  data: t.hex().notNull(),
  secret: t.hex(),
  timestamp: t.bigint(),
  heatId: t.hex(),
  startId: t.hex(),
  castId: t.hex(),
  revealId: t.hex(),
  linkId: t.hex(),
}))

export const PreimageRelations = relations(Preimage, ({ one }) => ({
  pointer: one(Pointer, { fields: [Preimage.pointerId], references: [Pointer.orderId] }),
  heat: one(Heat, { fields: [Preimage.heatId], references: [Heat.orderId] }),
  start: one(Start, { fields: [Preimage.startId], references: [Start.orderId] }),
  cast: one(Cast, { fields: [Preimage.castId], references: [Cast.orderId] }),
  reveal: one(Reveal, { fields: [Preimage.revealId], references: [Reveal.orderId] }),
  link: one(Link, { fields: [Preimage.linkId], references: [Link.orderId] }),
}))

export const Cast = onchainTable('Cast', (t) => ({
  orderId: t.hex().notNull().primaryKey(),
  index: t.bigint().notNull(),
  key: t.hex().notNull(),
  transactionId: t.hex().notNull(),
  startId: t.hex().notNull(),
  expiredId: t.hex(),
  seed: t.hex(),
}))

export const CastRelations = relations(Cast, ({ one, many }) => ({
  start: one(Start, { fields: [Cast.startId], references: [Start.orderId] }),
  expired: one(Expired, { fields: [Cast.expiredId], references: [Expired.orderId] }),
  // reveal: many(Reveal),
  link: many(Link),
}))

export const Expired = onchainTable('Expired', (t) => ({
  orderId: t.hex().notNull().primaryKey(),
  startId: t.hex().notNull(),
  castId: t.hex().notNull(),
  index: t.bigint().notNull(),
  transactionId: t.hex().notNull(),
}))

export const ExpiredRelations = relations(Expired, ({ one }) => ({
  start: one(Start, { fields: [Expired.startId], references: [Start.orderId] }),
  cast: one(Cast, { fields: [Expired.castId], references: [Cast.orderId] }),
  transaction: one(Transaction, { fields: [Expired.transactionId], references: [Transaction.orderId] }),
}))

export const Reveal = onchainTable('Reveal', (t) => ({
  orderId: t.hex().notNull().primaryKey(),
  index: t.bigint().notNull(),
  transactionId: t.hex().notNull(),
  preimageId: t.hex().notNull(),
}))

export const RevealRelations = relations(Reveal, ({ one }) => ({
  preimage: one(Preimage, { fields: [Reveal.preimageId], references: [Preimage.orderId] }),
  transaction: one(Transaction, { fields: [Reveal.transactionId], references: [Transaction.orderId] }),
}))

export const Unveil = onchainTable('Unveil', (t) => ({
  orderId: t.hex().notNull().primaryKey(),
  index: t.bigint().notNull(),
  transactionId: t.hex().notNull(),
  consumerPreimageId: t.hex().notNull(),
}))

export const UnveilRelations = relations(Unveil, ({ one }) => ({
  consumerPreimage: one(ConsumerPreimage, {
    fields: [Unveil.consumerPreimageId],
    references: [ConsumerPreimage.orderId],
  }),
  transaction: one(Transaction, { fields: [Unveil.transactionId], references: [Transaction.orderId] }),
}))

export const ConsumerPreimage = onchainTable('ConsumerPreimage', (t) => ({
  orderId: t.hex().notNull().primaryKey(),
  owner: t.hex().notNull(),
  identifier: t.bigint().notNull(),
  transactionId: t.hex().notNull(),
  startId: t.hex().notNull(),
  undermineId: t.hex().notNull(),
  consumerPreimageId: t.hex().notNull(),
}))

export const ConsumerPreimageRelations = relations(ConsumerPreimage, ({ one }) => ({
  transaction: one(Transaction, { fields: [ConsumerPreimage.transactionId], references: [Transaction.orderId] }),
  start: one(Start, { fields: [ConsumerPreimage.startId], references: [Start.orderId] }),
  undermine: one(Undermine, { fields: [ConsumerPreimage.undermineId], references: [Undermine.orderId] }),
}))

export const Undermine = onchainTable('Undermine', (t) => ({
  orderId: t.hex().notNull().primaryKey(),
  index: t.bigint().notNull(),
  transactionId: t.hex().notNull(),
  consumerPreimageId: t.hex().notNull(),
  owner: t.hex().notNull(),
  chainId: t.hex().notNull(),
}))

export const UndermineRelations = relations(Undermine, ({ one }) => ({
  consumerPreimage: one(ConsumerPreimage, {
    fields: [Undermine.consumerPreimageId],
    references: [ConsumerPreimage.orderId],
  }),
  chain: one(Chain, { fields: [Undermine.chainId], references: [Chain.orderId] }),
  transaction: one(Transaction, { fields: [Undermine.transactionId], references: [Transaction.orderId] }),
}))

export const Chain = onchainTable('Chain', (t) => ({
  orderId: t.hex().notNull().primaryKey(),
  owner: t.hex().notNull(),
  identifier: t.bigint().notNull(),
  consumerPreimageId: t.hex().notNull(),
  undermineId: t.hex().notNull(),
  startId: t.hex().notNull(),
  transactionId: t.hex().notNull(),
}))

export const ChainRelations = relations(Chain, ({ one }) => ({
  consumerPreimage: one(ConsumerPreimage, {
    fields: [Chain.consumerPreimageId],
    references: [ConsumerPreimage.orderId],
  }),
  undermine: one(Undermine, { fields: [Chain.undermineId], references: [Undermine.orderId] }),
  start: one(Start, { fields: [Chain.startId], references: [Start.orderId] }),
  transaction: one(Transaction, { fields: [Chain.transactionId], references: [Transaction.orderId] }),
}))

export const Link = onchainTable('Link', (t) => ({
  orderId: t.hex().notNull().primaryKey(),
  index: t.bigint().notNull(),
  transactionId: t.hex().notNull(),
  preimageId: t.hex().notNull(),
  castId: t.hex(),
}))

export const LinkRelations = relations(Link, ({ one }) => ({
  preimage: one(Preimage, { fields: [Link.preimageId], references: [Preimage.orderId] }),
  cast: one(Cast, { fields: [Link.castId], references: [Cast.orderId] }),
  transaction: one(Transaction, { fields: [Link.transactionId], references: [Transaction.orderId] }),
  reveal: one(Reveal, { fields: [Link.castId], references: [Reveal.orderId] }),
}))
