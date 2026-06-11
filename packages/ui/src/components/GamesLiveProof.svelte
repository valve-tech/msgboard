<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import * as viem from 'viem'
  import { pulsechainV4 } from 'viem/chains'

  // The live venue deployment on PulseChain testnet v4 — same contracts games.msgboard.xyz reads.
  const COINFLIP = '0x8d3a58d77d22636026066200f8868cd653ec2b2a'
  const RAFFLE = '0x33f506fafe4f05c8de9a07e1c8a7f73f50f1da36'
  const DEPLOY_BLOCK = 24645214n
  const EXPLORER = 'https://scan.v4.testnet.pulsechain.com/#'

  const coinFlipAbi = viem.parseAbi([
    'event Paired(bytes32 indexed flipId, address heads, address tails, uint256 stake)',
    'event Settled(bytes32 indexed flipId, address indexed winner, uint8 winningSide, uint256 payout, bytes32 seed)',
  ])
  const raffleAbi = viem.parseAbi(['event Finalised(bytes32 indexed roundId, address indexed winner, uint256 payout, uint256 fee)'])

  const client = viem.createPublicClient({ chain: pulsechainV4, transport: viem.http('https://rpc.v4.testnet.pulsechain.com') })

  type Proof = {
    flipId: viem.Hex
    heads: viem.Hex
    tails: viem.Hex
    seed: viem.Hex
    parity: 'even' | 'odd'
    computedSide: 'heads' | 'tails'
    computedWinner: viem.Hex
    chainWinner: viem.Hex
    payout: bigint
    matches: boolean
    tx: viem.Hex
    block: bigint
    when?: string
  }

  let proof = $state<Proof | undefined>()
  let flipsSettled = $state(0)
  let roundsPaid = $state(0)
  let paidOut = $state(0n)
  let error = $state<string | undefined>()
  let checkedAt = $state<string | undefined>()
  let timer: ReturnType<typeof setInterval> | undefined

  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

  const load = async () => {
    try {
      const [paired, settled, finalised] = await Promise.all([
        client.getContractEvents({ address: COINFLIP, abi: coinFlipAbi, eventName: 'Paired', fromBlock: DEPLOY_BLOCK }),
        client.getContractEvents({ address: COINFLIP, abi: coinFlipAbi, eventName: 'Settled', fromBlock: DEPLOY_BLOCK }),
        client.getContractEvents({ address: RAFFLE, abi: raffleAbi, eventName: 'Finalised', fromBlock: DEPLOY_BLOCK }),
      ])
      flipsSettled = settled.length
      roundsPaid = finalised.length
      paidOut =
        settled.reduce((s, log) => s + (log.args.payout ?? 0n), 0n) +
        finalised.reduce((s, log) => s + (log.args.payout ?? 0n), 0n)

      const last = settled.at(-1)
      if (last) {
        const pair = paired.find((p) => p.args.flipId === last.args.flipId)
        if (pair) {
          // the entire fairness claim, recomputed in YOUR browser: even seed -> heads, odd -> tails
          const seed = last.args.seed!
          const odd = BigInt(seed) % 2n === 1n
          const computedSide = odd ? 'tails' : 'heads'
          const computedWinner = computedSide === 'heads' ? pair.args.heads! : pair.args.tails!
          const block = await client.getBlock({ blockNumber: last.blockNumber })
          proof = {
            flipId: last.args.flipId!,
            heads: pair.args.heads!,
            tails: pair.args.tails!,
            seed,
            parity: odd ? 'odd' : 'even',
            computedSide,
            computedWinner,
            chainWinner: last.args.winner!,
            payout: last.args.payout ?? 0n,
            matches: computedWinner.toLowerCase() === last.args.winner!.toLowerCase(),
            tx: last.transactionHash,
            block: last.blockNumber,
            when: new Date(Number(block.timestamp) * 1000).toUTCString().replace(' GMT', ' UTC'),
          }
        }
      }
      checkedAt = new Date().toUTCString().replace(' GMT', ' UTC')
      error = undefined
    } catch (e) {
      error = e instanceof Error ? e.message.split('\n')[0] : String(e)
    }
  }

  onMount(() => {
    void load()
    timer = setInterval(() => void load(), 15_000)
  })
  onDestroy(() => clearInterval(timer))
</script>

<!-- Show, don't tell: this block re-verifies the venue's latest settled coin flip from raw
     chain data, in the reader's own browser, every 15 seconds. -->
<div class="overflow-hidden rounded-xl text-gray-100 ring-1 ring-amber-400/30" style="background: linear-gradient(180deg, #11301d, #0b2014)">
  <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-white/10 px-5 py-3">
    <span class="font-semibold text-amber-300">Live proof — verified in your browser just now</span>
    <span class="text-xs text-gray-400">
      {flipsSettled} flips settled · {roundsPaid} rounds paid · {viem.formatEther(paidOut)} tPLS paid out
    </span>
  </div>
  {#if proof}
    <div class="space-y-1.5 px-5 py-4 font-mono text-[13px] leading-relaxed">
      <div>
        <span class="text-gray-400">flip</span>
        {short(proof.heads)} (heads) vs {short(proof.tails)} (tails) · settled {proof.when}
      </div>
      <div class="break-all"><span class="text-gray-400">seed</span> {proof.seed}</div>
      <div>
        <span class="text-gray-400">your browser's count:</span>
        seed is {proof.parity} → <span class="text-amber-300">{proof.computedSide}</span> → {short(proof.computedWinner)} wins
        {viem.formatEther(proof.payout)}
      </div>
      <div><span class="text-gray-400">the chain paid:</span> {short(proof.chainWinner)}</div>
      <div class="pt-1">
        {#if proof.matches}
          <span class="inline-block -rotate-1 rounded border-2 border-emerald-400 px-2 py-0.5 font-sans text-xs font-bold uppercase tracking-wider text-emerald-400">✓ on the level — matches the chain</span>
        {:else}
          <span class="inline-block -rotate-1 rounded border-2 border-red-400 px-2 py-0.5 font-sans text-xs font-bold uppercase tracking-wider text-red-400">✗ crooked — does not match</span>
        {/if}
        <a class="ml-3 text-amber-300/80 underline hover:text-amber-300" href={`${EXPLORER}/tx/${proof.tx}`} target="_blank" rel="noopener noreferrer">settling tx ↗</a>
        <a class="ml-2 text-amber-300/80 underline hover:text-amber-300" href={`${EXPLORER}/block/${proof.block}`} target="_blank" rel="noopener noreferrer">block {proof.block} ↗</a>
      </div>
      <p class="pt-1 font-sans text-xs text-gray-400">
        Nothing above came from a server of ours: this page pulled the raw events from PulseChain testnet v4 and re-ran
        the settlement math locally. Re-checks every 15 s.{#if checkedAt}&nbsp;Last check {checkedAt}.{/if}
      </p>
    </div>
  {:else if error}
    <div class="px-5 py-4 text-sm text-red-300">chain read failed: {error}</div>
  {:else}
    <div class="px-5 py-4 text-sm text-gray-400">reading the chain…</div>
  {/if}
</div>
