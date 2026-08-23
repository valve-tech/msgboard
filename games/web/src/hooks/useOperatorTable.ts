import { useCallback, useEffect, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { operatorCoinFlipAbi } from '@msgboard/games-core'
import { decodeOperatorTable, type OperatorTable } from '../model/operator-table'
import { publicClientFor } from '../wallet'
import type { GameDeployment } from '../config'

const POLL_MS = 12_000

/**
 * Read one operator table's live state in a single multicall: tables() struct + tableCap + tableLocked.
 * Returns undefined until the first read lands, when no table is selected, or on a failed struct read.
 * Polls every POLL_MS so the exposure cap / open flag stay fresh while the tray is open.
 */
export const useOperatorTable = (
  deployment: GameDeployment,
  tableId: Hex | null,
): { table?: OperatorTable; refresh: () => void } => {
  const [table, setTable] = useState<OperatorTable | undefined>(undefined)
  const busy = useRef(false)

  const load = useCallback(async () => {
    const opCfg = deployment.operator
    if (!opCfg || !tableId || busy.current) return
    busy.current = true
    try {
      const client = publicClientFor(deployment.chainId, deployment.rpc)
      const [tableRes, capRes, lockedRes] = await client.multicall({
        contracts: [
          { address: opCfg.coinFlip, abi: operatorCoinFlipAbi, functionName: 'tables', args: [tableId] },
          { address: opCfg.coinFlip, abi: operatorCoinFlipAbi, functionName: 'tableCap', args: [tableId] },
          { address: opCfg.coinFlip, abi: operatorCoinFlipAbi, functionName: 'tableLocked', args: [tableId] },
        ],
        allowFailure: true,
      })
      if (tableRes.status !== 'success') {
        setTable(undefined)
        return
      }
      setTable(
        decodeOperatorTable(
          tableId,
          tableRes.result as readonly unknown[],
          capRes.status === 'success' ? (capRes.result as bigint) : 0n,
          lockedRes.status === 'success' ? (lockedRes.result as bigint) : 0n,
        ),
      )
    } catch {
      setTable(undefined)
    } finally {
      busy.current = false
    }
  }, [deployment.chainId, deployment.rpc, deployment.operator, tableId])

  useEffect(() => {
    if (!tableId) {
      setTable(undefined)
      return
    }
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [load, tableId])

  return { table, refresh: () => void load() }
}
