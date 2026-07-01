// Minimal, self-contained ABIs for the canonical Safe (Gnosis Safe) contracts, `as const` so Ponder
// derives the event-name union and populates the registry (a generic `as Abi` cast erases events and
// `ponder.on('SafeV130:SafeSetup')` then fails at runtime). Only the events we index are declared.
//
// Two Safe generations are indexed because the SafeProxyFactory v1.3.0 deploys v1.3.0 singletons and
// v1.4.1 deploys v1.4.1 singletons — and the ownership events differ in their `indexed` flags between
// the two versions. `indexed`-ness controls WHERE viem reads the arg (topic vs data), so a single ABI
// cannot decode both; hence one ABI per version, wired to its own factory in ponder.config.ts.
//
// Event signatures (topic0 is identical across versions — `indexed` does not change the signature
// string — so the difference is purely decode-location):
//   v1.3.0 OwnerManager:  event AddedOwner(address owner)            // NOT indexed
//                         event RemovedOwner(address owner)          // NOT indexed
//   v1.4.1 OwnerManager:  event AddedOwner(address indexed owner)    // indexed
//                         event RemovedOwner(address indexed owner)  // indexed
//   both (GnosisSafe/Safe): event ChangedThreshold(uint256 threshold)
//                           event SafeSetup(address indexed initiator, address[] owners,
//                                           uint256 threshold, address initializer,
//                                           address fallbackHandler)

// ── SafeProxyFactory ProxyCreation (used ONLY as the factory-discovery event) ──────────────────────
// v1.3.0: event ProxyCreation(GnosisSafeProxy proxy, address singleton)  — proxy NOT indexed
export const factoryAbiV130 = [
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: 'contract GnosisSafeProxy', name: 'proxy', type: 'address' },
      { indexed: false, internalType: 'address', name: 'singleton', type: 'address' },
    ],
    name: 'ProxyCreation',
    type: 'event',
  },
] as const

// v1.4.1: event ProxyCreation(SafeProxy indexed proxy, address singleton)  — proxy IS indexed
export const factoryAbiV141 = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'contract SafeProxy', name: 'proxy', type: 'address' },
      { indexed: false, internalType: 'address', name: 'singleton', type: 'address' },
    ],
    name: 'ProxyCreation',
    type: 'event',
  },
] as const

// SafeSetup — identical in v1.3.0 and v1.4.1 (initiator indexed; owners[] + threshold in data).
const safeSetup = {
  anonymous: false,
  inputs: [
    { indexed: true, internalType: 'address', name: 'initiator', type: 'address' },
    { indexed: false, internalType: 'address[]', name: 'owners', type: 'address[]' },
    { indexed: false, internalType: 'uint256', name: 'threshold', type: 'uint256' },
    { indexed: false, internalType: 'address', name: 'initializer', type: 'address' },
    { indexed: false, internalType: 'address', name: 'fallbackHandler', type: 'address' },
  ],
  name: 'SafeSetup',
  type: 'event',
} as const

const changedThreshold = {
  anonymous: false,
  inputs: [{ indexed: false, internalType: 'uint256', name: 'threshold', type: 'uint256' }],
  name: 'ChangedThreshold',
  type: 'event',
} as const

// ── Safe v1.3.0 ownership events (AddedOwner/RemovedOwner NOT indexed) ──────────────────────────────
export const safeAbiV130 = [
  safeSetup,
  changedThreshold,
  {
    anonymous: false,
    inputs: [{ indexed: false, internalType: 'address', name: 'owner', type: 'address' }],
    name: 'AddedOwner',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [{ indexed: false, internalType: 'address', name: 'owner', type: 'address' }],
    name: 'RemovedOwner',
    type: 'event',
  },
] as const

// ── Safe v1.4.1 ownership events (AddedOwner/RemovedOwner indexed) ──────────────────────────────────
export const safeAbiV141 = [
  safeSetup,
  changedThreshold,
  {
    anonymous: false,
    inputs: [{ indexed: true, internalType: 'address', name: 'owner', type: 'address' }],
    name: 'AddedOwner',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, internalType: 'address', name: 'owner', type: 'address' }],
    name: 'RemovedOwner',
    type: 'event',
  },
] as const
