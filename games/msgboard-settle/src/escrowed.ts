import { type Hex } from 'viem'
import HouseChannelArtifact from '@msgboard/games-contracts/artifacts/contracts/games/HouseChannel.sol/HouseChannel.json'
import { type Settlement, type TxRequest } from './settlement'
import { replaySession, type ReplayContext } from './replay'
import { type OpenTerms } from './openTerms'

export const houseChannelAbi = HouseChannelArtifact.abi

export interface EscrowedConfig<TParams> extends ReplayContext<TParams> {
  channel: Hex // HouseChannel address (== domain.verifyingContract)
}

/** Escrowed backend (spec §6.2): open() locks escrow (house-signed OpenTerms), settle()/dispute()
 *  use the final both-signed state. settlementMode is fixed to 1. */
export class EscrowedSettlement<TParams> implements Settlement {
  constructor(private cfg: EscrowedConfig<TParams>) {
    if (cfg.settlementMode !== 1) throw new Error('escrowed: settlementMode must be 1')
  }

  /** Build the player's HouseChannel.open call from house-signed terms. */
  buildOpen(terms: OpenTerms, houseSig: Hex): TxRequest {
    return { address: this.cfg.channel, abi: houseChannelAbi, functionName: 'open', args: [terms, houseSig] }
  }

  async buildSettle(transcriptJson: string): Promise<TxRequest> {
    const { final } = await replaySession(transcriptJson, this.cfg)
    return { address: this.cfg.channel, abi: houseChannelAbi, functionName: 'settle', args: [final.state, final.sigPlayer, final.sigHouse] }
  }

  /** Build a dispute() call posting the latest both-signed state. */
  async buildDispute(transcriptJson: string): Promise<TxRequest> {
    const { final } = await replaySession(transcriptJson, this.cfg)
    return { address: this.cfg.channel, abi: houseChannelAbi, functionName: 'dispute', args: [final.state, final.sigPlayer, final.sigHouse] }
  }
}
