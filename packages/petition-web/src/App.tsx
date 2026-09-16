import { useCallback, useEffect, useMemo, useState } from 'react'
import { Menu } from './components/Menu.js'
import type { Petition } from '@msgboard/petition'
import { useWallet } from './hooks/useWallet.js'
import { makeWorkerBoard, type BoardClient } from './seams/worker-board.js'
import { BOARD_ENDPOINTS, fetchBoardFactors, type BoardFactors } from './lib/board.js'
import { PETITION_READ_BASE, PETITION_INDEXER_URL, petitionAddressFor, chainMeta } from './lib/config.js'
import { listPetitions, createPetition as createPetitionFlow, type PetitionSummary } from './lib/petition-client.js'
import type { ProgressMsg } from './worker/types.js'
import { short } from './components/ui.js'
import { Directory } from './components/Directory.js'
import { CreatePetition } from './components/CreatePetition.js'
import { PetitionDetail } from './components/PetitionDetail.js'

type View = 'directory' | 'create' | 'detail'

export function App() {
  const wallet = useWallet()

  // ── board endpoint (chain selector — default 369, 943 for demo/bots) ───────────────────────
  const [boardIdx, setBoardIdx] = useState(0) // BOARD_ENDPOINTS[0] === PulseChain mainnet 369
  const endpoint = BOARD_ENDPOINTS[boardIdx]
  const [factors, setFactors] = useState<BoardFactors | null>(null)

  useEffect(() => {
    let cancelled = false
    setFactors(null)
    void fetchBoardFactors(endpoint.rpc, endpoint.chainId).then((f) => {
      if (!cancelled) setFactors(f)
    })
    return () => {
      cancelled = true
    }
  }, [endpoint.rpc, endpoint.chainId])

  const [grind, setGrind] = useState<ProgressMsg | null>(null)
  const onProgress = useCallback((msg: ProgressMsg) => setGrind(msg), [])

  const board = useMemo<BoardClient | null>(() => {
    if (!factors) return null
    return makeWorkerBoard({
      rpc: endpoint.rpc,
      chainId: endpoint.chainId,
      workMultiplier: factors.workMultiplier,
      workDivisor: factors.workDivisor,
      onProgress,
    })
  }, [endpoint.rpc, endpoint.chainId, factors, onProgress])

  const verifyingContract = useMemo(() => petitionAddressFor(endpoint.chainId), [endpoint.chainId])
  const meta = chainMeta(endpoint.chainId)

  // ── directory ────────────────────────────────────────────────────────────────────────────────
  const [view, setView] = useState<View>('directory')
  const [selected, setSelected] = useState<Petition | null>(null)
  const [summaries, setSummaries] = useState<PetitionSummary[] | null>(null)
  const [dirLoading, setDirLoading] = useState(false)
  const [dirError, setDirError] = useState<string | null>(null)

  const reloadDirectory = useCallback(async () => {
    setDirLoading(true)
    setDirError(null)
    try {
      setSummaries(await listPetitions(PETITION_READ_BASE))
    } catch (e) {
      setDirError(e instanceof Error ? e.message : 'Failed to load the petition directory')
    } finally {
      setDirLoading(false)
    }
  }, [])

  useEffect(() => {
    void reloadDirectory()
  }, [reloadDirectory])

  const openPetition = useCallback((p: Petition) => {
    setSelected(p)
    setView('detail')
  }, [])

  const handleCreated = useCallback(
    async (statement: string): Promise<Petition> => {
      if (!board || !wallet.address) throw new Error('Connect a wallet and wait for the board to be ready first.')
      const p = await createPetitionFlow(board, statement, wallet.address, endpoint.chainId)
      void reloadDirectory()
      return p
    },
    [board, wallet.address, endpoint.chainId, reloadDirectory],
  )

  return (
    <div className="wrap">
      <header className="hdr">
        <div className="brand">
          <div className="sig">✶</div>
          <div>
            <div className="eyebrow">the co-signed register</div>
            <h1>Petitions</h1>
          </div>
        </div>
        <div className="who">
          {wallet.address ? (
            <>
              <span className="chip">{short(wallet.address)}</span>
              {board && factors?.enabled ? (
                <span className="live">
                  ◆ <b>on the board</b>
                </span>
              ) : (
                <span className="pill">board offline</span>
              )}
            </>
          ) : (
            <button className="chip" onClick={() => void wallet.connect()} disabled={!wallet.available || wallet.connecting}>
              {wallet.available ? (wallet.connecting ? 'connecting…' : 'connect wallet') : 'no wallet'}
            </button>
          )}
        </div>
      </header>

      <div className="cfg" style={{ marginBottom: 18 }}>
        <span>
          board {meta.name} {endpoint.chainId} · {verifyingContract ? short(verifyingContract) : 'no verifier configured'}
          {grind ? ` · grinding ${grind.stats.iterations.toString()} iters` : ''}
        </span>
        <Menu label="board endpoint" options={BOARD_ENDPOINTS.map((b) => b.label)} value={boardIdx} onChange={setBoardIdx} />
      </div>

      {view === 'directory' && (
        <Directory
          summaries={summaries}
          loading={dirLoading}
          error={dirError}
          onOpen={openPetition}
          onCreate={() => setView('create')}
          onReload={() => void reloadDirectory()}
        />
      )}

      {view === 'create' && (
        <>
          <button type="button" className="edit" onClick={() => setView('directory')} style={{ marginBottom: 12 }}>
            ← back to directory
          </button>
          <CreatePetition
            onSubmit={handleCreated}
            onDone={openPetition}
            disabledReason={!wallet.address ? 'Connect a wallet to create a petition.' : !board ? 'Waiting for the board…' : null}
          />
        </>
      )}

      {view === 'detail' && selected && (
        <PetitionDetail
          petition={selected}
          board={board}
          wallet={wallet}
          verifyingContract={verifyingContract}
          readBase={PETITION_READ_BASE}
          indexerBase={PETITION_INDEXER_URL}
          onBack={() => setView('directory')}
        />
      )}

      <footer className="foot">@msgboard/petition · captured ∪ verified ∪ settled · signatures stamped off-thread</footer>
    </div>
  )
}
