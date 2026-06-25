import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App } from '../src/App'

describe('scaffold', () => {
  it('renders the app shell', () => {
    render(<App />)
    expect(screen.getByText(/msgboard/i)).toBeTruthy()
  })
})
