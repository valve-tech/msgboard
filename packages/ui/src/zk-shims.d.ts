// snarkjs and circomlibjs ship no TypeScript declarations. ZkChat's proving/verifying Web
// Worker (src/worker/zk-worker.ts) dynamically imports snarkjs (Groth16 fullProve/verify)
// and statically imports circomlibjs (buildPoseidon, for the identity commitment + Merkle
// tree). Mirror of games/web/src/zk-shims.d.ts so those imports typecheck here.
declare module 'snarkjs' {
  const snarkjs: any
  export = snarkjs
}

declare module 'circomlibjs' {
  export function buildPoseidon(): Promise<any>
}
