/**
 * Autonomous cosign actor: keeps the cosign.msgboard.xyz co-sign-over-MsgBoard flow on PulseChain
 * v4 (943) always live and always proving itself — the same "there is always something happening,
 * and it verifiably works" property the games actor fleet gives the games. Runs as a service in the
 * /opt/games-actors fleet.
 *
 * One SESSION per tick (default hourly), driven entirely through `@msgboard/cosign` + `@msgboard/sdk`
 * — the exact protocol the web app drives:
 *   1. resolve the fleet's 2-of-3 Safe (pinned via SAFE_943, else the deterministic derived address);
 *   2. propose a BENIGN digest — a 0-value self-call the Safe can always execute (moves no funds);
 *   3. THRESHOLD signers each EIP-712-sign the SafeTx digest and post their co-sign share to the
 *      board under scope `safe:<chainId>:<safe>` (PoW via the SDK's pow-grinder cascade — fast in
 *      Node, no worker needed at this cadence);
 *   4. read the shares back over the rolling 7-day window, group by digest;
 *   5. aggregate at threshold through the Safe adapter (which VERIFIES each share: recover + owner
 *      membership), build the Safe `signatures` blob, and prove the aggregate end-to-end by
 *      eth_call-simulating `execTransaction` (reverts iff the blob would be rejected on-chain);
 *   6. execute or skip — see the relay note below;
 *   7. log a one-line session summary a human (or the smoke) can read.
 *
 * A human opening cosign.msgboard.xyz, picking the same Safe, sees the bot's session live: the
 * category scheme, scope key, and record encoding are byte-identical to the web app's.
 *
 * ── on RELAY_URL and on-chain execution ──────────────────────────────────────────────────────
 * The cosign relay (`packages/cosign-relay`) sponsors ONLY Safe *deploys* (`POST /deploy-safe`) —
 * it has no execTransaction endpoint, so there is no way to relay the aggregated tx gaslessly.
 * Therefore:
 *   - The relay is used, when RELAY_URL is set, for the one-time gasless bootstrap DEPLOY of the
 *     Safe (signers at fresh derivation indices start unfunded).
 *   - RELAY_URL also gates on-chain EXECUTION of the session: when it is set AND a signer already
 *     holds enough gas, that signer (a Safe owner) submits `execTransaction` itself. When RELAY_URL
 *     is unset — or no signer is funded — the bot STOPS at verified aggregation (the fund-free,
 *     always-runnable proof) and logs that it skipped. We NEVER move funds between fleet accounts;
 *     a zero-balance signer produces a loud, actionable "fund <addr>" line and the tick skips
 *     gracefully.
 *
 * Resilience mirrors the sibling actors: every board/chain action is wrapped so one failure logs one
 * line and the tick continues; the loop never dies on a thrown tick. The cosign category rotates on
 * the UTC *day*, and we drive that clock from CHAIN time (latest block timestamp), never the box
 * clock — same lesson as flipbook-bots' `chainNow()`: a skewed box clock would post shares under a
 * day-key no human's browser (which reads real UTC) is looking at, silently splitting the session.
 *
 * Env (defaults in parens):
 *   MNEMONIC   — the fleet mnemonic (required); the three signers derive at COSIGN_INDICES.
 *   COSIGN_INDICES ("40,41,42") — address indices of the three signer accounts.
 *   CHAIN (943), RPC (keyed 943 RPC) — the Safe's chain + its reads/writes.
 *   BOARD_RPC (= RPC) — the msgboard-serving RPC (posts + reads of shares).
 *   SAFE_943 (unset) — pin the target Safe; when unset the bot derives/deploys one and logs it loudly.
 *   THRESHOLD (2) — signatures required.
 *   INTERVAL_MS (3600000) — one session per hour.
 *   RELAY_URL (unset) — cosign-relay base; enables gasless bootstrap deploy + gates on-chain execute.
 *   ONCE (unset) — single pass then exit (smoke / typecheck).
 */
import * as viem from 'viem'
import type { GamesChainId } from '@msgboard/games-core'
import {
  MsgBoardClient,
  type Content,
  type MessageSeed,
  type Provider,
} from '@msgboard/sdk'
import {
  type BoardClient,
  type CosignAdapter,
  type SafePublicClient,
  type SafeTx,
  type SignatureRecord,
  SCHEME,
  makeSafeAdapter,
  safeTransactionDigest,
  encodeSafeMeta,
  buildSignatureBlob,
  buildExecTransactionArgs,
  postSignature,
  readSignatures,
  groupByDigest,
  aggregate,
  recoverEffectiveSigner,
} from '@msgboard/cosign'
import { makeActor, flooredFees, sendAs } from './actor-common'
import {
  SAFE_V141,
  PROXY_FACTORY_ABI,
  buildSetup,
  predictSafeAddress,
  deterministicSaltNonce,
  benignSelfCall,
  deployRequestDigest,
  solveDeployPow,
  foldSession,
} from './cosign-plan'

const env = process.env
const CHAIN = (env.CHAIN ? Number(env.CHAIN) : 943) as GamesChainId
const INDICES = (env.COSIGN_INDICES ?? '40,41,42').split(',').map((s) => Number(s.trim()))
const THRESHOLD = env.THRESHOLD ? Number(env.THRESHOLD) : 2
const INTERVAL_MS = env.INTERVAL_MS ? Number(env.INTERVAL_MS) : 3_600_000
const SAFE_PINNED = (env.SAFE_943 ?? '').trim() as viem.Hex | ''
const RELAY_URL = (env.RELAY_URL ?? '').trim().replace(/\/$/, '')

/** Canonical cosign scheme — MUST match packages/cosign-web/src/lib/cosign.ts so the web app reads us. */
const NAMESPACE = 'cosign'
const WINDOW_DAYS = 7
const scopeFor = (chainId: number, safe: viem.Hex): string => `safe:${chainId}:${safe.toLowerCase()}`

/** Gas floors (943 gas is ~free, but a signer needs *some* native to send). */
const DEPLOY_GAS_FLOOR = viem.parseEther('0.02')
const EXEC_GAS_FLOOR = viem.parseEther('0.01')

/**
 * The viem typed-data table for a Safe `SafeTx` (v1.3.0 / v1.4.1). Replicated from
 * packages/cosign-web/src/lib/safe-typed-data.ts — the SDK exports the resulting digest
 * (`safeTransactionDigest`) but not the typed-data shape. We assert parity (below) before posting,
 * so a drift here can never produce an adapter-rejected share.
 */
const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

/** Safe read fragment — nonce() for the proposed digest; owners/threshold come via the adapter. */
const SAFE_READ_ABI = [
  { type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

/** execTransaction fragment — used for both the eth_call verify and the (gas-funded) submit. */
const EXEC_TRANSACTION_ABI = [
  {
    type: 'function',
    name: 'execTransaction',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-4)}`
const oneLine = (e: unknown) => (e as Error)?.message?.split('\n')[0] ?? String(e)

const main = async () => {
  if (!env.MNEMONIC) throw new Error('MNEMONIC required')
  if (INDICES.length < 3) throw new Error('COSIGN_INDICES needs three address indices (e.g. "40,41,42")')

  const signers = INDICES.slice(0, 3).map((i) => makeActor(CHAIN, env.MNEMONIC!, i, env.RPC))
  const owners = signers.map((s) => s.account.address)
  const publicClient = signers[0]!.publicClient

  // The board RPC is independent of the Safe's chain reads (cosign is a pure coordination layer);
  // it defaults to the same 943 endpoint, which serves both the eth_ and msgboard_ modules.
  const boardRpc = env.BOARD_RPC || env.RPC
  const boardProvider = makeActor(CHAIN, env.MNEMONIC!, INDICES[0]!, boardRpc).publicClient
  const boardClient = new MsgBoardClient(boardProvider as unknown as Provider)

  // cosign's BoardClient seam over the real MsgBoardClient (README pattern): post = doPoW+addMessage,
  // read = content passthrough. doPoW grinds via the SDK's native→WASM→JS engine cascade.
  const board: BoardClient = {
    async addMessage({ category, data }: { category: viem.Hex; data: viem.Hex }): Promise<unknown> {
      const { message } = await boardClient.doPoW(category, data)
      return boardClient.addMessage(message as MessageSeed)
    },
    content({ category }: { category: viem.Hex }): Promise<Content> {
      return boardClient.content({ category })
    },
  }

  const saltNonce = deterministicSaltNonce(CHAIN, owners, THRESHOLD)
  const derivedSafe = predictSafeAddress({ owners, threshold: THRESHOLD, saltNonce })
  const safe = (SAFE_PINNED || derivedSafe) as viem.Hex
  const scope = scopeFor(CHAIN, safe)

  // Banner FIRST (before any awaited work that could throw) — the smoke greps this prefix.
  console.log(
    `cosign bot on chain ${CHAIN}: safe ${SAFE_PINNED || derivedSafe} signers ${owners.join(',')} (tick ${INTERVAL_MS}ms)`,
  )
  if (!SAFE_PINNED) {
    console.log(`cosign: SAFE_943 unset — derived deterministic 2-of-3 Safe ${derivedSafe}; pin it with SAFE_943=${derivedSafe}`)
  }

  // Sync the board's live difficulty factors once (best-effort; the SDK defaults match the board's).
  try {
    const status = await boardClient.status()
    boardClient.setDifficultyFactors(BigInt(status.workMultiplier), BigInt(status.workDivisor))
  } catch (e) {
    console.error(`cosign: board status probe failed, using default difficulty: ${oneLine(e)}`)
  }

  const adapter: CosignAdapter = makeSafeAdapter({
    publicClient: publicClient as unknown as SafePublicClient,
    safe,
    chainId: CHAIN,
  })

  /** One action; a failure logs one line and never aborts the tick. */
  const attempt = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (e) {
      console.error(`${label}: ${oneLine(e)}`)
    }
  }

  /**
   * The cosign category rotates on the UTC day; drive that clock from CHAIN time, not the box clock.
   * A box running fast/slow would bucket shares under a day-key the human's (real-UTC) browser isn't
   * reading — silently splitting the session. Chain timestamps are real-world UTC, so this keeps the
   * bot aligned with every human viewer even when the box clock drifts.
   */
  const chainNow = async (): Promise<Date> => {
    const block = await publicClient.getBlock({ blockTag: 'latest' })
    return new Date(Number(block.timestamp) * 1000)
  }

  const isDeployed = async (addr: viem.Hex): Promise<boolean> => {
    const code = await publicClient.getCode({ address: addr })
    return !!code && code !== '0x'
  }

  /** Waits for a deploy receipt and returns the created proxy only if it equals `predicted`. */
  const confirmDeploy = async (txHash: viem.Hex, predicted: viem.Hex): Promise<viem.Hex> => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success') throw new Error('deploy transaction reverted')
    for (const log of receipt.logs) {
      if (!viem.isAddressEqual(log.address, SAFE_V141.factory)) continue
      try {
        const ev = viem.decodeEventLog({ abi: PROXY_FACTORY_ABI, topics: log.topics, data: log.data })
        if (ev.eventName !== 'ProxyCreation') continue
        const proxy = (ev.args as { proxy: viem.Hex }).proxy
        if (!viem.isAddressEqual(proxy, predicted)) throw new Error(`deployed ${proxy} != predicted ${predicted}`)
        return proxy
      } catch {
        /* not a ProxyCreation log */
      }
    }
    throw new Error('deploy produced no ProxyCreation event')
  }

  /** Bootstrap-deploy the derived Safe. Returns true on success; false (with a loud line) on skip. */
  const ensureSafe = async (): Promise<boolean> => {
    if (await isDeployed(safe)) return true
    if (SAFE_PINNED) {
      console.error(`cosign: SAFE_943 ${safe} has no code on chain ${CHAIN} — is it deployed on this chain? skipping tick`)
      return false
    }
    const initializer = buildSetup(owners, THRESHOLD)

    // Gasless bootstrap via the relay (the relay's one real capability), if configured + sponsoring.
    if (RELAY_URL) {
      try {
        const cfg = (await (await fetch(`${RELAY_URL}/config`, { headers: { accept: 'application/json' } })).json()) as {
          chains?: number[]
          powBits?: number
        }
        if (Array.isArray(cfg.chains) && cfg.chains.includes(CHAIN)) {
          const powBits = typeof cfg.powBits === 'number' ? cfg.powBits : 20
          const digest = deployRequestDigest({ chainId: CHAIN, singleton: SAFE_V141.singletonL2, initializer, saltNonce })
          const signature = await signers[0]!.account.sign!({ hash: digest })
          const powNonce = await solveDeployPow(digest, powBits)
          const res = await fetch(`${RELAY_URL}/deploy-safe`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              chainId: CHAIN,
              singleton: SAFE_V141.singletonL2,
              initializer,
              saltNonce: saltNonce.toString(),
              signature,
              powNonce,
            }),
          })
          const json = (await res.json().catch(() => ({}))) as { txHash?: viem.Hex; error?: string }
          if (!res.ok || !json.txHash) throw new Error(json.error ?? `relay deploy failed (HTTP ${res.status})`)
          const proxy = await confirmDeploy(json.txHash, safe)
          console.log(`cosign: relay-deployed 2-of-3 Safe ${proxy} — pin it with SAFE_943=${proxy}`)
          return true
        }
        console.error(`cosign: relay ${RELAY_URL} does not sponsor chain ${CHAIN} — trying self-pay deploy`)
      } catch (e) {
        console.error(`cosign: relay deploy failed (${oneLine(e)}) — trying self-pay deploy`)
      }
    }

    // Self-pay deploy from signer 0 (an owner). NEVER tops up — if unfunded, log + skip.
    const balance = await publicClient.getBalance({ address: signers[0]!.account.address })
    if (balance < DEPLOY_GAS_FLOOR) {
      console.error(
        `cosign: fund ${signers[0]!.account.address} with ~0.02 tPLS to deploy the Safe (or set RELAY_URL) — skipping tick`,
      )
      return false
    }
    const hash = await signers[0]!.wallet.writeContract({
      address: SAFE_V141.factory,
      abi: PROXY_FACTORY_ABI,
      functionName: 'createProxyWithNonce',
      args: [SAFE_V141.singletonL2, initializer, saltNonce],
      account: signers[0]!.account,
      chain: signers[0]!.wallet.chain,
      ...(await flooredFees(publicClient)),
    })
    const proxy = await confirmDeploy(hash, safe)
    console.log(`cosign: self-deployed 2-of-3 Safe ${proxy} — pin it with SAFE_943=${proxy}`)
    return true
  }

  const tick = async () => {
    if (!(await ensureSafe())) return

    const now = await chainNow()

    // Confirm the live owner set + threshold (a pinned Safe may differ from THRESHOLD/owners).
    const [onchainOwners, onchainThreshold] = await Promise.all([adapter.owners!(), adapter.threshold!()])

    // ── propose the benign digest for the Safe's live nonce ──────────────────────────────────
    const nonce = (await publicClient.readContract({
      address: safe,
      abi: SAFE_READ_ABI,
      functionName: 'nonce',
    })) as bigint
    const tx = benignSelfCall(safe, nonce)
    const digest = safeTransactionDigest(tx, CHAIN, safe)
    const meta = encodeSafeMeta(tx, safe, CHAIN)

    // ── read what's already on the board for this digest, so we only post missing shares ─────
    const preRecords = await readSignatures(board, { namespace: NAMESPACE, scope, days: WINDOW_DAYS, now })
    const already = new Set(
      groupByDigest(preRecords)
        .get(digest)
        ?.map((r) => r.signer.toLowerCase()) ?? [],
    )

    // ── THRESHOLD signers each sign + post their co-sign share (skip ones already posted) ────
    let posted = 0
    for (const signer of signers.slice(0, THRESHOLD)) {
      if (already.has(signer.account.address.toLowerCase())) continue
      await attempt(`post share ${short(signer.account.address)}`, async () => {
        const signature = await signer.account.signTypedData!({
          domain: { chainId: CHAIN, verifyingContract: safe },
          types: SAFE_TX_TYPES,
          primaryType: 'SafeTx',
          message: {
            to: tx.to,
            value: tx.value,
            data: tx.data,
            operation: tx.operation,
            safeTxGas: tx.safeTxGas,
            baseGas: tx.baseGas,
            gasPrice: tx.gasPrice,
            gasToken: tx.gasToken,
            refundReceiver: tx.refundReceiver,
            nonce: tx.nonce,
          },
        })
        // Parity guardrail: the local typed-data table must recover to us at the SDK's canonical
        // digest, or we refuse to post (never let a drifted table yield an adapter-rejected share).
        const recovered = await viem.recoverAddress({ hash: digest, signature })
        if (!viem.isAddressEqual(recovered, signer.account.address)) {
          throw new Error(`typed-data parity failed: recovered ${recovered} != ${signer.account.address}`)
        }
        const record: SignatureRecord = {
          digest,
          signer: signer.account.address,
          signature,
          scheme: SCHEME.EIP712,
          meta,
        }
        await postSignature(board, { namespace: NAMESPACE, scope, record, now })
        posted++
      })
    }

    // ── read back, aggregate at threshold, VERIFY ────────────────────────────────────────────
    const records = await readSignatures(board, { namespace: NAMESPACE, scope, days: WINDOW_DAYS, now })
    const group = groupByDigest(records).get(digest) ?? []

    const recovered = await Promise.all(
      group.map(async (r) => {
        try {
          return await recoverEffectiveSigner(r)
        } catch {
          return null
        }
      }),
    )
    const fold = foldSession(recovered, onchainOwners, onchainThreshold)

    let aggregateOk = false
    let verify = 'skipped (below threshold)'
    let executed = 'skipped'
    if (fold.thresholdMet) {
      try {
        // aggregate() runs adapter.verify on each record (recover + owner membership) — the cosign
        // verification seam — then orders them into the strictly-ascending blob the Safe accepts.
        const pairs = await aggregate(group, adapter)
        const ordered = pairs.map((p) => {
          const m = group.find((r) => r.signature === p.signature && viem.isAddressEqual(r.signer, p.signer))
          if (!m) throw new Error('aggregated pair has no source record')
          return m
        })
        aggregateOk = ordered.length >= onchainThreshold
        const blob = buildSignatureBlob(ordered)
        const execArgs = buildExecTransactionArgs(ordered, tx)

        // Strong verify: eth_call-simulate execTransaction. It reverts iff the Safe would reject the
        // blob (bad/short signatures) or the inner call fails — so a clean simulate is end-to-end
        // proof the aggregate is executable. Needs no gas and no funds.
        try {
          await publicClient.simulateContract({
            address: safe,
            abi: EXEC_TRANSACTION_ABI,
            functionName: 'execTransaction',
            args: execArgs,
            account: signers[0]!.account,
          })
          verify = 'ok'
        } catch (e) {
          verify = `FAILED (${oneLine(e)})`
        }

        void blob // built for parity with the web app's execute path; the simulate is the proof

        // ── execute or skip (see the header note on RELAY_URL) ──────────────────────────────
        if (verify === 'ok' && RELAY_URL) {
          const bal = await publicClient.getBalance({ address: signers[0]!.account.address })
          if (bal < EXEC_GAS_FLOOR) {
            console.error(
              `cosign: fund ${signers[0]!.account.address} with ~0.01 tPLS to execute (relay can't sponsor exec) — stopping at verified aggregation`,
            )
            executed = 'skipped (unfunded)'
          } else {
            await attempt('execute', async () => {
              const receipt = await sendAs(publicClient, signers[0]!.wallet, {
                address: safe,
                abi: EXEC_TRANSACTION_ABI as viem.Abi,
                functionName: 'execTransaction',
                args: execArgs,
              })
              executed = receipt.transactionHash
            })
          }
        } else if (verify === 'ok') {
          executed = 'skipped (no RELAY_URL)'
        }
      } catch (e) {
        verify = `aggregate error (${oneLine(e)})`
      }
    }

    console.log(
      `cosign session: digest ${short(digest)} · shares ${posted} posted / ${group.length} on board · ` +
        `owners ${fold.signedOwners.length}/${onchainThreshold} · aggregate ${aggregateOk ? 'ok' : 'no'} · ` +
        `verify ${verify} · exec ${executed.startsWith('0x') ? short(executed) : executed}`,
    )
  }

  if (env.ONCE === 'true') {
    await tick().catch((e) => console.error(`cosign tick failed: ${oneLine(e)}`))
    return
  }
  for (;;) {
    await tick().catch((e) => console.error(`cosign tick failed: ${oneLine(e)}`))
    const jitter = 0.5 + Math.random()
    await new Promise((resolve) => setTimeout(resolve, Math.round(INTERVAL_MS * jitter)))
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
