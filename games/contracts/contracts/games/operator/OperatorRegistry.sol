// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Permissionless operator identity + config for the table-maintainer substrate. Anyone may
/// register (no admin gate); the registry holds NO funds — it stores only rake config, a funding-source
/// pointer, and a metadata URI event. Curation / "verified" status lives entirely off-chain in the
/// discovery layer (slice C); this contract gatekeeps nothing.
contract OperatorRegistry {
    error NotRegistered();
    error RakeTooHigh();

    uint16 public constant MAX_RAKE_BPS = 500; // 5% ceiling on any operator's own rake

    mapping(address operator => bool) public registered;
    mapping(address operator => mapping(address game => uint16)) internal _rakeBps;
    mapping(address operator => mapping(address token => address)) internal _rakeRecipient;
    mapping(address operator => mapping(address token => address)) internal _fundingSource;

    event Registered(address indexed operator);
    event RakeSet(address indexed operator, address indexed game, uint16 bps);
    event RakeRecipientSet(address indexed operator, address indexed token, address recipient);
    event FundingSourceSet(address indexed operator, address indexed token, address src);
    event MetadataSet(address indexed operator, string uri);

    modifier onlyRegistered() {
        if (!registered[msg.sender]) revert NotRegistered();
        _;
    }

    function register() external returns (address operatorId) {
        registered[msg.sender] = true;
        emit Registered(msg.sender);
        return msg.sender;
    }

    function setRakeBps(address game, uint16 bps) external onlyRegistered {
        if (bps > MAX_RAKE_BPS) revert RakeTooHigh();
        _rakeBps[msg.sender][game] = bps;
        emit RakeSet(msg.sender, game, bps);
    }

    function rakeBps(address operator, address game) external view returns (uint16) {
        return _rakeBps[operator][game];
    }

    function setRakeRecipient(address token, address recipient) external onlyRegistered {
        _rakeRecipient[msg.sender][token] = recipient;
        emit RakeRecipientSet(msg.sender, token, recipient);
    }

    function rakeRecipientOf(address operator, address token) external view returns (address) {
        address r = _rakeRecipient[operator][token];
        return r == address(0) ? operator : r;
    }

    function setFundingSource(address token, address src) external onlyRegistered {
        _fundingSource[msg.sender][token] = src;
        emit FundingSourceSet(msg.sender, token, src);
    }

    function fundingSourceOf(address operator, address token) external view returns (address) {
        return _fundingSource[operator][token];
    }

    function setMetadataURI(string calldata uri) external onlyRegistered {
        emit MetadataSet(msg.sender, uri);
    }
}
