import { describe, it, expect } from 'vitest'
import { LocalTransport } from '../src/transport'

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('LocalTransport', () => {
  it('delivers a message to the peer', async () => {
    const [a, b] = LocalTransport.pair()
    const got: unknown[] = []
    b.onMessage((m) => got.push(m))
    await a.send({ hello: 1 })
    await tick()
    expect(got).toEqual([{ hello: 1 }])
  })

  it('drops the next message when told', async () => {
    const [a, b] = LocalTransport.pair()
    const got: unknown[] = []
    b.onMessage((m) => got.push(m))
    a.dropNext()
    await a.send({ x: 1 })
    await a.send({ x: 2 })
    await tick()
    expect(got).toEqual([{ x: 2 }])
  })
})
