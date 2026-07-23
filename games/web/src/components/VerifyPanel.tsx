import * as viem from 'viem'
import { verifyCoinFlip, verifyRaffle } from '../model/verify'
import type { FlipView } from '../model/coinflip-lobby'
import type { RaffleRoundView } from '../model/raffle-rounds'
import type { GameDeployment } from '../config'
import { explorerUrl, InfoDot, MSGBOARD_GAMES_DOCS } from './Meta'

/**
 * The product centerpiece: the cross-layer parity assertion as UI. The off-chain settle —
 * the exact code the e2e suite proved equals the contract — recomputes the winner from the
 * seed and entries, and the panel says on the level or crooked. A player never has to take
 * the contract's word for it.
 */

const Badge = ({ matches }: { matches: boolean }) =>
  matches ? (
    <span className="stamp ok">✓ on the level — matches the chain</span>
  ) : (
    <span className="stamp bad">✗ crooked — does not match the chain</span>
  )

const SlipHeader = ({ deployment, game }: { deployment: GameDeployment; game: viem.Hex }) => {
  const gameUrl = explorerUrl(deployment, 'address', game)
  const randomUrl = explorerUrl(deployment, 'address', deployment.random)
  return (
    <h3>
      The slip — run the numbers yourself
      <InfoDot>
        This slip is your browser doing the count, not ours: it recomputes the result from the seed and compares it
        with what the{' '}
        {gameUrl ? (
          <a href={gameUrl} target="_blank" rel="noreferrer">
            game contract
          </a>
        ) : (
          'game contract'
        )}{' '}
        paid out. The seed itself is set by the{' '}
        {randomUrl ? (
          <a href={randomUrl} target="_blank" rel="noreferrer">
            Random contract
          </a>
        ) : (
          'Random contract'
        )}{' '}
        from the validators' revealed secrets. How to re-run this count by hand is written up{' '}
        <a href={MSGBOARD_GAMES_DOCS} target="_blank" rel="noreferrer">
          on MsgBoard
        </a>
        .
      </InfoDot>
    </h3>
  )
}

const TxRow = ({ deployment, label, tx }: { deployment: GameDeployment; label: string; tx?: viem.Hex }) => {
  if (!tx) return null
  const url = explorerUrl(deployment, 'tx', tx)
  return (
    <tr>
      <td className="muted">{label}</td>
      <td className="mono">
        {url ? (
          <a href={url} target="_blank" rel="noreferrer">
            {tx}
          </a>
        ) : (
          tx
        )}
      </td>
    </tr>
  )
}

export const CoinFlipVerifyPanel = ({ flip, deployment }: { flip: FlipView; deployment: GameDeployment }) => {
  if (flip.status !== 'settled' || !flip.seed || !flip.winner) return null
  const verification = verifyCoinFlip({
    seed: flip.seed,
    heads: flip.heads,
    tails: flip.tails,
    onChainWinner: flip.winner,
  })
  return (
    <div className="receipt">
      <SlipHeader deployment={deployment} game={deployment.coinFlip} />
      <table>
        <tbody>
          <tr>
            <td className="muted">seed (keccak of the validators' secrets)</td>
            <td className="mono">{flip.seed}</td>
          </tr>
          <tr>
            <td className="muted">our count: seed is {verification.winningSide === 'heads' ? 'even' : 'odd'} →</td>
            <td className="mono">
              {verification.winningSide} — {verification.offChainWinner}
            </td>
          </tr>
          <tr>
            <td className="muted">the chain's winner</td>
            <td className="mono">{flip.winner}</td>
          </tr>
          <TxRow deployment={deployment} label="settling tx" tx={flip.settleTx} />
        </tbody>
      </table>
      <Badge matches={verification.matches} />
    </div>
  )
}

export const RaffleVerifyPanel = ({
  round,
  seed,
  deployment,
}: {
  round: RaffleRoundView
  seed?: viem.Hex
  deployment: GameDeployment
}) => {
  if (!seed || round.draw === undefined) return null
  const entries = round.tickets
    .filter((t) => !t.cancelled)
    .map((t) => ({
      ticketId: t.ticketId,
      player: t.player,
      guess: t.guess ?? 0n,
      committedAtBlock: t.committedAtBlock,
      revealed: t.revealed,
    }))
  const onChainBest = round.tickets.find((t) => t.leading)?.ticketId ?? 0n
  const verification = verifyRaffle({ seed, entries, onChainBestTicket: onChainBest })
  return (
    <div className="receipt">
      <SlipHeader deployment={deployment} game={deployment.raffle} />
      <table>
        <tbody>
          <tr>
            <td className="muted">seed</td>
            <td className="mono">{seed}</td>
          </tr>
          <tr>
            <td className="muted">our count: 1 + (seed mod 256)</td>
            <td>{verification.draw.toString()}</td>
          </tr>
          <tr>
            <td className="muted">our winning ticket (closest revealed guess)</td>
            <td>{verification.offChainTicket?.toString() ?? 'none revealed yet'}</td>
          </tr>
          <tr>
            <td className="muted">the chain's leading ticket</td>
            <td>{onChainBest === 0n ? 'none yet' : onChainBest.toString()}</td>
          </tr>
          <TxRow deployment={deployment} label="drawing tx" tx={round.drawTx} />
          <TxRow deployment={deployment} label="payout tx" tx={round.finaliseTx} />
        </tbody>
      </table>
      <Badge matches={verification.matches} />
    </div>
  )
}
