/**
 * randomness-game — a provably-fair dice game coordinated over the board, with its
 * unbiasable seed sourced from the gibsfinance commit-reveal randomness contract.
 *
 * The existing antagonistic-game shows commit-reveal between two players. This goes a
 * step further: when a game needs randomness that NO participant can bias (a dice roll,
 * a lottery draw, a shuffle), you want a neutral entropy source. gibsfinance/random
 * (https://github.com/gibsfinance/random, npm @gibs/random) provides exactly that:
 *
 *   1. ink   — providers pre-publish keccak256(secret) preimages on-chain, staking per slot.
 *   2. heat  — a consumer requests `required` of those preimages and gets a `key`.
 *   3. cast  — the secrets are revealed; the contract checks each against its preimage and
 *              sets seed = keccak256(revealed secrets). No single revealer can steer it
 *              (all secrets were committed before the request), and withholding is slashed.
 *   4. read  — anyone reads randomness(key).seed and derives the outcome deterministically.
 *
 * msgboard is the coordination layer: players post the game id, roster, bets and the
 * randomness `key` to a category; the chain is the single trust anchor that produces the
 * seed. Every participant derives the same roll from the same seed, so the result is
 * provably fair and independently verifiable.
 *
 * Two modes:
 *   • No RANDOM_RPC (default): plays a full round in-process against a MOCK of the contract
 *     — provider commits secrets, consumer requests, secrets are revealed into a seed, the
 *     dice roll settles the bets — and shows that a provider who reveals a secret that does
 *     not match its committed preimage is caught (the on-chain `SecretMismatch`).
 *   • RANDOM_RPC set: reads a real on-chain seed for a randomness `key` and derives the same
 *     dice roll. The seed is read from the gibsfinance/random ponder indexer when INDEXER_URL is
 *     set (https://seed.msgboard.xyz), otherwise straight from the deployed contract (PulseChain
 *     testnet v4 / 943 by default).
 *
 * Usage:
 *   npm run randomness-game --workspace=packages/examples
 *   RANDOM_RPC=https://one.valve.city/rpc/vk_demo/evm/943 RANDOM_KEY=0x… \
 *     npm run randomness-game --workspace=packages/examples
 *
 * 369 (PulseChain mainnet) pathway: the contract is only deployed on 943 today. To run on
 * 369, deploy gibsfinance/random there (you can be your own provider via `ink`) and set
 * RANDOM_CHAIN_ID=369 plus RANDOM_ADDRESS=<your deployment>.
 */
import { concatHex, createPublicClient, http, keccak256, type Abi, type Address, type Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { pulsechain, pulsechainV4 } from 'viem/chains'
import { fileURLToPath } from 'node:url'
import randomArtifact from '@gibs/random/artifacts/contracts/Random.sol/Random.json' with { type: 'json' }
import deployed943 from '@gibs/random/ignition/deployments/chain-943/deployed_addresses.json' with { type: 'json' }

export const CATEGORY = 'dice'
/** Address of the Random contract on PulseChain testnet v4 (943), from @gibs/random. */
export const RANDOM_ADDRESS_943 = deployed943['RandomModule#Random'] as Address
const randomAbi = randomArtifact.abi as Abi

/** A provider's committed preimage — the on-chain "invisible ink" over a secret. */
export const commitOf = (secret: Hex): Hex => keccak256(secret)

/**
 * The seed the contract derives at `cast`: keccak256 of the revealed secrets concatenated.
 * Reproduced here so a consumer can verify the on-chain seed from the revealed secrets.
 */
export const deriveSeed = (secrets: readonly Hex[]): Hex => keccak256(concatHex([...secrets]))

/** True when a revealed secret matches its committed preimage (the contract's anti-cheat check). */
export const verifyReveal = (secret: Hex, preimage: Hex): boolean => commitOf(secret) === preimage

/**
 * A deterministic, provably-fair draw in [1, sides] from a seed. Every participant computes
 * the same value from the same on-chain seed. (For byte-identical parity with the contract's
 * own internal draw you would mirror Solady's LibPRNG.uniform; this defines the game's own
 * rule, which is all that fairness requires.)
 */
export const rollFromSeed = (seed: Hex, sides: number): number => Number(BigInt(seed) % BigInt(sides)) + 1

/** A player's bet, as posted to the board. */
export type Bet = { player: string; guess: number }

/** Settles bets against the rolled value: winners guessed the roll exactly. */
export const settleBets = (seed: Hex, bets: readonly Bet[], sides: number): { roll: number; winners: string[] } => {
  const roll = rollFromSeed(seed, sides)
  const winners = bets.filter((bet) => bet.guess === roll).map((bet) => bet.player)
  return { roll, winners }
}

const SIDES = 6

/** Reads a cast seed for a key from the gibsfinance/random ponder indexer (GraphQL). */
const fetchSeedFromIndexer = async (indexerUrl: string, key: Hex): Promise<Hex | null> => {
  const query = 'query($key: String!) { casts(where: { key: $key }) { items { seed } } }'
  const response = await fetch(indexerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { key } }),
  })
  const body = (await response.json()) as { data?: { casts?: { items?: Array<{ seed?: Hex }> } } }
  return body.data?.casts?.items?.[0]?.seed ?? null
}

async function main() {
  const rpcUrl = process.env.RANDOM_RPC

  console.log('\nmsgboard randomness-game (provably-fair dice)')
  console.log('─────────────────────────────────────────')

  if (!rpcUrl) {
    // Offline: a full round against a mock of the commit-reveal randomness contract.
    // The provider inks three secrets; the consumer requests all three; revealing them
    // produces the seed that rolls the die.
    const secrets = [0, 1, 2].map(() => generatePrivateKey())
    const preimages = secrets.map(commitOf)
    console.log('\nprovider inked 3 preimages (secrets hidden):')
    for (const preimage of preimages) console.log(`  ${preimage.slice(0, 18)}…`)

    // Players coordinate bets over the board (a `dice` category message each).
    const bets: Bet[] = [{ player: 'alice', guess: 4 }, { player: 'bob', guess: 2 }]
    console.log(`\nbets posted to the "${CATEGORY}" category:`)
    for (const bet of bets) console.log(`  ${bet.player} → ${bet.guess}`)

    // Cast: reveal the secrets. The consumer verifies each against its preimage, then the
    // seed is fixed — no one could have known the roll when they placed their bet.
    console.log('\ncast — secrets revealed and checked against their preimages:')
    const allValid = secrets.every((secret, index) => verifyReveal(secret, preimages[index]))
    console.log(`  all reveals match their commitments: ${allValid}`)
    const seed = deriveSeed(secrets)
    const { roll, winners } = settleBets(seed, bets, SIDES)
    console.log(`\nseed: ${seed.slice(0, 18)}…`)
    console.log(`dice roll (1-${SIDES}): ${roll}`)
    console.log(`winners: ${winners.length ? winners.join(', ') : 'none'}`)

    // Cheat attempt: the provider reveals a secret that does not match its preimage.
    console.log('\ncheat attempt — provider reveals a secret that was never committed:')
    const forgedSecret = generatePrivateKey()
    console.log(`  reveal matches committed preimage: ${verifyReveal(forgedSecret, preimages[0])} — rejected (SecretMismatch on chain)`)

    console.log('\nSet RANDOM_RPC (and RANDOM_KEY) to read a live on-chain seed from gibsfinance/random.\n')
    process.exit(0)
  }

  // Live: read a real seed for a randomness `key` from the deployed contract.
  const chainId = Number(process.env.RANDOM_CHAIN_ID ?? 943)
  const chain = chainId === 369 ? pulsechain : pulsechainV4
  const address = (process.env.RANDOM_ADDRESS as Address | undefined)
    ?? (chainId === 943 ? RANDOM_ADDRESS_943 : undefined)
  if (!address) {
    console.log(`\ngibsfinance/random is only deployed on chain 943. For chain ${chainId}, deploy it`)
    console.log('and pass RANDOM_ADDRESS=<your deployment>. See https://github.com/gibsfinance/random.\n')
    process.exit(0)
  }

  const key = process.env.RANDOM_KEY as Hex | undefined
  if (!key) {
    console.log('\nSet RANDOM_KEY to a randomness key (the value heat() returns) to read its seed.')
    console.log('A key is produced by requesting randomness on chain; see @gibs/random for the')
    console.log('ink → heat → cast lifecycle, or set INDEXER_URL (https://seed.msgboard.xyz) to find one.\n')
    process.exit(0)
  }

  const zero = `0x${'00'.repeat(32)}`
  const indexerUrl = process.env.INDEXER_URL // gibsfinance/random ponder indexer (seed.msgboard.xyz once live)
  let seed: Hex | null = null

  // Prefer the indexer when configured; fall back to reading the contract directly.
  if (indexerUrl) {
    console.log(`\nquerying the indexer at ${indexerUrl} for ${key.slice(0, 18)}…`)
    seed = await fetchSeedFromIndexer(indexerUrl, key)
  }
  if (!seed || seed === zero) {
    const client = createPublicClient({ chain, transport: http(rpcUrl) })
    console.log(`reading randomness ${key.slice(0, 18)}… from ${address} on chain ${chainId}`)
    seed = ((await client.readContract({ address, abi: randomAbi, functionName: 'randomness', args: [key] })) as { seed: Hex }).seed
  }

  if (!seed || seed === zero) {
    console.log('seed is not set yet — the randomness has not been cast (revealed). Try again later.\n')
    process.exit(0)
  }

  const { roll, winners } = settleBets(seed, [{ player: 'alice', guess: 4 }, { player: 'bob', guess: 2 }], SIDES)
  console.log(`seed: ${seed}`)
  console.log(`dice roll (1-${SIDES}): ${roll}`)
  console.log(`anyone can recompute this roll from the seed — provably fair. winners: ${winners.join(', ') || 'none'}\n`)
}

// Run the demo only when executed directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) void main()
