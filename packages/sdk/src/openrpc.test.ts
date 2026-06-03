import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateOpenRPCDocument } from '@open-rpc/schema-utils-js'

const here = dirname(fileURLToPath(import.meta.url))
const specPath = join(here, '..', 'openrpc.json')

describe('openrpc.json', () => {
  const doc = JSON.parse(readFileSync(specPath, 'utf8'))

  it('is a valid OpenRPC document', () => {
    const result = validateOpenRPCDocument(doc)
    expect(result).toBe(true)
  })

  it('documents exactly the five wire methods', () => {
    const names = (doc.methods as Array<{ name: string }>).map((m) => m.name).sort()
    expect(names).toEqual([
      'msgboard_addMessage',
      'msgboard_categories',
      'msgboard_content',
      'msgboard_getMessage',
      'msgboard_status',
    ])
  })

  it('does not document client-side methods', () => {
    const names = (doc.methods as Array<{ name: string }>).map((m) => m.name)
    expect(names).not.toContain('doPoW')
    expect(names).not.toContain('getDifficulty')
  })
})
