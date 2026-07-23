// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {EfficientHashLib} from "solady/src/utils/EfficientHashLib.sol";

library PreimageLocation {
    struct Info {
        address provider;
        bool callAtChange;
        bool durationIsTimestamp;
        uint256 duration;
        address token;
        uint256 price;
        uint256 offset;
        uint256 index;
    }

    using PreimageLocation for Info;
    using PreimageLocation for bytes32;
    using EfficientHashLib for bytes32;

    /**
     * derive a unique location hash that is hash(section + index)
     * @param info location info to help derive hashes
     */
    function location(Info memory info) internal pure returns (bytes32) {
        return info.section().location(info.index);
    }

    function location(
        bytes32 sec,
        uint256 index
    ) internal pure returns (bytes32) {
        return sec.hash(bytes32(index));
    }

    function section(Info memory info) internal pure returns (bytes32) {
        unchecked {
            return
                EfficientHashLib.hash(
                    bytes32(uint256(uint160(info.provider))),
                    bytes32(info.encodeToken()),
                    bytes32(info.price),
                    bytes32(info.offset)
                );
        }
    }

    function encodeToken(Info memory info) internal pure returns (uint256) {
        return
            (uint256(info.durationIsTimestamp ? 1 : 0) << 255) |
            (uint256(info.callAtChange ? 1 : 0) << 254) |
            (uint256((uint40(info.duration) << 1) >> 1) << 160) |
            uint256(uint160(info.token));
    }
}
