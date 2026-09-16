// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PreimageLocation} from "../../contracts/PreimageLocation.sol";
import {EfficientHashLib} from "solady/src/utils/EfficientHashLib.sol";

/// @notice Direct unit tests for the pure PreimageLocation library.
/// @dev PreimageLocation is otherwise exercised only transitively (via GameBase / CoinFlip /
/// Raffle), so this suite calls every library function directly to get real line/branch
/// coverage against contracts/PreimageLocation.sol itself:
///   - encodeToken(): bit-packing of (durationIsTimestamp, callAtChange, duration, token) into a
///     single uint256, including the duration-truncation boundary logic
///     `(uint40(duration) << 1) >> 1` (keeps the low 39 bits of duration).
///   - section(): EfficientHashLib.hash(provider, encodeToken(), price, offset).
///   - location(bytes32,uint256) and location(Info): the derived per-index location hash.
contract PreimageLocationUnitTest is Test {
    using PreimageLocation for PreimageLocation.Info;

    /// @dev encodeToken keeps only the low 39 bits of `duration` (bits 160..198 of the packed
    /// word); bit 199 and the two flag bits at 254/255 sit above it.
    uint256 internal constant DURATION_MASK = (1 << 39) - 1;

    function _info(
        address provider,
        bool callAtChange,
        bool durationIsTimestamp,
        uint256 duration,
        address token,
        uint256 price,
        uint256 offset,
        uint256 index
    ) internal pure returns (PreimageLocation.Info memory info) {
        info.provider = provider;
        info.callAtChange = callAtChange;
        info.durationIsTimestamp = durationIsTimestamp;
        info.duration = duration;
        info.token = token;
        info.price = price;
        info.offset = offset;
        info.index = index;
    }

    /* ------------------------------------------------------------------ */
    /*                            encodeToken                              */
    /* ------------------------------------------------------------------ */

    /// @dev Round-trip: whatever goes into token/flags/duration comes back out of the packed
    /// uint256 unchanged (duration truncated to its documented 39-bit window).
    function testFuzz_encodeToken_roundTrip(
        address token,
        bool callAtChange,
        bool durationIsTimestamp,
        uint256 duration
    ) public pure {
        PreimageLocation.Info memory info =
            _info(address(0), callAtChange, durationIsTimestamp, duration, token, 0, 0, 0);
        uint256 encoded = info.encodeToken();

        assertEq(address(uint160(encoded)), token, "token bits");
        assertEq((encoded >> 254) & 1, callAtChange ? 1 : 0, "callAtChange bit");
        assertEq((encoded >> 255) & 1, durationIsTimestamp ? 1 : 0, "durationIsTimestamp bit");
        assertEq((encoded >> 160) & DURATION_MASK, duration & DURATION_MASK, "duration (39-bit window)");
        // Bits 199..253 (55 bits) are always-zero padding between the duration field and the two
        // flag bits at the top -- never touched by any input, so pin them down explicitly.
        assertEq((encoded >> 199) & ((1 << 55) - 1), 0, "reserved padding bits must be zero");
    }

    /// @dev All four combinations of the two flag bits must be independent and distinguishable.
    function test_encodeToken_allFlagCombinations() public pure {
        address token = address(0xBEEF);
        uint256 duration = 12345; // well under 2**39, so no truncation noise in this check

        uint256 e00 = _info(address(0), false, false, duration, token, 0, 0, 0).encodeToken();
        uint256 e10 = _info(address(0), true, false, duration, token, 0, 0, 0).encodeToken();
        uint256 e01 = _info(address(0), false, true, duration, token, 0, 0, 0).encodeToken();
        uint256 e11 = _info(address(0), true, true, duration, token, 0, 0, 0).encodeToken();

        assertEq(e00, uint256(uint160(token)) | (duration << 160));
        assertEq(e10, e00 | (uint256(1) << 254));
        assertEq(e01, e00 | (uint256(1) << 255));
        assertEq(e11, e00 | (uint256(1) << 254) | (uint256(1) << 255));

        assertTrue(e00 != e10 && e00 != e01 && e00 != e11 && e10 != e01 && e10 != e11 && e01 != e11);
    }

    /// @dev duration is cast to uint40 (mod 2**40), then its top bit (bit 39) is cleared via the
    /// `(x << 1) >> 1` trick performed in uint40 arithmetic. Exercise every relevant boundary:
    /// exactly at 2**39-1 (max survivor), exactly at 2**39 (the cleared bit), a value with only
    /// the 40th bit set (dropped by the uint40 cast, independent of the later masking), and a
    /// value spanning the full uint256 range.
    function test_encodeToken_durationTruncationBoundaries() public pure {
        address token = address(0x1234);

        uint256 maxSurvivor = (1 << 39) - 1;
        assertEq(_encodedDuration(token, maxSurvivor), maxSurvivor);

        assertEq(_encodedDuration(token, 1 << 39), 0);
        assertEq(_encodedDuration(token, (1 << 39) | 1), 1);

        assertEq(_encodedDuration(token, (1 << 40) | 7), 7);

        assertEq(_encodedDuration(token, type(uint256).max), DURATION_MASK);
    }

    function testFuzz_encodeToken_durationAlwaysMasked(uint256 duration) public pure {
        assertEq(_encodedDuration(address(0xABCD), duration), duration & DURATION_MASK);
    }

    function _encodedDuration(address token, uint256 duration) internal pure returns (uint256) {
        uint256 encoded = _info(address(0), false, false, duration, token, 0, 0, 0).encodeToken();
        return (encoded >> 160) & DURATION_MASK;
    }

    /* ------------------------------------------------------------------ */
    /*                              section                                */
    /* ------------------------------------------------------------------ */

    function testFuzz_section_matchesManualHash(
        address provider,
        bool callAtChange,
        bool durationIsTimestamp,
        uint256 duration,
        address token,
        uint256 price,
        uint256 offset
    ) public pure {
        PreimageLocation.Info memory info =
            _info(provider, callAtChange, durationIsTimestamp, duration, token, price, offset, 0);
        bytes32 expected = EfficientHashLib.hash(
            bytes32(uint256(uint160(provider))), bytes32(info.encodeToken()), bytes32(price), bytes32(offset)
        );
        assertEq(info.section(), expected);
    }

    /// @dev NOTE: Info is a memory struct, so `v = base;` in Solidity ALIASES the same memory
    /// (memory structs are reference types) rather than deep-copying. Each variant below is
    /// therefore built fresh via `_info(...)` so mutating one field can't silently leak into the
    /// baseline used for comparison.
    function test_section_sensitiveToEveryField() public pure {
        address baseProvider = address(0xAAAA);
        address baseToken = address(0xBBBB);
        uint256 basePrice = 100;
        uint256 baseOffset = 7;
        uint256 baseDuration = 1;

        bytes32 d = _info(baseProvider, false, false, baseDuration, baseToken, basePrice, baseOffset, 0).section();

        assertTrue(
            _info(address(0xCCCC), false, false, baseDuration, baseToken, basePrice, baseOffset, 0).section() != d,
            "provider"
        );
        assertTrue(
            _info(baseProvider, false, false, baseDuration, address(0xDDDD), basePrice, baseOffset, 0).section() != d,
            "token"
        );
        assertTrue(
            _info(baseProvider, false, false, baseDuration, baseToken, 101, baseOffset, 0).section() != d, "price"
        );
        assertTrue(
            _info(baseProvider, false, false, baseDuration, baseToken, basePrice, 8, 0).section() != d, "offset"
        );
        assertTrue(
            _info(baseProvider, true, false, baseDuration, baseToken, basePrice, baseOffset, 0).section() != d,
            "callAtChange"
        );
        assertTrue(
            _info(baseProvider, false, true, baseDuration, baseToken, basePrice, baseOffset, 0).section() != d,
            "durationIsTimestamp"
        );
        assertTrue(
            _info(baseProvider, false, false, 2, baseToken, basePrice, baseOffset, 0).section() != d, "duration"
        );

        // index does NOT feed into section() -- only location() consumes it.
        assertEq(
            _info(baseProvider, false, false, baseDuration, baseToken, basePrice, baseOffset, 999).section(),
            d,
            "index must not affect section"
        );
    }

    /* ------------------------------------------------------------------ */
    /*                              location                               */
    /* ------------------------------------------------------------------ */

    function testFuzz_location_bytes32Overload_matchesManualHash(bytes32 sec, uint256 index) public pure {
        assertEq(PreimageLocation.location(sec, index), EfficientHashLib.hash(sec, bytes32(index)));
    }

    function testFuzz_location_infoOverload_composesSectionAndIndex(
        address provider,
        bool callAtChange,
        bool durationIsTimestamp,
        uint256 duration,
        address token,
        uint256 price,
        uint256 offset,
        uint256 index
    ) public pure {
        PreimageLocation.Info memory info =
            _info(provider, callAtChange, durationIsTimestamp, duration, token, price, offset, index);
        bytes32 expected = PreimageLocation.location(info.section(), index);
        assertEq(info.location(), expected);
    }

    function test_location_sensitiveToIndex() public pure {
        PreimageLocation.Info memory info = _info(address(0x1), false, false, 1, address(0x2), 1, 1, 0);
        bytes32 loc0 = info.location();
        info.index = 1;
        bytes32 loc1 = info.location();
        assertTrue(loc0 != loc1);
    }

    function test_location_differsFromSection() public pure {
        // location() hashes section() again with the index, so for index == 0 it must still
        // differ from the bare section hash (hash(sec) != hash(sec, 0)).
        PreimageLocation.Info memory info = _info(address(0x1), false, false, 1, address(0x2), 1, 1, 0);
        assertTrue(info.location() != info.section());
    }
}
