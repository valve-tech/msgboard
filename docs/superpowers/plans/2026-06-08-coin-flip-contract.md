# Coin Flip Periphery Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `CoinFlip.sol`, a periphery contract that escrows player stakes, matches entrants by side, drives the gibsfinance/random ink → heat → cast lifecycle for each matched pair, and pays the winner from the escrowed pot when the random seed is finalized.

**Architecture:** A standalone periphery contract that composes core `Random` (unchanged). Players enter with a side and a stake (escrowed on entry); opposite-side equal-stake entrants are matched first-in-first-out; matching inks both player preimages and heats validator preimages from an always-on pool, registering the contract as the request owner with the change-callback set so `Random` calls `onCast(key, seed)` back into it to settle. Built test-first against the existing hardhat suite.

**Tech Stack:** Solidity ^0.8.24, hardhat 2.22 with `@nomicfoundation/hardhat-toolbox-viem`, viem, mocha/chai, solady utilities. Repo: `gibsfinance/random` (local clone `~/Documents/gibsfinance/github/random`), package `packages/contracts`.

**Spec:** `docs/superpowers/specs/2026-06-08-coin-flip-design.md` (in the msgboard repo).

---

## Working location and conventions

All paths below are relative to `~/Documents/gibsfinance/github/random/packages/contracts`.

- Compile/test: `NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/hardhat test test/CoinFlip.test.ts` (the solc 0.8.25 compiler is already cached locally).
- The contracts use `pragma solidity ^0.8.24`. Match the style of `Consumer.sol` (custom errors, `unchecked` where the existing code does, no nested conditionals — guard-and-return).
- Tests follow the existing pattern in `test/Random.test.ts` and `test/utils.ts`: `helpers.loadFixture`, viem contract clients, `expectations` helpers, `utils.createTestPreimages` / `utils.defaultSection`.
- Native token only for this version. `defaultSection.price` in `lib/utils.ts` is `parseEther('100')`; player and validator preimages for the flip are inked at **price 0** so the only value that moves is the escrowed wager. The seed still works at price 0 (price only affects the protocol's own reward economics, which this contract does not use to pay players).

## File structure

- Create: `contracts/CoinFlip.sol` — the periphery contract (one responsibility: escrow + match + drive randomness + settle).
- Create: `test/CoinFlip.test.ts` — the contract's test suite.
- Modify: `test/utils.ts` — add a `deployCoinFlip` fixture and a helper to ink a price-0 validator pool.
- Create (later task): `ignition/modules/CoinFlip.ts` — deployment module.

---

## Task 1: Integration spike — lock the ink → heat → cast → onCast cycle

Before building the contract, prove the exact protocol calls with a throwaway minimal consumer, so later tasks use verified call shapes. This produces a passing test that documents the integration.

**Files:**
- Create: `test/spike-oncast.test.ts`
- Use existing: `contracts/test/ConsumerEmitter.sol` (implements `ConsumerReceiver`)

- [ ] **Step 1: Write a test driving a price-0 heat owned by a ConsumerReceiver with callAtChange, then cast, asserting onCast fires**

```ts
import * as utils from '../lib/utils'
import * as viem from 'viem'
import _ from 'lodash'
import * as helpers from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import * as testUtils from './utils'

describe('spike: onCast integration', () => {
  it('fires onCast into a receiver owner when callAtChange is set', async () => {
    // price-0 section so no value moves; the receiver contract is the request owner
    const section = { ...utils.defaultSection, price: 0n }
    const ctx = await helpers.loadFixture(async () => testUtils.deployWithRandomness(section))
    const receiver = ctx.consumerEmitter // ConsumerEmitter implements ConsumerReceiver
    const { selections } = await testUtils.selectPreimages(ctx, Number(ctx.required), [section])
    const secrets = selections.map((s) => ctx.secretByPreimage.get(s.preimage) as viem.Hex)
    // owner = receiver address, callAtChange = true so the protocol calls onCast on cast
    const settings = { ...section, provider: receiver.address, callAtChange: true }
    const heatTx = await ctx.random.write.heat([ctx.required, settings, selections, false], { value: 0n })
    const receipt = await testUtils.confirmTx(ctx, heatTx)
    const [start] = await ctx.random.getEvents.Start({}, { blockHash: receipt.blockHash })
    const key = start.args.key!
    // cast reveals the secrets and finalizes the seed, triggering the onCast callback
    await ctx.random.write.cast([key, selections, secrets])
    const seed = (await ctx.random.read.randomness([key])).seed
    expect(seed).to.not.equal(viem.zeroHash)
  })
})
```

- [ ] **Step 2: Run it and confirm the integration works**

Run: `NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/hardhat test test/spike-oncast.test.ts`
Expected: PASS. If `deployWithRandomness(section)` does not thread the price-0 section through `writePreimages`, note the exact change needed (the fixture passes `section` to `writePreimages`, which inks at `utils.sum` of the price-0 locations = 0). Record any deviation in the test as a comment.

- [ ] **Step 3: Record findings, delete the spike file**

Capture in `test/CoinFlip.test.ts` (top-of-file comment, written in Task 2) the verified facts: owner is `settings.provider`; `callAtChange: true` triggers `onCast`; `useTSTORE` must be `false`; a price-0 heat moves no value; `cast` finalizes `seed = hash(revealed)`.

```bash
rm test/spike-oncast.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(coinflip): spike the onCast integration"
```

---

## Task 2: Contract skeleton — types, storage, entry escrow

Create the contract with its state and the `enter` function that escrows native value and records an entry. No matching yet.

**Files:**
- Create: `contracts/CoinFlip.sol`
- Create: `test/CoinFlip.test.ts`
- Modify: `test/utils.ts`

- [ ] **Step 1: Write the contract skeleton**

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {ConsumerReceiver} from "./implementations/ConsumerReceiver.sol";

/// @notice Two-person coin flip. Players escrow a stake and a side; opposite-side
/// equal-stake entrants are matched first-in-first-out, the matched pair's randomness is
/// driven through core Random, and the seed's parity decides the winner of the escrowed pot.
contract CoinFlip is ConsumerReceiver {
    using SafeTransferLib for address;

    error WrongSide();
    error ZeroStake();
    error StakeMismatch();
    error NotEntrant();
    error AlreadyResolved();
    error TooEarly();

    event Entered(uint256 indexed id, address indexed player, uint8 side, uint256 stake);
    event Cancelled(uint256 indexed id);

    uint8 internal constant HEADS = 0;
    uint8 internal constant TAILS = 1;

    address public immutable random;

    uint256 public nextEntrant;

    struct Entry {
        address player;
        uint8 side;
        uint256 stake;
        bytes32 preimage;
        uint256 enteredAtBlock;
        bool active;
    }

    mapping(uint256 id => Entry entry) public entries;

    constructor(address _random) payable {
        random = _random;
    }

    /// @param side HEADS (0) or TAILS (1)
    /// @param preimage the hash of the player's secret, or hash(0) for a walk-away
    function enter(uint8 side, bytes32 preimage) external payable returns (uint256 id) {
        if (side > TAILS) revert WrongSide();
        if (msg.value == 0) revert ZeroStake();
        id = ++nextEntrant;
        entries[id] = Entry({
            player: msg.sender,
            side: side,
            stake: msg.value,
            preimage: preimage,
            enteredAtBlock: block.number,
            active: true
        });
        emit Entered(id, msg.sender, side, msg.value);
    }
}
```

- [ ] **Step 2: Add the deploy fixture**

In `test/utils.ts`, inside `deploy()` after the other `deployContract` calls, add:

```ts
const coinFlip = await hre.viem.deployContract(contractName.CoinFlip, [random.address])
```

Add `coinFlip` to the `deployedContracts` object. Then in `lib/utils.ts` `contractName`, add:

```ts
CoinFlip: 'CoinFlip',
```

- [ ] **Step 3: Write the entry-escrow test**

```ts
import * as viem from 'viem'
import * as helpers from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import * as testUtils from './utils'

describe('CoinFlip', () => {
  describe('enter', () => {
    it('escrows the stake and records an active entry', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const [player] = ctx.signers
      const stake = viem.parseEther('1')
      const preimage = viem.keccak256(viem.toHex('secret-a'))
      const hash = await ctx.coinFlip.write.enter([0, preimage], { value: stake, account: player.account })
      await testUtils.confirmTx(ctx, hash)
      const balance = await (await ctx.hre.viem.getPublicClient()).getBalance({ address: ctx.coinFlip.address })
      expect(balance).to.equal(stake)
      const entry = await ctx.coinFlip.read.entries([1n])
      // tuple: [player, side, stake, preimage, enteredAtBlock, active]
      expect(entry[2]).to.equal(stake)
      expect(entry[5]).to.equal(true)
    })
    it('rejects a zero stake', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      await expectations.revertedWithCustomError(
        ctx.coinFlip, ctx.coinFlip.write.enter([0, viem.zeroHash], { value: 0n }), 'ZeroStake'
      )
    })
  })
})
```

(Import `expectations` from `./expectations` at the top, matching `Random.test.ts`.)

- [ ] **Step 4: Run the tests**

Run: `NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/hardhat test test/CoinFlip.test.ts`
Expected: PASS (both `enter` cases).

- [ ] **Step 5: Commit**

```bash
git add contracts/CoinFlip.sol test/CoinFlip.test.ts test/utils.ts lib/utils.ts
git commit -m "feat(coinflip): entry escrow skeleton"
```

---

## Task 3: Per-side first-in-first-out queues and opposite-side matching

Add the queues and match an entrant against the oldest waiting opposite-side entrant at the same stake. On a match, record a `Flip` (no randomness yet — that is Task 4).

**Files:**
- Modify: `contracts/CoinFlip.sol`
- Modify: `test/CoinFlip.test.ts`

- [ ] **Step 1: Add queue storage, the Flip record, and matching to `enter`**

Add to the contract:

```solidity
    event Paired(bytes32 indexed flipId, address heads, address tails, uint256 stake);

    enum Status { None, Pending, Settled, Refunded }

    struct Flip {
        address heads;
        address tails;
        uint256 stake;
        bytes32 preimageHeads;
        bytes32 preimageTails;
        bytes32 key;
        uint256 pairedAtBlock;
        Status status;
    }

    // stake => side => first-in-first-out queue of entry ids, with a moving head index
    mapping(uint256 stake => mapping(uint8 side => uint256[] ids)) internal _queue;
    mapping(uint256 stake => mapping(uint8 side => uint256 head)) internal _queueHead;

    mapping(bytes32 flipId => Flip flip) public flips;
    uint256 internal _flipNonce;
```

Replace the tail of `enter` (after writing `entries[id]` and emitting `Entered`) with matching logic:

```solidity
        uint8 opposite = side == HEADS ? TAILS : HEADS;
        uint256 matchedId = _popQueued(msg.value, opposite);
        if (matchedId == 0) {
            _queue[msg.value][side].push(id);
            return id;
        }
        _pair(matchedId, id, msg.value);
        return id;
```

Add the helpers:

```solidity
    /// @return id the oldest active entry id waiting on `side` at `stake`, or 0 if none
    function _popQueued(uint256 stake, uint8 side) internal returns (uint256 id) {
        uint256[] storage q = _queue[stake][side];
        uint256 head = _queueHead[stake][side];
        while (head < q.length) {
            uint256 candidate = q[head];
            ++head;
            if (entries[candidate].active) {
                _queueHead[stake][side] = head;
                return candidate;
            }
        }
        _queueHead[stake][side] = head;
        return 0;
    }

    function _pair(uint256 aId, uint256 bId, uint256 stake) internal {
        Entry storage a = entries[aId];
        Entry storage b = entries[bId];
        a.active = false;
        b.active = false;
        (Entry storage heads, Entry storage tails) = a.side == HEADS ? (a, b) : (b, a);
        bytes32 flipId = keccak256(abi.encode(address(this), ++_flipNonce, heads.player, tails.player));
        flips[flipId] = Flip({
            heads: heads.player,
            tails: tails.player,
            stake: stake,
            preimageHeads: heads.preimage,
            preimageTails: tails.preimage,
            key: bytes32(0),
            pairedAtBlock: block.number,
            status: Status.Pending
        });
        emit Paired(flipId, heads.player, tails.player, stake);
    }
```

- [ ] **Step 2: Write matching tests**

```ts
  describe('matching', () => {
    it('queues same-side entrants and pairs the first opposite-side entrant', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const [a, b, c] = ctx.signers
      const stake = viem.parseEther('1')
      // three heads, none tails -> all queue, none paired
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enter([0, viem.keccak256(viem.toHex('a'))], { value: stake, account: a.account }))
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enter([0, viem.keccak256(viem.toHex('b'))], { value: stake, account: b.account }))
      const noPair = await ctx.coinFlip.getEvents.Paired()
      expect(noPair.length).to.equal(0)
      // first tails pairs with the oldest heads (entry 1 = a)
      await expectations.emit(ctx,
        ctx.coinFlip.write.enter([1, viem.keccak256(viem.toHex('c'))], { value: stake, account: c.account }),
        ctx.coinFlip, 'Paired', { heads: viem.getAddress(a.account!.address) })
    })
    it('does not match across different stakes', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const [a, b] = ctx.signers
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enter([0, viem.keccak256(viem.toHex('a'))], { value: viem.parseEther('1'), account: a.account }))
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enter([1, viem.keccak256(viem.toHex('b'))], { value: viem.parseEther('2'), account: b.account }))
      expect((await ctx.coinFlip.getEvents.Paired()).length).to.equal(0)
    })
  })
```

- [ ] **Step 3: Run the tests**

Run: `NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/hardhat test test/CoinFlip.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add contracts/CoinFlip.sol test/CoinFlip.test.ts
git commit -m "feat(coinflip): per-side fifo matching"
```

---

## Task 4: Drive randomness on pairing — dual-ink and heat

On pairing, ink both player preimages at price 0 and heat them together with validator preimages from the always-on pool, with the contract as the owner and `callAtChange = true`. The validator preimage locations are supplied by the caller of `enter` so the contract does not need to discover the pool on-chain in this version; the contract verifies they are valid by letting `heat` revert if not.

**Files:**
- Modify: `contracts/CoinFlip.sol` (add an `enterWith` entrypoint that carries the validator locations and the section template; keep `enter` for the queue-only path)
- Modify: `test/utils.ts` (add `inkValidatorPool` helper)
- Modify: `test/CoinFlip.test.ts`

- [ ] **Step 1: Add the randomness wiring**

Add imports and the protocol structs:

```solidity
import {PreimageLocation} from "./PreimageLocation.sol";
import {IRandom} from "./implementations/IRandom.sol";
```

Add a section template stored at construction-time per flip is overkill; instead the matching caller passes the section template and the validator locations. Change `enter` to `enter(uint8 side, bytes32 preimage, PreimageLocation.Info calldata template, PreimageLocation.Info[] calldata validatorLocations)` and store `template`/`validatorLocations` on the queued entry is heavy. Simpler: only the entrant who *completes* a pair needs them, so add a sibling:

```solidity
    /// @notice Enter and, if this completes a pair, settle the randomness using the provided
    /// validator preimage locations. `template` is the price-0 section both player preimages
    /// share; `validatorLocations` are free entropy preimages from the always-on pool.
    function enterAndMatch(
        uint8 side,
        bytes32 preimage,
        PreimageLocation.Info calldata template,
        PreimageLocation.Info[] calldata validatorLocations
    ) external payable returns (uint256 id) {
        if (side > TAILS) revert WrongSide();
        if (msg.value == 0) revert ZeroStake();
        id = ++nextEntrant;
        entries[id] = Entry(msg.sender, side, msg.value, preimage, block.number, true);
        emit Entered(id, msg.sender, side, msg.value);
        uint8 opposite = side == HEADS ? TAILS : HEADS;
        uint256 matchedId = _popQueued(msg.value, opposite);
        if (matchedId == 0) {
            _queue[msg.value][side].push(id);
            return id;
        }
        _pairAndHeat(matchedId, id, msg.value, template, validatorLocations);
    }
```

Add `_pairAndHeat`, extending `_pair` to ink and heat:

```solidity
    function _pairAndHeat(
        uint256 aId,
        uint256 bId,
        uint256 stake,
        PreimageLocation.Info calldata template,
        PreimageLocation.Info[] calldata validatorLocations
    ) internal {
        Entry storage a = entries[aId];
        Entry storage b = entries[bId];
        a.active = false;
        b.active = false;
        (Entry storage heads, Entry storage tails) = a.side == HEADS ? (a, b) : (b, a);

        // ink both player preimages at price 0 in one batch
        PreimageLocation.Info memory playerInfo = template; // template carries provider=address(this), price=0
        playerInfo.offset = template.offset;
        bytes memory data = abi.encodePacked(heads.preimage, tails.preimage);
        IRandom(random); // see Task 1 spike: ink signature is ink(info, data)
        (bool ok,) = random.call(abi.encodeWithSignature(
            "ink((address,bool,bool,uint256,address,uint256,uint256,uint256),bytes)", playerInfo, data));
        require(ok, "ink failed");

        // build the heat selection: the two player preimages plus the validator locations
        uint256 n = validatorLocations.length + 2;
        PreimageLocation.Info[] memory locations = new PreimageLocation.Info[](n);
        // the two freshly inked player locations occupy index 0 and 1 of this pointer
        locations[0] = playerInfo; locations[0].index = 0;
        locations[1] = playerInfo; locations[1].index = 1;
        for (uint256 i = 0; i < validatorLocations.length; ++i) locations[i + 2] = validatorLocations[i];

        PreimageLocation.Info memory settings = template;
        settings.provider = address(this);
        settings.callAtChange = true;
        bytes32 key = IRandom(random).heat(n, settings, locations, false);

        bytes32 flipId = keccak256(abi.encode(address(this), ++_flipNonce, heads.player, tails.player));
        flips[flipId] = Flip(heads.player, tails.player, stake, heads.preimage, tails.preimage, key, block.number, Status.Pending);
        _flipByKey[key] = flipId;
        emit Paired(flipId, heads.player, tails.player, stake);
    }

    mapping(bytes32 key => bytes32 flipId) internal _flipByKey;
```

> Note for the implementer: the `ink` call shape and whether the two player preimages share one pointer (indices 0 and 1) versus needing distinct sections was locked down in the Task 1 spike. If the spike showed a different layout (for example each preimage needing its own `index`/`offset`), mirror that here exactly. Do not guess — re-run a focused spike test if the heat reverts with `UnableToService`.

- [ ] **Step 2: Add the validator-pool ink helper to `test/utils.ts`**

```ts
export const inkValidatorPool = async (ctx: Context, count = 3) => {
  const section = { ...utils.defaultSection, price: 0n }
  const [provider] = ctx.randomnessProviders
  const sec = { ...section, provider: provider.account!.address }
  const [batch] = await utils.createTestPreimages(sec, count)
  const preimages = batch.map((s) => s.preimage)
  const locations = preimages.map((preimage, index) => ({ ...sec, index: BigInt(index), preimage }))
  await confirmTx(ctx, ctx.random.write.ink([locations[0], viem.concatHex(preimages)], {
    account: provider.account, value: 0n,
  }))
  return { section: sec, locations, secrets: batch }
}
```

- [ ] **Step 3: Write the pairing-heats test**

```ts
  describe('pairing drives randomness', () => {
    it('inks the players and heats validators, recording a key', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const pool = await testUtils.inkValidatorPool(ctx, 3)
      const [a, b] = ctx.signers
      const stake = viem.parseEther('1')
      const template = { ...pool.section, provider: ctx.coinFlip.address, price: 0n, offset: 0n, index: 0n }
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch(
        [0, viem.keccak256(viem.toHex('a')), template, []], { value: stake, account: a.account }))
      await expectations.emit(ctx,
        ctx.coinFlip.write.enterAndMatch([1, viem.keccak256(viem.toHex('b')), template, pool.locations], { value: stake, account: b.account }),
        ctx.random, 'Start')
    })
  })
```

- [ ] **Step 4: Run; iterate on the ink/heat shape until it passes**

Run: `NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/hardhat test test/CoinFlip.test.ts --grep "pairing drives randomness"`
Expected: PASS with a `Start` event. If `heat` reverts, the most likely cause is the player preimage layout (the freshly inked pointer's offset/index). Re-read the Task 1 spike notes and the `ink`/`heat` selection in `test/utils.ts` `writePreimages`/`selectPreimages` and align `locations[0]`/`locations[1]`.

- [ ] **Step 5: Commit**

```bash
git add contracts/CoinFlip.sol test/CoinFlip.test.ts test/utils.ts
git commit -m "feat(coinflip): ink players and heat validators on pairing"
```

---

## Task 5: Settlement via onCast — parity picks the winner, pot pays out

Implement `onCast(key, seed)`: look up the flip by key, compute the winner from `seed` parity, pay the pot, mark settled.

**Files:**
- Modify: `contracts/CoinFlip.sol`
- Modify: `test/CoinFlip.test.ts`

- [ ] **Step 1: Implement `onCast` and the unused-callback no-ops**

```solidity
    event Settled(bytes32 indexed flipId, address indexed winner, uint8 winningSide, uint256 payout);

    /// @notice Called by Random when a request's seed is finalized (callAtChange was set).
    function onCast(bytes32 key, bytes32 seed) external override {
        if (msg.sender != random) revert NotEntrant();
        bytes32 flipId = _flipByKey[key];
        Flip storage flip = flips[flipId];
        if (flip.status != Status.Pending) revert AlreadyResolved();
        flip.status = Status.Settled;
        // even seed -> heads wins, odd -> tails wins. Provably fair fifty-fifty.
        uint8 winningSide = uint8(uint256(seed) & 1);
        address winner = winningSide == HEADS ? flip.heads : flip.tails;
        uint256 payout = flip.stake * 2;
        emit Settled(flipId, winner, winningSide, payout);
        winner.safeTransferETH(payout);
    }

    function onReverse(bytes32, address, uint256) external override {}
    function onChop(bytes32) external override {}
```

- [ ] **Step 2: Write the settlement test**

```ts
  describe('settlement', () => {
    it('pays the whole pot to the parity-selected winner on cast', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const pool = await testUtils.inkValidatorPool(ctx, 3)
      const [a, b] = ctx.signers
      const stake = viem.parseEther('1')
      const template = { ...pool.section, provider: ctx.coinFlip.address, price: 0n, offset: 0n, index: 0n }
      // both players use hash(1) walk-away preimages so the secrets are public (the non-zero
      // value 1). A zero secret cannot settle — Random.cast treats bytes32(0) as "not supplied"
      // (MISSING_SECRET), proven by the Task 1 spike — so the walk-away uses 1, not 0.
      const walkAwaySecret = viem.padHex('0x01', { size: 32 }) // bytes32(uint256(1))
      const walkAwayPre = viem.keccak256(walkAwaySecret)
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, walkAwayPre, template, []], { value: stake, account: a.account }))
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([1, walkAwayPre, template, pool.locations], { value: stake, account: b.account }))
      const [start] = await ctx.random.getEvents.Start()
      const key = start.args.key!
      // assemble the full selection (2 player zero-secrets + 3 validator secrets) and cast
      const playerLocs = [
        { ...template, index: 0n }, { ...template, index: 1n },
      ]
      const selections = [...playerLocs, ...pool.locations]
      const secrets = [walkAwaySecret, walkAwaySecret, ...pool.secrets.map((s) => s.secret)]
      const publicClient = await ctx.hre.viem.getPublicClient()
      const before = { heads: await publicClient.getBalance({ address: a.account!.address }), tails: await publicClient.getBalance({ address: b.account!.address }) }
      await expectations.emit(ctx, ctx.random.write.cast([key, selections, secrets]), ctx.coinFlip, 'Settled')
      const seed = (await ctx.random.read.randomness([key])).seed
      const winnerIsHeads = (BigInt(seed) & 1n) === 0n
      const winnerAddr = winnerIsHeads ? a.account!.address : b.account!.address
      const after = await publicClient.getBalance({ address: winnerAddr })
      // winner gained ~2 * stake (minus any gas if they were the casting account — here a third account casts)
      expect(after - (winnerIsHeads ? before.heads : before.tails)).to.equal(stake * 2n)
    })
  })
```

> Note: have a *third* signer submit the `cast` so gas does not perturb the winner's balance assertion. Adjust the test to `ctx.random.write.cast([...], { account: ctx.signers[5].account })`.

- [ ] **Step 3: Run the tests**

Run: `NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/hardhat test test/CoinFlip.test.ts --grep "settlement"`
Expected: PASS — `Settled` emitted, winner balance up by `2 * stake`.

- [ ] **Step 4: Commit**

```bash
git add contracts/CoinFlip.sol test/CoinFlip.test.ts
git commit -m "feat(coinflip): settle pot to parity winner on cast"
```

---

## Task 6: Recovery — cancel an unmatched entry, refund a stale flip

**Files:**
- Modify: `contracts/CoinFlip.sol`
- Modify: `test/CoinFlip.test.ts`

- [ ] **Step 1: Implement `cancel` and `refundStale`**

```solidity
    uint256 public constant STALE_BLOCKS = 200;

    /// @notice A still-waiting entrant reclaims their stake.
    function cancel(uint256 id) external {
        Entry storage e = entries[id];
        if (e.player != msg.sender) revert NotEntrant();
        if (!e.active) revert AlreadyResolved();
        e.active = false;
        emit Cancelled(id);
        e.player.safeTransferETH(e.stake);
    }

    /// @notice Refund both players of a paired flip whose seed never finalized in time.
    function refundStale(bytes32 flipId) external {
        Flip storage flip = flips[flipId];
        if (flip.status != Status.Pending) revert AlreadyResolved();
        if (block.number < flip.pairedAtBlock + STALE_BLOCKS) revert TooEarly();
        flip.status = Status.Refunded;
        flip.heads.safeTransferETH(flip.stake);
        flip.tails.safeTransferETH(flip.stake);
    }
```

- [ ] **Step 2: Write recovery tests**

```ts
  describe('recovery', () => {
    it('lets an unmatched entrant cancel for a refund', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const [a] = ctx.signers
      const stake = viem.parseEther('1')
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enter([0, viem.keccak256(viem.toHex('a'))], { value: stake, account: a.account }))
      const publicClient = await ctx.hre.viem.getPublicClient()
      const before = await publicClient.getBalance({ address: ctx.coinFlip.address })
      expect(before).to.equal(stake)
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.cancel([1n], { account: a.account }))
      expect(await publicClient.getBalance({ address: ctx.coinFlip.address })).to.equal(0n)
    })
    it('refunds both players when a paired flip goes stale', async () => {
      const ctx = await helpers.loadFixture(testUtils.deploy)
      const pool = await testUtils.inkValidatorPool(ctx, 3)
      const [a, b] = ctx.signers
      const stake = viem.parseEther('1')
      const template = { ...pool.section, provider: ctx.coinFlip.address, price: 0n, offset: 0n, index: 0n }
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([0, viem.keccak256(viem.toHex('a')), template, []], { value: stake, account: a.account }))
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.enterAndMatch([1, viem.keccak256(viem.toHex('b')), template, pool.locations], { value: stake, account: b.account }))
      const [paired] = await ctx.coinFlip.getEvents.Paired()
      await helpers.mine(201)
      const publicClient = await ctx.hre.viem.getPublicClient()
      await testUtils.confirmTx(ctx, ctx.coinFlip.write.refundStale([paired.args.flipId!]))
      expect(await publicClient.getBalance({ address: ctx.coinFlip.address })).to.equal(0n)
    })
  })
```

- [ ] **Step 3: Run the tests**

Run: `NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/hardhat test test/CoinFlip.test.ts --grep "recovery"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add contracts/CoinFlip.sol test/CoinFlip.test.ts
git commit -m "feat(coinflip): cancel and stale-refund recovery"
```

---

## Task 7: Full-suite run and deployment module

**Files:**
- Create: `ignition/modules/CoinFlip.ts`
- Run: the whole `CoinFlip.test.ts`

- [ ] **Step 1: Run the full CoinFlip suite**

Run: `NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/hardhat test test/CoinFlip.test.ts`
Expected: all `enter`, `matching`, `pairing drives randomness`, `settlement`, `recovery` cases PASS.

- [ ] **Step 2: Run the existing suites to confirm no regressions**

Run: `NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/hardhat test test/Random.test.ts test/Consumer.test.ts`
Expected: PASS (unchanged behavior — `CoinFlip.sol` is additive).

- [ ] **Step 3: Write the ignition deployment module**

```ts
import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

export default buildModule('CoinFlipModule', (m) => {
  const random = m.getParameter('random')
  const coinFlip = m.contract('CoinFlip', [random])
  return { coinFlip }
})
```

- [ ] **Step 4: Commit**

```bash
git add ignition/modules/CoinFlip.ts
git commit -m "feat(coinflip): ignition deployment module"
```

---

## Self-review notes (resolve during execution)

- The Task 1 spike is load-bearing: the exact `ink`/`heat` preimage layout for the two freshly-inked player preimages must come from it, not from guessing. **RESOLVED by the spike (commit `310fcd8`):** the two player preimages ARE inked in one batch and share one pointer at `{provider: address(this), token: 0, price: 0, offset: 0}`, addressed by `index` 0 and 1; the validator preimages use a DIFFERENT provider so their `(offset, index)` slots don't collide. The combined `heat` of `[player0, player1, validator0..N]` succeeds with `settings.provider = address(this)` (the owner that receives `onCast`) and `callAtChange = true`. `cast` requires `info` order to match the heat selection order and `revealed[i]` to be positionally aligned (the contract casts directly; the `Consumer` chain path is not needed). The spike also found that the walk-away secret must be NON-ZERO (`1`), since `bytes32(0)` casts as `MISSING_SECRET` — see the corrected Task 5 test.
- Stake matching is exact-equal native value. Variable stakes / an order book are out of scope (spec non-goal).
- Fee is zero in this version; `payout = stake * 2`. A configurable fee is a later, additive task.
- The validator-pool discovery is off-chain in this version (the matching caller passes `validatorLocations`); an on-chain validator registry is a follow-on once the node service exists.
