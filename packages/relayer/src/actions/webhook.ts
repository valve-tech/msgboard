import type { RelayerAction } from '../types.js'

export type WebhookActionOptions = {
  url: string
  /** Overridable fetch implementation (injected in tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/** Posts each item as JSON to a webhook. Demonstrates a non-on-chain gated action. */
export const webhookAction = <T>(options: WebhookActionOptions): RelayerAction<T> => {
  const doFetch = options.fetchImpl ?? fetch
  return {
    describe: (_item) => `POST to ${options.url}`,
    execute: async (item) => {
      const response = await doFetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(item),
      })
      return { ok: response.ok, meta: { status: response.status } }
    },
  }
}
