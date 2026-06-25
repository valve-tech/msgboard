import { useEffect, useState } from 'react'
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
const raffleAbi = viem.parseAbi([
  'event Finalised(bytes32 indexed roundId, address indexed winner, uint256 payout, uint256 fee)',
])

type Proof = {
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

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/**
 * Ported from `GamesLiveProof.svelte` — re-verifies the venue's latest settled coin flip from
 * raw chain data, in the reader's own browser, every 15s.
 */
export function GamesLiveProof() {
  const [proof, setProof] = useState<Proof | undefined>()
  const [flipsSettled, setFlipsSettled] = useState(0)
  const [roundsPaid, setRoundsPaid] = useState(0)
  const [paidOut, setPaidOut] = useState(0n)
  const [error, setError] = useState<string | undefined>()
  const [checkedAt, setCheckedAt] = useState<string | undefined>()

  useEffect(() => {
    const client = viem.createPublicClient({
      chain: pulsechainV4,
      transport: viem.http('https://rpc.v4.testnet.pulsechain.com'),
    })

    let cancelled = false
    const load = async () => {
      try {
        const [paired, settled, finalised] = await Promise.all([
          client.getContractEvents({
            address: COINFLIP,
            abi: coinFlipAbi,
            eventName: 'Paired',
            fromBlock: DEPLOY_BLOCK,
          }),
          client.getContractEvents({
            address: COINFLIP,
            abi: coinFlipAbi,
            eventName: 'Settled',
            fromBlock: DEPLOY_BLOCK,
          }),
          client.getContractEvents({
            address: RAFFLE,
            abi: raffleAbi,
            eventName: 'Finalised',
            fromBlock: DEPLOY_BLOCK,
          }),
        ])
        if (cancelled) return
        setFlipsSettled(settled.length)
        setRoundsPaid(finalised.length)
        setPaidOut(
          settled.reduce((s, log) => s + (log.args.payout ?? 0n), 0n) +
            finalised.reduce((s, log) => s + (log.args.payout ?? 0n), 0n),
        )

        const last = settled.at(-1)
        if (last) {
          const pair = paired.find((p) => p.args.flipId === last.args.flipId)
          if (pair) {
            const seed = last.args.seed!
            const odd = BigInt(seed) % 2n === 1n
            const computedSide = odd ? 'tails' : 'heads'
            const computedWinner = computedSide === 'heads' ? pair.args.heads! : pair.args.tails!
            const block = await client.getBlock({ blockNumber: last.blockNumber })
            if (cancelled) return
            setProof({
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
            })
          }
        }
        setCheckedAt(new Date().toUTCString().replace(' GMT', ' UTC'))
        setError(undefined)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message.split('\n')[0] : String(e))
      }
    }

    void load()
    const timer = setInterval(() => void load(), 15_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return (
    <div
      className="overflow-hidden rounded-xl text-gray-100 ring-1 ring-amber-400/30"
      style={{ background: 'linear-gradient(180deg, #11301d, #0b2014)' }}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-white/10 px-5 py-3">
        <span className="font-semibold text-amber-300">
          Live proof — verified in your browser just now
        </span>
        <span className="text-xs text-gray-400">
          {flipsSettled} flips settled · {roundsPaid} rounds paid · {viem.formatEther(paidOut)} tPLS
          paid out
        </span>
      </div>
      {proof ? (
        <div className="space-y-1.5 px-5 py-4 font-mono text-[13px] leading-relaxed">
          <div>
            <span className="text-gray-400">flip</span> {short(proof.heads)} (heads) vs{' '}
            {short(proof.tails)} (tails) · settled {proof.when}
          </div>
          <div className="break-all">
            <span className="text-gray-400">seed</span> {proof.seed}
          </div>
          <div>
            <span className="text-gray-400">your browser's count:</span> seed is {proof.parity} →{' '}
            <span className="text-amber-300">{proof.computedSide}</span> →{' '}
            {short(proof.computedWinner)} wins {viem.formatEther(proof.payout)}
          </div>
          <div>
            <span className="text-gray-400">the chain paid:</span> {short(proof.chainWinner)}
          </div>
          <div className="pt-1">
            {proof.matches ? (
              <span className="inline-block -rotate-1 rounded border-2 border-emerald-400 px-2 py-0.5 font-sans text-xs font-bold uppercase tracking-wider text-emerald-400">
                ✓ on the level — matches the chain
              </span>
            ) : (
              <span className="inline-block -rotate-1 rounded border-2 border-red-400 px-2 py-0.5 font-sans text-xs font-bold uppercase tracking-wider text-red-400">
                ✗ crooked — does not match
              </span>
            )}
            <a
              className="ml-3 text-amber-300/80 underline hover:text-amber-300"
              href={`${EXPLORER}/tx/${proof.tx}`}
              target="_blank"
              rel="noopener noreferrer">
              settling tx ↗
            </a>
            <a
              className="ml-2 text-amber-300/80 underline hover:text-amber-300"
              href={`${EXPLORER}/block/${proof.block}`}
              target="_blank"
              rel="noopener noreferrer">
              block {proof.block.toString()} ↗
            </a>
          </div>
          <p className="pt-1 font-sans text-xs text-gray-400">
            Nothing above came from a server of ours: this page pulled the raw events from
            PulseChain testnet v4 and re-ran the settlement math locally. Re-checks every 15 s.
            {checkedAt && <>&nbsp;Last check {checkedAt}.</>}
          </p>
        </div>
      ) : error ? (
        <div className="px-5 py-4 text-sm text-red-300">chain read failed: {error}</div>
      ) : (
        <div className="px-5 py-4 text-sm text-gray-400">reading the chain…</div>
      )}
    </div>
  )
}
