// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IValidatorPolicy} from "./IValidatorPolicy.sol";

interface IOperatorGameTables {
    function operatorOf(bytes32 tableId) external view returns (address);
}

/// @notice A ready-made stricter-only validator policy. Per (game, table) an operator sets: a minimum
/// count, whether the operator address must be in the subset, and an optional whitelist (if non-empty,
/// every subset member must be on it). The game already enforces the hard floor (>=3 distinct allowlisted),
/// so this can only add constraints. Config is writable only by the table's operator (read via the game's
/// operatorOf). All checks are pure reads → view, cannot move funds.
contract DefaultValidatorPolicy is IValidatorPolicy {
    error NotOperator();

    struct Config {
        uint256 minCount;
        bool requireOperator;
        bool useWhitelist;
        uint256 version; // bump on each setConfig so a re-set whitelist replaces the old one cleanly
    }

    mapping(address game => mapping(bytes32 tableId => Config)) internal _config;
    // whitelist membership keyed by version so a fresh setConfig doesn't inherit stale entries
    mapping(address game => mapping(bytes32 tableId => mapping(uint256 version => mapping(address => bool)))) internal _wl;

    event ConfigSet(address indexed game, bytes32 indexed tableId, uint256 minCount, bool requireOperator, bool useWhitelist);

    function setConfig(
        address game,
        bytes32 tableId,
        uint256 minCount,
        bool requireOperator,
        address[] calldata whitelist
    ) external {
        if (msg.sender != IOperatorGameTables(game).operatorOf(tableId)) revert NotOperator();
        Config storage c = _config[game][tableId];
        uint256 v = c.version + 1;
        c.minCount = minCount;
        c.requireOperator = requireOperator;
        c.useWhitelist = whitelist.length > 0;
        c.version = v;
        for (uint256 i = 0; i < whitelist.length; ++i) {
            _wl[game][tableId][v][whitelist[i]] = true;
        }
        emit ConfigSet(game, tableId, minCount, requireOperator, c.useWhitelist);
    }

    function configOf(address game, bytes32 tableId)
        external
        view
        returns (uint256 minCount, bool requireOperator, bool useWhitelist)
    {
        Config storage c = _config[game][tableId];
        return (c.minCount, c.requireOperator, c.useWhitelist);
    }

    /// @dev msg.sender is the calling game; config is keyed by it.
    function validate(address operator, bytes32 tableId, address, address[] calldata subset)
        external
        view
        returns (bool)
    {
        Config storage c = _config[msg.sender][tableId];
        if (subset.length < c.minCount) return false;
        if (c.requireOperator) {
            bool found;
            for (uint256 i = 0; i < subset.length; ++i) {
                if (subset[i] == operator) { found = true; break; }
            }
            if (!found) return false;
        }
        if (c.useWhitelist) {
            uint256 v = c.version;
            for (uint256 i = 0; i < subset.length; ++i) {
                if (!_wl[msg.sender][tableId][v][subset[i]]) return false;
            }
        }
        return true;
    }
}
