import * as viem from 'viem'
import { cardName } from '@msgboard/games'

/** A fresh random 256-bit deck seed (the house). The commit is keccak(seed); cards are revealed
 *  incrementally and the seed is disclosed at settlement so the player can re-check the whole hand. */
export const randomDeckSeed = (): bigint =>
  viem.hexToBigInt(viem.bytesToHex(crypto.getRandomValues(new Uint8Array(32))))

/** Render a card index as a chip; red for hearts/diamonds. */
export const Card = ({ index, dim }: { index: number; dim?: boolean }) => {
  const name = cardName(index)
  const red = name.includes('♥') || name.includes('♦')
  return (
    <span
      className="tag mono"
      style={{ fontSize: '1.1rem', padding: '0.3rem 0.5rem', opacity: dim ? 0.5 : 1, color: red ? '#d44' : undefined }}
    >
      {name}
    </span>
  )
}

/** A face-down card placeholder (hidden until revealed). */
export const CardBack = () => (
  <span className="tag mono" style={{ fontSize: '1.1rem', padding: '0.3rem 0.5rem', opacity: 0.7 }}>🂠</span>
)

export const fmtMultD = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`
