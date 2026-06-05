import type { RelayerContext, RelayerSource } from '../types.js'

/** A source that produces exactly one fresh item per poll. For producers like spam writers. */
export const generatedSource = <T>(
  produce: (context: RelayerContext) => T | Promise<T>,
): RelayerSource<T> => ({
  poll: async (context) => [await produce(context)],
})
