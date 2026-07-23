import { useState, useMemo } from 'react'
import * as viem from 'viem'
import { dice, diceMultiplierX100, buildSeedChain, commitSeed, makeDomain, type DiceParams } from '@msgboard/games'
import { EscrowedSettlement, signOpenTerms, paramsHashOf, type OpenTerms } from '@msgboard/settle'
import type { GameDeployment } from '../config'
import { useSession, makeInMemoryHouseDriver, PLACEHOLDER_VERIFIER, type RoundRecord, DEMO_HOUSE_ADDRESS } from '../hooks/useSession'
import { StakeInput, parseStake } from './StakeInput'
import { TurnTiming } from './TurnTiming'
import { InfoDot } from './Meta'

const HUNDREDTHS = 100n

/** target is a roll-under win chance in percent (the dice module's targetX100 is hundredths-of-a-percent). */
const MIN_TARGET_PCT = 0.01
const MAX_TARGET_PCT = 98.99

const pctToTargetX100 = (pct: number): bigint => BigInt(Math.round(pct * 100))
const fmtMult = (x100: bigint): string => `${(Number(x100) / 100).toFixed(2)}x`

/** Per-table settle status: after the round is co-signed, the player can settle on-chain. */
type TableStatus = 'idle' | 'playing' | 'settle-pending' | 'settling' | 'landed'

const ERC20_APPROVE_ABI = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }] },
] as const

/**
 * Reference OFF-CHAIN session-game screen (Dice). The template the other session games follow:
 *   1. `useSession({ game, walletClient, chainId })` drives the HouseSession.
 *   2. a params UI (here: target/win-chance) → `session.play(stake, params)`.
 *   3. a result/receipt + history list in the CoinFlip/Raffle visual style.
 * Swapping `dice` for `limbo`/`plinko`/`keno` + their params UI is the whole job for the next four.
 */
const RoundReceipt = ({ record }: { record: RoundRecord }) => (
  <div className="card">
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <span>
        <span className="tag">round {record.round}</span>
        {viem.formatEther(record.stake)} staked
        {record.win ? (
          <span className="tag ok">won {fmtMult(record.multiplierX100)}</span>
        ) : (
          <span className="tag">lost</span>
        )}
      </span>
      <span className={record.playerDelta >= 0n ? 'ok' : 'bad'}>
        {record.playerDelta >= 0n ? '+' : ''}
        {viem.formatEther(record.playerDelta)}
      </span>
    </div>
    <p className="card-meta muted">
      balance {viem.formatEther(record.balancePlayer)} · co-signed by both parties
    </p>
    {record.timing && (
      <p className="card-meta muted">
        <TurnTiming timing={record.timing} />
      </p>
    )}
  </div>
)

export const DiceScreen = ({
  deployment,
  walletClient,
  trustAcknowledged,
  myAddress,
}: {
  deployment: GameDeployment
  walletClient?: viem.WalletClient
  trustAcknowledged: boolean
  myAddress?: viem.Hex
}) => {
  const [amount, setAmount] = useState('0.1')
  const [targetPct, setTargetPct] = useState('50')
  const [tableStatus, setTableStatus] = useState<TableStatus>('idle')
  const [settleError, setSettleError] = useState<string>()

  const sessionDomain = useMemo(
    () => makeDomain(deployment.chainId, deployment.houseChannel ?? PLACEHOLDER_VERIFIER),
    [deployment.chainId, deployment.houseChannel],
  )
  // TODO(Task 9/live): replace with a board-backed driver that posts the round-request
  // over MsgBoardTransport and awaits the house service's finished transcript response.
  const houseDriver = useMemo(
    () => makeInMemoryHouseDriver(dice, { domain: sessionDomain, chainLength: 64 }),
    [sessionDomain],
  )

  const session = useSession<DiceParams>({
    game: dice,
    walletClient,
    chainId: deployment.chainId,
    boardRpc: deployment.boardRpc,
    gameLabel: 'dice',
    houseChannel: deployment.houseChannel,
    houseDriver,
  })

  const stake = parseStake(amount)
  const pct = Number(targetPct)
  const targetOk = Number.isFinite(pct) && pct >= MIN_TARGET_PCT && pct <= MAX_TARGET_PCT
  const targetX100 = targetOk ? pctToTargetX100(pct) : undefined
  const multiplierX100 = targetX100 !== undefined ? diceMultiplierX100(targetX100) : undefined
  const potentialWin =
    stake !== undefined && multiplierX100 !== undefined
      ? (stake * multiplierX100) / HUNDREDTHS - stake
      : undefined

  const busy = session.status === 'opening' || session.status === 'playing'
  const canOpen = walletClient !== undefined && trustAcknowledged && !busy
  const canRoll = session.ready && !busy && stake !== undefined && targetX100 !== undefined

  const roll = async () => {
    if (stake === undefined || targetX100 === undefined) return
    setTableStatus('playing')
    const record = await session.play(stake, { targetX100 })
    if (record) {
      setTableStatus('settle-pending')
    } else {
      setTableStatus('idle')
    }
  }

  /** faucet → Chips.approve → EscrowedSettlement.buildOpen → open tx → then start the co-sign session */
  const openAndStart = async () => {
    if (!walletClient?.account) return
    if (!deployment.houseChannel) { setSettleError('no houseChannel in deployment config'); return }
    if (!deployment.chips) {
      // No Chips token configured — just start the co-sign session (demo without on-chain open)
      await session.start()
      return
    }

    setSettleError(undefined)
    try {
      const playerAddress = walletClient.account.address
      const escrowPlayer = 10n ** 18n   // 1 Chip (matches useSession openBalances default)

      // ── Build open terms (demo: use DEMO_HOUSE_KEY to sign; production: receive from house) ──
      const { privateKeyToAccount: pkToAccount, generatePrivateKey } = await import('viem/accounts')
      const DEMO_HOUSE_KEY_LOCAL = `0x${'de'.repeat(32)}` as viem.Hex
      const DEMO_SEED_TIP_LOCAL = `0x${'55'.repeat(32)}` as viem.Hex
      const demoHouseAcct = pkToAccount(DEMO_HOUSE_KEY_LOCAL)
      const chain = buildSeedChain(DEMO_SEED_TIP_LOCAL, 64)

      // The OPEN handshake commits the player's CSPRNG clientSeed (only keccak256(clientSeed) is
      // bound into OpenTerms — never the raw seed) so the house can't grind its tip against it.
      // Mirrors useSession.start()/buildOpenRequest; signed into the EIP-712 OpenTerms the contract
      // verifies, so the digest matches the house signature.
      const clientSeed = generatePrivateKey()
      // paramsHash binds the table's dice params; matches reviewOpen's paramsHashOf(targetX100).
      const tableTargetX100 = targetX100 ?? pctToTargetX100(50)

      const tableId = viem.keccak256(
        viem.stringToHex(`mbg:open:${Date.now()}:${playerAddress}`)
      ) as viem.Hex

      const terms: OpenTerms = {
        tableId,
        player: playerAddress,
        playerKey: playerAddress,
        escrowPlayer,
        escrowHouse: 10n ** 21n,
        gameId: dice.gameId,
        rngCommit: chain.commit,
        clockBlocks: 100n,
        expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
        clientSeedCommit: commitSeed(clientSeed),
        paramsHash: paramsHashOf(tableTargetX100),
      }

      // TODO(Task 9/live): fetch house-signed OpenTerms from the house service instead.
      const demoHouseSigner = {
        address: demoHouseAcct.address,
        signTypedData: (args: Parameters<typeof demoHouseAcct.signTypedData>[0]) =>
          demoHouseAcct.signTypedData(args),
        signMessage: (args: { message: { raw: viem.Hex } }) => demoHouseAcct.signMessage(args),
      }
      const houseSig = await signOpenTerms(demoHouseSigner, sessionDomain, terms)

      // ── Approve Chips spend ──────────────────────────────────────────────────────
      await walletClient.writeContract({
        address: deployment.chips,
        abi: ERC20_APPROVE_ABI,
        functionName: 'approve',
        args: [deployment.houseChannel, escrowPlayer],
        account: walletClient.account,
        chain: walletClient.chain,
      })

      // ── Submit HouseChannel.open ─────────────────────────────────────────────────
      const esc = new EscrowedSettlement<DiceParams>({
        parties: { player: playerAddress, house: demoHouseAcct.address },
        commit: chain.commit,
        game: dice,
        domain: sessionDomain,
        settlementMode: 1,
        channel: deployment.houseChannel,
      })
      const openTx = esc.buildOpen(terms, houseSig)
      await walletClient.writeContract({
        address: openTx.address,
        abi: openTx.abi as viem.Abi,
        functionName: openTx.functionName,
        args: openTx.args,
        account: walletClient.account,
        chain: walletClient.chain,
      })

      // ── Start the co-sign session ────────────────────────────────────────────────
      await session.start()
    } catch (e) {
      setSettleError(e instanceof Error ? e.message : String(e))
    }
  }

  /** Build and submit the on-chain settle transaction from the retained co-signed transcript. */
  const settle = async () => {
    const transcriptJson = session.transcriptJson()
    if (!transcriptJson) { setSettleError('no transcript to settle'); return }
    if (!walletClient?.account) { setSettleError('connect a wallet to settle'); return }
    if (!deployment.houseChannel) { setSettleError('no houseChannel in deployment config'); return }

    setTableStatus('settling')
    setSettleError(undefined)
    try {
      const domain = makeDomain(deployment.chainId, deployment.houseChannel)
      // The DEMO house address is derived from DEMO_HOUSE_KEY — the same key that signed the
      // round in play(). In production this would be the real house's address from the deployment.
      const houseAddress = DEMO_HOUSE_ADDRESS
      // The seed commit must match what runHouseSide put in the OPEN state.
      // buildSeedChain(DEMO_SEED_TIP, chainLength).commit == the rngCommit in the transcript.
      // We read it from the transcript at replay time (EscrowedSettlement.buildSettle → replaySession).
      // We just need to supply the parties so replaySession can verify both co-sigs.
      const esc = new EscrowedSettlement<DiceParams>({
        parties: { player: walletClient.account.address, house: houseAddress },
        // The commit is verified inside replaySession against the transcript's OPEN rngCommit.
        // We provide a placeholder here; replaySession reads it from the transcript directly.
        // (EscrowedSettlement calls replaySession which checks ctx.commit === ob.rngCommit —
        //  so we must provide the real commit from the transcript's OPEN entry.)
        commit: await extractCommitFromTranscript(transcriptJson),
        game: dice,
        domain,
        settlementMode: 1,
        channel: deployment.houseChannel,
      })
      const tx = await esc.buildSettle(transcriptJson)
      // Simulate + send the settle tx via the wallet.
      await walletClient.writeContract({
        address: tx.address,
        abi: tx.abi as viem.Abi,
        functionName: tx.functionName,
        args: tx.args,
        account: walletClient.account,
        chain: walletClient.chain,
      })
      setTableStatus('landed')
    } catch (e) {
      setSettleError(e instanceof Error ? e.message : String(e))
      setTableStatus('settle-pending')
    }
  }

  const wins = session.history.filter((r) => r.win).length
  const taken = session.history.reduce((sum, r) => sum + r.playerDelta, 0n)

  return (
    <div>
      <div className="card">
        <h3>
          Roll under
          <InfoDot>
            <strong>Roll under your win chance to win.</strong> The lower the chance, the bigger the
            payout. Each roll is settled instantly off-chain — no gas — and the seed was sealed before
            you opened the table, so you can re-check it.
          </InfoDot>
        </h3>
        <div className="row">
          <StakeInput value={amount} onChange={setAmount} />
          <label className="threshold-label">
            win chance %
            <input
              type="number"
              min={MIN_TARGET_PCT}
              max={MAX_TARGET_PCT}
              step={0.5}
              value={targetPct}
              onChange={(e) => setTargetPct(e.target.value)}
              style={{ width: '5.5rem' }}
              aria-label="win chance percent"
            />
          </label>
          {session.ready ? (
            <button onClick={() => void roll()} disabled={!canRoll}>
              {session.status === 'playing' ? 'Rolling…' : 'Roll'}
            </button>
          ) : (
            <button onClick={() => void openAndStart()} disabled={!canOpen}>
              {session.status === 'opening' ? 'Opening…' : 'Open table'}
            </button>
          )}
          {!walletClient && <span className="muted">connect a wallet to play</span>}
          {walletClient && !trustAcknowledged && (
            <span className="muted">tap "Got it" on the fairness note above first</span>
          )}
        </div>
        <p className="muted">
          {amount !== '' && stake === undefined && <span className="bad">enter a positive amount · </span>}
          {targetPct !== '' && !targetOk && (
            <span className="bad">
              win chance {MIN_TARGET_PCT}–{MAX_TARGET_PCT}% ·{' '}
            </span>
          )}
          {multiplierX100 !== undefined && <span className="ok">pays {fmtMult(multiplierX100)}</span>}
          {potentialWin !== undefined && potentialWin > 0n && (
            <span className="muted"> · +{viem.formatEther(potentialWin)} on a win</span>
          )}
        </p>
        {session.commit && (
          <p className="card-meta muted">
            server-seed commit <span className="mono">{session.commit.slice(0, 10)}…</span>
            {session.balances && (
              <>
                {' · '}your balance {viem.formatEther(session.balances.player)} · {session.roundsLeft} rolls left
              </>
            )}
          </p>
        )}
        {session.error && <p className="bad">{session.error}</p>}

        {/* Settle button — shown after a round completes (co-signed off-chain) */}
        {tableStatus === 'settle-pending' && deployment.houseChannel && (
          <div className="row" style={{ marginTop: '0.5rem' }}>
            <button onClick={() => void settle()}>
              Settle on-chain
            </button>
            <span className="muted">posts the co-signed final state to the HouseChannel contract</span>
          </div>
        )}
        {tableStatus === 'settling' && (
          <p className="muted">Settling…</p>
        )}
        {tableStatus === 'landed' && (
          <p className="ok">Settled on-chain.</p>
        )}
        {settleError && <p className="bad">{settleError}</p>}
      </div>

      <h2>This table</h2>
      {!session.ready && session.history.length === 0 && (
        <p className="muted">No table open — set your stake and odds, then open one to start rolling.</p>
      )}
      {[...session.history].reverse().map((record) => (
        <RoundReceipt key={record.round} record={record} />
      ))}

      {myAddress && session.history.length > 0 && (
        <>
          <h2>Your book</h2>
          <details className="history" open>
            <summary>
              {session.history.length} roll{session.history.length === 1 ? '' : 's'}
              <span className="muted">
                {' '}
                · {wins}/{session.history.length} won · {viem.formatEther(taken)} net
              </span>
            </summary>
            {[...session.history].reverse().map((record) => (
              <RoundReceipt key={record.round} record={record} />
            ))}
          </details>
        </>
      )}
    </div>
  )
}

/**
 * Extract the rngCommit from a finished transcript's OPEN entry.
 * Needed to supply the correct `commit` to EscrowedSettlement so replaySession can verify it.
 */
async function extractCommitFromTranscript(transcriptJson: string): Promise<viem.Hex> {
  const parsed = JSON.parse(transcriptJson) as {
    entries: Array<{ kind: string; body: { rngCommit?: string } }>
  }
  const openEntry = parsed.entries.find((e) => e.kind === 'OPEN')
  if (!openEntry?.body?.rngCommit) throw new Error('settle: transcript missing OPEN rngCommit')
  return openEntry.body.rngCommit as viem.Hex
}
