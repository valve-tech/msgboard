import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // circom compile + PLONK setup (universal Hermez ptau) is slow the first time per circuit.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
})
