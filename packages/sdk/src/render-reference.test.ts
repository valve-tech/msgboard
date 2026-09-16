import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderReference } from './render-reference.js'

const here = dirname(fileURLToPath(import.meta.url))
const doc = JSON.parse(readFileSync(join(here, '..', 'openrpc.json'), 'utf8'))

describe('renderReference', () => {
  const md = renderReference(doc)

  // Derived from the spec, not a hand-written list. The list version could not
  // fail when a method was added to openrpc.json and left unrendered, which is
  // the only way this renderer breaks.
  it('renders a heading for every method in the spec', () => {
    expect(doc.methods.length).toBeGreaterThan(0)
    for (const method of doc.methods) {
      expect(md).toContain(`### ${method.name}`)
    }
  })

  // The subscription is the one part of the surface OpenRPC cannot fully
  // describe: it has no notification concept, so `msgboard_subscription`
  // lives in the hand-written README section. The two methods still belong in
  // the spec, and they were absent from it until 2026-08-24 while the feature
  // was live. Pin them so the reference cannot lose them again.
  it('documents the subscription pair', () => {
    const names = doc.methods.map((m: { name: string }) => m.name)
    expect(names).toContain('msgboard_subscribe')
    expect(names).toContain('msgboard_unsubscribe')
  })

  it('renders the shared schemas', () => {
    expect(md).toContain('### Status')
    expect(md).toContain('### RPCMessage')
  })

  it('includes a result type for status', () => {
    expect(md).toMatch(/msgboard_status[\s\S]*Status/)
  })
})
