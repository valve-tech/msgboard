// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {EdOnBN254} from "../vendor/uzkge/libraries/EdOnBN254.sol";

/// @notice GENERATED — do not hand-edit the M table; regenerate via
/// games/zk-core/scripts/gen-deck-constants.mts (pins the zypher-game secret-engine npm package,
/// version 0.3.0). NOTE: this NatSpec deliberately avoids writing the npm scope name verbatim
/// with its leading at-sign — solc's NatSpec parser treats a leading at-sign as a doc-tag and
/// rejects unknown ones at the contract level (error 6546).
///
/// On-chain CANONICAL INITIAL (unshuffled) masked deck for ZkTable's deck-key-binding dispute
/// path (deckkey-binding-spec.md, B4). Zypher's init_masked_cards(agg, 52) output is deterministic
/// in a specific way, empirically confirmed by the regen script (run under two unrelated
/// aggregates, both e1==G and both M-tables identical): the masking randomness r is the constant
/// 1 for every card, every slot, every joint key agg — so e1_i == G (the fixed EdOnBN254
/// generator) always, and e2_i == M_i (+) agg where M_i is this FIXED per-slot point, independent
/// of agg. That lets this contract recompute the entire 208-word initial deck for ANY joint key
/// from just these 52 hardcoded points plus 52 point-additions (~52 EdOnBN254.add calls), with no
/// proof and no off-chain input beyond agg itself.
///
/// M_i here is the SAME canonical per-slot plaintext-card point table as
/// contracts/vendor/uzkge/CardTable52.sol (that file's decode table was derived independently, by
/// subtracting a reveal_card share rather than the raw aggregate — the two derivations agree,
/// which is itself part of the confirmation this table is correct; see gen-deck-constants.mts's
/// header for the cross-check).
///
/// Word layout of initialDeck's uint256[208] output MUST match what ZkTable._verifyAndStoreReveal
/// / ShowdownDecodeLib consume: per card i, deck[4i]=e1.x, deck[4i+1]=e1.y, deck[4i+2]=e2.x,
/// deck[4i+3]=e2.y (i.e. [c1.x, c1.y, c2.x, c2.y] in the seam's naming — c1 is the ElGamal
/// ephemeral, c2 the message-bearing point). This is verified byte-for-byte against a live
/// Zypher-generated deck in test/foundry/DeckConstants.t.sol (FOUNDRY_PROFILE=ffi).
library DeckConstants {
    uint256 internal constant DECK_SIZE = 52;
    uint256 internal constant DECK_WORDS = 208;

    /// @dev The 52 fixed per-slot card points M_i (i = 0..51), flattened [x0,y0,x1,y1,...],
    /// in the SAME canonical order as CardTable52 / init_masked_cards's unshuffled deck position
    /// i (deck position i decodes to plaintext card index i).
    function _points() private pure returns (uint256[104] memory p) {
        p = [
            0x23118ac889f6ac9172ea3e80a3741abe2cebce374cc96a6d98bfa132cd2b1e97, 0x0e7e20b3cb30785b64cd6972e2ddf919db64d03d6cf01456243c5ef2fb766a65, 0x242cbada3ae8d6e90056e73e4941eeccee72cb99945a194f754205b3678bd769, 0x2d7690deeaa77c9d89b0ceb3c25f7bb09c44f40b4b8cf5d6fcb512c7be8fcba9,
            0x22061fddb411408e4469f02ca3fce002f9ef481aef65cfba9142af3689ce3b21, 0x13a50334ef174fd8160bb22e5f150b0ce7656c5c4a19b0ad6bc8f93fdf5fab7c, 0x20717bc201b973fb407d64a3136a351cd9b279763252d6b13a96154538a5f890, 0x02acd55fbf59ea2b7a4733ccb5568681e6445d2cba2a4ee0707c1c1d3bc27fea,
            0x229a442b94aafa3c7316e10a632d0aceb92ed13b832deb794b91b7ecda38b2f3, 0x17fd6b5a880d0570dad7bd4da582c2ba03717615764e3955a8bf2a1b546abfa2, 0x20dd45eb511c4c3d1509e6ec6e34b17f4132424c51cd66a7678f66e9367f872d, 0x10b37010cd0d430a2bc91ee19f30d1a3d5984605dc299953fdd1ef2fff2f1a95,
            0x22617ca9d3484fa6d1b287226c01b89d657f2c14befc40b3aa2d965b19bbe067, 0x2a6a6ec33c00e9d9073ce5e48f45afd40cb29303bbc0367606c6f2963ec057c9, 0x19a80e23e0a9d02127777d8f5d88e17a2c7e434f07107912957b70e7324ea3d9, 0x27bfe4a93f3e0802f37732ef692a7ff681ce6baaacb6e1cc73e972374e58cec2,
            0x2fd5618e727854e94c1cc6c5f1bd537d826e6bdbcb415fbbbd70eeade8b6694d, 0x2627f2b312c0f1f30b638a1ccc76c7025e94d99cc6006229432fa431044cf7aa, 0x1d66a40fe2e50fe931dbb34736ff309eeeaed15abc04d4523091ad380fd2d2cd, 0x0eb99c13f783f3416210d34a8e5fa766ae239c4c00cb9d3e81f14dc975a7a957,
            0x186d8b011025f8af258ab91d00eb6111bb571bf7859707af310fd59ee270f878, 0x1245109a40dc41351a708f1b7c6fb8bcf809c656b366fb1d0fa7a46991d2b977, 0x249d1270e48ce350b5425e48371a38bfe5d3f6667fd19360546e5218047116f9, 0x000f90cf5f6433978210b9098c0e0865d44f6bc4ab9a7c3cfa63ed7e586f8fa7,
            0x23794670cbc92779c1d4c4ab1319335d9c973279f5efa3f33498c73fd1c165b4, 0x2c957cd805d207f518047f6117ecd42fa98b78734efe4cb588cd409ff25aa0b8, 0x2160bd7ed7b219bb8f63c2208a1071525e48bdc4b35ab2cdeb26d62f37e3fc76, 0x2d4b20b261ace4d99d8d80a0998133b0f5c49bad68a4a9a92e9fe2084c8dcde8,
            0x1ca0fed3941b3f574bae9c6d6a5a75a677a5cf1d46a314423348c21f5cd47ab8, 0x23f5c25e039914df2928a715bf68c41ba91b51103d1b1aeaba9323b677b9ea8d, 0x2b64a56a0abebdf781b5f951f0b46887a3a642603c2b10f8f122f692ff68ad0e, 0x04578915cb17f8fd142120c1bd5c0a26da6668cd746aad9ce707ccfd4464533f,
            0x2d6c7f5c4ba17c8a9f04ca462309fa1f00832778ad33fba1439f9e1bbc33d70a, 0x18d33bc856f163194090c1c6419aedbedfaf6dcfb23588ce7002d7deb6ea7623, 0x281b7cbede803c58af75a6d43adc053e7f1189f92893bcddce87a79b8b4f2817, 0x1db8329a5d644ab56185ebb02724b836c5b1d22d29a57965a0e3a43067e06a08,
            0x28d36271c74cd1a1c8939b990965db4e61f7f2ec5e8d65c5b95a00f811e17043, 0x17a87862cbcee70b0cd0c442d36e26ed763385bb2e948d8f00469d908aa07e72, 0x2c7cabfb0115df002782e779bce19cc59594a9ef7912277a10a32a9d598d3edd, 0x13fa0efab13db7078ee0aa83cf8fd476614c779e530da57c2101177e69cd68e3,
            0x237e350b64d55aaa7525b0c2e58ec79c95f0153e74362e9128cb10c4cb827524, 0x16d52c3e7be3ab38454acdfa2cd7a3cb7a321092f41f038a3ae4f1947bad724e, 0x23617f2ef7aea8c3beca9aee046cbff6adc8387ec26358b8f5d4ae1dc2c91b38, 0x14157ff39b00904e49f284a3ae75e225b995e3b123887c2ddea019e791fcf88d,
            0x21cb7925cbe107706b7f34b429ff88621efe0e09f8bed736e8deb5ea36d431c5, 0x0967dd7bac9eb504b37cf33860d77e8ed747f54864aabb63b2487c3f249dd2d2, 0x2514666ff5f1c782e1f501389904bedd9d0ad09740a056ae85e029d7796f0afa, 0x0047239fd59b5ce078d0fa8a1f0c667b2355fb331bfcfe5fe58754cdade49f2b,
            0x1f215334bfe5e52ea8cef7fcb18c4700dd7fcfe78f4d8a188020ef01bcfdf651, 0x0f220815394d328c3a819ca5dc13219b422b8443eca0b8e6911d2b0078d1bb68, 0x2b55656e2c251d83a45fda757080072d7d11d7b7502d6e1b94b4fb1420093e2e, 0x04c1f519b090dac2ebff9282ca66592f8b9b6c8c2e38705740daa1230fe2b6cc,
            0x1d554b35c77a76b88fc35361fa00778b46e793e7ed891d7444aa3ada2eaba60c, 0x169a776c4976ebb48f3c2f3eb6214f26ac70557acd6a28c95044653dee7c7306, 0x1e45bc1d1364497c156d76c5c3e3dfd3819227be04c09fb3006ff8fd021a39c7, 0x17859495fda1f3ac4d240997cfa7d61d9624006410ddc97c7060a24e9fc1053a,
            0x29fd70894e3e1b69a5286864eb9110b90fb96d16387175ba0888dae500b7fec4, 0x250f584b0539ef28cb0b7a136b26a2b796fbbde5a0df8236b4775c0e713ef8c8, 0x19b0fc810698c0ec14772f04ff26da87e3ef9a981ff41b626c70843e849d8e5a, 0x025761ba480df2787230ecd283209f959b80a16ff631b751e2213a431a0be30c,
            0x195ead7b2f16628e26cf7a25cc80c1b1b5a58202549f85b692bae8150ec752f3, 0x0ac3e3209fa174e4981b53a69ce6c5cbca1e217262a27826621553d15fce1317, 0x1bf8ab76c97d9383fb07e1aba54b0415b59adfdbe9c03eccc2ff6fbd37c82f84, 0x1daa7bc5da2abf17ed3a43a4a3ddec8e0ed6cc3f2a729b6bfab7f4f252f47197,
            0x29ec5991706c677e5ee08fd469052a50cbc36ba0728f8ad4b3e3e716252a9165, 0x17e97bb5c68c80f4c0f38eebf4106b0c8ec02c6d9d678588be5f4a71b43c86fe, 0x2d236f71deb33f6e0ec9e7991e8a1fd2ae0ae17e9a1f42f3d650354c6608199e, 0x1dcedb86bb03fa3b404afd3edaa59ceaf8122b2e9dc35c1cdc9f4c65ac6df154,
            0x2cb7051a7b113a0c427bea94e5d5941846eae003b91394913db14b59ae72f365, 0x2f2ce3a1cddb1e92541481d30b7c43af5d0350266672632ad06728818b6affdb, 0x3021c9f38cfebd4db94ad791252687fff0283c46b65f11c4346e355067dc7e05, 0x2c9fb046ab1f36b104b456598d00e3211fb31b0ef357d7c7de55c4a122257dbe,
            0x1b83e2dd3e7fabcff48100a7017809845257ba707f317a919d608609891f065f, 0x078d7b6afe9372d90a9b9e2e5f40dc97c06bed7821c0870c8f19847cb4d6d5ce, 0x2c8502d963ced5e206e015f79925d9670eab426e5e76d61bba5cab79dcbab73f, 0x0548073474086bb9f2f2eda49f8625572f2be9d6b71bb293388e3ff9ad8fb7aa,
            0x1f3d0fd965be1878140f51f0042c6225e11c98db6917bd6fa08bdcd8e7f01223, 0x012b6918773feaa8a22ac16c2e243f2c371c98dbf13801ad0bb9f4cee4575c8d, 0x24d32d7ebebd9d9a4363d6db5b787ad300b414c99d33e8732c2472ff8e7d8e92, 0x1abcecb5d562b19da37897d7db6f6227be857493300e1f38d234b43d36037b5d,
            0x1a29d444d1aeb20d4bcc4855a9f05ad62190e92d242b0f7107940632a36a98c3, 0x2fb979bcc2cc562386634c502b9425003d9c0876250b28e21996de4babe104cc, 0x2f15739f6357b7bc50251ccc03f296e4e9143b01402955347162e12d89843c5e, 0x173e80227d906db5ba7289d3611dae189797aa8e3e235949e76d2ce97f6f3c73,
            0x1c93e2923ba3f919f22548b193620f3baff473640309e050b5f49857255b8df0, 0x022a95649ff5d46713821806b85466cf709ad85171567cf1c0692940793dd30f, 0x1fa7cda8a96fb094c1dff65d33744f24167ec0c259e6cf10ac160f23fe0be24c, 0x00fbc18c6483aef1404ac3e81cae370bb7c9548b5d76124017d522043fc19a6c,
            0x2bb3373e64b15a66d56bdc8124f0d0824c913ec38de1dbe97c3c76f5c75447e4, 0x1d65fcc3af60454fcb4b6a5fd74eb5c3305757a8a47ff7d07cd92e74cb2a1fbb, 0x2d142eedd945e24f81216a1deac8bf987705ad525102ad4f151e8fbcd578b3a7, 0x227532d0e59b89a139600b60e96a3a8950a93dfa61e40ae623bd16f5529c0687,
            0x288c372e990177f2794c2cacf8f61ce8e1e9aef3dc2af067f93c2beb101168e4, 0x10f119e93c8adb81acde0c8876e199a30fa0e5f96345a14ab5e6aee59ad80e12, 0x23a25fde9b82fe58ea1a694289704b6d587f3e373e5cd7caf068b2d60dcbbd1c, 0x1785b53f50e8bb17af2e5394c3c12bcf8349c13b45a0f0aff2da29070e2109b2,
            0x1fe433e88795f95b85b20ca4e65a77ab90f09e34216118ca10d76d20e1d3f9a9, 0x0e928ce03f8f6d07a6c818b295bbc453034e07c55f43eb85b576b22739eb4a51, 0x2ac502c64f0043ef439e7d1184a5f5e1ee2b79a4fdc343d11afce0415409471e, 0x0d55d8fae5d67f985fe733eaf647f53f42490c2226e54bb7058031fc5e4ef58e,
            0x1970d7681e0be9cf3c69c47ee6e230982d5c42ff89acd6fe77f7d1b955e28e89, 0x0759e62cf2464671501c16a8534d28bc2e5721a1de966ff2ef9e924424765f41, 0x287fd85fdda7987e249faf7cac78827e78c754a874d606d1ad72377e827cd8b4, 0x25bebd6ecfef4f2613efc455e4038489febf84079c88c787977fee2e07629b4b
        ];
    }

    /// @notice Recomputes the canonical initial (unshuffled) masked deck under joint key `agg`.
    /// For each card i: e1 = G (fixed generator), e2 = M_i (+) agg. ~52 EdOnBN254.add calls.
    function initialDeck(EdOnBN254.Point memory agg) internal view returns (uint256[208] memory deck) {
        uint256[104] memory pts = _points();
        EdOnBN254.Point memory g = EdOnBN254.generator();
        for (uint256 i = 0; i < DECK_SIZE; i++) {
            EdOnBN254.Point memory m = EdOnBN254.Point(pts[2 * i], pts[2 * i + 1]);
            EdOnBN254.Point memory e2 = EdOnBN254.add(m, agg);
            uint256 base = 4 * i;
            deck[base] = g.x;
            deck[base + 1] = g.y;
            deck[base + 2] = e2.x;
            deck[base + 3] = e2.y;
        }
    }

    /// @notice Deck-key-binding entry point (deckkey-binding-spec.md B4/§1.2): derives the joint
    /// masking key ON-CHAIN as the raw EdOnBN254 point sum of the two seats' REGISTERED deckKeys
    /// (`agg = k1 (+) k2`, the same semantics as RevealVerifier.aggregateKeys) and returns both
    /// that aggregate AND the canonical initial deck recomputed under it — so ZkTable never trusts
    /// a caller-supplied aggregate; it always derives one itself from state it already owns.
    ///
    /// Deliberately EXTERNAL (unlike `initialDeck` above, which stays `internal`/inlined for the
    /// existing DeckConstants.t.sol round-trip test): this is the entry point ZkTable's
    /// `_challengeDeck` links against as a separately-deployed library, for the same viaIR
    /// stack-budget reason `ShowdownDecodeLib` is external (see that file's header) — keeping the
    /// 52-point M-table and the EdOnBN254 arithmetic out of ZkTable's own bytecode.
    function initialDeckAndAgg(uint256[2] memory k1, uint256[2] memory k2)
        external
        view
        returns (uint256[] memory deck, uint256 aggX, uint256 aggY)
    {
        EdOnBN254.Point memory agg = EdOnBN254.add(EdOnBN254.Point(k1[0], k1[1]), EdOnBN254.Point(k2[0], k2[1]));
        uint256[208] memory fixedDeck = initialDeck(agg);
        deck = new uint256[](DECK_WORDS);
        for (uint256 i = 0; i < DECK_WORDS; i++) deck[i] = fixedDeck[i];
        aggX = agg.x;
        aggY = agg.y;
    }
}
