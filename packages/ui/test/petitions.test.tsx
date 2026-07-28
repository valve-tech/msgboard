import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
 * The sign flow itself needs a deployed PetitionSignatures verifier per chain, which does not exist
 * yet for any chain (`@msgboard/petition`'s `deployments` map is still empty and no
 * `VITE_PETITION_ADDR_*` is set) — so the honest-degrade path (no wallet/connect UI, an explanatory
 * message instead) is exactly what today's default state exercises, and is asserted here too.
 */

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
    expect(screen.getByText(/1 signed/i)).toBeTruthy()
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
