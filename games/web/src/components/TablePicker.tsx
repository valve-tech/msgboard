import { useMemo, useState } from 'react'
import * as viem from 'viem'
import { coinFlipTablesAbi } from '@msgboard/games-core'
import type { GameDeployment } from '../config'
import { useTableEvents } from '../model/table-rounds'
import { reduceTables, type TableView } from '../lib/tablesIndex'
import { parseTableIdFromReceipt } from '../lib/tableCreate'
import { sendGameTx } from '../tx'
import { fmtAmount } from './Meta'
import { Menu } from './Menu'
import { StakeInput, parseStake } from './StakeInput'

/** Minimal ERC20 approve — Chips has no ABI export in games-core, mirrors DiceScreen's local const. */
const ERC20_APPROVE_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

/** ~1 day of blocks at the fleet's ~15s block time (86_400s / 15s) — the "recent rounds" window
 *  reduceTables uses to bias the sort toward tables that are actually being played right now. */
const WINDOW_BLOCKS = 5760n

/** The create-form's edge choices, 1.50x–2.00x in 0.10x steps (contract units are x100). */
const MULTIPLIER_OPTIONS = [150, 160, 170, 180, 190, 200]
const fmtMultiplier = (x100: number) => `${(x100 / 100).toFixed(2)}×`
const shortAddr = (address: viem.Address) => `${address.slice(0, 6)}…${address.slice(-4)}`

/** Why a table can't be selected right now — undefined when it's a live pick. */
const tableBlockReason = (t: TableView): string | undefined => {
  if (!t.open) return 'paused by operator'
  if (t.hot < 1n) return 'no liquidity armed'
  return undefined
}

const TableRow = ({
  deployment,
  table,
  selected,
  onSelect,
}: {
  deployment: GameDeployment
  table: TableView
  selected: boolean
  onSelect: (tableId: viem.Hex) => void
}) => {
  const reason = tableBlockReason(table)
  return (
    <li>
      <button
        type="button"
        className={`tp-row${selected ? ' selected' : ''}`}
        disabled={reason !== undefined}
        title={reason}
        onClick={() => onSelect(table.tableId)}
      >
        <span className="mono tp-op">{shortAddr(table.operator)}</span>
        <span className="tag">{fmtMultiplier(table.maxMultiplierX100)}</span>
        <span className="tp-hot">{fmtAmount(deployment, table.hot)} armed</span>
        <span className="muted">{table.roundsRecent} recent</span>
        <span className="muted">stake {fmtAmount(deployment, table.stake)}</span>
        {reason && <span className="bad tp-reason">{reason}</span>}
      </button>
    </li>
  )
}

/**
 * Browse live CoinFlipTables tables, create a new one, and pick which to join. No play/settlement
 * logic here — this is purely discovery + table admin (Task 14 wires the picked tableId into an
 * actual round). Reads via `useTableEvents` + `reduceTables` (armed-first sort); writes via the
 * house `sendGameTx` (simulate-then-send) idiom every other screen uses.
 */
export const TablePicker = ({
  deployment,
  walletClient,
  selected,
  onSelect,
}: {
  deployment: GameDeployment
  walletClient?: viem.WalletClient
  selected: viem.Hex | null
  onSelect: (tableId: viem.Hex) => void
}) => {
  const { events, head } = useTableEvents(deployment)
  const tables = useMemo(() => reduceTables(events, head, WINDOW_BLOCKS), [events, head])

  const [showCreate, setShowCreate] = useState(false)
  const [multIdx, setMultIdx] = useState(2) // 1.70x — a middling default edge
  const [maxStake, setMaxStake] = useState('1')
  const [hotTarget, setHotTarget] = useState('10')
  const [hotAmount, setHotAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const deployed = deployment.coinFlipTables !== undefined
  const canCreate = deployed && walletClient !== undefined

  const maxStakeWei = parseStake(maxStake)
  const hotTargetWei = parseStake(hotTarget)
  const hotAmountWei = hotAmount.trim() === '' ? 0n : parseStake(hotAmount)
  const formOk = maxStakeWei !== undefined && hotTargetWei !== undefined && hotAmountWei !== undefined

  const createTable = async () => {
    const coinFlipTables = deployment.coinFlipTables
    if (!walletClient?.account || !coinFlipTables) return
    if (!formOk) {
      setError('enter a valid max stake and hot target')
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const receipt = await sendGameTx(deployment, walletClient, {
        address: coinFlipTables,
        abi: coinFlipTablesAbi,
        functionName: 'createTable',
        args: [MULTIPLIER_OPTIONS[multIdx], maxStakeWei!, hotTargetWei!],
      })
      const tableId = parseTableIdFromReceipt(receipt)
      if (!tableId) throw new Error('no TableCreated event in the receipt')

      if (hotAmountWei! > 0n) {
        if (!deployment.chips) throw new Error('no Chips token configured on this chain — cannot fund hot liquidity')
        await sendGameTx(deployment, walletClient, {
          address: deployment.chips,
          abi: ERC20_APPROVE_ABI,
          functionName: 'approve',
          args: [coinFlipTables, hotAmountWei!],
        })
        await sendGameTx(deployment, walletClient, {
          address: coinFlipTables,
          abi: coinFlipTablesAbi,
          functionName: 'fundHot',
          args: [tableId, hotAmountWei!],
        })
      }

      setShowCreate(false)
      setHotAmount('')
      onSelect(tableId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!deployed) {
    return (
      <div className="tp-picker card">
        <p className="muted">tables not available on this chain yet</p>
      </div>
    )
  }

  return (
    <div className="tp-picker card">
      <div className="row tp-head" style={{ justifyContent: 'space-between' }}>
        <span className="tp-title">Player-run tables</span>
        <button className="secondary" onClick={() => setShowCreate((s) => !s)} disabled={!canCreate}>
          {showCreate ? 'Cancel' : 'Create a table'}
        </button>
      </div>
      {!walletClient && <p className="muted tp-hint">connect a wallet to create a table</p>}

      {showCreate && (
        <div className="tp-create">
          <div className="acts">
            <label className="tp-field">
              max edge
              <Menu
                label="max edge"
                options={MULTIPLIER_OPTIONS.map(fmtMultiplier)}
                value={multIdx}
                onChange={setMultIdx}
                disabled={busy}
              />
            </label>
            <label className="tp-field">
              max stake
              <StakeInput value={maxStake} onChange={setMaxStake} placeholder="max stake" />
            </label>
            <label className="tp-field">
              hot target
              <StakeInput value={hotTarget} onChange={setHotTarget} placeholder="hot target" />
            </label>
            <label className="tp-field">
              initial hot funding (optional)
              <StakeInput value={hotAmount} onChange={setHotAmount} placeholder="0" />
            </label>
          </div>
          <button className="primary" onClick={() => void createTable()} disabled={!canCreate || busy || !formOk}>
            {busy ? 'Sending…' : 'Create table'}
          </button>
          {error && <p className="bad">{error}</p>}
        </div>
      )}

      {tables.length === 0 ? (
        <p className="muted tp-empty">no tables yet — be the first to open one</p>
      ) : (
        <ul className="tp-list">
          {tables.map((t) => (
            <TableRow key={t.tableId} deployment={deployment} table={t} selected={selected === t.tableId} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </div>
  )
}
