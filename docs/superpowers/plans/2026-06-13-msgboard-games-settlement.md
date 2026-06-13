# MsgBoard Games — Settlement Seam + Optimistic + Escrowed (Plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the off-chain `SessionState`s of Plan 1 on-chain under two interchangeable, signature-adjudicated settlement backends — an **optimistic House bankroll** (shared deposit, net-delta settle, highest-nonce-wins) and an **escrowed `HouseChannel`** (per-table escrow, cooperative settle + chess-clock dispute/forfeit) — behind a single TS `Settlement` seam, with the deferred TS↔Solidity `SessionState` EIP-712 digest parity test and full conservation/ephemerality coverage.

**Architecture:** Plan 2 of the `2026-06-13-msgboard-games-design.md` spec (§13 plan 2; §6.1 optimistic, §6.2 escrowed, §10 + §12 safety/testing). Money and finality live on-chain (spec §2); each backend pays **from co-signed balances the parties already hold signatures for** — it never recomputes a round, so no on-chain game-rules mirror is needed in this plan (that is the ZK plan, §13 plan 5). Solidity mirrors the Plan 1 `SessionState` tuple field-for-field (consensus); the new contracts reuse the `ZkTable` patterns verbatim where they fit (Solady `EIP712` domain, `structHash`/`stateDigest`, conservation guard, status-before-transfer `_payout`, ForceMove-style chess-clock dispute, `keyA`/`keyB` session keys). A new TS package `@gibs/msgboard-settle` consumes the Plan 1 retained `Transcript`, replays it to reconstruct the open + final co-signed states, and builds the viem settle/open/dispute calldata.

**Tech Stack:** Solidity `^0.8.24` (solc 0.8.25, viaIR, shanghai — matches the `ZkTable` family), Solady (`EIP712`, `ECDSA`, `SafeTransferLib`, `ERC20`, `Ownable`), Foundry (`forge test`, `vm.sign`) for fuzz/unit, Hardhat + `hardhat-viem` + Mocha/chai for the TS↔Solidity parity and end-to-end tests, Hardhat Ignition for deploy; off-chain TypeScript (ESM, viem ^2.25, vitest ^2.1, TS ~5.8) reusing `@gibs/msgboard-games` (Plan 1). Matches the surrounding `packages/contracts` + `examples/games/*` packages exactly.

**Where the code lives / git:** `~/Documents/gibs-finance/random`, branch `games-platform`. Contracts → `packages/contracts` (beside `ZkTable`); off-chain settlement seam → `examples/games/msgboard-settle`. Commits are unsigned in this repo (`commit.gpgsign false` already set locally). NO Co-Authored-By trailers. Push with `git push ssh://git@ssh.github.com:443/gibsfinance/random.git games-platform` (do this only when asked; a concurrent session may push, so `git fetch && git rebase origin/games-platform` on rejection). The plan + progress records live in the msgboard repo (`progress.txt` is the shared worklog for both repos).

**Conventions that bite:**
- pnpm workspace. Contracts package is `@gibs/random` (`packages/contracts`). Foundry tests live in `test/foundry/*.t.sol` and are run with `forge test` **from `packages/contracts`**; the default Foundry profile compiles `test/foundry` + transitive imports under viaIR/shanghai (the new contracts are tstore-free, so they compile cleanly there). Hardhat/Mocha TS tests live in `test/*.test.ts` and run with `pnpm test` (from `packages/contracts`). After adding a new contract you MUST add a per-contract override block to `hardhat.config.ts` (shanghai/viaIR/runs 1000) exactly as the `contracts/zk/*` entries do, or Hardhat compiles it cancun and the 943 deploy diverges.
- Solady imports are `solady/src/utils/...` and `solady/src/tokens|auth/...` (the remapping is `solady/=node_modules/solady/`; files live under `src/`). EIP-712 via Solady `EIP712` (NOT OpenZeppelin — OZ 5.6 emits MCOPY which solc rejects for shanghai/943).
- No floats anywhere; all amounts are `uint256` chip base units / `bigint`. `SessionState` field order is consensus — it MUST stay identical across `sessionState.ts` (Plan 1), `SessionState.sol`, every TYPEHASH, and every test.
- Off-chain contract clients import ABIs from the Hardhat artifacts: `@gibs/random/artifacts/contracts/games/<Name>.sol/<Name>.json` (the `@gibs/random` package ships `artifacts/`). The artifacts only exist after `pnpm --filter @gibs/random build` (hardhat compile) — run it before any TS that imports them.
- viem contract calls use simulate-then-write: `publicClient.simulateContract(...)` → `walletClient.writeContract(request)` (the `@gibs/games-core` `operator.ts` pattern).

## Numeric codes and canonical encodings pinned by this plan

(Plan 1 pinned the `SessionState` tuple; Plan 2 mirrors it on-chain and adds `OpenTerms`. Order is law — any reorder breaks EIP-712 parity.)

- **SessionState EIP-712 tuple** (matches Plan 1 `SESSION_STATE_TYPES`): `(bytes32 tableId, uint64 nonce, uint256 balancePlayer, uint256 balanceHouse, uint8 settlementMode, uint8 gameId, bytes32 gameStateHash, bytes32 rngCommit)`.
- **EIP-712 domain:** `name = "MsgBoardGames"`, `version = "1"`, `chainId`, `verifyingContract = <the settlement contract that will verify these sigs>`. A session signs against the contract it will settle on (chosen with `settlementMode` at open): optimistic → the `HouseBankroll` address, escrowed → the `HouseChannel` address.
- **settlementMode:** `0 = optimistic`, `1 = escrowed`, `2 = zk`. (Plan 2 implements 0 and 1; the contracts reject the mode they don't serve.)
- **gameId:** `1 = dice`, `2 = limbo`.
- **OpenTerms EIP-712 tuple** (escrowed open authorization, house-signed): `(bytes32 tableId, address player, address playerKey, uint256 escrowPlayer, uint256 escrowHouse, uint8 gameId, bytes32 rngCommit, uint64 clockBlocks, uint64 expiry)`.
- **Conservation:** every state a backend accepts satisfies `balancePlayer + balanceHouse == <the session's committed total>` — for optimistic that total is `openState.balancePlayer + openState.balanceHouse` (zero-sum vs the open); for escrowed it is `escrowPlayer + escrowHouse` (the on-chain locked total), exactly the `ZkTable` rule minus `pot`.

## Scoping decisions (read before implementing)

1. **Signature-adjudicated, not rules-adjudicated.** Both backends pay out the co-signed `balancePlayer`/`balanceHouse` directly. The contract never recomputes a Dice/Limbo round, so **no on-chain game-rules mirror and no game-rules parity test is in this plan.** "Parity tests" in the §13-plan-2 line refers to the `SessionState` EIP-712 digest parity (the item Plan 1's self-review explicitly deferred here). The on-chain Dice/Limbo rules mirror + fuzzed rules parity belong to the ZK/unilateral plan (§13 plan 5), where a backend actually adjudicates a round from a revealed seed.
2. **Optimistic deposits are keyed by the signing (session) key.** With no on-chain `open` in the optimistic path (its whole point — "the purest MsgBoard story", §6.1), the bankroll cannot know a wallet↔session-key binding, so it keys deposits/credits by the address that signs the `SessionState` (the in-memory session key of §4.3). "Authorize the session key once" (§4.3) becomes "fund the session key's deposit." The richer wallet-bound `SessionAuth` (so a leaked session key risks only one session's funds, not the whole deposit) is a documented follow-up; the **escrowed** `HouseChannel` already binds payout to the opening wallet and is the path for users wanting that hard guarantee. This is called out again in the self-review and READMEs.
3. **Escrowed open is a single player tx + a house signature.** The house pre-funds a `housePool`; the player calls `open(...)` escrowing their own chips and reserving the house's escrow from the pool, authorized by an off-chain `OpenTerms` signature from the house session key (instant, no house tx). This keeps the per-table escrow ("both sides escrow at open", §6.2) while staying off the play critical path and giving the house control over which tables draw its pool (anti-griefing).
4. **Dispute is co-signed-state + chess-clock only** ("the `ZkTable` dispute pattern, minus the shuffle machinery", §6.2). No reveal demand / no rules `applyMove` in this plan (single-draw games settle to agreed balances; the reveal-demand path is the unilateral/ZK plan). Because Plan 1's `open()` co-signs state 0, the player always holds at least one both-signed state, so no `disputeSetup` (the pre-state edge case `ZkTable` needs) is required.

## File structure

```
packages/contracts/
  contracts/games/
    SessionState.sol           SessionState struct + SessionStateLib (TYPEHASH/structHash) + abstract SessionStateEIP712
    Chips.sol                  mintable ERC20 unit of account (solady ERC20 + Ownable)
    HouseBankroll.sol          optimistic backend (§6.1): deposits, housePool, settle(open,final)
    HouseChannel.sol           escrowed backend (§6.2): OpenTerms, open, settle, dispute/respond/resolveTimeout
  contracts/test/
    SessionStateHarness.sol    concrete SessionStateEIP712 for the digest parity test
  test/foundry/
    HouseBankroll.t.sol        optimistic: settle/conservation/stale/single-sig/deposit-floor
    HouseChannel.t.sol         escrowed: open/settle/conservation/stale + dispute/timeout/respond
  test/
    SessionStateSig.test.ts    TS↔Solidity SessionState digest parity (the deferred Plan 1 item)
    MsgBoardSettleE2E.test.ts  deploy + real HouseSession off-chain + settle under both backends + dispute + ephemerality
  ignition/modules/
    MsgBoardGames.ts           deploy Chips + HouseBankroll + HouseChannel
  hardhat.config.ts            (modify) per-contract overrides for contracts/games/*
  package.json                 (modify) devDeps: @gibs/msgboard-games, @gibs/msgboard-settle

examples/games/msgboard-settle/
  package.json                 @gibs/msgboard-settle; deps @gibs/msgboard-games, @gibs/random, viem
  tsconfig.json                copy of msgboard-games/tsconfig.json
  src/
    index.ts                   public surface (re-exports)
    settlement.ts              Settlement interface + shared types (SettleArgs, OpenArgs, etc.)
    replay.ts                  replay a retained Transcript -> reconstructed open/final co-signed states
    openTerms.ts               OpenTerms EIP-712 types + signOpenTerms + makeSettleDomain
    optimistic.ts              OptimisticSettlement (HouseBankroll calldata)
    escrowed.ts                EscrowedSettlement (HouseChannel calldata)
  test/
    replay.test.ts
    openTerms.test.ts
    optimistic.test.ts
    escrowed.test.ts
  README.md
```

---

### Task 1: `SessionState.sol` library + EIP-712 base + TS↔Solidity digest parity (the deferred Plan 1 item)

**Read first:** `packages/contracts/contracts/zk/ChannelState.sol` (the library shape to mirror) and `packages/contracts/test/ZkChannelSig.test.ts` (the parity-test shape to mirror).

**Files:**
- Create: `packages/contracts/contracts/games/SessionState.sol`
- Create: `packages/contracts/contracts/test/SessionStateHarness.sol`
- Modify: `packages/contracts/hardhat.config.ts` (add overrides)
- Modify: `packages/contracts/package.json` (add `@gibs/msgboard-games` devDep)
- Create: `packages/contracts/test/foundry/SessionStateDigest.t.sol`
- Create: `packages/contracts/test/SessionStateSig.test.ts`

- [ ] **Step 1: Write `contracts/games/SessionState.sol`**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {EIP712} from "solady/src/utils/EIP712.sol";

/// Mirrors @gibs/msgboard-games sessionState.ts SESSION_STATE_TYPES exactly.
/// Field order is consensus — the off-chain EIP-712 typing and every TYPEHASH must match.
struct SessionState {
    bytes32 tableId;
    uint64 nonce;
    uint256 balancePlayer;
    uint256 balanceHouse;
    uint8 settlementMode; // 0 optimistic, 1 escrowed, 2 zk
    uint8 gameId;         // 1 dice, 2 limbo
    bytes32 gameStateHash;
    bytes32 rngCommit;
}

library SessionStateLib {
    bytes32 internal constant TYPEHASH = keccak256(
        "SessionState(bytes32 tableId,uint64 nonce,uint256 balancePlayer,uint256 balanceHouse,uint8 settlementMode,uint8 gameId,bytes32 gameStateHash,bytes32 rngCommit)"
    );

    function structHash(SessionState calldata s) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            TYPEHASH, s.tableId, s.nonce, s.balancePlayer, s.balanceHouse,
            s.settlementMode, s.gameId, s.gameStateHash, s.rngCommit
        ));
    }

    /// Identical body for a `memory` state (tests, contracts holding a memory struct).
    function structHashMem(SessionState memory s) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            TYPEHASH, s.tableId, s.nonce, s.balancePlayer, s.balanceHouse,
            s.settlementMode, s.gameId, s.gameStateHash, s.rngCommit
        ));
    }
}

/// EIP-712 domain shared by both settlement backends. Matches makeDomain() in
/// @gibs/msgboard-games: { name: 'MsgBoardGames', version: '1' }. Solady EIP712 (not OZ:
/// OZ 5.6's Strings->Bytes uses MCOPY, rejected by solc targeting shanghai for 943).
abstract contract SessionStateEIP712 is EIP712 {
    using SessionStateLib for SessionState;

    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("MsgBoardGames", "1");
    }

    /// Public so off-chain code can parity-test the EIP-712 digest. `memory` arg so Solidity
    /// callers holding a memory struct (fuzz tests, other contracts) can hash directly; the
    /// external ABI signature is unchanged (memory vs calldata is codegen-internal).
    function stateDigest(SessionState memory state) public view returns (bytes32) {
        return _hashTypedData(state.structHashMem());
    }
}
```

- [ ] **Step 2: Write `contracts/test/SessionStateHarness.sol`** (a concrete instance to deploy in the parity test)

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SessionStateEIP712} from "../games/SessionState.sol";

/// Minimal concrete SessionStateEIP712 so the TS↔Solidity digest parity test can deploy
/// something and call stateDigest(). Both real backends inherit the same base/domain, so
/// parity proven here holds for HouseBankroll/HouseChannel at their own addresses.
contract SessionStateHarness is SessionStateEIP712 {}
```

- [ ] **Step 3: Add Hardhat per-contract overrides.** In `packages/contracts/hardhat.config.ts`, find the block of `'contracts/zk/*.sol'` override entries (each `{ version: '0.8.25', settings: { viaIR: true, evmVersion: 'shanghai', optimizer: { enabled: true, runs: 1_000 } } }`). Add these four sibling entries right after the `contracts/zk/HiLoWarRules.sol` entry (all four bodies identical to the zk entries):

```ts
      'contracts/games/SessionState.sol': {
        version: '0.8.25',
        settings: { viaIR: true, evmVersion: 'shanghai', optimizer: { enabled: true, runs: 1_000 } },
      },
      'contracts/games/Chips.sol': {
        version: '0.8.25',
        settings: { viaIR: true, evmVersion: 'shanghai', optimizer: { enabled: true, runs: 1_000 } },
      },
      'contracts/games/HouseBankroll.sol': {
        version: '0.8.25',
        settings: { viaIR: true, evmVersion: 'shanghai', optimizer: { enabled: true, runs: 1_000 } },
      },
      'contracts/games/HouseChannel.sol': {
        version: '0.8.25',
        settings: { viaIR: true, evmVersion: 'shanghai', optimizer: { enabled: true, runs: 1_000 } },
      },
      'contracts/test/SessionStateHarness.sol': {
        version: '0.8.25',
        settings: { viaIR: true, evmVersion: 'shanghai', optimizer: { enabled: true, runs: 1_000 } },
      },
```

- [ ] **Step 4: Add the off-chain package as a Hardhat devDependency.** In `packages/contracts/package.json`, add to `devDependencies` (alphabetical, beside `@gibs/hilo-war`):

```json
    "@gibs/msgboard-games": "workspace:*",
    "@gibs/msgboard-settle": "workspace:*",
```

Then from the repo root: `cd ~/Documents/gibs-finance/random && pnpm install` (links the workspace packages; `@gibs/msgboard-settle` is created in Task 7 — the dep can be declared now and resolves once that package exists).

- [ ] **Step 5: Write the Foundry digest-stability test** `test/foundry/SessionStateDigest.t.sol`

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SessionState} from "../../contracts/games/SessionState.sol";
import {SessionStateHarness} from "../../contracts/test/SessionStateHarness.sol";

contract SessionStateDigestTest is Test {
    SessionStateHarness internal h;

    function setUp() public {
        h = new SessionStateHarness();
    }

    function _base() internal pure returns (SessionState memory s) {
        s.tableId = keccak256("table");
        s.nonce = 7;
        s.balancePlayer = 1500;
        s.balanceHouse = 500;
        s.settlementMode = 1;
        s.gameId = 2;
        s.gameStateHash = keccak256("gs");
        s.rngCommit = keccak256("commit");
    }

    function test_digestDeterministic() public view {
        assertEq(h.stateDigest(_base()), h.stateDigest(_base()));
    }

    function test_digestSensitiveToEveryField() public view {
        bytes32 d = h.stateDigest(_base());
        SessionState memory s = _base(); s.nonce = 8; assertTrue(h.stateDigest(s) != d);
        s = _base(); s.balancePlayer = 1499; assertTrue(h.stateDigest(s) != d);
        s = _base(); s.balanceHouse = 501; assertTrue(h.stateDigest(s) != d);
        s = _base(); s.settlementMode = 0; assertTrue(h.stateDigest(s) != d);
        s = _base(); s.gameId = 1; assertTrue(h.stateDigest(s) != d);
        s = _base(); s.gameStateHash = keccak256("gs2"); assertTrue(h.stateDigest(s) != d);
        s = _base(); s.rngCommit = keccak256("commit2"); assertTrue(h.stateDigest(s) != d);
    }
}
```

- [ ] **Step 6: Run the Foundry test** — `cd ~/Documents/gibs-finance/random/packages/contracts && forge test --match-contract SessionStateDigestTest -vv`
Expected: 2 passing.

- [ ] **Step 7: Write the TS↔Solidity parity test** `test/SessionStateSig.test.ts` (mirrors `ZkChannelSig.test.ts`)

```ts
import * as viem from 'viem'
import { expect } from 'chai'
import hre from 'hardhat'
import { makeDomain, hashSessionState, type SessionState } from '@gibs/msgboard-games'

describe('SessionStateSig', () => {
  it('TS hashSessionState matches the on-chain EIP-712 digest for a fully populated state', async () => {
    const harness = await hre.viem.deployContract('SessionStateHarness')
    const publicClient = await hre.viem.getPublicClient()
    const chainId = await publicClient.getChainId()
    const domain = makeDomain(chainId, harness.address)
    // nonzero in EVERY field so a single transposed/missing field breaks parity
    const state: SessionState = {
      tableId: viem.keccak256(viem.toHex('table-1')),
      nonce: 7n,
      balancePlayer: 1500n,
      balanceHouse: 500n,
      settlementMode: 1,
      gameId: 2,
      gameStateHash: viem.keccak256(viem.toHex('game-state')),
      rngCommit: viem.keccak256(viem.toHex('commit')),
    }
    const offChain = hashSessionState(domain, state)
    const onChain = await harness.read.stateDigest([state])
    expect(onChain).to.equal(offChain)
  })
})
```

- [ ] **Step 8: Run the parity test** — `cd ~/Documents/gibs-finance/random/packages/contracts && pnpm build && pnpm test --grep SessionStateSig`
Expected: 1 passing (`onChain === offChain`). (`pnpm build` = hardhat compile, which also produces the `artifacts/contracts/games/...` JSON later tasks import. If `makeDomain`/`hashSessionState` aren't exported, confirm Plan 1's `index.ts` re-exports `./sessionState` — it does.)

- [ ] **Step 9: Commit**

```bash
cd ~/Documents/gibs-finance/random
git add packages/contracts/contracts/games/SessionState.sol packages/contracts/contracts/test/SessionStateHarness.sol packages/contracts/hardhat.config.ts packages/contracts/package.json packages/contracts/test/foundry/SessionStateDigest.t.sol packages/contracts/test/SessionStateSig.test.ts pnpm-lock.yaml
git commit -m "feat(msgboard-games): on-chain SessionState EIP-712 lib + TS<->Solidity digest parity"
```

---

### Task 2: `Chips.sol` — mintable ERC20 unit of account

**Read first:** `packages/contracts/contracts/test/ERC20.sol` (the solady ERC20 subclass idiom — `name`/`symbol`/`mint`).

**Files:**
- Create: `packages/contracts/contracts/games/Chips.sol`
- Create: `packages/contracts/test/foundry/Chips.t.sol`

- [ ] **Step 1: Write `contracts/games/Chips.sol`**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ERC20} from "solady/src/tokens/ERC20.sol";
import {Ownable} from "solady/src/auth/Ownable.sol";

/// The mintable per-chain accounting unit (spec §6: chips are a mintable ERC20; the house can
/// mint to pay, so house solvency is never what picks the settlement mode). Owner = the house
/// deployer; only the owner mints. Plain ERC20 otherwise.
contract Chips is ERC20, Ownable {
    constructor() {
        _initializeOwner(msg.sender);
    }

    function name() public pure override returns (string memory) {
        return "MsgBoard Chips";
    }

    function symbol() public pure override returns (string memory) {
        return "CHIP";
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
```

- [ ] **Step 2: Write `test/foundry/Chips.t.sol`**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Chips} from "../../contracts/games/Chips.sol";

contract ChipsTest is Test {
    Chips internal chips;
    address internal owner = address(this);
    address internal alice = address(0xA11CE);

    function setUp() public {
        chips = new Chips();
    }

    function test_ownerMints() public {
        chips.mint(alice, 1_000);
        assertEq(chips.balanceOf(alice), 1_000);
        assertEq(chips.totalSupply(), 1_000);
    }

    function test_nonOwnerCannotMint() public {
        vm.prank(alice);
        vm.expectRevert(); // Solady Ownable: Unauthorized()
        chips.mint(alice, 1);
    }

    function test_transferMovesBalance() public {
        chips.mint(owner, 100);
        chips.transfer(alice, 40);
        assertEq(chips.balanceOf(alice), 40);
        assertEq(chips.balanceOf(owner), 60);
    }
}
```

- [ ] **Step 3: Run** — `cd ~/Documents/gibs-finance/random/packages/contracts && forge test --match-contract ChipsTest -vv`
Expected: 3 passing.

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/gibs-finance/random
git add packages/contracts/contracts/games/Chips.sol packages/contracts/test/foundry/Chips.t.sol
git commit -m "feat(msgboard-games): Chips mintable ERC20 unit of account"
```

---

### Task 3: `HouseBankroll.sol` — optimistic backend (§6.1)

The optimistic backend: a player deposits chips into a **shared** balance (keyed by their session signing key — see scoping decision 2); the house funds a `housePool`. A session is settled by submitting its **open** state (nonce 0, both-signed) and its **final** state (both-signed); the contract verifies all four signatures, checks zero-sum conservation against the open, enforces highest-nonce-wins per table, and moves only the **net delta** between the player's deposit and the pool. No per-table lock, no timer — the residual exposure is settlement *timing* and the house's willingness to honor (it can mint), never the player's principal, which is capped at their deposit (spec §6.1, §10).

**Files:**
- Create: `packages/contracts/contracts/games/HouseBankroll.sol`
- Create: `packages/contracts/test/foundry/HouseBankroll.t.sol`

- [ ] **Step 1: Write `contracts/games/HouseBankroll.sol`**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ECDSA} from "solady/src/utils/ECDSA.sol";
import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {Ownable} from "solady/src/auth/Ownable.sol";
import {SessionState, SessionStateLib, SessionStateEIP712} from "./SessionState.sol";

/// Optimistic settlement backend (spec §6.1). Players hold a shared deposit (keyed by their
/// session signing key — see plan scoping decision 2); the house funds a mintable-backed pool.
/// settle() pays only the net delta of a session, proven by the open + final co-signed states.
contract HouseBankroll is SessionStateEIP712, Ownable {
    using SafeTransferLib for address;
    using SessionStateLib for SessionState;

    error WrongTable();
    error BadMode();
    error BadGenesis();
    error StaleNonce();
    error ConservationViolated();
    error BadSig();
    error NotPlayer();
    error InsufficientPool();
    error InsufficientDeposit();

    address public immutable chips;
    address public houseKey;             // the house's session signing key
    uint256 public housePool;            // house-funded, mintable-backed
    mapping(address signer => uint256) public deposits;          // player deposit by session key
    mapping(bytes32 tableId => uint64) public settledNonce;      // highest-nonce-wins
    mapping(bytes32 tableId => uint256) public settledBalancePlayer; // last-settled player balance (incremental baseline)

    event Deposited(address indexed signer, uint256 amount);
    event Withdrawn(address indexed signer, uint256 amount);
    event HouseFunded(uint256 amount);
    event HouseWithdrawn(uint256 amount);
    event HouseKeySet(address indexed key);
    event Settled(bytes32 indexed tableId, address indexed player, uint64 nonce, int256 playerDelta);

    constructor(address chips_) {
        chips = chips_;
        _initializeOwner(msg.sender);
    }

    function setHouseKey(address key) external onlyOwner {
        houseKey = key;
        emit HouseKeySet(key);
    }

    // ── player + house funding ────────────────────────────────────────────────

    function deposit(uint256 amount) external {
        deposits[msg.sender] += amount;
        chips.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external {
        if (deposits[msg.sender] < amount) revert InsufficientDeposit();
        deposits[msg.sender] -= amount;
        chips.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function fundHouse(uint256 amount) external onlyOwner {
        housePool += amount;
        chips.safeTransferFrom(msg.sender, address(this), amount);
        emit HouseFunded(amount);
    }

    function withdrawHouse(uint256 amount) external onlyOwner {
        if (housePool < amount) revert InsufficientPool();
        housePool -= amount;
        chips.safeTransfer(msg.sender, amount);
        emit HouseWithdrawn(amount);
    }

    // ── settlement ────────────────────────────────────────────────────────────

    /// Settle a finished optimistic session. `openState` is the both-signed genesis (nonce 0)
    /// fixing the session's starting balances; `finalState` is the both-signed latest. The net
    /// player delta (finalState.balancePlayer - openState.balancePlayer) moves between the
    /// player's deposit and the house pool. Both states must be signed by the SAME player key
    /// (recovered) and the configured houseKey. Anyone may submit (permissionless settle, §7).
    function settle(
        SessionState calldata openState,
        SessionState calldata finalState,
        bytes calldata openSigPlayer,
        bytes calldata openSigHouse,
        bytes calldata finalSigPlayer,
        bytes calldata finalSigHouse
    ) external {
        bytes32 tableId = finalState.tableId;
        if (openState.tableId != tableId) revert WrongTable();
        if (openState.settlementMode != 0 || finalState.settlementMode != 0) revert BadMode();
        if (openState.gameId != finalState.gameId) revert BadMode();
        if (openState.nonce != 0) revert BadGenesis();
        if (finalState.nonce <= openState.nonce) revert StaleNonce();
        if (finalState.nonce <= settledNonce[tableId]) revert StaleNonce();
        // zero-sum within the session (the off-chain driver guarantees it; enforce on-chain)
        if (openState.balancePlayer + openState.balanceHouse
            != finalState.balancePlayer + finalState.balanceHouse) revert ConservationViolated();

        bytes32 openDigest = _hashTypedData(openState.structHash());
        bytes32 finalDigest = _hashTypedData(finalState.structHash());
        address player = ECDSA.recoverCalldata(openDigest, openSigPlayer);
        if (player == address(0) || player == houseKey) revert NotPlayer();
        if (ECDSA.recoverCalldata(finalDigest, finalSigPlayer) != player) revert BadSig();
        if (ECDSA.recoverCalldata(openDigest, openSigHouse) != houseKey) revert BadSig();
        if (ECDSA.recoverCalldata(finalDigest, finalSigHouse) != houseKey) revert BadSig();

        // Incremental baseline: the first settle of a session measures from the genesis open
        // balance; a later settle of the same continuing session measures from the LAST-settled
        // balance, so re-settling at a higher nonce moves only the incremental delta and never
        // re-applies the whole genesis->final delta (which would over-pay / over-debit — a real
        // double-settlement value-loss bug). prevNonce == 0 marks "never settled" (a final nonce
        // is always >= 1, so this is unambiguous).
        uint64 prevNonce = settledNonce[tableId];
        uint256 baseline = prevNonce == 0 ? openState.balancePlayer : settledBalancePlayer[tableId];
        settledNonce[tableId] = finalState.nonce;
        settledBalancePlayer[tableId] = finalState.balancePlayer;

        if (finalState.balancePlayer >= baseline) {
            uint256 win = finalState.balancePlayer - baseline;
            if (housePool < win) revert InsufficientPool();
            housePool -= win;
            deposits[player] += win;
            emit Settled(tableId, player, finalState.nonce, int256(win));
        } else {
            uint256 loss = baseline - finalState.balancePlayer;
            if (deposits[player] < loss) revert InsufficientDeposit();
            deposits[player] -= loss;
            housePool += loss;
            emit Settled(tableId, player, finalState.nonce, -int256(loss));
        }
    }
}
```

- [ ] **Step 2: Write the failing Foundry tests** `test/foundry/HouseBankroll.t.sol`

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Chips} from "../../contracts/games/Chips.sol";
import {HouseBankroll} from "../../contracts/games/HouseBankroll.sol";
import {SessionState} from "../../contracts/games/SessionState.sol";

contract HouseBankrollTest is Test {
    Chips internal chips;
    HouseBankroll internal bank;

    uint256 internal pkPlayer = 0xA11CE;
    uint256 internal pkHouse = 0xB0B;
    address internal player; // session key
    address internal house;  // house session key

    function setUp() public {
        chips = new Chips();
        bank = new HouseBankroll(address(chips));
        player = vm.addr(pkPlayer);
        house = vm.addr(pkHouse);
        bank.setHouseKey(house);

        // fund: player deposits 1000, house pool 1000
        chips.mint(player, 1_000);
        chips.mint(address(this), 1_000);
        vm.startPrank(player);
        chips.approve(address(bank), type(uint256).max);
        bank.deposit(1_000);
        vm.stopPrank();
        chips.approve(address(bank), type(uint256).max);
        bank.fundHouse(1_000);
    }

    function _state(uint64 nonce, uint256 bp, uint256 bh) internal pure returns (SessionState memory s) {
        s.tableId = keccak256("t1");
        s.nonce = nonce;
        s.balancePlayer = bp;
        s.balanceHouse = bh;
        s.settlementMode = 0;
        s.gameId = 1;
        s.gameStateHash = bytes32(0);
        s.rngCommit = keccak256("commit");
    }

    function _sign(uint256 pk, SessionState memory s) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(pk, bank.stateDigest(s));
        return abi.encodePacked(r, ss, v);
    }

    function test_settlePaysPlayerNetWin() public {
        SessionState memory o = _state(0, 200, 200);   // open: each committed 200
        SessionState memory f = _state(5, 260, 140);   // player +60
        bank.settle(o, f, _sign(pkPlayer, o), _sign(pkHouse, o), _sign(pkPlayer, f), _sign(pkHouse, f));
        assertEq(bank.deposits(player), 1_060);
        assertEq(bank.housePool(), 940);
        assertEq(bank.settledNonce(keccak256("t1")), 5);
    }

    function test_settleDebitsPlayerNetLoss() public {
        SessionState memory o = _state(0, 200, 200);
        SessionState memory f = _state(5, 150, 250);   // player -50
        bank.settle(o, f, _sign(pkPlayer, o), _sign(pkHouse, o), _sign(pkPlayer, f), _sign(pkHouse, f));
        assertEq(bank.deposits(player), 950);
        assertEq(bank.housePool(), 1_050);
    }

    function test_rejectsStaleNonce() public {
        SessionState memory o = _state(0, 200, 200);
        SessionState memory f = _state(5, 260, 140);
        bank.settle(o, f, _sign(pkPlayer, o), _sign(pkHouse, o), _sign(pkPlayer, f), _sign(pkHouse, f));
        SessionState memory f2 = _state(5, 100, 300); // same nonce, stale
        vm.expectRevert(HouseBankroll.StaleNonce.selector);
        bank.settle(o, f2, _sign(pkPlayer, o), _sign(pkHouse, o), _sign(pkPlayer, f2), _sign(pkHouse, f2));
    }

    function test_rejectsSingleSigned() public {
        SessionState memory o = _state(0, 200, 200);
        SessionState memory f = _state(5, 260, 140);
        bytes memory wrong = _sign(pkPlayer, f); // house slot signed by player
        vm.expectRevert(HouseBankroll.BadSig.selector);
        bank.settle(o, f, _sign(pkPlayer, o), _sign(pkHouse, o), _sign(pkPlayer, f), wrong);
    }

    function test_rejectsConservationViolation() public {
        SessionState memory o = _state(0, 200, 200);
        SessionState memory f = _state(5, 260, 200); // total 460 != 400
        vm.expectRevert(HouseBankroll.ConservationViolated.selector);
        bank.settle(o, f, _sign(pkPlayer, o), _sign(pkHouse, o), _sign(pkPlayer, f), _sign(pkHouse, f));
    }

    function test_rejectsNonGenesisOpen() public {
        SessionState memory o = _state(1, 200, 200); // nonce != 0
        SessionState memory f = _state(5, 260, 140);
        vm.expectRevert(HouseBankroll.BadGenesis.selector);
        bank.settle(o, f, _sign(pkPlayer, o), _sign(pkHouse, o), _sign(pkPlayer, f), _sign(pkHouse, f));
    }

    // Re-settling a continuing session at a higher nonce must move only the INCREMENTAL delta,
    // never re-apply the whole genesis->final delta (the double-settlement value-loss bug).
    function test_incrementalSettleNoDoublePay() public {
        SessionState memory o = _state(0, 200, 200);
        SessionState memory f5 = _state(5, 260, 140); // +60 from genesis
        bank.settle(o, f5, _sign(pkPlayer, o), _sign(pkHouse, o), _sign(pkPlayer, f5), _sign(pkHouse, f5));
        assertEq(bank.deposits(player), 1_060);
        assertEq(bank.housePool(), 940);
        SessionState memory f8 = _state(8, 300, 100); // 300 total => +40 more, +100 total
        bank.settle(o, f8, _sign(pkPlayer, o), _sign(pkHouse, o), _sign(pkPlayer, f8), _sign(pkHouse, f8));
        assertEq(bank.deposits(player), 1_100); // not 1_160 (which the genesis-baseline bug gave)
        assertEq(bank.housePool(), 900);
        assertEq(bank.settledNonce(keccak256("t1")), 8);
    }
}
```

- [ ] **Step 3: Run** — `cd ~/Documents/gibs-finance/random/packages/contracts && forge test --match-contract HouseBankrollTest -vv`
Expected: 7 passing.

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/gibs-finance/random
git add packages/contracts/contracts/games/HouseBankroll.sol packages/contracts/test/foundry/HouseBankroll.t.sol
git commit -m "feat(msgboard-games): HouseBankroll optimistic settlement backend"
```

---

### Task 4: `HouseChannel.sol` — escrowed backend, open + cooperative settle (§6.2)

**Read first:** `packages/contracts/contracts/zk/ZkTable.sol` — `create`/`join`/`settle`/`_checkCoSigned`/`_seatOf`/`_payout` are the patterns this mirrors (minus the deck/pot/rules machinery).

The escrowed backend locks per-table escrow: the house pre-funds a pool; the player calls `open()` escrowing their own chips and reserving the house's escrow from the pool, authorized by an off-chain house-signed `OpenTerms` (scoping decision 3). `settle()` pays the final both-signed state's balances from the locked escrow, exactly the `ZkTable` conservation + status-before-transfer rules.

**Files:**
- Create: `packages/contracts/contracts/games/HouseChannel.sol`
- Create: `packages/contracts/test/foundry/HouseChannel.t.sol`

- [ ] **Step 1: Write `contracts/games/HouseChannel.sol`** (open + settle; dispute fns added in Task 5)

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ECDSA} from "solady/src/utils/ECDSA.sol";
import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {Ownable} from "solady/src/auth/Ownable.sol";
import {SessionState, SessionStateLib, SessionStateEIP712} from "./SessionState.sol";

/// House-signed authorization for a single escrowed table open (spec §4.3 / §6.2). The player
/// presents this with the house's signature; the contract reserves escrowHouse from the pool.
struct OpenTerms {
    bytes32 tableId;
    address player;
    address playerKey;
    uint256 escrowPlayer;
    uint256 escrowHouse;
    uint8 gameId;
    bytes32 rngCommit;
    uint64 clockBlocks;
    uint64 expiry;
}

library OpenTermsLib {
    bytes32 internal constant TYPEHASH = keccak256(
        "OpenTerms(bytes32 tableId,address player,address playerKey,uint256 escrowPlayer,uint256 escrowHouse,uint8 gameId,bytes32 rngCommit,uint64 clockBlocks,uint64 expiry)"
    );

    function structHash(OpenTerms calldata t) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            TYPEHASH, t.tableId, t.player, t.playerKey, t.escrowPlayer, t.escrowHouse,
            t.gameId, t.rngCommit, t.clockBlocks, t.expiry
        ));
    }

    function structHashMem(OpenTerms memory t) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            TYPEHASH, t.tableId, t.player, t.playerKey, t.escrowPlayer, t.escrowHouse,
            t.gameId, t.rngCommit, t.clockBlocks, t.expiry
        ));
    }
}

/// Escrowed settlement backend (spec §6.2): per-table escrow, cooperative settle, chess-clock
/// dispute/forfeit. The ZkTable channel pattern minus deck/pot/rules. Chips (ERC20) escrow.
contract HouseChannel is SessionStateEIP712, Ownable {
    using SafeTransferLib for address;
    using SessionStateLib for SessionState;
    using OpenTermsLib for OpenTerms;

    error BadStatus();
    error BadClock();
    error Expired();
    error WrongTable();
    error BadMode();
    error BadSig();
    error NotPlayer();
    error ConservationViolated();
    error StaleNonce();
    error InsufficientPool();
    error ClockNotExpired();

    enum Status { None, Live, Disputed, Settled }

    struct Table {
        address player;       // wallet that opened + receives payout
        address playerKey;    // session signing key
        uint256 escrowPlayer;
        uint256 escrowHouse;  // reserved from housePool at open
        uint8 gameId;
        Status status;
        uint64 clockBlocks;
        uint64 checkpointNonce;
        bool hasCheckpoint;
        uint64 disputeDeadline;
        uint8 disputant;      // 1 player, 2 house
        SessionState disputeState;
    }

    uint64 public constant MIN_CLOCK_BLOCKS = 30;     // ~5 min at 10s blocks
    uint64 public constant MAX_CLOCK_BLOCKS = 60480;  // ~1 week

    address public immutable chips;
    address public houseKey;
    uint256 public housePool;
    mapping(bytes32 tableId => Table) public tables;

    event HouseFunded(uint256 amount);
    event HouseWithdrawn(uint256 amount);
    event HouseKeySet(address indexed key);
    event Opened(bytes32 indexed tableId, address indexed player, address playerKey, uint256 escrowPlayer, uint256 escrowHouse);
    event Settled(bytes32 indexed tableId, uint256 payoutPlayer, uint256 payoutHouse);
    event DisputeOpened(bytes32 indexed tableId, uint8 disputant, uint64 nonce, uint64 deadline);
    event DisputeAnsweredWithState(bytes32 indexed tableId, uint64 nonce);
    event DisputeForfeited(bytes32 indexed tableId, uint256 payoutPlayer, uint256 payoutHouse);

    constructor(address chips_) {
        chips = chips_;
        _initializeOwner(msg.sender);
    }

    function setHouseKey(address key) external onlyOwner {
        houseKey = key;
        emit HouseKeySet(key);
    }

    function fundHouse(uint256 amount) external onlyOwner {
        housePool += amount;
        chips.safeTransferFrom(msg.sender, address(this), amount);
        emit HouseFunded(amount);
    }

    function withdrawHouse(uint256 amount) external onlyOwner {
        if (housePool < amount) revert InsufficientPool();
        housePool -= amount;
        chips.safeTransfer(msg.sender, amount);
        emit HouseWithdrawn(amount);
    }

    /// Public for off-chain parity + house signing.
    function openTermsDigest(OpenTerms memory terms) public view returns (bytes32) {
        return _hashTypedData(terms.structHashMem());
    }

    /// Player opens an escrowed table: escrows their own chips, reserves the house's escrow from
    /// the pool, authorized by the house's signature over `terms`. One player tx, no house tx.
    function open(OpenTerms calldata terms, bytes calldata houseSig) external {
        if (terms.player != msg.sender) revert NotPlayer();
        if (block.timestamp > terms.expiry) revert Expired();
        if (terms.clockBlocks < MIN_CLOCK_BLOCKS || terms.clockBlocks > MAX_CLOCK_BLOCKS) revert BadClock();
        if (terms.playerKey == address(0) || terms.playerKey == houseKey) revert NotPlayer();
        Table storage t = tables[terms.tableId];
        if (t.status != Status.None) revert BadStatus();
        if (ECDSA.recoverCalldata(_hashTypedData(terms.structHash()), houseSig) != houseKey) revert BadSig();
        if (housePool < terms.escrowHouse) revert InsufficientPool();
        housePool -= terms.escrowHouse;

        t.player = msg.sender;
        t.playerKey = terms.playerKey;
        t.escrowPlayer = terms.escrowPlayer;
        t.escrowHouse = terms.escrowHouse;
        t.gameId = terms.gameId;
        t.clockBlocks = terms.clockBlocks;
        t.status = Status.Live;

        chips.safeTransferFrom(msg.sender, address(this), terms.escrowPlayer);
        emit Opened(terms.tableId, msg.sender, terms.playerKey, terms.escrowPlayer, terms.escrowHouse);
    }

    /// Cooperative settle: anyone submits the final both-signed state. Pays from locked escrow.
    function settle(SessionState calldata s, bytes calldata sigPlayer, bytes calldata sigHouse) external {
        Table storage t = tables[s.tableId];
        if (t.status != Status.Live) revert BadStatus();
        _checkCoSigned(t, s, sigPlayer, sigHouse);
        if (t.hasCheckpoint && s.nonce <= t.checkpointNonce) revert StaleNonce();
        _payout(t, s.tableId, s.balancePlayer, s.balanceHouse);
    }

    function _checkCoSigned(Table storage t, SessionState calldata s, bytes calldata sigPlayer, bytes calldata sigHouse) internal view {
        if (s.tableId == bytes32(0) || t.status == Status.None) revert WrongTable();
        if (s.settlementMode != 1) revert BadMode();
        if (s.balancePlayer + s.balanceHouse != t.escrowPlayer + t.escrowHouse) revert ConservationViolated();
        bytes32 digest = _hashTypedData(s.structHash());
        if (ECDSA.recoverCalldata(digest, sigPlayer) != t.playerKey) revert BadSig();
        if (ECDSA.recoverCalldata(digest, sigHouse) != houseKey) revert BadSig();
    }

    function _seatOf(Table storage t, address who) internal view returns (uint8) {
        if (who == t.player || who == t.playerKey) return 1;
        if (who == houseKey || who == owner()) return 2;
        revert NotPlayer();
    }

    function _payout(Table storage t, bytes32 tableId, uint256 toPlayer, uint256 toHouse) internal {
        t.status = Status.Settled;
        t.escrowPlayer = 0;
        t.escrowHouse = 0;
        emit Settled(tableId, toPlayer, toHouse);
        if (toPlayer > 0) chips.safeTransfer(t.player, toPlayer);
        housePool += toHouse; // house's share returns to the pool
    }
}
```

- [ ] **Step 2: Write the failing Foundry tests** `test/foundry/HouseChannel.t.sol` (open + settle here; dispute tests added in Task 5)

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Chips} from "../../contracts/games/Chips.sol";
import {HouseChannel, OpenTerms} from "../../contracts/games/HouseChannel.sol";
import {SessionState} from "../../contracts/games/SessionState.sol";

contract HouseChannelTest is Test {
    Chips internal chips;
    HouseChannel internal ch;

    uint256 internal pkPlayerKey = 0xA11CE;
    uint256 internal pkHouse = 0xB0B;
    // a deterministic non-key wallet address (distinct from playerKey/houseKey)
    address internal playerWallet = address(uint160(uint256(keccak256("player-wallet"))));
    address internal playerKey;
    address internal house;

    bytes32 internal constant TID = keccak256("ct1");
    uint64 internal constant CLOCK = 30;

    function setUp() public {
        chips = new Chips();
        ch = new HouseChannel(address(chips));
        playerKey = vm.addr(pkPlayerKey);
        house = vm.addr(pkHouse);
        ch.setHouseKey(house);

        chips.mint(playerWallet, 1_000);
        chips.mint(address(this), 10_000);
        chips.approve(address(ch), type(uint256).max);
        ch.fundHouse(10_000);
        vm.prank(playerWallet);
        chips.approve(address(ch), type(uint256).max);
    }

    function _terms() internal view returns (OpenTerms memory t) {
        t.tableId = TID;
        t.player = playerWallet;
        t.playerKey = playerKey;
        t.escrowPlayer = 200;
        t.escrowHouse = 200;
        t.gameId = 1;
        t.rngCommit = keccak256("commit");
        t.clockBlocks = CLOCK;
        t.expiry = uint64(block.timestamp + 1 hours);
    }

    function _signHouseTerms(OpenTerms memory t) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pkHouse, ch.openTermsDigest(t));
        return abi.encodePacked(r, s, v);
    }

    function _open() internal returns (OpenTerms memory t) {
        t = _terms();
        bytes memory sig = _signHouseTerms(t); // hoist: vm.prank only affects the NEXT call, and
        vm.prank(playerWallet);                // _signHouseTerms makes a view call to ch that would consume it
        ch.open(t, sig);
    }

    function _state(uint64 nonce, uint256 bp, uint256 bh) internal pure returns (SessionState memory s) {
        s.tableId = TID;
        s.nonce = nonce;
        s.balancePlayer = bp;
        s.balanceHouse = bh;
        s.settlementMode = 1;
        s.gameId = 1;
        s.gameStateHash = bytes32(0);
        s.rngCommit = keccak256("commit");
    }

    function _coSign(SessionState memory s) internal view returns (bytes memory sp, bytes memory sh) {
        bytes32 d = ch.stateDigest(s);
        (uint8 v1, bytes32 r1, bytes32 ss1) = vm.sign(pkPlayerKey, d);
        (uint8 v2, bytes32 r2, bytes32 ss2) = vm.sign(pkHouse, d);
        sp = abi.encodePacked(r1, ss1, v1);
        sh = abi.encodePacked(r2, ss2, v2);
    }

    function test_openEscrowsAndReserves() public {
        _open();
        assertEq(chips.balanceOf(address(ch)), 10_200); // pool 10k + player escrow 200
        assertEq(ch.housePool(), 9_800);                // 10k - reserved 200
        assertEq(chips.balanceOf(playerWallet), 800);
    }

    function test_settlePaysFromEscrow() public {
        _open();
        SessionState memory f = _state(5, 260, 140); // player won 60 within the 400 escrow
        (bytes memory sp, bytes memory sh) = _coSign(f);
        ch.settle(f, sp, sh);
        assertEq(chips.balanceOf(playerWallet), 800 + 260);
        assertEq(ch.housePool(), 9_800 + 140);
    }

    function test_settleRejectsConservation() public {
        _open();
        SessionState memory f = _state(5, 260, 200); // 460 != 400
        (bytes memory sp, bytes memory sh) = _coSign(f);
        vm.expectRevert(HouseChannel.ConservationViolated.selector);
        ch.settle(f, sp, sh);
    }

    function test_openRejectsBadHouseSig() public {
        OpenTerms memory t = _terms();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pkPlayerKey, ch.openTermsDigest(t)); // wrong signer
        vm.prank(playerWallet);
        vm.expectRevert(HouseChannel.BadSig.selector);
        ch.open(t, abi.encodePacked(r, s, v));
    }

    function test_doubleSettleRejected() public {
        _open();
        SessionState memory f = _state(5, 260, 140);
        (bytes memory sp, bytes memory sh) = _coSign(f);
        ch.settle(f, sp, sh);
        vm.expectRevert(HouseChannel.BadStatus.selector); // table now Settled
        ch.settle(f, sp, sh);
    }
}
```

- [ ] **Step 3: Run** — `cd ~/Documents/gibs-finance/random/packages/contracts && forge test --match-contract HouseChannelTest -vv`
Expected: 5 passing.

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/gibs-finance/random
git add packages/contracts/contracts/games/HouseChannel.sol packages/contracts/test/foundry/HouseChannel.t.sol
git commit -m "feat(msgboard-games): HouseChannel escrowed backend — open + cooperative settle"
```

---

### Task 5: `HouseChannel` dispute machine — chess-clock forfeit (§6.2)

A counterparty that stops co-signing is handled by the `ZkTable` chess-clock pattern, minus the move/share machinery: a party posts its latest both-signed state (`dispute`), starting a clock; the counterparty can override with a strictly-newer both-signed state (`respondWithState`, which settles it immediately); if the clock expires unanswered, the posted state's balances are paid (`resolveTimeout`). Conservation is guaranteed at `dispute` time by `_checkCoSigned`, so any resolution consumes exactly the escrow.

**Files:**
- Modify: `packages/contracts/contracts/games/HouseChannel.sol` (add three functions before the closing brace)
- Modify: `packages/contracts/test/foundry/HouseChannel.t.sol` (add dispute tests)

- [ ] **Step 1: Add the dispute functions** to `HouseChannel.sol`, immediately after `settle(...)`:

```solidity
    /// Post your latest both-signed state and start the chess clock. Because Plan-1 open()
    /// co-signs state 0, a party always holds at least one both-signed state (nonce 0 refunds
    /// the opening escrows), so no separate pre-state disputeSetup is needed.
    function dispute(SessionState calldata s, bytes calldata sigPlayer, bytes calldata sigHouse) external {
        Table storage t = tables[s.tableId];
        if (t.status != Status.Live) revert BadStatus();
        uint8 seat = _seatOf(t, msg.sender);
        _checkCoSigned(t, s, sigPlayer, sigHouse);
        if (t.hasCheckpoint && s.nonce < t.checkpointNonce) revert StaleNonce();
        t.status = Status.Disputed;
        t.disputant = seat;
        t.disputeState = s;
        t.checkpointNonce = s.nonce;
        t.hasCheckpoint = true;
        t.disputeDeadline = uint64(block.number) + t.clockBlocks;
        emit DisputeOpened(s.tableId, seat, s.nonce, t.disputeDeadline);
    }

    /// Override a dispute with a strictly-newer both-signed state — which IS the true latest, so
    /// it settles immediately (single-draw games have no further play to resume).
    function respondWithState(SessionState calldata s, bytes calldata sigPlayer, bytes calldata sigHouse) external {
        Table storage t = tables[s.tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        _checkCoSigned(t, s, sigPlayer, sigHouse);
        if (s.nonce <= t.disputeState.nonce) revert StaleNonce();
        emit DisputeAnsweredWithState(s.tableId, s.nonce);
        _payout(t, s.tableId, s.balancePlayer, s.balanceHouse);
    }

    /// Clock expired unanswered: the disputer's posted state stands; pay its balances.
    function resolveTimeout(bytes32 tableId) external {
        Table storage t = tables[tableId];
        if (t.status != Status.Disputed) revert BadStatus();
        if (uint64(block.number) <= t.disputeDeadline) revert ClockNotExpired();
        emit DisputeForfeited(tableId, t.disputeState.balancePlayer, t.disputeState.balanceHouse);
        _payout(t, tableId, t.disputeState.balancePlayer, t.disputeState.balanceHouse);
    }
```

- [ ] **Step 2: Add dispute tests** to `HouseChannelTest` (append these methods before the closing brace):

```solidity
    function test_disputeTimeoutPaysPostedState() public {
        _open();
        SessionState memory s = _state(3, 240, 160);
        (bytes memory sp, bytes memory sh) = _coSign(s);
        vm.prank(playerWallet);
        ch.dispute(s, sp, sh);
        vm.roll(block.number + CLOCK + 1);
        ch.resolveTimeout(TID);
        assertEq(chips.balanceOf(playerWallet), 800 + 240);
        assertEq(ch.housePool(), 9_800 + 160);
    }

    function test_resolveTimeoutBeforeClockReverts() public {
        _open();
        SessionState memory s = _state(3, 240, 160);
        (bytes memory sp, bytes memory sh) = _coSign(s);
        vm.prank(playerWallet);
        ch.dispute(s, sp, sh);
        vm.expectRevert(HouseChannel.ClockNotExpired.selector);
        ch.resolveTimeout(TID);
    }

    function test_respondWithNewerStateOverrides() public {
        _open();
        SessionState memory stale = _state(3, 300, 100); // player-favorable, posted by player
        (bytes memory sp1, bytes memory sh1) = _coSign(stale);
        vm.prank(playerWallet);
        ch.dispute(stale, sp1, sh1);
        // house overrides with a strictly-newer co-signed state
        SessionState memory newer = _state(7, 150, 250);
        (bytes memory sp2, bytes memory sh2) = _coSign(newer);
        ch.respondWithState(newer, sp2, sh2);
        assertEq(chips.balanceOf(playerWallet), 800 + 150);
        assertEq(ch.housePool(), 9_800 + 250);
    }

    function test_respondWithOlderStateReverts() public {
        _open();
        SessionState memory s = _state(7, 150, 250);
        (bytes memory sp1, bytes memory sh1) = _coSign(s);
        vm.prank(playerWallet);
        ch.dispute(s, sp1, sh1);
        SessionState memory older = _state(3, 300, 100);
        (bytes memory sp2, bytes memory sh2) = _coSign(older);
        vm.expectRevert(HouseChannel.StaleNonce.selector);
        ch.respondWithState(older, sp2, sh2);
    }
```

- [ ] **Step 3: Run** — `cd ~/Documents/gibs-finance/random/packages/contracts && forge test --match-contract HouseChannelTest -vv`
Expected: 9 passing (5 from Task 4 + 4 dispute).

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/gibs-finance/random
git add packages/contracts/contracts/games/HouseChannel.sol packages/contracts/test/foundry/HouseChannel.t.sol
git commit -m "feat(msgboard-games): HouseChannel dispute machine (chess-clock forfeit)"
```

---

### Task 6: Ignition deploy module

**Read first:** `packages/contracts/ignition/modules/ZkCards.ts` (the module shape).

**Files:**
- Create: `packages/contracts/ignition/modules/MsgBoardGames.ts`

- [ ] **Step 1: Write `ignition/modules/MsgBoardGames.ts`**

```ts
import { buildModule } from "@nomicfoundation/hardhat-ignition/modules"

// Deploys the MsgBoard-games settlement family: the Chips ERC20 unit of account, the optimistic
// HouseBankroll, and the escrowed HouseChannel (both bound to Chips). houseKey + pool funding are
// post-deploy operator steps (setHouseKey / fundHouse), not constructor args.
const MsgBoardGamesModule = buildModule("MsgBoardGamesModule", (m) => {
  const chips = m.contract("Chips", [])
  const bankroll = m.contract("HouseBankroll", [chips])
  const channel = m.contract("HouseChannel", [chips])
  return { chips, bankroll, channel }
})

export default MsgBoardGamesModule
```

- [ ] **Step 2: Verify it compiles + dry-runs.** Run: `cd ~/Documents/gibs-finance/random/packages/contracts && pnpm build && npx hardhat ignition deploy ignition/modules/MsgBoardGames.ts --network hardhat`
Expected: hardhat compile succeeds and Ignition reports the three contracts deployed on the in-process network (no revert). (If Ignition prompts about an ephemeral network, that is fine for a dry run.)

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/gibs-finance/random
git add packages/contracts/ignition/modules/MsgBoardGames.ts
git commit -m "feat(msgboard-games): Ignition deploy module (Chips + HouseBankroll + HouseChannel)"
```

---

### Task 7: Scaffold `@gibs/msgboard-settle` + `Settlement` interface + transcript replay

**Read first:** `examples/games/msgboard-games/src/session.ts` (`verifyFinishedSession` — the replay logic to parallel) and `examples/games/msgboard-games/package.json` / `tsconfig.json` (the package shape to copy).

**Files:**
- Create: `examples/games/msgboard-settle/package.json`
- Create: `examples/games/msgboard-settle/tsconfig.json`
- Create: `examples/games/msgboard-settle/src/index.ts`
- Create: `examples/games/msgboard-settle/src/settlement.ts`
- Create: `examples/games/msgboard-settle/src/replay.ts`
- Create: `examples/games/msgboard-settle/test/replay.test.ts`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "@gibs/msgboard-settle",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@gibs/msgboard-games": "workspace:*",
    "@gibs/random": "workspace:*",
    "viem": "^2.25.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "~5.8.3",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`** (identical to `examples/games/msgboard-games/tsconfig.json`)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Write `src/settlement.ts`** — the seam (spec §6) + shared types

```ts
import { type Hex } from 'viem'
import { type SessionState } from '@gibs/msgboard-games'

/** A both-signed state pulled from a retained transcript. */
export interface CoSignedState {
  state: SessionState
  sigPlayer: Hex
  sigHouse: Hex
}

/** A viem-ready contract call: address + abi + functionName + args. The caller simulates then
 *  writes (the @gibs/games-core operator.ts pattern); we only build the request shape. */
export interface TxRequest {
  address: Hex
  abi: unknown
  functionName: string
  args: readonly unknown[]
}

/** The settlement seam (spec §6): three interchangeable backends behind one interface. Plan 2
 *  ships optimistic + escrowed; open() is a no-op for optimistic (no per-table lock). */
export interface Settlement {
  /** Build the on-chain call that settles a finished session from its retained transcript JSON. */
  buildSettle(transcriptJson: string): Promise<TxRequest>
}
```

- [ ] **Step 4: Write `src/replay.ts`** — reconstruct the open + final co-signed states from a retained transcript (parallels `verifyFinishedSession`, but returns the states + embedded sigs)

```ts
import { keccak256, type Hex } from 'viem'
import {
  type SessionState, type GameDomain, type Game,
  roundRandom, verifyReveal, verifySessionStateSig,
  Transcript,
} from '@gibs/msgboard-games'
import { type CoSignedState } from './settlement'

const ZERO32 = `0x${'00'.repeat(32)}` as Hex

export interface ReplayContext<TParams> {
  parties: { player: Hex; house: Hex }
  commit: Hex
  game: Game<TParams>
  domain: GameDomain
  settlementMode: number
}

export interface ReplayResult {
  open: CoSignedState
  final: CoSignedState
  rounds: number
}

interface SigPair { player: Hex; house: Hex }
interface OpenBody { rngCommit?: Hex; settlementMode?: number; gameId?: number; balances?: { player?: string; house?: string }; sigs?: SigPair }
interface RoundBody { round: number; stake: string; clientSeed: Hex; serverSeed: Hex; params: Record<string, string>; outcome: { win: boolean; playerDelta: string; multiplierX100: string }; sigs?: SigPair }

function deserializeParams<TParams>(raw: Record<string, string>): TParams {
  const out: Record<string, bigint> = {}
  for (const [k, v] of Object.entries(raw)) out[k] = BigInt(v)
  return out as unknown as TParams
}

/** Re-derive the open (nonce 0) and final co-signed SessionStates from the retained transcript,
 *  recomputing every round from (serverSeed, clientSeed, nonce) and verifying both EIP-712
 *  co-signatures at every step (spec §2 — the retained transcript alone proves the result).
 *  Throws on any mismatch so settlement never builds calldata from a tampered transcript. */
export async function replaySession<TParams>(transcriptJson: string, ctx: ReplayContext<TParams>): Promise<ReplayResult> {
  const t = Transcript.fromJSON(transcriptJson)
  if (!(await t.verify(ctx.parties))) throw new Error('replay: transcript chain/sig verify failed')

  const openEnv = t.entries.find((e) => e.kind === 'OPEN')
  if (!openEnv) throw new Error('replay: no OPEN entry')
  const ob = openEnv.body as OpenBody
  if (ob.rngCommit !== ctx.commit) throw new Error('replay: open rngCommit mismatch')
  if (!ob.balances || ob.balances.player === undefined || ob.balances.house === undefined) throw new Error('replay: open balances missing')
  if (!ob.sigs) throw new Error('replay: open sigs missing')
  if (Number(ob.settlementMode ?? 0) !== ctx.settlementMode) throw new Error('replay: settlementMode mismatch')

  let state: SessionState = {
    tableId: t.tableId,
    nonce: 0n,
    balancePlayer: BigInt(ob.balances.player),
    balanceHouse: BigInt(ob.balances.house),
    settlementMode: ctx.settlementMode,
    gameId: ctx.game.gameId,
    gameStateHash: ZERO32,
    rngCommit: ctx.commit,
  }
  await assertPair(state, ob.sigs, ctx)
  const open: CoSignedState = { state, sigPlayer: ob.sigs.player, sigHouse: ob.sigs.house }

  let final: CoSignedState = open
  let priorLink: Hex = ctx.commit
  let rounds = 0
  for (const e of t.entries) {
    if (e.kind !== 'ROUND') continue
    const b = e.body as RoundBody
    if (!b.sigs) throw new Error('replay: round sigs missing')
    if (!verifyReveal(priorLink, b.serverSeed)) throw new Error('replay: bad seed reveal')
    priorLink = b.serverSeed
    const raw = roundRandom(b.serverSeed, b.clientSeed, BigInt(b.round))
    const params = deserializeParams<TParams>(b.params)
    const outcome = ctx.game.settleRound(BigInt(b.stake), params, raw)
    if (
      outcome.win !== b.outcome.win ||
      outcome.playerDelta.toString() !== b.outcome.playerDelta ||
      outcome.multiplierX100.toString() !== b.outcome.multiplierX100
    ) throw new Error('replay: recomputed outcome mismatch')
    state = {
      ...state,
      nonce: BigInt(b.round),
      balancePlayer: state.balancePlayer + outcome.playerDelta,
      balanceHouse: state.balanceHouse - outcome.playerDelta,
      gameStateHash: keccak256(ctx.game.encodeRound(BigInt(b.stake), params, raw)),
    }
    if (state.balancePlayer < 0n || state.balanceHouse < 0n) throw new Error('replay: balance underflow')
    await assertPair(state, b.sigs, ctx)
    final = { state, sigPlayer: b.sigs.player, sigHouse: b.sigs.house }
    rounds++
  }
  if (rounds === 0) throw new Error('replay: no ROUND entries to settle')
  return { open, final, rounds }
}

async function assertPair<TParams>(state: SessionState, sigs: SigPair, ctx: ReplayContext<TParams>): Promise<void> {
  if (!(await verifySessionStateSig(ctx.parties.player, ctx.domain, state, sigs.player))) throw new Error(`replay: bad player sig at nonce ${state.nonce}`)
  if (!(await verifySessionStateSig(ctx.parties.house, ctx.domain, state, sigs.house))) throw new Error(`replay: bad house sig at nonce ${state.nonce}`)
}
```

- [ ] **Step 5: Write `src/index.ts`**

```ts
export const PACKAGE = '@gibs/msgboard-settle'
export * from './settlement'
export * from './replay'
```

- [ ] **Step 6: Write the failing test** `test/replay.test.ts` (drive a real Plan-1 session, then replay its transcript)

```ts
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { HouseSession, dice, makeDomain } from '@gibs/msgboard-games'
import { replaySession } from '../src/replay'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const tableId = `0x${'ab'.repeat(32)}` as Hex
const tip = `0x${'77'.repeat(32)}` as Hex
const domain = makeDomain(31337, '0x00000000000000000000000000000000000a3eb1')

async function play(mode: number) {
  const s = new HouseSession({
    domain, tableId, game: dice, player, house, seedTip: tip, chainLength: 8,
    openBalances: { player: 1000n, house: 1000n }, settlementMode: mode,
  })
  await s.open()
  for (let i = 0; i < 4; i++) {
    await s.playRound({ stake: 100n, params: { targetX100: 5000n }, clientSeed: `0x${'33'.repeat(32)}` })
  }
  return s
}

describe('replaySession', () => {
  it('reconstructs the open + final co-signed states from a retained transcript', async () => {
    const s = await play(0)
    const r = await replaySession(s.transcript.toJSON(), {
      parties: { player: player.address, house: house.address },
      commit: s.chain.commit, game: dice, domain, settlementMode: 0,
    })
    expect(r.open.state.nonce).toBe(0n)
    expect(r.open.state.balancePlayer).toBe(1000n)
    expect(r.final.state.nonce).toBe(4n)
    expect(r.final.state.balancePlayer).toBe(s.state.balancePlayer)
    expect(r.final.state.balanceHouse).toBe(s.state.balanceHouse)
    expect(r.rounds).toBe(4)
  })

  it('rejects a tampered transcript', async () => {
    const s = await play(0)
    const obj = JSON.parse(s.transcript.toJSON())
    const round = obj.entries.find((e: any) => e.kind === 'ROUND')
    round.body.outcome.playerDelta = '999999'
    await expect(replaySession(JSON.stringify(obj), {
      parties: { player: player.address, house: house.address },
      commit: s.chain.commit, game: dice, domain, settlementMode: 0,
    })).rejects.toThrow()
  })

  it('rejects a ctx that disagrees with the signed states (wrong settlementMode / commit)', async () => {
    const s = await play(0)
    const parties = { player: player.address, house: house.address }
    await expect(replaySession(s.transcript.toJSON(), {
      parties, commit: s.chain.commit, game: dice, domain, settlementMode: 1, // states signed with mode 0
    })).rejects.toThrow()
    await expect(replaySession(s.transcript.toJSON(), {
      parties, commit: `0x${'99'.repeat(32)}` as Hex, game: dice, domain, settlementMode: 0,
    })).rejects.toThrow()
  })
})
```

- [ ] **Step 7: Install + run** — `cd ~/Documents/gibs-finance/random && pnpm install && cd examples/games/msgboard-settle && pnpm test && pnpm typecheck`
Expected: 2 tests pass; typecheck clean. (The `@gibs/random` dep resolves even though we don't import its artifacts yet.)

- [ ] **Step 8: Commit**

```bash
cd ~/Documents/gibs-finance/random
git add examples/games/msgboard-settle pnpm-lock.yaml
git commit -m "feat(msgboard-settle): scaffold package + Settlement seam + transcript replay"
```

---

### Task 8: `OptimisticSettlement` + `EscrowedSettlement` + `signOpenTerms`

Build the viem calldata for each backend from a replayed transcript, and the off-chain `OpenTerms` signing helper the player presents at escrowed open.

**Files:**
- Create: `examples/games/msgboard-settle/src/openTerms.ts`
- Create: `examples/games/msgboard-settle/src/optimistic.ts`
- Create: `examples/games/msgboard-settle/src/escrowed.ts`
- Modify: `examples/games/msgboard-settle/src/index.ts`
- Create: `examples/games/msgboard-settle/test/openTerms.test.ts`
- Create: `examples/games/msgboard-settle/test/optimistic.test.ts`
- Create: `examples/games/msgboard-settle/test/escrowed.test.ts`

- [ ] **Step 1: Write `src/openTerms.ts`** — OpenTerms EIP-712 types mirroring the Solidity `OpenTermsLib.TYPEHASH`, plus a signer and a domain helper

```ts
import { recoverTypedDataAddress, type Hex } from 'viem'
import { makeDomain, type GameDomain, type StateSigner } from '@gibs/msgboard-games'

/** Mirrors HouseChannel.sol OpenTermsLib TYPEHASH field order exactly. */
export interface OpenTerms {
  tableId: Hex
  player: Hex
  playerKey: Hex
  escrowPlayer: bigint
  escrowHouse: bigint
  gameId: number
  rngCommit: Hex
  clockBlocks: bigint
  expiry: bigint
}

export const OPEN_TERMS_TYPES = {
  OpenTerms: [
    { name: 'tableId', type: 'bytes32' },
    { name: 'player', type: 'address' },
    { name: 'playerKey', type: 'address' },
    { name: 'escrowPlayer', type: 'uint256' },
    { name: 'escrowHouse', type: 'uint256' },
    { name: 'gameId', type: 'uint8' },
    { name: 'rngCommit', type: 'bytes32' },
    { name: 'clockBlocks', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const

/** The EIP-712 domain for the settlement contracts (same name/version as SessionState).
 *  `verifyingContract` is the HouseBankroll or HouseChannel address. */
export function makeSettleDomain(chainId: number, verifyingContract: Hex): GameDomain {
  return makeDomain(chainId, verifyingContract)
}

/** House signs OpenTerms with its session key; the player presents this sig to HouseChannel.open. */
export async function signOpenTerms(signer: StateSigner, domain: GameDomain, terms: OpenTerms): Promise<Hex> {
  return signer.signTypedData({ domain, types: OPEN_TERMS_TYPES, primaryType: 'OpenTerms', message: terms })
}

export async function verifyOpenTermsSig(expected: Hex, domain: GameDomain, terms: OpenTerms, sig: Hex): Promise<boolean> {
  try {
    const rec = await recoverTypedDataAddress({ domain, types: OPEN_TERMS_TYPES, primaryType: 'OpenTerms', message: terms as any, signature: sig })
    return rec.toLowerCase() === expected.toLowerCase()
  } catch { return false }
}
```

- [ ] **Step 2: Write `src/optimistic.ts`**

```ts
import { type Hex } from 'viem'
import HouseBankrollArtifact from '@gibs/random/artifacts/contracts/games/HouseBankroll.sol/HouseBankroll.json'
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
```

- [ ] **Step 3: Write `src/escrowed.ts`**

```ts
import { type Hex } from 'viem'
import HouseChannelArtifact from '@gibs/random/artifacts/contracts/games/HouseChannel.sol/HouseChannel.json'
import { type Settlement, type TxRequest } from './settlement'
import { replaySession, type ReplayContext } from './replay'
import { type OpenTerms } from './openTerms'

export const houseChannelAbi = HouseChannelArtifact.abi

export interface EscrowedConfig<TParams> extends ReplayContext<TParams> {
  channel: Hex // HouseChannel address (== domain.verifyingContract)
}

/** Escrowed backend (spec §6.2): open() locks escrow (house-signed OpenTerms), settle() / dispute()
 *  use the final both-signed state. settlementMode is fixed to 1. */
export class EscrowedSettlement<TParams> implements Settlement {
  constructor(private cfg: EscrowedConfig<TParams>) {
    if (cfg.settlementMode !== 1) throw new Error('escrowed: settlementMode must be 1')
  }

  /** Build the player's HouseChannel.open call from house-signed terms. */
  buildOpen(terms: OpenTerms, houseSig: Hex): TxRequest {
    return { address: this.cfg.channel, abi: houseChannelAbi, functionName: 'open', args: [terms, houseSig] }
  }

  async buildSettle(transcriptJson: string): Promise<TxRequest> {
    const { final } = await replaySession(transcriptJson, this.cfg)
    return { address: this.cfg.channel, abi: houseChannelAbi, functionName: 'settle', args: [final.state, final.sigPlayer, final.sigHouse] }
  }

  /** Build a dispute() call posting the latest both-signed state. */
  async buildDispute(transcriptJson: string): Promise<TxRequest> {
    const { final } = await replaySession(transcriptJson, this.cfg)
    return { address: this.cfg.channel, abi: houseChannelAbi, functionName: 'dispute', args: [final.state, final.sigPlayer, final.sigHouse] }
  }
}
```

- [ ] **Step 4: Update `src/index.ts`**

```ts
export const PACKAGE = '@gibs/msgboard-settle'
export * from './settlement'
export * from './replay'
export * from './openTerms'
export * from './optimistic'
export * from './escrowed'
```

- [ ] **Step 5: Write `test/openTerms.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { makeSettleDomain, signOpenTerms, verifyOpenTermsSig, type OpenTerms } from '../src/openTerms'

const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const channel = '0x00000000000000000000000000000000000c4a11' as Hex

const terms: OpenTerms = {
  tableId: `0x${'ab'.repeat(32)}`,
  player: player.address,
  playerKey: player.address,
  escrowPlayer: 200n,
  escrowHouse: 200n,
  gameId: 1,
  rngCommit: `0x${'cd'.repeat(32)}`,
  clockBlocks: 30n,
  expiry: 9_999_999_999n,
}

describe('OpenTerms signing', () => {
  it('round-trips a house signature and rejects the wrong signer', async () => {
    const domain = makeSettleDomain(31337, channel)
    const sig = await signOpenTerms(house, domain, terms)
    expect(await verifyOpenTermsSig(house.address, domain, terms, sig)).toBe(true)
    expect(await verifyOpenTermsSig(player.address, domain, terms, sig)).toBe(false)
  })
})
```

- [ ] **Step 6: Write `test/optimistic.test.ts`** (asserts the built calldata's states/sigs verify off-chain — proves correctness without a chain)

```ts
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { HouseSession, dice, makeDomain, verifySessionStateSig } from '@gibs/msgboard-games'
import { OptimisticSettlement } from '../src/optimistic'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const bankroll = '0x00000000000000000000000000000000000ba111' as Hex
const tableId = `0x${'ab'.repeat(32)}` as Hex
const domain = makeDomain(31337, bankroll)

describe('OptimisticSettlement', () => {
  it('builds a settle call whose open/final states + sigs verify off-chain', async () => {
    const s = new HouseSession({
      domain, tableId, game: dice, player, house, seedTip: `0x${'77'.repeat(32)}` as Hex, chainLength: 8,
      openBalances: { player: 1000n, house: 1000n }, settlementMode: 0,
    })
    await s.open()
    for (let i = 0; i < 4; i++) await s.playRound({ stake: 100n, params: { targetX100: 5000n }, clientSeed: `0x${'33'.repeat(32)}` })

    const opt = new OptimisticSettlement({
      parties: { player: player.address, house: house.address }, commit: s.chain.commit,
      game: dice, domain, settlementMode: 0, bankroll,
    })
    const tx = await opt.buildSettle(s.transcript.toJSON())
    expect(tx.address).toBe(bankroll)
    expect(tx.functionName).toBe('settle')
    const [openState, finalState, openSigP, openSigH, finalSigP, finalSigH] = tx.args as any[]
    expect(openState.nonce).toBe(0n)
    expect(finalState.nonce).toBe(4n)
    expect(await verifySessionStateSig(player.address, domain, openState, openSigP)).toBe(true)
    expect(await verifySessionStateSig(house.address, domain, openState, openSigH)).toBe(true)
    expect(await verifySessionStateSig(player.address, domain, finalState, finalSigP)).toBe(true)
    expect(await verifySessionStateSig(house.address, domain, finalState, finalSigH)).toBe(true)
  })
})
```

- [ ] **Step 7: Write `test/escrowed.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { type Hex } from 'viem'
import { HouseSession, limbo, makeDomain, verifySessionStateSig } from '@gibs/msgboard-games'
import { EscrowedSettlement } from '../src/escrowed'

const player = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const house = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const channel = '0x00000000000000000000000000000000000c4a11' as Hex
const tableId = `0x${'ab'.repeat(32)}` as Hex
const domain = makeDomain(31337, channel)

describe('EscrowedSettlement', () => {
  it('builds a settle call whose final state + sigs verify off-chain', async () => {
    const s = new HouseSession({
      domain, tableId, game: limbo, player, house, seedTip: `0x${'77'.repeat(32)}` as Hex, chainLength: 8,
      openBalances: { player: 1000n, house: 1000n }, settlementMode: 1,
    })
    await s.open()
    for (let i = 0; i < 3; i++) await s.playRound({ stake: 10n, params: { targetX100: 200n }, clientSeed: `0x${'44'.repeat(32)}` })

    const esc = new EscrowedSettlement({
      parties: { player: player.address, house: house.address }, commit: s.chain.commit,
      game: limbo, domain, settlementMode: 1, channel,
    })
    const tx = await esc.buildSettle(s.transcript.toJSON())
    expect(tx.functionName).toBe('settle')
    const [finalState, sigP, sigH] = tx.args as any[]
    expect(finalState.nonce).toBe(3n)
    expect(await verifySessionStateSig(player.address, domain, finalState, sigP)).toBe(true)
    expect(await verifySessionStateSig(house.address, domain, finalState, sigH)).toBe(true)
  })
})
```

- [ ] **Step 8: Build artifacts + run** — `cd ~/Documents/gibs-finance/random/packages/contracts && pnpm build && cd ../../examples/games/msgboard-settle && pnpm test && pnpm typecheck`
Expected: all tests pass; typecheck clean. (`pnpm build` must run first so `@gibs/random/artifacts/contracts/games/*.json` exist for the ABI imports.)

- [ ] **Step 9: Commit**

```bash
cd ~/Documents/gibs-finance/random
git add examples/games/msgboard-settle
git commit -m "feat(msgboard-settle): Optimistic + Escrowed settlement builders + OpenTerms signing"
```

---

### Task 9: End-to-end on a local chain — play off-chain, settle under both backends + dispute + ephemerality

The capstone (spec §12 "End-to-end on a local chain" + "Ephemerality"): deploy Chips + both backends via `hre.viem`, run a **real** Plan-1 `HouseSession` off-chain for several rounds, then settle under each backend from the retained transcript JSON alone, plus a dispute→timeout recovery. This is a Hardhat/Mocha test (it has `hre.viem` + an in-process node).

**Files:**
- Create: `packages/contracts/test/MsgBoardSettleE2E.test.ts`

- [ ] **Step 1: Write the test** `test/MsgBoardSettleE2E.test.ts`

```ts
import * as viem from 'viem'
import { expect } from 'chai'
import hre from 'hardhat'
import { privateKeyToAccount } from 'viem/accounts'
import { HouseSession, dice, makeDomain } from '@gibs/msgboard-games'
import { OptimisticSettlement, EscrowedSettlement, signOpenTerms, type OpenTerms } from '@gibs/msgboard-settle'

const playerKey = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const houseKey = privateKeyToAccount(`0x${'22'.repeat(32)}`)
const tip = `0x${'77'.repeat(32)}` as viem.Hex

async function playSession(domain: any, tableId: viem.Hex, mode: number, rounds = 5) {
  const s = new HouseSession({
    domain, tableId, game: dice, player: playerKey, house: houseKey, seedTip: tip, chainLength: 16,
    openBalances: { player: 200n, house: 200n }, settlementMode: mode,
  })
  await s.open()
  for (let i = 0; i < rounds; i++) {
    await s.playRound({ stake: 20n, params: { targetX100: 5000n }, clientSeed: `0x${(i + 1).toString(16).padStart(64, '0')}` as viem.Hex })
  }
  return s
}

describe('MsgBoard settlement E2E', () => {
  it('optimistic: play off-chain, settle the net delta from the transcript alone', async () => {
    const [house] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()
    const chainId = await publicClient.getChainId()

    const chips = await hre.viem.deployContract('Chips')
    const bank = await hre.viem.deployContract('HouseBankroll', [chips.address])
    await chips.write.mint([house.account.address, 10_000n])
    await chips.write.mint([playerKey.address, 1_000n])
    await bank.write.setHouseKey([houseKey.address])
    await chips.write.approve([bank.address, viem.maxUint256])
    await bank.write.fundHouse([5_000n])

    // player funds its session-key deposit (optimistic keys by signing address)
    const playerWallet = await hre.viem.getWalletClient(playerKey.address)
    await chips.write.approve([bank.address, viem.maxUint256], { account: playerKey.address })
    await bank.write.deposit([1_000n], { account: playerKey.address })

    const domain = makeDomain(chainId, bank.address)
    const tableId = viem.keccak256(viem.toHex('opt-table'))
    const s = await playSession(domain, tableId, 0)

    const opt = new OptimisticSettlement({
      parties: { player: playerKey.address, house: houseKey.address }, commit: s.chain.commit,
      game: dice, domain, settlementMode: 0, bankroll: bank.address,
    })
    const tx = await opt.buildSettle(s.transcript.toJSON())
    await house.writeContract({ address: tx.address, abi: tx.abi as viem.Abi, functionName: tx.functionName, args: tx.args })

    // deposit moved by exactly the net delta (final - open player balance)
    const expectedDelta = s.state.balancePlayer - 200n
    const dep = await bank.read.deposits([playerKey.address])
    expect(dep).to.equal(1_000n + expectedDelta)
  })

  it('escrowed: open (house-signed terms), play, settle from escrow', async () => {
    const [house] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()
    const chainId = await publicClient.getChainId()

    const chips = await hre.viem.deployContract('Chips')
    const ch = await hre.viem.deployContract('HouseChannel', [chips.address])
    await chips.write.mint([house.account.address, 10_000n])
    await chips.write.mint([playerKey.address, 1_000n])
    await ch.write.setHouseKey([houseKey.address])
    await chips.write.approve([ch.address, viem.maxUint256])
    await ch.write.fundHouse([5_000n])
    await chips.write.approve([ch.address, viem.maxUint256], { account: playerKey.address })

    const domain = makeDomain(chainId, ch.address)
    const tableId = viem.keccak256(viem.toHex('esc-table'))
    const s = await playSession(domain, tableId, 1)

    const terms: OpenTerms = {
      tableId, player: playerKey.address, playerKey: playerKey.address,
      escrowPlayer: 200n, escrowHouse: 200n, gameId: 1, rngCommit: s.chain.commit,
      clockBlocks: 30n, expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    }
    const houseSig = await signOpenTerms(houseKey, domain, terms)
    await ch.write.open([terms, houseSig], { account: playerKey.address })

    const esc = new EscrowedSettlement({
      parties: { player: playerKey.address, house: houseKey.address }, commit: s.chain.commit,
      game: dice, domain, settlementMode: 1, channel: ch.address,
    })
    const tx = await esc.buildSettle(s.transcript.toJSON())
    await house.writeContract({ address: tx.address, abi: tx.abi as viem.Abi, functionName: tx.functionName, args: tx.args })

    const bal = await chips.read.balanceOf([playerKey.address])
    // player started with 1000, escrowed 200, received back balancePlayer of the final state
    expect(bal).to.equal(1_000n - 200n + s.state.balancePlayer)
  })
})
```

- [ ] **Step 2: Run** — `cd ~/Documents/gibs-finance/random/packages/contracts && pnpm build && pnpm test --grep "MsgBoard settlement E2E"`
Expected: 2 passing. (If `hre.viem.getWalletClient(address)` is unavailable in the installed hardhat-viem, the player tx can instead be sent by deriving a wallet client from the public client + the player account; adjust to the installed `hardhat-viem` API — the assertion logic is unchanged.)

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/gibs-finance/random
git add packages/contracts/test/MsgBoardSettleE2E.test.ts
git commit -m "test(msgboard-games): E2E — off-chain play then on-chain settle under both backends"
```

---

### Task 10: READMEs, progress, and full verification sweep

**Files:**
- Create: `examples/games/msgboard-settle/README.md`
- Modify: `~/Documents/gibs-finance/random/examples/games/msgboard-games/README.md` (add a "Settlement (Plan 2)" pointer)
- Modify: msgboard repo `progress.txt`

- [ ] **Step 1: Write `examples/games/msgboard-settle/README.md`** — document: what the package is (the on-chain settlement seam over the Plan-1 substrate); the `Settlement` interface; the two backends and their trust models (optimistic = shared deposit, net-delta, timing/willingness trust, deposits keyed by session key — note the SessionAuth follow-up; escrowed = per-table escrow, cooperative settle + chess-clock forfeit, payout to the opening wallet, the §6.2 hard guarantee); the `OpenTerms` house authorization; `replaySession` (transcript-only reconstruction, the §2 ephemerality property); how the contracts (`Chips`, `HouseBankroll`, `HouseChannel`) map to the seam; that the on-chain game-rules mirror + rules parity is deferred to the ZK plan (§13 plan 5); and how to run the tests. Point to `docs/superpowers/specs/2026-06-13-msgboard-games-design.md` (§6, §10, §12) in the msgboard repo.

- [ ] **Step 2: Add a "Settlement (Plan 2)" section** to `examples/games/msgboard-games/README.md` pointing at `@gibs/msgboard-settle` and the contracts in `packages/contracts/contracts/games/`.

- [ ] **Step 3: Full sweep.**

Contracts (Foundry): `cd ~/Documents/gibs-finance/random/packages/contracts && forge test --match-contract "SessionStateDigestTest|ChipsTest|HouseBankrollTest|HouseChannelTest" -vv` → all green.
Contracts (Hardhat): `pnpm build && pnpm test --grep "SessionStateSig|MsgBoard settlement E2E"` → all green.
Off-chain: `cd ../../examples/games/msgboard-settle && pnpm test && pnpm typecheck` → all green.
Plan-1 substrate (regression): `cd ../msgboard-games && pnpm test && pnpm typecheck` → still green.

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/gibs-finance/random
git add examples/games/msgboard-settle/README.md examples/games/msgboard-games/README.md
git commit -m "docs(msgboard-games): settlement READMEs (Plan 2 — optimistic + escrowed)"
```

- [ ] **Step 5: Record progress** (msgboard repo `progress.txt`, newest-first section at top): Plan 2 executed — on-chain `SessionState` EIP-712 lib + TS↔Solidity digest parity (the deferred Plan-1 item); `Chips` mintable ERC20; `HouseBankroll` (optimistic, §6.1 — shared deposit, net-delta settle, highest-nonce-wins, both-sigs); `HouseChannel` (escrowed, §6.2 — house-signed `OpenTerms` open, cooperative settle, chess-clock dispute/forfeit); the `@gibs/msgboard-settle` seam (`Settlement` + Optimistic/Escrowed builders + `replaySession` transcript-only reconstruction + `signOpenTerms`); Ignition module; Foundry + Hardhat parity + E2E green; test counts; the commit range; note the scoping decisions (signature-adjudicated so no on-chain rules mirror; optimistic deposits keyed by session key with `SessionAuth` as follow-up; dispute is co-signed-state+chess-clock only). NEXT: Plan 3 (async settlement relayer). Commit + push msgboard (`master`, signed, HTTPS origin).

---

## Self-review notes

- **Spec coverage (§13 plan 2):** the `Settlement` interface (Task 7 `settlement.ts`) ✓; House bankroll optimistic (Task 3) ✓; `HouseChannel` escrowed + dispute/forfeit (Tasks 4–5) ✓; settle Dice **and** Limbo under both (Task 8 tests use dice + limbo; Task 9 E2E plays dice under both backends) ✓; conservation tests (Foundry `test_rejectsConservation*` for both backends; on-chain `_checkCoSigned`/settle conservation guard) ✓; **parity tests** = the TS↔Solidity `SessionState` EIP-712 digest parity (Task 1) — the item Plan 1's self-review explicitly deferred here ✓. Ephemerality (§12) = `replaySession` + the E2E settling from `transcript.toJSON()` alone ✓. Async/permissionless settle (§7) = anyone may submit (the contracts gate on signatures + nonce, not on `msg.sender`); the relayer composition itself is Plan 3, out of scope here ✓.
- **Deliberately deferred (called out so they are not mistaken for gaps):** (1) the on-chain Dice/Limbo **game-rules mirror + fuzzed rules parity** — not needed because Plan 2's backends adjudicate by co-signed balances, never by recomputing a round; it lands in the ZK/unilateral plan (§13 plan 5) where a backend recomputes from a revealed seed. (2) Wallet-bound `SessionAuth` for the optimistic deposit (so a leaked session key risks one session, not the whole deposit) — optimistic keys deposits by the session signing key in this plan; the escrowed channel already binds payout to the opening wallet. (3) The dispute **reveal-demand** path (`respondWithMove`/share) — single-draw games settle to agreed balances; the reveal-demand is the unilateral/ZK plan.
- **Type/encoding consistency:** the `SessionState` tuple field order is identical across Plan-1 `sessionState.ts`, `SessionState.sol`/`SessionStateLib.TYPEHASH`, every Foundry `_state(...)` helper, and the parity test. `settlementMode` 0/1 and `gameId` 1/2 match Plan 1. `OpenTerms` field order matches between `HouseChannel.sol` `OpenTermsLib.TYPEHASH` and `openTerms.ts` `OPEN_TERMS_TYPES`. The EIP-712 domain name `"MsgBoardGames"`/version `"1"` matches between `SessionStateEIP712._domainNameAndVersion()` and Plan-1 `makeDomain`. Both contracts inherit `SessionStateEIP712`, so a session's sigs are bound to the specific settlement contract via `verifyingContract` — exactly what `makeDomain(chainId, contractAddress)` encodes.
- **Reused-verbatim patterns (de-risked):** Solady `EIP712` domain + `structHash`/`stateDigest`, `_checkCoSigned` conservation guard, status-before-transfer `_payout`, `_seatOf`, ForceMove chess-clock (`disputeDeadline = block.number + clockBlocks`, `resolveTimeout`) all mirror `ZkTable.sol`. Foundry `vm.sign(pk, digest)` + `abi.encodePacked(r,s,v)` and the Hardhat `hashState == stateDigest` parity mirror `ZkTable.t.sol` / `ZkChannelSig.test.ts`. Solady `ERC20`+`Ownable` mirror `contracts/test/ERC20.sol`.
- **Placeholder scan:** every code step contains full code; the one place a literal needs care (`playerWallet` in `HouseChannel.t.sol`) is fixed by the inline note in Task 4 Step 2 (use `address(uint160(uint256(keccak256("player-wallet"))))`).

## Execution corrections (fill in during build)

(Leave this section for the executor to record any deltas vs the task code — e.g. the installed `hardhat-viem` wallet-client API in Task 9, or the exact Solady `Ownable` revert selector for the `test_nonOwnerCannotMint` `expectRevert` — so a re-run matches the committed code.)
