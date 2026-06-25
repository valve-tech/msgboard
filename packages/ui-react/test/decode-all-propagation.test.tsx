import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

beforeEach(() => {
  localStorage.clear()
  cleanup()
})

/**
 * Task-4 review carry-forward: flipping "decode all" in Summary must propagate live to the
 * already-mounted TreeView nodes (a global re-render), not only re-render the toggle itself.
 */
describe('decode-all live propagation (Summary → TreeView)', () => {
  it('toggling decode-all re-renders sibling TreeView nodes', async () => {
    const { Summary } = await import('../src/components/Summary')
    const { TreeView, decodeAll } = await import('../src/components/TreeView')
    const { stringToHex } = await import('viem')

    decodeAll.value = false
    // a category that does NOT auto-decode (only `gasmoneyplease` defaults to decoded), so the
    // visible change is driven purely by the decode-all toggle
    const word = 'cosignplease'
    const catHex = stringToHex(word, { size: 32 })
    render(
      <div>
        <Summary />
        <TreeView label={catHex} decodable />
      </div>,
    )

    // with decode-all OFF, the leaf shows the raw hex
    expect(screen.getByText(catHex)).toBeTruthy()

    // flip decode-all in the Summary toggle (the first switch; the second is the leaf's own)
    const toggle = screen.getAllByRole('switch')[0]
    fireEvent.click(toggle)

    // the TreeView leaf must now show the decoded text — a LIVE cross-node update.
    // (the hex is zero-padded, so the decoded value starts with the word + trailing NULs)
    expect(await screen.findByText((content) => content.startsWith(word))).toBeTruthy()
    // and the raw hex is no longer shown
    expect(screen.queryByText(catHex)).toBeNull()
  })
})
