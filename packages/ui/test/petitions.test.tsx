import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { Hex } from 'viem'
import { type Petition, derivePetitionId, encodePetition, PETITION_NS, INDEX_SCOPE, signScope } from '@msgboard/petition'
import { categoryKey, currentKey, isoDay, encodeRecord, SCHEME, type SignatureRecord } from '@msgboard/cosign'
import type { Content } from '@msgboard/sdk'

/**
 * Petitions widget — the landing teaser.
 *
 * These tests seed the app-wide `content` cache directly (the same 20s-polled snapshot every other
 * tab reads from) with a real petition descriptor + one real signature record, both wire-encoded via
 * the actual `@msgboard/petition`/`@msgboard/cosign` codecs — no network, no worker, no wallet. This
 * exercises the REAL `readPetitions` → `readPetitionSignatures` → `tally` pipeline the component runs
 * over that cache, not a re-implementation of it.
 *
 * The sign flow needs a deployed PetitionSignatures verifier for the chain. This file asserts the
 * honest-degrade path taken when there is none: no wallet or connect UI, an explanatory message
 * instead.
 *
 * That path is FORCED here rather than assumed. It used to rely on `@msgboard/petition`'s
 * `deployments` map being empty, and went red the day a verifier landed on 943 (2026-07-28) —
 * the test broke on a deployment, which is not a defect it should be reporting. The mock below
 * keeps every real codec and removes only the deployment, so the premise is the test's to set.
 */
vi.mock('@msgboard/petition', async (importActual) => ({
  ...(await importActual<typeof import('@msgboard/petition')>()),
  deployments: {},
}))

const CHAIN_ID = 943
const CREATOR = ('0x' + 'ab'.repeat(20)) as Hex
const SALT = ('0x' + '22'.repeat(32)) as Hex
const STATEMENT = 'We petition the board to keep messages free and permissionless.'

function seededContent(): { indexCategory: Hex; sigCategory: Hex; petition: Petition; content: Content } {
  const petition: Petition = {
    id: derivePetitionId(STATEMENT, CREATOR, SALT),
    statement: STATEMENT,
    creator: CREATOR,
    createdAt: Math.floor(Date.now() / 1000),
    chainId: CHAIN_ID,
    salt: SALT,
  }
  const indexCategory = categoryKey(PETITION_NS, INDEX_SCOPE, isoDay(new Date()))
  const sigCategory = currentKey(PETITION_NS, signScope(petition.id))
  const record: SignatureRecord = {
    digest: ('0x' + '11'.repeat(32)) as Hex,
    signer: ('0x' + 'cd'.repeat(20)).toLowerCase() as Hex,
    signature: ('0x' + '99'.repeat(65)) as Hex,
    scheme: SCHEME.EIP712,
    meta: '0x',
  }
  const content = {
    [indexCategory]: [{ data: encodePetition(petition) }],
    [sigCategory]: [{ data: encodeRecord(record) }],
  } as unknown as Content
  return { indexCategory, sigCategory, petition, content }
}

beforeEach(async () => {
  localStorage.clear()
  cleanup()
  const { useChainStore } = await import('../src/stores/chain')
  const { content } = seededContent()
  useChainStore.setState({ chainOption: 'pulsechainV4', customRpcUrl: '', forceProxy: false, content })
})

afterEach(() => cleanup())

describe('Petitions — landing widget', () => {
  it('renders the featured petition + its captured (posted, unverified) count from the board cache', async () => {
    const { Petitions } = await import('../src/components/Petitions')
    render(<Petitions />)

    await screen.findByText(new RegExp(STATEMENT))
    expect(await screen.findByText(/posted, unverified/i)).toBeTruthy()
    expect(await screen.findByText(/1 signed/i)).toBeTruthy()
  })

  it('links out to the full app', async () => {
    const { Petitions } = await import('../src/components/Petitions')
    render(<Petitions />)

    await screen.findByText(new RegExp(STATEMENT))
    const link = screen.getByRole('link', { name: /open the full app/i })
    expect(link.getAttribute('href')).toBe('https://petition.msgboard.xyz')
  })

  it('degrades honestly when no verifier is deployed on this chain (no deployments configured)', async () => {
    const { Petitions } = await import('../src/components/Petitions')
    render(<Petitions />)

    await screen.findByText(new RegExp(STATEMENT))
    expect(screen.queryByRole('button', { name: /connect wallet/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /sign this petition/i })).toBeNull()
    expect(await screen.findByText(/no petitionsignatures verifier is deployed/i)).toBeTruthy()
  })
})
