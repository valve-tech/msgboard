import { describe, expect, it, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { SignatureRecord } from '@msgboard/cosign'
import { SCHEME } from '@msgboard/cosign'
import { derivePetitionId, petitionDigest, type Petition } from '@msgboard/petition'
import { VerifyPanel } from './VerifyPanel.js'

afterEach(cleanup)

const signerPk = ('0x' + '11'.repeat(32)) as Hex
const signerAccount = privateKeyToAccount(signerPk)
const salt = ('0x' + '22'.repeat(32)) as Hex
const verifyingContract = '0x3333333333333333333333333333333333333333' as Hex

function makePetition(statement: string): Petition {
  return {
    id: derivePetitionId(statement, signerAccount.address, salt),
    statement,
    creator: signerAccount.address,
    createdAt: 1_753_700_000,
    chainId: 369,
    salt,
  }
}

async function signFor(p: Petition): Promise<SignatureRecord> {
  const digest = petitionDigest(p, verifyingContract)
  const signature = await signerAccount.sign({ hash: digest })
  return { digest, signer: signerAccount.address, signature, scheme: SCHEME.EIP712, meta: '0x' }
}

describe('VerifyPanel', () => {
  it('recomputes a valid captured signature and counts it as verified', async () => {
    const petition = makePetition('Save the park')
    const record = await signFor(petition)

    render(<VerifyPanel petition={petition} verifyingContract={verifyingContract} records={[record]} />)

    await waitFor(() => expect(screen.getByText('1 verified')).toBeTruthy())
    expect(screen.queryByText(/failed verification/)).toBeNull()
  })

  it('shows a mismatch when the petition statement was tampered after signing', async () => {
    const original = makePetition('Save the park')
    const record = await signFor(original)
    // the petition shown to the panel has a DIFFERENT statement than what was actually signed —
    // e.g. a captured descriptor was reposted/edited. The digest no longer matches.
    const tampered: Petition = { ...original, statement: 'Bulldoze the park' }

    render(<VerifyPanel petition={tampered} verifyingContract={verifyingContract} records={[record]} />)

    await waitFor(() => expect(screen.getByText('0 verified')).toBeTruthy())
    expect(screen.getByText(/1 captured signature failed verification/)).toBeTruthy()
  })

  it('dedupes a signer who verifies twice into a single verified count', async () => {
    const petition = makePetition('Save the park')
    const record = await signFor(petition)

    render(<VerifyPanel petition={petition} verifyingContract={verifyingContract} records={[record, record]} />)

    await waitFor(() => expect(screen.getByText('1 verified')).toBeTruthy())
  })
})
