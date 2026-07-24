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

  /** Build the cooperative HouseChannel.settle(close, sigPlayer, sigHouse) call. settle() now takes a
   *  DISTINCT SessionClose both parties sign ONLY at mutual close — NOT the running SessionState — so
   *  the transcript MUST carry a CLOSE envelope (HouseSession.authorizeClose / the house's close
   *  handshake in runHouseSide). Without it the cooperative fast path is unavailable and the table must
   *  fall back to dispute()/the clock. */
  async buildSettle(transcriptJson: string): Promise<TxRequest> {
    const { close } = await replaySession(transcriptJson, this.cfg)
    if (!close) {
      throw new Error('escrowed: transcript carries no mutual-close authorization — settle() needs a co-signed SessionClose (call authorizeClose / have the house co-sign the close at mutual close)')
    }
    return { address: this.cfg.channel, abi: houseChannelAbi, functionName: 'settle', args: [close.close, close.sigPlayer, close.sigHouse] }
  }

  /** Build a dispute() call posting the latest both-signed state. */
  async buildDispute(transcriptJson: string): Promise<TxRequest> {
    const { final } = await replaySession(transcriptJson, this.cfg)
    return { address: this.cfg.channel, abi: houseChannelAbi, functionName: 'dispute', args: [final.state, final.sigPlayer, final.sigHouse] }
  }
}
