import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  type SafeTx,
  type SignatureRecord,
  SCHEME,
  encodeRecord,
  encodeSafeMeta,
  safeTransactionDigest,
} from '@msgboard/cosign'
import { cosignCategories } from '../src/lib/cosign-feed'
import type { SafeReader } from '../src/components/Cosign'

/**
 * The Cosign tab.
 *
 * The test builds a REAL fleet session: a benign Safe self-call, its canonical EIP-712 digest, and
 * two owner signatures over that digest, all wire-encoded with the actual `@msgboard/cosign` codecs.
 * A fake `fetch` serves them as archive rows and a fake `SafeReader` returns the owner set, so the
 * component runs its real decode, recover and quorum path with no network, no worker and no wallet.
 */

const CHAIN_ID = 943
const SAFE = '0x67D4FBA30DFeFb1AA2d199c33e239dc6BCAfF705' as Hex
const ZERO = '0x0000000000000000000000000000000000000000' as Hex

const ownerA = privateKeyToAccount(('0x' + '11'.repeat(32)) as Hex)
const ownerB = privateKeyToAccount(('0x' + '22'.repeat(32)) as Hex)
const ownerC = privateKeyToAccount(('0x' + '33'.repeat(32)) as Hex)
const stranger = privateKeyToAccount(('0x' + '44'.repeat(32)) as Hex)

/** The benign self-call the fleet proposes each session: zero value, empty calldata. */
const benignTx: SafeTx = {
  to: SAFE,
  value: 0n,
  data: '0x',
  operation: 0,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: ZERO,
  refundReceiver: ZERO,
  nonce: 0n,
}
const DIGEST = safeTransactionDigest(benignTx, CHAIN_ID, SAFE)
const META = encodeSafeMeta(benignTx, SAFE, CHAIN_ID)

async function share(account: typeof ownerA): Promise<SignatureRecord> {
  return {
    digest: DIGEST,
    signer: account.address,
    signature: await account.sign({ hash: DIGEST }),
    scheme: SCHEME.EIP712,
    meta: META,
  }
}

/** A fake `fetch` that serves the given records as archive rows under today's category. */
function archiveServing(records: SignatureRecord[]): typeof fetch {
  const category = cosignCategories({ chainId: CHAIN_ID, safe: SAFE, days: 1 })[0]!
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          message_archive: records.map((record, i) => ({
            category,
            data: encodeRecord(record),
            block_number: 25_331_298 - i,
            first_seen_at: `2026-09-07T1${i}:00:00+00:00`,
          })),
        },
      }),
    }) as unknown as Response) as unknown as typeof fetch
}

const readsSafe =
  (threshold: number): SafeReader =>
  async () => ({ owners: [ownerA.address, ownerB.address, ownerC.address], threshold, nonce: 0n })

const failingSafeReader: SafeReader = async () => {
  throw new Error('rpc unreachable')
}

async function seedChain({ chainOption }: { chainOption: string }) {
  const { useChainStore } = await import('../src/stores/chain')
  useChainStore.setState({
    chainOption: chainOption as never,
    customRpcUrl: '',
    forceProxy: false,
    content: {},
  })
}

/**
 * jsdom implements no scrolling, so `Element.scrollIntoView` is missing. The house `Menu` calls it
 * to keep the highlighted option in view. Supply a no-op so opening a menu under test does not
 * throw; every real browser ships the method.
 */
beforeEach(async () => {
  localStorage.clear()
  cleanup()
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
  await seedChain({ chainOption: 'pulsechainV4' })
})

afterEach(() => cleanup())

describe('Cosign — the landing tab', () => {
  it('lists the live co-signature feed and marks each share verified', async () => {
    const { Cosign } = await import('../src/components/Cosign')
    const records = [await share(ownerA), await share(ownerB)]
    render(<Cosign fetchImpl={archiveServing(records)} safeReader={readsSafe(2)} />)

    const feed = await screen.findByLabelText('co-signature feed')
    expect(feed.querySelectorAll('li')).toHaveLength(2)
    expect(feed.textContent).toContain(ownerA.address.slice(0, 6))
    expect(feed.textContent).toContain(ownerB.address.slice(0, 6))
    expect(feed.textContent).toContain('EIP-712')
  })

  it('walks the session to a met 2-of-3 threshold', async () => {
    const { Cosign } = await import('../src/components/Cosign')
    const records = [await share(ownerA), await share(ownerB)]
    render(<Cosign fetchImpl={archiveServing(records)} safeReader={readsSafe(2)} />)

    expect(await screen.findByText(/2 of 2 required owners signed/i)).toBeTruthy()
    expect(await screen.findByText(/the quorum is met/i)).toBeTruthy()
    // Every one of the three owner slots renders; two of them carry a signature.
    expect(await screen.findByText(new RegExp(ownerC.address.slice(0, 6)))).toBeTruthy()
  })

  it('leaves the quorum open below the threshold', async () => {
    const { Cosign } = await import('../src/components/Cosign')
    render(<Cosign fetchImpl={archiveServing([await share(ownerA)])} safeReader={readsSafe(2)} />)

    expect(await screen.findByText(/1 of 2 required owners signed/i)).toBeTruthy()
    expect(await screen.findByText(/the quorum is still open/i)).toBeTruthy()
  })

  it('shows a non-owner signature in the feed but never counts it', async () => {
    const { Cosign } = await import('../src/components/Cosign')
    const records = [await share(ownerA), await share(stranger)]
    render(<Cosign fetchImpl={archiveServing(records)} safeReader={readsSafe(2)} />)

    const feed = await screen.findByLabelText('co-signature feed')
    expect(feed.querySelectorAll('li')).toHaveLength(2)
    expect(await screen.findByText(/1 of 2 required owners signed/i)).toBeTruthy()
    expect(await screen.findByText(/came from a non-owner and never counts/i)).toBeTruthy()
  })

  it('says the owner set is unknown when the Safe read fails, rather than inventing a quorum', async () => {
    const { Cosign } = await import('../src/components/Cosign')
    render(<Cosign fetchImpl={archiveServing([await share(ownerA)])} safeReader={failingSafeReader} />)

    await screen.findByLabelText('co-signature feed')
    expect(await screen.findByText(/owner membership is unknown/i)).toBeTruthy()
    expect(screen.queryByText(/required owners signed/i)).toBeNull()
  })

  it('says so honestly when the archive is unreachable', async () => {
    const { Cosign } = await import('../src/components/Cosign')
    const broken = (async () => ({ ok: false, status: 502, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch
    render(<Cosign fetchImpl={broken} safeReader={readsSafe(2)} />)

    expect(await screen.findByText(/502/)).toBeTruthy()
    expect(screen.queryByLabelText('co-signature feed')).toBeNull()
  })

  it('picks the feed window through the house Menu, never a native select', async () => {
    const { Cosign } = await import('../src/components/Cosign')
    render(<Cosign fetchImpl={archiveServing([await share(ownerA)])} safeReader={readsSafe(2)} />)

    await screen.findByLabelText('co-signature feed')
    expect(document.querySelector('select')).toBeNull()
    expect(document.querySelector('input[type=checkbox]')).toBeNull()

    const trigger = screen.getByRole('button', { name: 'feed window' })
    expect(trigger.textContent).toContain('Last 3 days')
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('option', { name: 'Last 7 days' }))
    expect(screen.getByRole('button', { name: 'feed window' }).textContent).toContain('Last 7 days')
  })

  it('degrades honestly on a chain the fleet runs no Safe on', async () => {
    await seedChain({ chainOption: 'ethereum' })
    const { Cosign } = await import('../src/components/Cosign')
    render(<Cosign fetchImpl={archiveServing([])} safeReader={readsSafe(2)} />)

    expect(await screen.findByText(/No demo Safe runs on chain 1 yet/i)).toBeTruthy()
    expect(screen.queryByLabelText('co-signature feed')).toBeNull()
    const link = screen.getByRole('link', { name: /open the full app/i })
    expect(link.getAttribute('href')).toBe('https://cosign.msgboard.xyz')
  })
})
