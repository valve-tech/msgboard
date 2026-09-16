import type { Abi } from 'viem'
// The operator substrate ABIs aren't re-exported by games-core, so they come straight from the
// compiled artifacts — same pattern ponder.config.ts already uses for SudokuLog/FlipBook
// (`Artifact.abi as viem.Abi`). The artifacts live under games/contracts/artifacts (one level above
// games/indexer), reached the same way the existing imports reach it.
import OperatorCoinFlipArtifact from '../../../contracts/artifacts/contracts/games/operator/OperatorCoinFlip.sol/OperatorCoinFlip.json'
import GameEscrowArtifact from '../../../contracts/artifacts/contracts/games/operator/GameEscrow.sol/GameEscrow.json'
import OperatorRegistryArtifact from '../../../contracts/artifacts/contracts/games/operator/OperatorRegistry.sol/OperatorRegistry.json'
import DefaultValidatorPolicyArtifact from '../../../contracts/artifacts/contracts/games/operator/DefaultValidatorPolicy.sol/DefaultValidatorPolicy.json'

export const operatorCoinFlipAbi = OperatorCoinFlipArtifact.abi as Abi
export const gameEscrowAbi = GameEscrowArtifact.abi as Abi
export const operatorRegistryAbi = OperatorRegistryArtifact.abi as Abi
export const defaultValidatorPolicyAbi = DefaultValidatorPolicyArtifact.abi as Abi
