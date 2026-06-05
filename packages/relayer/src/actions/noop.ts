import type { RelayerAction } from '../types.js'

/** An action that does nothing. For sink-only relayers (archivist, flagger). */
export const noopAction = <T>(): RelayerAction<T> => ({
  describe: () => 'noop',
  execute: async () => ({ ok: true }),
})
