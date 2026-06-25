import { Icon } from '@iconify/react'
import { Footer } from '../components/Footer'
import { SideToc } from '../components/SideToc'
import { GamesLiveProof } from '../components/GamesLiveProof'

const sections = [
  { id: 'live-proof', label: 'Live proof' },
  { id: 'what-it-is', label: 'What it is' },
  { id: 'trust-model', label: 'The trust model' },
  { id: 'how-a-draw-works', label: 'How a draw works' },
  { id: 'why-fees-stay-low', label: 'Why fees stay low' },
  { id: 'verify-it-yourself', label: 'Verify it yourself' },
  { id: 'where-it-runs', label: 'Where it runs' },
]

const explorer = 'https://scan.v4.testnet.pulsechain.com/#'
const explorerMain = 'https://scan.pulsechain.com/#'
// prefilled archive query for the venue's settlement notices (category msgboard-games)
const archiveTrail = `https://archive.msgboard.xyz/?query=${encodeURIComponent(
  '{\n  message_archive(\n    where: { chain_id: { _eq: 943 }, category_text: { _eq: "msgboard-games" } }\n    order_by: { first_seen_at: desc }\n    limit: 50\n  ) {\n    category_text\n    data_text\n    block_number\n    first_seen_at\n  }\n}',
)}`
const contracts = [
  { label: 'CoinFlip', address: '0x8d3a58d77d22636026066200f8868cd653ec2b2a' },
  { label: 'Raffle (the numbers)', address: '0x33f506fafe4f05c8de9a07e1c8a7f73f50f1da36' },
  { label: 'Random (validator entropy)', address: '0x775AF72d62c85d2F7f0Bcc05BAa4Be0830087217' },
]
const contractsMain = [
  { label: 'CoinFlip', address: '0x66bdacfdd918f9d4c29f0a7d26609912ab478f4d' },
  { label: 'Raffle (the numbers)', address: '0x004564d44E6921FFA68936F44ae58988Cd146b10' },
  { label: 'Random (validator entropy)', address: '0x87fc31413534733a09df5dc5aa33b4dba1f64b61' },
]

function ContractTable({
  rows,
  explorerUrl,
}: {
  rows: { label: string; address: string }[]
  explorerUrl: string
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Contract</th>
          <th>Address</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.address}>
            <td>{c.label}</td>
            <td>
              <a
                href={`${explorerUrl}/address/${c.address}`}
                target="_blank"
                rel="noopener noreferrer">
                <code>{c.address}</code>
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Ported from `pages/Games.svelte` — the venue fairness explainer + live proof. */
export function Games() {
  return (
    <>
      <SideToc sections={sections} />

      <div className="relative overflow-hidden w-full text-white" style={{ background: '#0b2014' }}>
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(60% 55% at 50% 0%, rgba(224,168,52,0.18), transparent 70%)',
          }}
        />
        <div className="relative m-auto flex w-full max-w-3xl flex-col items-center gap-4 px-5 py-12 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-amber-400/10 ring-1 ring-amber-400/40">
            <Icon icon="mdi:cards-playing-outline" className="size-7 text-amber-400" />
          </div>
          <h1 className="text-3xl font-bold sm:text-5xl">
            MsgBoard{' '}
            <span className="bg-gradient-to-br from-amber-200 via-amber-400 to-orange-500 bg-clip-text text-transparent">
              Games
            </span>
          </h1>
          <p className="max-w-xl text-sm font-light text-gray-300 sm:text-lg">
            A provably fair venue, supercharged by MsgBoard — live on PulseChain mainnet and testnet
            v4. Coin flips and a numbers game where every draw can be re-checked in your own browser
            — no trust-me odds. Don't take this page's word for it either: it just did the check,
            live, below.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
            <a
              href="https://games.msgboard.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full bg-amber-400 px-6 py-2.5 text-sm font-semibold text-gray-950 shadow-lg shadow-amber-500/20 transition hover:bg-amber-300">
              Enter the venue →
            </a>
            <a
              href="#/"
              className="rounded-full px-5 py-2.5 text-sm text-gray-300 ring-1 ring-white/15 transition hover:text-white hover:ring-white/30">
              ← Back to home
            </a>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-4 py-12 text-slate-800 dark:text-gray-200">
        <section id="live-proof" className="scroll-mt-16">
          <GamesLiveProof />
        </section>

        <article className="games-prose">
          <h2 id="what-it-is" className="scroll-mt-16">
            What it is
          </h2>
          <p>
            <a href="https://games.msgboard.xyz" target="_blank" rel="noopener noreferrer">
              games.msgboard.xyz
            </a>{' '}
            is a small on-chain casino with two tables: a <strong>coin flip</strong> (pick a side
            and a stake, get paired with an opponent at the same stake, winner takes the pot) and{' '}
            <strong>the numbers</strong> (a raffle: set a ticket price and a player count, commit a
            hidden guess from 1–256, the closest revealed guess to the draw takes the pot). The
            venue is run by valve and supercharged by MsgBoard.
          </p>
          <p>
            The point of the venue is the fairness story: <em>nobody can cook the draw</em> — not
            the house, not the player across the table, not MsgBoard, and not the website. Every
            game settles from validator entropy with the receipts to prove it — the block above is
            this page re-checking the latest one in your browser.
          </p>

          <h2 id="trust-model" className="scroll-mt-16">
            The trust model
          </h2>
          <p>
            Every draw is decided by secrets held by a set of <strong>validators</strong> —
            independent parties who commit hashed secrets on chain <em>before</em> anyone plays. The
            guarantee is:
          </p>
          <ul>
            <li>
              <strong>A draw is safe as long as at least one chosen validator is honest.</strong> If
              every validator colluded they could grind the result; if even one is honest, nobody
              can.
            </li>
            <li>
              The contracts <strong>pin the validator set when you enter</strong>, so it cannot be
              swapped afterwards.
            </li>
            <li>
              <strong>Anyone can contribute randomness.</strong> The validator set is open — a
              player, a stranger, or even the house can ink secrets and join the entropy. Don't
              trust anybody on the list? Add yourself: if the honest validator is <em>you</em>, the
              draw is safe for you by construction.
            </li>
            <li>
              The house never holds a secret that decides an outcome, and the website only reads the
              chain — it has nothing to tamper with.
            </li>
          </ul>

          <h2 id="how-a-draw-works" className="scroll-mt-16">
            How a draw works
          </h2>
          <ol>
            <li>
              <strong>Secrets go in before the action.</strong> Validators "ink" pools of hashed
              secrets (preimage commitments) on chain ahead of time. When you enter a game, your
              entry pins specific slots from those pools.
            </li>
            <li>
              <strong>The game heats the validators.</strong> Once a flip is paired or a raffle
              round arms, the pinned preimages are requested ("heated"). Each validator reveals the
              secret behind its hash.
            </li>
            <li>
              <strong>The reveal is the draw.</strong> The seed is the keccak hash of all revealed
              secrets together. A coin flip settles on the seed's parity; the numbers draw is{' '}
              <code>1 + (seed mod 256)</code> and the closest revealed guess wins. Both are pure
              functions of the seed — there is no step where anyone chooses an outcome.
            </li>
          </ol>
          <p>
            The raffle uses a commit–reveal scheme on the player side too: your guess stays hidden
            (salted hash) until the draw lands, so nobody can snipe your number or front-run your
            reveal.
          </p>

          <h2 id="why-fees-stay-low" className="scroll-mt-16">
            Why fees stay low
          </h2>
          <p>
            Keeping a validator network coordinated usually costs gas, and that cost leaks into the
            odds. Here the validators coordinate over <a href="#/">MsgBoard</a>, where a message
            costs a <strong>proof-of-work stamp</strong> instead of a fee — no gas, no token, no
            account. The entropy pipeline runs at near-zero overhead, so you aren't bled dry by fees
            to keep the games supplied with randomness.
          </p>
          <p>
            Every settlement leaves a compact notice on the board (category{' '}
            <code>msgboard-games</code>) —{' '}
            <a href={archiveTrail} target="_blank" rel="noopener noreferrer">
              browse the trail in the archive
            </a>
            . And because the coordination layer is free, a chain whose gas vault runs dry doesn't
            break anything: the tables on that chain simply <strong>pause</strong>, the validators
            keep talking on MsgBoard for nothing, and play resumes the moment the vault is refilled.
          </p>

          <h2 id="verify-it-yourself" className="scroll-mt-16">
            Verify it yourself
          </h2>
          <p>
            Every settled game on the site comes with a <strong>slip</strong>: your browser
            re-computes the outcome from the on-chain seed — the same math the contracts run — and
            stamps the result <em>on the level</em> if it matches what the chain paid out, or{' '}
            <em>crooked</em> if it doesn't. The verification code runs client-side; you never have
            to take the site's word for it. The live block at the top of this page is exactly that
            check, running against the venue's latest settled flip.
          </p>
          <p>
            Every card also carries its provenance: real block timestamps plus links to the exact
            transactions and blocks on the public explorer. The source of record is the chain itself
            — this page is just the playbook for reading it.
          </p>

          <h2 id="where-it-runs" className="scroll-mt-16">
            Where it runs
          </h2>
          <p>
            <strong>PulseChain mainnet</strong> (chain id 369) — live with real PLS. The house bots
            here are deliberately sparing (a self-initiated game roughly every six hours), but they
            always pair a waiting human promptly; and when the chain's gas vault runs low the tables
            pause rather than drain. The bring-up was verified the same way every game is: a full
            coin flip and raffle settled on chain with off-chain parity checks. The mainnet
            contracts:
          </p>
          <ContractTable rows={contractsMain} explorerUrl={explorerMain} />
          <p>
            <strong>PulseChain testnet v4</strong> (chain id 943) — free play money from the faucet,
            no real stakes, and livelier bots, so there is always action to watch, pair against, and
            verify. The testnet contracts:
          </p>
          <ContractTable rows={contracts} explorerUrl={explorer} />
          <p>
            Source:{' '}
            <a
              href="https://github.com/gibsfinance/random"
              target="_blank"
              rel="noopener noreferrer">
              contracts
            </a>{' '}
            ·{' '}
            <a
              href="https://github.com/valve-tech/msgboard"
              target="_blank"
              rel="noopener noreferrer">
              msgboard
            </a>
            . Want to watch a draw settle right now?{' '}
            <a href="https://games.msgboard.xyz" target="_blank" rel="noopener noreferrer">
              Pull up a chair
            </a>
            .
          </p>
        </article>
      </div>

      <Footer />
    </>
  )
}
