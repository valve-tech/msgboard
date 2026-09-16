import { describe, expect, it, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Hex } from 'viem'
import { SignerList, tierLabel } from './SignerList.js'

afterEach(cleanup)

/** A `Hex`-shaped fake address — unique per index, cheap to generate at scale. */
const fakeAddr = (i: number): Hex => `0x${i.toString(16).padStart(40, '0')}` as Hex

describe('tierLabel', () => {
  it('shows an exact count under the threshold', () => {
    expect(tierLabel(842)).toBe('842 signed')
  })

  it('rounds to a K-tier past the threshold', () => {
    expect(tierLabel(1200)).toBe('1.2K signed')
    expect(tierLabel(12_400)).toBe('12K signed')
  })
})

describe('SignerList', () => {
  it('mounts a small list rendering every row (below one batch)', () => {
    const signers = Array.from({ length: 5 }, (_, i) => fakeAddr(i))
    render(<SignerList signers={signers} batchSize={50} />)
    expect(screen.getAllByTestId('signer-row')).toHaveLength(5)
    expect(screen.queryByText(/load more/)).toBeNull()
  })

  it('mounts a 2,000-signer fixture rendering only the first batch, and "load more" reveals the next', () => {
    const signers = Array.from({ length: 2000 }, (_, i) => fakeAddr(i))
    render(<SignerList signers={signers} batchSize={50} />)

    // only the first batch is in the DOM — not all 2000 rows.
    expect(screen.getAllByTestId('signer-row')).toHaveLength(50)
    expect(screen.getByText('2K signed')).toBeTruthy()

    const loadMore = screen.getByText(/load more/)
    fireEvent.click(loadMore)

    expect(screen.getAllByTestId('signer-row')).toHaveLength(100)
  })

  it('stops offering "load more" once every signer is revealed', () => {
    const signers = Array.from({ length: 60 }, (_, i) => fakeAddr(i))
    render(<SignerList signers={signers} batchSize={50} />)
    expect(screen.getAllByTestId('signer-row')).toHaveLength(50)

    fireEvent.click(screen.getByText(/load more/))
    expect(screen.getAllByTestId('signer-row')).toHaveLength(60)
    expect(screen.queryByText(/load more/)).toBeNull()
  })
})
