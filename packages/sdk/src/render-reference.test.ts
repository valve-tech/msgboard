import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderReference } from './render-reference.js'

const here = dirname(fileURLToPath(import.meta.url))
const doc = JSON.parse(readFileSync(join(here, '..', 'openrpc.json'), 'utf8'))

describe('renderReference', () => {
  const md = renderReference(doc)

  it('renders a heading for every method', () => {
    for (const name of ['msgboard_status', 'msgboard_categories', 'msgboard_content', 'msgboard_addMessage', 'msgboard_getMessage']) {
      expect(md).toContain(`### ${name}`)
    }
  })

  it('renders the shared schemas', () => {
    expect(md).toContain('### Status')
    expect(md).toContain('### RPCMessage')
  })

  it('includes a result type for status', () => {
    expect(md).toMatch(/msgboard_status[\s\S]*Status/)
  })
})
