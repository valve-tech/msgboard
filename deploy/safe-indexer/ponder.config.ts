import { createConfig, factory } from 'ponder'
import { getAbiItem } from 'viem'
import { factoryAbiV130, factoryAbiV141, safeAbiV130, safeAbiV141 } from './abis'

// Self-hosted Safe-owner indexer for PulseChain (369) and its v4 testnet (943), which have NO official
// Safe Transaction Service. It indexes the Safe ownership graph so the cosign UI can answer the same
// question the Safe Tx Service answers on mainnet: "which Safes does address X own?"
//
// Discovery uses Ponder's factory pattern: every Safe is a CREATE2 proxy minted by the canonical
// SafeProxyFactory, which emits ProxyCreation(proxy, singleton). Ponder auto-registers each `proxy`
// as an instance of the Safe contract, and we then index its ownership events (SafeSetup / AddedOwner
// / RemovedOwner / ChangedThreshold).
//
// Canonical factory addresses (deterministic CREATE2, identical across EVM chains):
//   v1.3.0  0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2
//   v1.4.1  0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
//
// Verified deployed via eth_getCode against one.valve.city (2026-07-01):
//   chain 369 (PulseChain):      v1.3.0 ✅  v1.4.1 ✅
//   chain 943 (PulseChain v4):   v1.3.0 ✅  v1.4.1 ❌ (eth_getCode → 0x, so NOT indexed on 943)
//
// Start blocks are the exact factory contract-creation blocks (binary-searched via eth_getCode).
// NOTE on backfill cost: 369/943 inherited Ethereum's pre-fork history, so v1.3.0 "appears" at ETH's
// mainnet deploy block 12_504_126 — a ~14M-block range to 369's head. Backfill is a getLogs scan and
// the events are sparse, but it is not instant. Operators who only need PulseChain-native Safes can
// raise the start block to the PulseChain fork (~17_233_000 on 369) or a recent block by setting the
// PONDER_START_* env vars below; whatever is set is what gets indexed (logged here for the record).
const FACTORY_V130 = '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2'
const FACTORY_V141 = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67'

// Exact factory deploy blocks (binary-searched via eth_getCode); env-overridable to cap backfill.
const START_369_V130 = Number(process.env.PONDER_START_369_V130 ?? 12_504_126)
const START_369_V141 = Number(process.env.PONDER_START_369_V141 ?? 18_804_210)
const START_943_V130 = Number(process.env.PONDER_START_943_V130 ?? 12_504_126)

const proxyEventV130 = getAbiItem({ abi: factoryAbiV130, name: 'ProxyCreation' })
const proxyEventV141 = getAbiItem({ abi: factoryAbiV141, name: 'ProxyCreation' })

export default createConfig({
  ordering: 'omnichain',
  chains: {
    pulsechain: {
      id: 369,
      rpc: process.env.PONDER_RPC_URL_369,
    },
    pulsechainV4: {
      id: 943,
      rpc: process.env.PONDER_RPC_URL_943,
    },
  },
  contracts: {
    // v1.3.0 Safes — factory deployed on BOTH 369 and 943 (same CREATE2 address).
    SafeV130: {
      abi: safeAbiV130,
      chain: {
        pulsechain: {
          address: factory({ address: FACTORY_V130, event: proxyEventV130, parameter: 'proxy' }),
          startBlock: START_369_V130,
        },
        pulsechainV4: {
          address: factory({ address: FACTORY_V130, event: proxyEventV130, parameter: 'proxy' }),
          startBlock: START_943_V130,
        },
      },
    },
    // v1.4.1 Safes — factory deployed on 369 ONLY (943 has no v1.4.1 factory code).
    SafeV141: {
      abi: safeAbiV141,
      chain: {
        pulsechain: {
          address: factory({ address: FACTORY_V141, event: proxyEventV141, parameter: 'proxy' }),
          startBlock: START_369_V141,
        },
      },
    },
  },
})
