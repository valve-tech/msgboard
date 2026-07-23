// The proof-gated solve schema UIDs (chain-specific — registered per SchemaRegistry) → game name.
// Shared by ponder.config.ts (log filter) and src/index.ts (row naming); lives outside the config
// module so indexing code never has to import (and re-execute) createConfig.
export const SOLVE_SCHEMAS: Record<string, string> = {
  // 943
  '0x0de9a3bb2e72a1116f44d1a4a5e612d315143af9916e27572d073663e9877fc5': 'sudoku',
  '0x68880687b7c28fa1618ad4f612173b23aef8443fc5df354d2e6693f6df243f37': 'wordle',
  // 369
  '0x3a8ce1bd299f82fb7f25a88386fbf6320fa066db643f5bb995c67ec46b6a129e': 'sudoku',
  '0xd827ebf0849a1328cb1527195b426db2a8c65a2e18102fd79cdb39fff358fde8': 'wordle',
}
