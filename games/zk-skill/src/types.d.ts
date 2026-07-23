// snarkjs and circomlibjs ship no TypeScript declarations.
declare module 'snarkjs' {
  const snarkjs: any
  export = snarkjs
}

declare module 'circomlibjs' {
  export function buildPoseidon(): Promise<any>
}
