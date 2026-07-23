// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Chips} from "../../contracts/games/Chips.sol";
import {HouseChannel, OpenTerms} from "../../contracts/games/HouseChannel.sol";

/// M2 (ZK mode-2) on-chain settle: settleWithProof verifies a REAL UltraHonk proof on-chain (seeds
/// NEVER revealed) then settles the table's escrow to the proven split. The proof + public inputs are
/// the generated fixture (examples/games/zk-settle/scripts/genOnchainVerifier.ts) — a dice-WIN round
/// at target 5000, stake 1000, escrowHouse 980, pot 1980, payoutPlayer 1980.
///
/// The fixture's seed commits are keccak256(serverSeed=0x..01) and keccak256(clientSeed=0x..08); the
/// table is opened with EXACTLY those commits so the contract-reconstructed public inputs match the
/// proof. A table opened with different commits (a different round/channel) makes verify() fail —
/// that is the replay-prevention binding under test.
///
/// COMPILATION NOTE: this suite runs under the DEFAULT profile (solc 0.8.25, viaIR — where
/// HouseChannel/Solady compile). The generated UltraHonk verifier needs solc 0.8.26+ and viaIR:false,
/// so it CANNOT be co-compiled here. Instead we `vm.etch` its fully-deployed runtime bytecode (with
/// immutables resolved), dumped by DiceSettleVerifier.t.sol::test_dumpRuntime under the `zkverify`
/// profile. The etched code IS the real generated verifier — the on-chain verify is genuine.
interface IHonkVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

contract SettleWithProofTest is Test {
    Chips internal chips;
    HouseChannel internal ch;
    address internal verifier;

    uint256 internal pkHouse = 0xB0B;
    address internal playerWallet = address(uint160(uint256(keccak256("player-wallet"))));
    address internal playerKey = address(uint160(uint256(keccak256("player-key"))));
    address internal house;

    bytes32 internal constant TID = keccak256("zk-mode2-1");
    uint64 internal constant CLOCK = 30;
    uint8 internal constant DICE = 1;

    // Fixture round facts (must equal genOnchainVerifier.ts ROUND).
    bytes32 internal constant SERVER = bytes32(uint256(1));
    bytes32 internal constant CLIENT = bytes32(uint256(8));
    uint256 internal constant TARGET = 5000;
    uint256 internal constant ESCROW_PLAYER = 1000;
    uint256 internal constant ESCROW_HOUSE = 980;
    uint256 internal constant PAYOUT_WIN = 1980; // == pot; dice-WIN at nonce 1

    bytes internal proof;
    bytes32[] internal publicInputs;

    function setUp() public {
        chips = new Chips();
        ch = new HouseChannel(address(chips));

        // Deploy the REAL generated UltraHonk verifier from its PRE-BUILT artifact (compiled under the
        // zkverify profile: solc 0.8.27 + viaIR:false — the only settings it compiles under). This
        // profile (zkm2) shares `out = forge-out-zkverify`, so forge finds that artifact WITHOUT
        // recompiling the verifier under this profile's viaIR (which the verifier cannot do). The
        // verifier links one external library (ZKTranscriptLib): we deploy it, then splice its address
        // into the verifier's creation-bytecode link placeholder and CREATE the verifier. See the
        // COMPILATION NOTE above.
        verifier = _deployLinkedVerifier();

        house = vm.addr(pkHouse);
        ch.setHouseKey(house);
        ch.setProofVerifier(DICE, verifier);

        chips.mint(playerWallet, 10_000);
        chips.mint(address(this), 100_000);
        chips.approve(address(ch), type(uint256).max);
        ch.fundHouse(50_000);
        vm.prank(playerWallet);
        chips.approve(address(ch), type(uint256).max);

        string memory json = vm.readFile("test/foundry/fixtures/diceSettleOnchainProof.json");
        proof = vm.parseJsonBytes(json, ".proof");
        publicInputs = vm.parseJsonBytes32Array(json, ".publicInputs");
    }

    // The verifier links ONE external library, ZKTranscriptLib. solc writes a 40-hex-char placeholder
    // token `__$<34-hex linkhash>$__` into the creation bytecode where the library address goes. The
    // linkhash is deterministic from the fully-qualified library name; pinned here. If a verifier regen
    // changes it, _deployLinkedVerifier's vm.replace finds no match and the deploy reverts — caught.
    string internal constant LINK_PLACEHOLDER = "__$46b871aef3f67394afdcde1fbbf01d674a$__";

    /// Deploy ZKTranscriptLib, substitute its address into the verifier creation-bytecode link
    /// placeholder, and CREATE the verifier. Reproduces what `new HonkVerifier()` does in-profile,
    /// but from the PRE-BUILT artifact so the verifier is never recompiled under this profile's viaIR.
    function _deployLinkedVerifier() internal returns (address dep) {
        address lib = vm.deployCode("DiceSettleHonkVerifier.sol:ZKTranscriptLib");

        // Read the verifier creation bytecode as a hex STRING from the artifact (vm.getCode rejects the
        // unlinked placeholder, so we read+patch the raw string ourselves), replace the placeholder
        // token with the deployed library address (20-byte hex, no 0x), and parse to bytes.
        string memory artifact = vm.readFile("forge-out-zkverify/DiceSettleHonkVerifier.sol/HonkVerifier.json");
        string memory creationHex = vm.parseJsonString(artifact, ".bytecode.object");
        string memory libHex = _addrHexNoPrefix(lib);
        string memory linked = vm.replace(creationHex, LINK_PLACEHOLDER, libHex);
        bytes memory code = vm.parseBytes(linked);

        assembly {
            dep := create(0, add(code, 0x20), mload(code))
        }
        require(dep != address(0), "verifier deploy failed");
    }

    /// address -> 40-hex-char string WITHOUT the 0x prefix (the form solc embeds for a linked library).
    function _addrHexNoPrefix(address a) internal pure returns (string memory) {
        bytes memory s = bytes(vm.toString(a)); // "0x" + 40 hex
        bytes memory out = new bytes(40);
        for (uint256 i = 0; i < 40; i++) out[i] = s[i + 2];
        return string(out);
    }

    function _params() internal pure returns (bytes memory) {
        return abi.encode(TARGET);
    }

    // Open a table whose commits match the fixture's seeds (so the proof binds to it).
    function _open(bytes32 tableId) internal {
        OpenTerms memory t;
        t.tableId = tableId;
        t.player = playerWallet;
        t.playerKey = playerKey;
        t.escrowPlayer = ESCROW_PLAYER;
        t.escrowHouse = ESCROW_HOUSE;
        t.gameId = DICE;
        t.rngCommit = keccak256(abi.encodePacked(SERVER));
        t.clockBlocks = CLOCK;
        t.expiry = uint64(block.timestamp + 1 hours);
        t.clientSeedCommit = keccak256(abi.encodePacked(CLIENT));
        t.paramsHash = keccak256(_params());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pkHouse, ch.openTermsDigest(t));
        vm.prank(playerWallet);
        ch.open(t, abi.encodePacked(r, s, v));
    }

    // --- the happy path: a real proof settles, funds conserved, payout matches Track-1 math ---
    function test_validProofSettlesAndConserves() public {
        _open(TID);
        uint256 playerBefore = chips.balanceOf(playerWallet);
        uint256 poolBefore = ch.housePool();

        ch.settleWithProof(TID, _params(), PAYOUT_WIN, proof);

        // player receives exactly the proven payout (== the dice-WIN payout from the canonical math).
        assertEq(chips.balanceOf(playerWallet), playerBefore + PAYOUT_WIN, "player payout");
        // house share (pot - payout) returns to the pool.
        uint256 toHouse = (ESCROW_PLAYER + ESCROW_HOUSE) - PAYOUT_WIN;
        assertEq(ch.housePool(), poolBefore + toHouse, "house pool");
        // conservation: payouts sum to the locked pot — no mint, no steal.
        assertEq(PAYOUT_WIN + toHouse, ESCROW_PLAYER + ESCROW_HOUSE, "conservation");
    }

    // --- the proof verified is the SAME proof the off-chain prover produced (sanity) ---
    function test_payoutEqualsProvenPublicInput() public {
        // last public input is payoutPlayer; assert the test constant matches the fixture.
        assertEq(uint256(publicInputs[publicInputs.length - 1]), PAYOUT_WIN, "fixture payout binding");
    }

    // --- tampered proof reverts (bb verifier reverts; settle never happens) ---
    function test_tamperedProofReverts() public {
        _open(TID);
        bytes memory bad = proof;
        bad[bad.length - 1] = bytes1(uint8(bad[bad.length - 1]) ^ 0xff);
        vm.expectRevert();
        ch.settleWithProof(TID, _params(), PAYOUT_WIN, bad);
    }

    // --- wrong payoutPlayer reverts: the claimed payout is a bound public input, so a different value
    //     makes the proof fail to verify (the player cannot over-claim) ---
    function test_wrongPayoutReverts() public {
        _open(TID);
        vm.expectRevert(); // verifier reverts on mismatched public input
        ch.settleWithProof(TID, _params(), PAYOUT_WIN + 1, proof);
    }

    // --- REPLAY across channels: a table opened with DIFFERENT commits (a different round) cannot be
    //     settled with this proof. The contract feeds the table's own commits into the verifier, so the
    //     transcript differs and verify() fails. This is the core anti-replay binding. ---
    function test_replayDifferentChannelReverts() public {
        bytes32 otherTid = keccak256("zk-mode2-OTHER");
        // open a table whose commits are for DIFFERENT seeds (0x..02 / 0x..09) — same escrows/params.
        OpenTerms memory t;
        t.tableId = otherTid;
        t.player = playerWallet;
        t.playerKey = playerKey;
        t.escrowPlayer = ESCROW_PLAYER;
        t.escrowHouse = ESCROW_HOUSE;
        t.gameId = DICE;
        t.rngCommit = keccak256(abi.encodePacked(bytes32(uint256(2))));
        t.clockBlocks = CLOCK;
        t.expiry = uint64(block.timestamp + 1 hours);
        t.clientSeedCommit = keccak256(abi.encodePacked(bytes32(uint256(9))));
        t.paramsHash = keccak256(_params());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pkHouse, ch.openTermsDigest(t));
        vm.prank(playerWallet);
        ch.open(t, abi.encodePacked(r, s, v));

        // the fixture proof was made for the 0x..01 / 0x..08 commits; against this table it must fail.
        vm.expectRevert();
        ch.settleWithProof(otherTid, _params(), PAYOUT_WIN, proof);
    }

    // --- params binding: wrong params (paramsHash mismatch) reverts before verify ---
    function test_wrongParamsReverts() public {
        _open(TID);
        vm.expectRevert(HouseChannel.BadParams.selector);
        ch.settleWithProof(TID, abi.encode(uint256(1234)), PAYOUT_WIN, proof);
    }

    // --- no verifier wired for a game => NoVerifier ---
    function test_noVerifierReverts() public {
        ch.setProofVerifier(DICE, address(0));
        _open(TID);
        vm.expectRevert(HouseChannel.NoVerifier.selector);
        ch.settleWithProof(TID, _params(), PAYOUT_WIN, proof);
    }

    // --- double settle reverts (table no longer Live) ---
    function test_doubleSettleReverts() public {
        _open(TID);
        ch.settleWithProof(TID, _params(), PAYOUT_WIN, proof);
        vm.expectRevert(HouseChannel.BadStatus.selector);
        ch.settleWithProof(TID, _params(), PAYOUT_WIN, proof);
    }

    // --- mode 1 (recompute) still works alongside mode 2 — additive, not a replacement ---
    function test_mode1StillWorks() public {
        _open(TID);
        uint256 playerBefore = chips.balanceOf(playerWallet);
        // settleWithSeeds reveals the seeds and recomputes — same payout as the proof path.
        ch.settleWithSeeds(TID, SERVER, CLIENT, _params());
        assertEq(chips.balanceOf(playerWallet), playerBefore + PAYOUT_WIN, "mode-1 payout");
    }

    // --- gas report for verify + settle (mode 2) ---
    function test_gas_settleWithProof() public {
        _open(TID);
        uint256 g0 = gasleft();
        ch.settleWithProof(TID, _params(), PAYOUT_WIN, proof);
        uint256 used = g0 - gasleft();
        emit log_named_uint("settleWithProof gas (verify + settle)", used);
    }
}
