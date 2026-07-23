import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // both parity tests deploy from anvil account 0; parallel files would race its nonce
    fileParallelism: false,
  },
})
