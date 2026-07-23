import { type Hex } from 'viem'
import HouseBankrollArtifact from '@msgboard/games-contracts/artifacts/contracts/games/HouseBankroll.sol/HouseBankroll.json'
import { type Settlement, type TxRequest } from './settlement'
import { replaySession, type ReplayContext } from './replay'

export const houseBankrollAbi = HouseBankrollArtifact.abi

export interface OptimisticConfig<TParams> extends ReplayContext<TParams> {
  bankroll: Hex // HouseBankroll address (== domain.verifyingContract)
}

/** Optimistic backend (spec §6.1): no open() call; settle() submits open + final co-signed
 *  states. settlementMode is fixed to 0. */
export class OptimisticSettlement<TParams> implements Settlement {
  constructor(private cfg: OptimisticConfig<TParams>) {
    if (cfg.settlementMode !== 0) throw new Error('optimistic: settlementMode must be 0')
  }

  async buildSettle(transcriptJson: string): Promise<TxRequest> {
    const { open, final } = await replaySession(transcriptJson, this.cfg)
    return {
      address: this.cfg.bankroll,
      abi: houseBankrollAbi,
      functionName: 'settle',
      args: [
        open.state, final.state,
        open.sigPlayer, open.sigHouse,
        final.sigPlayer, final.sigHouse,
      ],
    }
  }
}
