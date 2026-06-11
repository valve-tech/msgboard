<script lang="ts">
  import Icon from '@iconify/svelte'
  import Footer from '../components/Footer.svelte'
  import SideToc from '../components/SideToc.svelte'

  const sections = [
    { id: 'what-it-is', label: 'What it is' },
    { id: 'trust-model', label: 'The trust model' },
    { id: 'how-a-draw-works', label: 'How a draw works' },
    { id: 'verify-it-yourself', label: 'Verify it yourself' },
    { id: 'testnet-status', label: 'Testnet status' },
  ]

  const explorer = 'https://scan.v4.testnet.pulsechain.com/#'
  const contracts = [
    { label: 'CoinFlip', address: '0x8d3a58d77d22636026066200f8868cd653ec2b2a' },
    { label: 'Raffle (the numbers)', address: '0x33f506fafe4f05c8de9a07e1c8a7f73f50f1da36' },
    { label: 'Random (validator entropy)', address: '0x775AF72d62c85d2F7f0Bcc05BAa4Be0830087217' },
  ]
</script>

<SideToc {sections} />

<!-- felt-table header, echoing the venue's own card-room look -->
<div class="relative overflow-hidden w-full text-white" style="background: #0b2014">
  <div
    class="pointer-events-none absolute inset-0"
    style="background: radial-gradient(60% 55% at 50% 0%, rgba(224,168,52,0.18), transparent 70%)">
  </div>
  <div class="relative m-auto flex w-full max-w-3xl flex-col items-center gap-4 px-5 py-12 text-center">
    <div class="grid size-12 place-items-center rounded-full bg-amber-400/10 ring-1 ring-amber-400/40">
      <Icon icon="mdi:cards-playing-outline" class="size-7 text-amber-400" />
    </div>
    <h1 class="text-3xl font-bold sm:text-5xl">
      MsgBoard <span class="bg-gradient-to-br from-amber-200 via-amber-400 to-orange-500 bg-clip-text text-transparent">Games</span>
    </h1>
    <p class="max-w-xl text-sm font-light text-gray-300 sm:text-lg">
      A provably fair venue running on MsgBoard. Coin flips and a numbers game where every draw
      can be re-checked in your own browser — no trust-me odds.
    </p>
    <div class="flex flex-wrap items-center justify-center gap-3 pt-1">
      <a
        href="https://games.msgboard.xyz"
        target="_blank"
        rel="noopener noreferrer"
        class="rounded-full bg-amber-400 px-6 py-2.5 text-sm font-semibold text-gray-950 shadow-lg shadow-amber-500/20 transition hover:bg-amber-300">
        Enter the venue →
      </a>
      <a
        href="#/"
        class="rounded-full px-5 py-2.5 text-sm text-gray-300 ring-1 ring-white/15 transition hover:text-white hover:ring-white/30">
        ← Back to home
      </a>
    </div>
  </div>
</div>

<div class="mx-auto max-w-3xl px-4 py-12 text-slate-800 dark:text-gray-200">
  <article class="games-prose">
    <h2 id="what-it-is" class="scroll-mt-16">What it is</h2>
    <p>
      <a href="https://games.msgboard.xyz" target="_blank" rel="noopener noreferrer">games.msgboard.xyz</a>
      is a small on-chain casino with two tables: a <strong>coin flip</strong> (pick a side, get paired with
      an opponent at the same stake, winner takes the pot) and <strong>the numbers</strong> (a raffle: commit
      a hidden guess from 1–256, the closest revealed guess to the draw takes the pot). It runs as a venue on
      the MsgBoard platform — MsgBoard and valve run the show; the randomness contracts are by
      <a href="https://github.com/gibsfinance/random" target="_blank" rel="noopener noreferrer">gibs.finance</a>.
    </p>
    <p>
      The point of the venue is the fairness story: <em>nobody can cook the draw</em> — not the house, not the
      player across the table, not MsgBoard, and not the website. Every game settles from validator entropy
      with the receipts to prove it.
    </p>

    <h2 id="trust-model" class="scroll-mt-16">The trust model</h2>
    <p>
      Every draw is decided by secrets held by a set of <strong>validators</strong> — independent parties who
      commit hashed secrets on chain <em>before</em> anyone plays. The guarantee is:
    </p>
    <ul>
      <li>
        <strong>A draw is safe as long as at least one chosen validator is honest.</strong> If every validator
        colluded they could grind the result; if even one is honest, nobody can.
      </li>
      <li>
        The contracts <strong>pin the validator set when you enter</strong>, so it cannot be swapped afterwards.
      </li>
      <li>
        The house never holds a secret that decides an outcome, and the website only reads the chain — it has
        nothing to tamper with.
      </li>
    </ul>

    <h2 id="how-a-draw-works" class="scroll-mt-16">How a draw works</h2>
    <ol>
      <li>
        <strong>Secrets go in before the action.</strong> Validators "ink" pools of hashed secrets
        (preimage commitments) on chain ahead of time. When you enter a game, your entry pins specific
        slots from those pools.
      </li>
      <li>
        <strong>The game heats the validators.</strong> Once a flip is paired or a raffle round arms, the
        pinned preimages are requested ("heated"). Each validator reveals the secret behind its hash.
      </li>
      <li>
        <strong>The reveal is the draw.</strong> The seed is the keccak hash of all revealed secrets together.
        A coin flip settles on the seed's parity; the numbers draw is <code>1 + (seed mod 256)</code> and the
        closest revealed guess wins. Both are pure functions of the seed — there is no step where anyone
        chooses an outcome.
      </li>
    </ol>
    <p>
      The raffle uses a commit–reveal scheme on the player side too: your guess stays hidden (salted hash)
      until the draw lands, so nobody can snipe your number or front-run your reveal.
    </p>

    <h2 id="verify-it-yourself" class="scroll-mt-16">Verify it yourself</h2>
    <p>
      Every settled game on the site comes with a <strong>slip</strong>: your browser re-computes the outcome
      from the on-chain seed — using the same logic that the contracts run — and stamps the result
      <em>on the level</em> if it matches what the chain paid out, or <em>crooked</em> if it doesn't. The
      verification code runs client-side; you never have to take the site's word for it.
    </p>
    <p>
      Every card also carries its provenance: real block timestamps plus links to the exact transactions and
      blocks on the public explorer. The source of record is the chain itself — this page (on MsgBoard) is
      just the playbook for reading it.
    </p>

    <h2 id="testnet-status" class="scroll-mt-16">Testnet status</h2>
    <p>
      The venue is live on <strong>PulseChain testnet v4</strong> (chain id 943) with test PLS — free play
      money from the faucet, no real stakes. House bots keep the tables warm, so there is always action to
      watch, pair against, and verify. The contracts:
    </p>
    <table>
      <thead>
        <tr><th>Contract</th><th>Address</th></tr>
      </thead>
      <tbody>
        {#each contracts as c}
          <tr>
            <td>{c.label}</td>
            <td>
              <a href={`${explorer}/address/${c.address}`} target="_blank" rel="noopener noreferrer">
                <code>{c.address}</code>
              </a>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p>
      Want to watch a draw settle right now?
      <a href="https://games.msgboard.xyz" target="_blank" rel="noopener noreferrer">Pull up a chair</a>.
    </p>
  </article>
</div>

<Footer />

<style>
  .games-prose :global(h2) { font-size: 1.5rem; font-weight: 700; margin: 2rem 0 0.75rem; }
  .games-prose :global(p) { margin: 0.75rem 0; line-height: 1.7; }
  .games-prose :global(ul), .games-prose :global(ol) { padding-left: 1.5rem; margin: 0.75rem 0; }
  .games-prose :global(ul) { list-style: disc; }
  .games-prose :global(ol) { list-style: decimal; }
  .games-prose :global(li) { margin: 0.4rem 0; line-height: 1.65; }
  .games-prose :global(a) { color: var(--color-indigo-600, #4f46e5); text-decoration: underline; }
  .games-prose :global(code) { font-family: ui-monospace, monospace; font-size: 0.85em; background: rgba(120,120,120,0.15); padding: 0.1em 0.3em; border-radius: 0.25rem; word-break: break-all; }
  .games-prose :global(table) { width: 100%; border-collapse: collapse; margin: 0.75rem 0; font-size: 0.9rem; }
  .games-prose :global(th), .games-prose :global(td) { border: 1px solid rgba(120,120,120,0.3); padding: 0.4rem 0.6rem; text-align: left; }
</style>
