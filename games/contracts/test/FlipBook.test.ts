import hre from 'hardhat'
import * as viem from 'viem'
import { expect } from 'chai'
import * as helpers from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import * as expectations from './expectations'

/**
 * FlipBook — the P2P guessing-game coin flip (matching pennies), variant A of
 * examples/games/P2P_COINFLIP_DESIGN.md: escrowed offers, public guesses, one-sided
 * maker reveal + bond, directly-observable forfeit.
 */

const STAKE = viem.parseEther('1')
const BOND = viem.parseEther('0.2')
const REVEAL_WINDOW = 3600 // 1h
const DAY = 24 * 3600

const commitFor = (maker: viem.Hex, choice: boolean, salt: viem.Hex) =>
  viem.keccak256(
    viem.encodeAbiParameters(
      [{ type: 'address' }, { type: 'bool' }, { type: 'bytes32' }],
      [maker, choice, salt],
    ),
  )

const SALT = viem.keccak256(viem.toHex('flip-salt-1'))

const deployFixture = async () => {
  const flipBook = await hre.viem.deployContract('FlipBook', [])
  const rejector = await hre.viem.deployContract('RejectingTaker', [flipBook.address])
  const signers = await hre.viem.getWalletClients()
  const publicClient = await hre.viem.getPublicClient()
  return { flipBook, rejector, signers, publicClient }
}
type Ctx = Awaited<ReturnType<typeof deployFixture>>

/** Maker posts a standard offer (choice=heads/true unless overridden); returns its id (1st = 1n). */
const postOffer = async (ctx: Ctx, opts: { choice?: boolean; salt?: viem.Hex; makerIdx?: number } = {}) => {
  const maker = ctx.signers[opts.makerIdx ?? 0]!
  const now = BigInt(await helpers.time.latest())
  const commit = commitFor(maker.account.address, opts.choice ?? true, opts.salt ?? SALT)
  const hash = await ctx.flipBook.write.post([commit, BOND, now + BigInt(DAY), REVEAL_WINDOW], {
    value: STAKE + BOND,
    account: maker.account,
  })
  await ctx.publicClient.waitForTransactionReceipt({ hash })
  return { maker, commit }
}

const confirm = async (ctx: Ctx, p: Promise<viem.Hex>) =>
  ctx.publicClient.waitForTransactionReceipt({ hash: await p })

const balance = (ctx: Ctx, address: viem.Hex) => ctx.publicClient.getBalance({ address })

describe('FlipBook', () => {
  describe('post', () => {
    it('escrows stake + bond and records the offer', async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      const { maker, commit } = await postOffer(ctx)
      expect(await balance(ctx, ctx.flipBook.address)).to.equal(STAKE + BOND)
      const o = await ctx.flipBook.read.offers([1n])
      // [maker, commit, stake, bond, takeDeadline, revealWindow, taker, takenAt, guess]
      expect(o[0].toLowerCase()).to.equal(maker.account.address.toLowerCase())
      expect(o[1]).to.equal(commit)
      expect(o[2]).to.equal(STAKE)
      expect(o[3]).to.equal(BOND)
      expect(o[5]).to.equal(REVEAL_WINDOW)
      expect(o[6]).to.equal(viem.zeroAddress)
    })

    it('rejects a zero bond (even-money indifference: bailing must cost strictly more than losing)', async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      const now = BigInt(await helpers.time.latest())
      await expectations.revertedWithCustomError(
        ctx.flipBook,
        ctx.flipBook.write.post([SALT, 0n, now + BigInt(DAY), REVEAL_WINDOW], { value: STAKE }),
        'ZeroBond',
      )
    })

    it('rejects value <= bond (no stake left to flip)', async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      const now = BigInt(await helpers.time.latest())
      await expectations.revertedWithCustomError(
        ctx.flipBook,
        ctx.flipBook.write.post([SALT, BOND, now + BigInt(DAY), REVEAL_WINDOW], { value: BOND }),
        'ZeroStake',
      )
    })

    it('rejects a past takeDeadline and an out-of-bounds revealWindow', async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      const now = BigInt(await helpers.time.latest())
      await expectations.revertedWithCustomError(
        ctx.flipBook,
        ctx.flipBook.write.post([SALT, BOND, now, REVEAL_WINDOW], { value: STAKE + BOND }),
        'BadDeadline',
      )
      await expectations.revertedWithCustomError(
        ctx.flipBook,
        ctx.flipBook.write.post([SALT, BOND, now + BigInt(DAY), 60], { value: STAKE + BOND }),
        'BadWindow',
      )
      await expectations.revertedWithCustomError(
        ctx.flipBook,
        ctx.flipBook.write.post([SALT, BOND, now + BigInt(DAY), 8 * DAY], { value: STAKE + BOND }),
        'BadWindow',
      )
    })
  })

  describe('cancel', () => {
    it('refunds an untaken offer to the maker and deletes it', async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      const { maker } = await postOffer(ctx)
      const before = await balance(ctx, maker.account.address)
      const receipt = await confirm(ctx, ctx.flipBook.write.cancel([1n], { account: maker.account }))
      const gas = receipt.gasUsed * receipt.effectiveGasPrice
      expect(await balance(ctx, maker.account.address)).to.equal(before + STAKE + BOND - gas)
      // deleted: taking it now fails
      const [, taker] = ctx.signers
      await expectations.revertedWithCustomError(
        ctx.flipBook,
        ctx.flipBook.write.take([1n, true], { value: STAKE, account: taker!.account }),
        'UnknownOffer',
      )
    })

    it('only the maker can cancel', async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      await postOffer(ctx)
      const [, stranger] = ctx.signers
      await expectations.revertedWithCustomError(
        ctx.flipBook,
        ctx.flipBook.write.cancel([1n], { account: stranger!.account }),
        'NotMaker',
      )
    })

    it('CANNOT cancel after a take — the free-option closure', async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      const { maker } = await postOffer(ctx)
      const [, taker] = ctx.signers
      await confirm(ctx, ctx.flipBook.write.take([1n, false], { value: STAKE, account: taker!.account }))
      // maker now sees a guess they would lose to — bailing via cancel must be impossible
      await expectations.revertedWithCustomError(
        ctx.flipBook,
        ctx.flipBook.write.cancel([1n], { account: maker.account }),
        'AlreadyTaken',
      )
    })
  })

  describe('take', () => {
    it('locks the offer atomically with the taker, guess, and clock', async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      await postOffer(ctx)
      const [, taker] = ctx.signers
      await confirm(ctx, ctx.flipBook.write.take([1n, true], { value: STAKE, account: taker!.account }))
      expect(await balance(ctx, ctx.flipBook.address)).to.equal(STAKE * 2n + BOND)
      const o = await ctx.flipBook.read.offers([1n])
      expect(o[6].toLowerCase()).to.equal(taker!.account.address.toLowerCase())
      expect(o[8]).to.equal(true)
      expect(Number(o[7])).to.be.greaterThan(0)
    })

    it('rejects a mismatched stake, a second take, a self-take, and an expired offer', async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      const { maker } = await postOffer(ctx)
      const [, taker, other] = ctx.signers
      await expectations.revertedWithCustomError(
        ctx.flipBook,
        ctx.flipBook.write.take([1n, true], { value: STAKE - 1n, account: taker!.account }),
        'WrongValue',
      )
      await expectations.revertedWithCustomError(
        ctx.flipBook,
        ctx.flipBook.write.take([1n, true], { value: STAKE, account: maker.account }),
        'SelfTake',
      )
      await confirm(ctx, ctx.flipBook.write.take([1n, true], { value: STAKE, account: taker!.account }))
      await expectations.revertedWithCustomError(
        ctx.flipBook,
        ctx.flipBook.write.take([1n, false], { value: STAKE, account: other!.account }),
        'AlreadyTaken',
      )
      // a fresh offer, expired past its takeDeadline
      await postOffer(ctx)
      await helpers.time.increase(DAY + 1)
      await expectations.revertedWithCustomError(
        ctx.flipBook,
        ctx.flipBook.write.take([2n, true], { value: STAKE, account: taker!.account }),
        'OfferExpired',
      )
    })
  })

  describe('reveal (matching pennies, both branches)', () => {
    it('taker wins when the guess matches: pot to taker, bond back to maker', async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      const { maker } = await postOffer(ctx, { choice: true })
      const [, taker, cranker] = ctx.signers
      await confirm(ctx, ctx.flipBook.write.take([1n, true], { value: STAKE, account: taker!.account }))
      const takerBefore = await balance(ctx, taker!.account.address)
      const makerBefore = await balance(ctx, maker.account.address)
      // reveal is permissionless — a third party cranks, so winner balances have no gas noise
      await confirm(ctx, ctx.flipBook.write.reveal([1n, true, SALT], { account: cranker!.account }))
      expect(await balance(ctx, taker!.account.address)).to.equal(takerBefore + STAKE * 2n)
      expect(await balance(ctx, maker.account.address)).to.equal(makerBefore + BOND)
      expect(await balance(ctx, ctx.flipBook.address)).to.equal(0n)
    })

    it('maker wins when the guess misses: pot + bond back to maker', async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      const { maker } = await postOffer(ctx, { choice: true })
      const [, taker, cranker] = ctx.signers
      await confirm(ctx, ctx.flipBook.write.take([1n, false], { value: STAKE, account: taker!.account }))
      const makerBefore = await balance(ctx, maker.account.address)
      await confirm(ctx, ctx.flipBook.write.reveal([1n, true, SALT], { account: cranker!.account }))
      expect(await balance(ctx, maker.account.address)).to.equal(makerBefore + STAKE * 2n + BOND)
      expect(await balance(ctx, ctx.flipBook.address)).to.equal(0n)
    })

    it('rejects a reveal that does not open the commit', async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      await postOffer(ctx, { choice: true })
      const [, taker] = ctx.signers
      await confirm(ctx, ctx.flipBook.write.take([1n, true], { value: STAKE, account: taker!.account }))
      await expectations.revertedWithCustomError(
        ctx.flipBook,
        ctx.flipBook.write.reveal([1n, false, SALT]), // wrong choice
        'BadReveal',
      )
      await expectations.revertedWithCustomError(
        ctx.flipBook,
        ctx.flipBook.write.reveal([1n, true, viem.keccak256(viem.toHex('wrong'))]), // wrong salt
        'BadReveal',
      )
    })

    it('rejects reveal on an untaken offer (a premature reveal would hand takers a sure win)', async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      await postOffer(ctx, { choice: true })
      await expectations.revertedWithCustomError(ctx.flipBook, ctx.flipBook.write.reveal([1n, true, SALT]), 'NotTaken')
    })

    it('rejects reveal after the window (the forfeit path owns the offer) and settles at most once', async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      await postOffer(ctx, { choice: true })
      const [, taker] = ctx.signers
      await confirm(ctx, ctx.flipBook.write.take([1n, true], { value: STAKE, account: taker!.account }))
      await helpers.time.increase(REVEAL_WINDOW + 1)
      await expectations.revertedWithCustomError(
        ctx.flipBook,
        ctx.flipBook.write.reveal([1n, true, SALT]),
        'RevealWindowOver',
      )
      // and a settled flip is gone: fresh offer, settle, then double-reveal fails
      await postOffer(ctx, { choice: true })
      await confirm(ctx, ctx.flipBook.write.take([2n, true], { value: STAKE, account: taker!.account }))
      await confirm(ctx, ctx.flipBook.write.reveal([2n, true, SALT]))
      await expectations.revertedWithCustomError(ctx.flipBook, ctx.flipBook.write.reveal([2n, true, SALT]), 'UnknownOffer')
    })
  })

  describe('claim (forfeit)', () => {
    it('pays the taker 2·stake + bond after the reveal window lapses', async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      await postOffer(ctx, { choice: true })
      const [, taker, cranker] = ctx.signers
      // taker GUESSED WRONG — but the maker bails anyway; bailing must still pay the taker
      await confirm(ctx, ctx.flipBook.write.take([1n, false], { value: STAKE, account: taker!.account }))
      await helpers.time.increase(REVEAL_WINDOW + 1)
      const takerBefore = await balance(ctx, taker!.account.address)
      // permissionless crank: funds go to the taker regardless of caller
      await confirm(ctx, ctx.flipBook.write.claim([1n], { account: cranker!.account }))
      expect(await balance(ctx, taker!.account.address)).to.equal(takerBefore + STAKE * 2n + BOND)
      expect(await balance(ctx, ctx.flipBook.address)).to.equal(0n)
      // gone
      await expectations.revertedWithCustomError(ctx.flipBook, ctx.flipBook.write.claim([1n]), 'UnknownOffer')
    })

    it('charges the ABANDONING maker stake + bond — exactly one bond more than revealing the same loss', async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      const [maker, taker, cranker] = ctx.signers

      // Flip 1: the maker REVEALS a losing flip (taker guessed right). The cranker submits the
      // reveal (permissionless), so the maker's balance delta is gas-clean: +bond back.
      await postOffer(ctx, { choice: true })
      await confirm(ctx, ctx.flipBook.write.take([1n, true], { value: STAKE, account: taker!.account }))
      const m1 = await balance(ctx, maker!.account.address)
      await confirm(ctx, ctx.flipBook.write.reveal([1n, true, SALT], { account: cranker!.account }))
      const honestReturn = (await balance(ctx, maker!.account.address)) - m1
      expect(honestReturn).to.equal(BOND) // escrowed stake+bond, bond came home → honest loss = stake

      // Flip 2: identical position, but the maker ABANDONS. Nothing comes home → loss = stake + bond.
      await postOffer(ctx, { choice: true })
      await confirm(ctx, ctx.flipBook.write.take([2n, true], { value: STAKE, account: taker!.account }))
      const m2 = await balance(ctx, maker!.account.address)
      await helpers.time.increase(REVEAL_WINDOW + 1)
      await confirm(ctx, ctx.flipBook.write.claim([2n], { account: cranker!.account }))
      const abandonReturn = (await balance(ctx, maker!.account.address)) - m2
      expect(abandonReturn).to.equal(0n)

      // The theorem the bond exists for: quitting costs exactly one bond more than losing honestly.
      expect(honestReturn - abandonReturn).to.equal(BOND)
    })

    it('cannot claim while the reveal window is open, nor on an untaken offer', async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      await postOffer(ctx, { choice: true })
      const [, taker] = ctx.signers
      await expectations.revertedWithCustomError(ctx.flipBook, ctx.flipBook.write.claim([1n]), 'NotTaken')
      await confirm(ctx, ctx.flipBook.write.take([1n, true], { value: STAKE, account: taker!.account }))
      await expectations.revertedWithCustomError(ctx.flipBook, ctx.flipBook.write.claim([1n]), 'RevealWindowOpen')
    })

    it('boundary: reveal works AT the window edge, claim only strictly after', async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      await postOffer(ctx, { choice: true })
      const [, taker] = ctx.signers
      await confirm(ctx, ctx.flipBook.write.take([1n, true], { value: STAKE, account: taker!.account }))
      const o = await ctx.flipBook.read.offers([1n])
      const edge = Number(o[7]) + REVEAL_WINDOW
      await helpers.time.setNextBlockTimestamp(edge)
      await expectations.revertedWithCustomError(ctx.flipBook, ctx.flipBook.write.claim([1n]), 'RevealWindowOpen')
      await helpers.time.setNextBlockTimestamp(edge + 1)
      await expectations.revertedWithCustomError(
        ctx.flipBook,
        ctx.flipBook.write.reveal([1n, true, SALT]),
        'RevealWindowOver',
      )
      await confirm(ctx, ctx.flipBook.write.claim([1n]))
    })
  })

  describe('hostile winner (push failure → pull fallback)', () => {
    it('a revert-on-receive winner cannot block settlement; funds park in owed and are withdrawable', async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      await postOffer(ctx, { choice: true })
      const [, funder] = ctx.signers
      // the rejecting contract takes (and wins) the flip
      await confirm(
        ctx,
        ctx.rejector.write.take([1n, true], { value: STAKE, account: funder!.account }),
      )
      // settlement must SUCCEED even though paying the winner reverts
      await confirm(ctx, ctx.flipBook.write.reveal([1n, true, SALT]))
      expect(await ctx.flipBook.read.owed([ctx.rejector.address])).to.equal(STAKE * 2n)
      // withdraw still fails while the receive path is broken, and the credit survives.
      // Decode against the FLIPBOOK abi — NothingOwed is its error (the rejector's abi declares
      // none), and the revert bubbles through the rejector's passthrough.
      await expectations.revertedWithCustomError(ctx.flipBook, ctx.rejector.write.withdraw(), 'NothingOwed')
      expect(await ctx.flipBook.read.owed([ctx.rejector.address])).to.equal(STAKE * 2n)
      // flip the receiver on and collect
      await confirm(ctx, ctx.rejector.write.setAccept([true]))
      await confirm(ctx, ctx.rejector.write.withdraw())
      expect(await ctx.flipBook.read.owed([ctx.rejector.address])).to.equal(0n)
      expect(await balance(ctx, ctx.rejector.address)).to.equal(STAKE * 2n)
    })

    it('withdraw with nothing owed reverts', async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      await expectations.revertedWithCustomError(ctx.flipBook, ctx.flipBook.write.withdraw(), 'NothingOwed')
    })
  })

  describe('commit binding', () => {
    it("a copied commit is useless: it binds the ORIGINAL maker's address, so the copier can never reveal", async () => {
      const ctx = await helpers.loadFixture(deployFixture)
      const { commit } = await postOffer(ctx) // signer0's commit
      const [, copier, taker] = ctx.signers
      // copier posts the same commit bytes as their own offer
      const now = BigInt(await helpers.time.latest())
      await confirm(
        ctx,
        ctx.flipBook.write.post([commit, BOND, now + BigInt(DAY), REVEAL_WINDOW], {
          value: STAKE + BOND,
          account: copier!.account,
        }),
      )
      await confirm(ctx, ctx.flipBook.write.take([2n, true], { value: STAKE, account: taker!.account }))
      // even knowing signer0's (choice, salt) — say it leaked after offer 1 settled — the
      // commit hashes with THIS offer's maker (the copier), so reveal cannot verify
      await expectations.revertedWithCustomError(
        ctx.flipBook,
        ctx.flipBook.write.reveal([2n, true, SALT]),
        'BadReveal',
      )
      // the copier's only exits: never reveal → forfeit to the taker
      await helpers.time.increase(REVEAL_WINDOW + 1)
      const takerBefore = await balance(ctx, taker!.account.address)
      await confirm(ctx, ctx.flipBook.write.claim([2n], { account: copier!.account }))
      expect(await balance(ctx, taker!.account.address)).to.equal(takerBefore + STAKE * 2n + BOND)
    })
  })
})
