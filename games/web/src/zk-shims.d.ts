// snarkjs and circomlibjs ship no TypeScript declarations. The web program pulls them in
// transitively via `@msgboard/zk-skill/sudoku` (circomlibjs) and the prover worker (snarkjs), and it
// dynamically imports snarkjs on the main thread only for the cheap PLONK→calldata formatting
// (`plonk.exportSolidityCallData` — string/field arithmetic, NOT proving). Mirror of
// examples/games/zk-skill/src/types.d.ts so those imports typecheck here.
declare module 'snarkjs' {
  const snarkjs: any
  export = snarkjs
}

declare module 'circomlibjs' {
  export function buildPoseidon(): Promise<any>
}
