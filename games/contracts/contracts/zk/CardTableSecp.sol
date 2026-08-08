// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice GENERATED — do not hand-edit. Regenerate via
/// games/zk-core/scripts/gen-card-table-secp.mts. NOTE: this NatSpec deliberately avoids
/// writing the npm scope name of any dependency verbatim with a leading at-sign — solc's
/// NatSpec parser treats a leading at-sign as a doc-tag and rejects unknown ones at the
/// contract level (error 6546); see CardTable52.sol for the precedent this mirrors.
///
/// Fixed 52-point plaintext-card decode table for HoldemTableN's showdown-share decode over
/// secp256k1 — the SAME curve games/zk-core/src/elgamal.ts uses off-chain (NOT the uzkge
/// Baby-JubJub/ed_on_bn254 table in vendor/uzkge/CardTable52.sol, which is a different curve
/// for a different table). Card index i (0..51) maps to point (i+1)*G, matching
/// elgamal.ts's `cardPoint(i)`. This is what a showdown slot decrypts to once
/// c2 - sum(decryption shares) is fully unmasked.
///
/// matchCard() finds the row by x (unique across all 52 entries) then checks the paired y,
/// returning ok=false (NOT reverting) on no match OR a mismatched y. Non-reverting is
/// deliberate: a showdown decrypt can legitimately land on a non-table point (a decoy/garbage
/// masking key from a malicious seat, or (0,0) for a missing share) and the caller
/// (HoldemShowdownLib / HoldemTableN's finalize path) must be able to branch on that — fall
/// back to a split/void outcome — rather than have the whole finalize revert and strand funds.
/// (Named `matchCard`, not `match` — the latter is a reserved Solidity keyword.)
library CardTableSecp {
    function matchCard(uint256 x, uint256 y) internal pure returns (bool ok, uint8 card) {
        if (x == 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798) {
            return (y == 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8, 0);
        }
        if (x == 0xc6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5) {
            return (y == 0x1ae168fea63dc339a3c58419466ceaeef7f632653266d0e1236431a950cfe52a, 1);
        }
        if (x == 0xf9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9) {
            return (y == 0x388f7b0f632de8140fe337e62a37f3566500a99934c2231b6cb9fd7584b8e672, 2);
        }
        if (x == 0xe493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13) {
            return (y == 0x51ed993ea0d455b75642e2098ea51448d967ae33bfbdfe40cfe97bdc47739922, 3);
        }
        if (x == 0x2f8bde4d1a07209355b4a7250a5c5128e88b84bddc619ab7cba8d569b240efe4) {
            return (y == 0xd8ac222636e5e3d6d4dba9dda6c9c426f788271bab0d6840dca87d3aa6ac62d6, 4);
        }
        if (x == 0xfff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a1460297556) {
            return (y == 0xae12777aacfbb620f3be96017f45c560de80f0f6518fe4a03c870c36b075f297, 5);
        }
        if (x == 0x5cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc) {
            return (y == 0x6aebca40ba255960a3178d6d861a54dba813d0b813fde7b5a5082628087264da, 6);
        }
        if (x == 0x2f01e5e15cca351daff3843fb70f3c2f0a1bdd05e5af888a67784ef3e10a2a01) {
            return (y == 0x5c4da8a741539949293d082a132d13b4c2e213d6ba5b7617b5da2cb76cbde904, 7);
        }
        if (x == 0xacd484e2f0c7f65309ad178a9f559abde09796974c57e714c35f110dfc27ccbe) {
            return (y == 0xcc338921b0a7d9fd64380971763b61e9add888a4375f8e0f05cc262ac64f9c37, 8);
        }
        if (x == 0xa0434d9e47f3c86235477c7b1ae6ae5d3442d49b1943c2b752a68e2a47e247c7) {
            return (y == 0x893aba425419bc27a3b6c7e693a24c696f794c2ed877a1593cbee53b037368d7, 9);
        }
        if (x == 0x774ae7f858a9411e5ef4246b70c65aac5649980be5c17891bbec17895da008cb) {
            return (y == 0xd984a032eb6b5e190243dd56d7b7b365372db1e2dff9d6a8301d74c9c953c61b, 10);
        }
        if (x == 0xd01115d548e7561b15c38f004d734633687cf4419620095bc5b0f47070afe85a) {
            return (y == 0xa9f34ffdc815e0d7a8b64537e17bd81579238c5dd9a86d526b051b13f4062327, 11);
        }
        if (x == 0xf28773c2d975288bc7d1d205c3748651b075fbc6610e58cddeeddf8f19405aa8) {
            return (y == 0x0ab0902e8d880a89758212eb65cdaf473a1a06da521fa91f29b5cb52db03ed81, 12);
        }
        if (x == 0x499fdf9e895e719cfd64e67f07d38e3226aa7b63678949e6e49b241a60e823e4) {
            return (y == 0xcac2f6c4b54e855190f044e4a7b3d464464279c27a3f95bcc65f40d403a13f5b, 13);
        }
        if (x == 0xd7924d4f7d43ea965a465ae3095ff41131e5946f3c85f79e44adbcf8e27e080e) {
            return (y == 0x581e2872a86c72a683842ec228cc6defea40af2bd896d3a5c504dc9ff6a26b58, 14);
        }
        if (x == 0xe60fce93b59e9ec53011aabc21c23e97b2a31369b87a5ae9c44ee89e2a6dec0a) {
            return (y == 0xf7e3507399e595929db99f34f57937101296891e44d23f0be1f32cce69616821, 15);
        }
        if (x == 0xdefdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34) {
            return (y == 0x4211ab0694635168e997b0ead2a93daeced1f4a04a95c0f6cfb199f69e56eb77, 16);
        }
        if (x == 0x5601570cb47f238d2b0286db4a990fa0f3ba28d1a319f5e7cf55c2a2444da7cc) {
            return (y == 0xc136c1dc0cbeb930e9e298043589351d81d8e0bc736ae2a1f5192e5e8b061d58, 17);
        }
        if (x == 0x2b4ea0a797a443d293ef5cff444f4979f06acfebd7e86d277475656138385b6c) {
            return (y == 0x85e89bc037945d93b343083b5a1c86131a01f60c50269763b570c854e5c09b7a, 18);
        }
        if (x == 0x4ce119c96e2fa357200b559b2f7dd5a5f02d5290aff74b03f3e471b273211c97) {
            return (y == 0x12ba26dcb10ec1625da61fa10a844c676162948271d96967450288ee9233dc3a, 19);
        }
        if (x == 0x352bbf4a4cdd12564f93fa332ce333301d9ad40271f8107181340aef25be59d5) {
            return (y == 0x321eb4075348f534d59c18259dda3e1f4a1b3b2e71b1039c67bd3d8bcf81998c, 20);
        }
        if (x == 0x421f5fc9a21065445c96fdb91c0c1e2f2431741c72713b4b99ddcb316f31e9fc) {
            return (y == 0x2b90f16d11dabdb616f6db7e225d1e14743034b37b223115db20717ad1cd6781, 21);
        }
        if (x == 0x2fa2104d6b38d11b0230010559879124e42ab8dfeff5ff29dc9cdadd4ecacc3f) {
            return (y == 0x02de1068295dd865b64569335bd5dd80181d70ecfc882648423ba76b532b7d67, 22);
        }
        if (x == 0xfe72c435413d33d48ac09c9161ba8b09683215439d62b7940502bda8b202e6ce) {
            return (y == 0x6851de067ff24a68d3ab47e09d72998101dc88e36b4a9d22978ed2fbcf58c5bf, 23);
        }
        if (x == 0x9248279b09b4d68dab21a9b066edda83263c3d84e09572e269ca0cd7f5453714) {
            return (y == 0x73016f7bf234aade5d1aa71bdea2b1ff3fc0de2a887912ffe54a32ce97cb3402, 24);
        }
        if (x == 0x6687cdb5b650d558f40cbdefc8e40997c03fe1b2abb840885e5cad81710c4c8a) {
            return (y == 0x3fd502b3111178b11a1fa873825c72000ef8e529f033f272b32e83b25c83ad64, 25);
        }
        if (x == 0xdaed4f2be3a8bf278e70132fb0beb7522f570e144bf615c07e996d443dee8729) {
            return (y == 0xa69dce4a7d6c98e8d4a1aca87ef8d7003f83c230f3afa726ab40e52290be1c55, 26);
        }
        if (x == 0x55eb67d7b7238a70a7fa6f64d5dc3c826b31536da6eb344dc39a66f904f97968) {
            return (y == 0x7d916a47b2b581400b1e718bf404258540973bce1c95052dd0689f2f493be3c8, 27);
        }
        if (x == 0xc44d12c7065d812e8acf28d7cbb19f9011ecd9e9fdf281b0e6a3b5e87d22e7db) {
            return (y == 0x2119a460ce326cdc76c45926c982fdac0e106e861edf61c5a039063f0e0e6482, 28);
        }
        if (x == 0x6d2b085e9e382ed10b69fc311a03f8641ccfff21574de0927513a49d9a688a00) {
            return (y == 0xacb82eb93309ad1cc739ddfa33604a83776238aa0bd5ff248dbac47a17f388fb, 29);
        }
        if (x == 0x6a245bf6dc698504c89a20cfded60853152b695336c28063b61c65cbd269e6b4) {
            return (y == 0xe022cf42c2bd4a708b3f5126f16a24ad8b33ba48d0423b6efd5e6348100d8a82, 30);
        }
        if (x == 0xd30199d74fb5a22d47b6e054e2f378cedacffcb89904a61d75d0dbd407143e65) {
            return (y == 0x95038d9d0ae3d5c3b3d6dec9e98380651f760cc364ed819605b3ff1f24106ab9, 31);
        }
        if (x == 0x1697ffa6fd9de627c077e3d2fe541084ce13300b0bec1146f95ae57f0d0bd6a5) {
            return (y == 0xb9c398f186806f5d27561506e4557433a2cf15009e498ae7adee9d63d01b2396, 32);
        }
        if (x == 0x1be68a5a028f2601d0e80d468c344ba331d611b96c358b6032e8b4da0547fc11) {
            return (y == 0xbebc47511ade7308b3ca6265f9400779c076329c75146bc6ff1822f5d1f30e79, 33);
        }
        if (x == 0x605bdb019981718b986d0f07e834cb0d9deb8360ffb7f61df982345ef27a7479) {
            return (y == 0x02972d2de4f8d20681a78d93ec96fe23c26bfae84fb14db43b01e1e9056b8c49, 34);
        }
        if (x == 0xe0392cfa338aaf2f0b56c563e3e5e67a5d5fefe3388f85d90c899da20f0198f9) {
            return (y == 0x76d458642a2c93adee7a347a5e4681f9bb5b10f4bd8aa51edfd6e3f50e7da3ac, 35);
        }
        if (x == 0x62d14dab4150bf497402fdc45a215e10dcb01c354959b10cfe31c7e9d87ff33d) {
            return (y == 0x80fc06bd8cc5b01098088a1950eed0db01aa132967ab472235f5642483b25eaf, 36);
        }
        if (x == 0xb699a30e6e184cdfa88ac16c7d80bffd38e2e1fc705821ea69cd5fdf1691fff7) {
            return (y == 0xd505700c51d860ce5a096ee637ebed3bd9d7268126c76a16b745bc318a51ab04, 37);
        }
        if (x == 0x80c60ad0040f27dade5b4b06c408e56b2c50e9f56b9b8b425e555c2f86308b6f) {
            return (y == 0x1c38303f1cc5c30f26e66bad7fe72f70a65eed4cbe7024eb1aa01f56430bd57a, 38);
        }
        if (x == 0x91de2f6bb67b11139f0e21203041bf080eacf59a33d99cd9f1929141bb0b4d0b) {
            return (y == 0xeb9ef6c031eed31de34e7a1009f8725155b03158202a9d3e9a9a2e83124a7899, 39);
        }
        if (x == 0x7a9375ad6167ad54aa74c6348cc54d344cc5dc9487d847049d5eabb0fa03c8fb) {
            return (y == 0x0d0e3fa9eca8726909559e0d79269046bdc59ea10c70ce2b02d499ec224dc7f7, 40);
        }
        if (x == 0xfe8d1eb1bcb3432b1db5833ff5f2226d9cb5e65cee430558c18ed3a3c86ce1af) {
            return (y == 0x07b158f244cd0de2134ac7c1d371cffbfae4db40801a2572e531c573cda9b5b4, 41);
        }
        if (x == 0xd528ecd9b696b54c907a9ed045447a79bb408ec39b68df504bb51f459bc3ffc9) {
            return (y == 0xeecf41253136e5f99966f21881fd656ebc4345405c520dbc063465b521409933, 42);
        }
        if (x == 0x5d045857332d5b9e541514731622af8d60c180165d971a61e06b70a9b3834765) {
            return (y == 0xdb2ba972802d45fd2decbab8d098a8c2a1d1f34761c6cf261879a7cabf06fb68, 43);
        }
        if (x == 0x049370a4b5f43412ea25f514e8ecdad05266115e4a7ecb1387231808f8b45963) {
            return (y == 0x758f3f41afd6ed428b3081b0512fd62a54c3f3afbb5b6764b653052a12949c9a, 44);
        }
        if (x == 0xf8b0b03d44112259f903b3d100e3950d980fdde9c7e85701c16baedc90235717) {
            return (y == 0xbd8e9dc301d9adc96be1883b362f123bd0a986928ac79972517ab5c246242203, 45);
        }
        if (x == 0x77f230936ee88cbbd73df930d64702ef881d811e0e1498e2f1c13eb1fc345d74) {
            return (y == 0x958ef42a7886b6400a08266e9ba1b37896c95330d97077cbbe8eb3c7671c60d6, 46);
        }
        if (x == 0x6eca335d9645307db441656ef4e65b4bfc579b27452bebc19bd870aa1118e5c3) {
            return (y == 0xd50123b57a7a0710592f579074b875a03a496a3a3bf8ec34498a2f7805a08668, 47);
        }
        if (x == 0xf2dac991cc4ce4b9ea44887e5c7c0bce58c80074ab9d4dbaeb28531b7739f530) {
            return (y == 0xe0dedc9b3b2f8dad4da1f32dec2531df9eb5fbeb0598e4fd1a117dba703a3c37, 48);
        }
        if (x == 0x29757774cc6f3be1d5f1774aefa8f02e50bc64404230e7a67e8fde79bd559a9a) {
            return (y == 0xc39d07337ddc9268a0eba45a7a41876d151b423eac4033b550bd28c17c470134, 49);
        }
        if (x == 0x463b3d9f662621fb1b4be8fbbe2520125a216cdfc9dae3debcba4850c690d45b) {
            return (y == 0x5ed430d78c296c3543114306dd8622d7c622e27c970a1de31cb377b01af7307e, 50);
        }
        if (x == 0x2b22efda32491a9e0294339ca3da761f7d36cfc8814c1b29ca731921025ff695) {
            return (y == 0x7ed520327080a9fa4c16662fc134fadcc7048846d46ade0030b83fd19adc87cd, 51);
        }
        return (false, 0);
    }
}
