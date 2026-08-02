import * as viem from 'viem'
import { cardName } from '@msgboard/games'

/** A fresh random 256-bit deck seed (the house). The commit is keccak(seed); cards are revealed
 *  incrementally and the seed is disclosed at settlement so the player can re-check the whole hand. */
export const randomDeckSeed = (): bigint =>
  viem.hexToBigInt(viem.bytesToHex(crypto.getRandomValues(new Uint8Array(32))))

/** Render a card index as a real playing-card face; red for hearts/diamonds. `big` = foreground
 *  hand size, `dim` = a settled/secondary card (e.g. the dealer row in a history receipt). */
export const Card = ({ index, big, dim }: { index: number; big?: boolean; dim?: boolean }) => {
  const name = cardName(index) // e.g. "10♥", "A♠", "K♦"
  const suit = name.slice(-1)
  const rank = name.slice(0, -1)
  const red = suit === '♥' || suit === '♦'
  return (
    <span
      className={`playcard${big ? ' big' : ''}${red ? ' red' : ''}`}
      style={dim ? { opacity: 0.5 } : undefined}
      aria-label={name}
    >
      <span className="corner">
        {rank}
        <br />
        {suit}
      </span>
      <span className="pip">{suit}</span>
    </span>
  )
}

/** A face-down card — the ◈-sealed back (committed, not yet revealed). */
export const CardBack = ({ big }: { big?: boolean }) => (
  <span className={`playcard back${big ? ' big' : ''}`} aria-label="face-down card" />
)

export const fmtMultD = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`
