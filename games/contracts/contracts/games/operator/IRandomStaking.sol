// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {PreimageLocation} from "../../PreimageLocation.sol";

/// @notice The concrete-Random surface the operator game needs beyond the shared `IRandom`. The
/// shared `IRandom` abstract exposes only `heat`/`randomness` (enough to arm a draw and read a seed);
/// it lacks the custody-ledger and stake-forfeit calls that the validator-forfeit path depends on.
/// This interface adds `balanceOf` (read the game's per-token custody), `chop` (finalize a stalled
/// cohort — refunds the fee and credits the withheld validators' forfeited stake to the request
/// owner), and `handoff` (move custodied token out of Random to the game). It is intentionally scoped
/// to the operator directory so only this game depends on the concrete surface.
interface IRandomStaking {
    function heat(
        uint256 required,
        PreimageLocation.Info calldata settings,
        PreimageLocation.Info[] calldata info,
        bool useTSTORE
    ) external payable returns (bytes32);

    function chop(bytes32 key, PreimageLocation.Info[] calldata info) external;

    function handoff(address recipient, address token, int256 amount) external;

    function balanceOf(address account, address token) external view returns (uint256);
}
