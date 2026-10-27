import { createConfig } from "ponder";

import deployedAddresses from '@gibs/random/ignition/deployments/chain-943/deployed_addresses.json'
import { abi as randomAbi } from '@gibs/random/artifacts/contracts/Random.sol/Random.json'
import { abi as readerAbi } from '@gibs/random/artifacts/contracts/Reader.sol/Reader.json'
import * as viem from 'viem'
import { Random$Type } from "@gibs/random/artifacts/contracts/Random.sol/Random";
import { Reader$Type } from "@gibs/random/artifacts/contracts/Reader.sol/Reader";

const addresses = deployedAddresses as {
  [k in keyof typeof deployedAddresses]: viem.Hex;
}

// Per-contract deployment blocks on PulseChain testnet v4 (943), taken from the @gibs/random
// ignition journal (ignition/deployments/chain-943/journal.jsonl). Starting each contract at
// its own deployment block indexes its full history with no wasted pre-deploy scanning.
const DEPLOY_BLOCK_943 = {
  Random: 21_157_084,
  Reader: 21_157_093,
  Consumer: 21_157_114,
} as const

// Optional single-value override (applied to every contract) for fast bring-up when the
// full — currently event-free — history isn't needed. Unset in production to get full history.
const startBlockOverride = process.env.PONDER_START_BLOCK_943
const startBlockFor = (contract: keyof typeof DEPLOY_BLOCK_943): number =>
  startBlockOverride ? Number(startBlockOverride) : DEPLOY_BLOCK_943[contract]

export default createConfig({
  ordering: "omnichain",
  chains: {
    pulsechainV4: {
      id: 943,
      rpc: process.env.PONDER_RPC_URL_943,
    },
  },
  contracts: {
    Random: {
      chain: "pulsechainV4",
      abi: randomAbi as Random$Type["abi"],
      address: addresses["RandomModule#Random"],
      startBlock: startBlockFor("Random"),
      // includeCallTraces: true,
      includeTransactionReceipts: true,
    },
    Reader: {
      chain: "pulsechainV4",
      abi: readerAbi as Reader$Type["abi"],
      address: addresses["ReaderModule#Reader"],
      startBlock: startBlockFor("Reader"),
      includeTransactionReceipts: true,
    },
    Consumer: {
      chain: "pulsechainV4",
      abi: readerAbi as Reader$Type["abi"],
      address: addresses["ConsumerModule#Consumer"],
      startBlock: startBlockFor("Consumer"),
      // includeCallTraces: true,
      includeTransactionReceipts: true,
    },
  },
});
