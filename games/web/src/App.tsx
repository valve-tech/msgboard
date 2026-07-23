import { useEffect, useState } from 'react'
import * as viem from 'viem'
import { deployments } from './config'
import { useWallet } from './hooks/useWallet'
import { useChainData } from './hooks/useChainData'
import { TrustBanner, isTrustAcknowledgedFor, TRUST_ICON, type TrustModel } from './components/TrustBanner'
import { FlipBookScreen } from './components/FlipBookScreen'
import { FlipBookXScreen } from './components/FlipBookXScreen'
import { RaffleScreen } from './components/RaffleScreen'
import { DiceScreen } from './components/DiceScreen'
import { DiceX2Screen } from './components/DiceX2Screen'
import { LimboScreen } from './components/LimboScreen'
import { CrashScreen } from './components/CrashScreen'
import { PlinkoScreen } from './components/PlinkoScreen'
import { PachinkoScreen } from './components/PachinkoScreen'
import { WheelScreen } from './components/WheelScreen'
import { MonteScreen } from './components/MonteScreen'
import { BaccaratScreen } from './components/BaccaratScreen'
import { DragonTigerScreen } from './components/DragonTigerScreen'
import { AndarBaharScreen } from './components/AndarBaharScreen'
import { CrapsScreen } from './components/CrapsScreen'
import { ThreeCardPokerScreen } from './components/ThreeCardPokerScreen'
import { VideoPokerScreen } from './components/VideoPokerScreen'
import { BlackjackScreen } from './components/BlackjackScreen'
import { KenoScreen } from './components/KenoScreen'
import { MinesScreen } from './components/MinesScreen'
import { TowersScreen } from './components/TowersScreen'
import { ChickenScreen } from './components/ChickenScreen'
import { FirewalkScreen } from './components/FirewalkScreen'
import { HeistScreen } from './components/HeistScreen'
import { HiLoScreen } from './components/HiLoScreen'
import { GreedDiceScreen } from './components/GreedDiceScreen'
import { CascadeScreen } from './components/CascadeScreen'
import { LotteryScreen } from './components/LotteryScreen'
import { HiLoWarScreen } from './components/HiLoWarScreen'
import { SudokuScreen } from './components/SudokuScreen'
import { WordleScreen } from './components/WordleScreen'
import { LiveFeed } from './components/LiveFeed'
import { StandingsScreen } from './components/StandingsScreen'
import { Menu } from './components/Menu'

const short = (a?: viem.Hex) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')

const PITCH_KEY = 'msgboard-games:pitch-collapsed'

const chainIcon = (chainId: number): string | undefined =>
  chainId === 31337 ? undefined : `https://gib.show/image/${chainId}?w=32&h=32&format=webp`

/** The venue's table list — too many for a tab strip now, so the picker is a select-style Menu. */
const GAMES = [
  { id: 'coinflip', label: '🪙 Coin Flip' },
  { id: 'flipx', label: '✍️ Signed Flips' },
  { id: 'raffle', label: '🎟 The Numbers' },
  { id: 'dice', label: '🎲 Dice' },
  { id: 'dicex2', label: '🎲 Dice X2' },
  { id: 'limbo', label: '🚀 Limbo' },
  { id: 'crash', label: '📈 Crash' },
  { id: 'plinko', label: '⚪ Plinko' },
  { id: 'pachinko', label: '🔴 Pachinko' },
  { id: 'wheel', label: '🎡 Wheel' },
  { id: 'monte', label: '🃏 Monte' },
  { id: 'baccarat', label: '🀄 Baccarat' },
  { id: 'dragon-tiger', label: '🐲 Dragon Tiger' },
  { id: 'andar-bahar', label: '🎴 Andar Bahar' },
  { id: 'craps', label: '🎲 Craps' },
  { id: 'three-card', label: '🃏 Three Card Poker' },
  { id: 'video-poker', label: '🎰 Video Poker' },
  { id: 'blackjack', label: '🂡 Blackjack' },
  { id: 'keno', label: '🔢 Keno' },
  { id: 'mines', label: '💣 Mines' },
  { id: 'towers', label: '🗼 Towers' },
  { id: 'chicken', label: '🐔 Chicken' },
  { id: 'firewalk', label: '🔥 Firewalk' },
  { id: 'heist', label: '💰 Heist' },
  { id: 'hilo-ladder', label: '🔼 Hi-Lo' },
  { id: 'greed-dice', label: '🎲 Greed Dice' },
  { id: 'cascade', label: '🍒 Cascade' },
  { id: 'lottery', label: '🎰 Lottery' },
  { id: 'hilo', label: '⚔️ Hi-Lo War' },
  { id: 'sudoku', label: '🧩 ZK Sudoku' },
  { id: 'wordle', label: '🟩 ZK Wordle' },
  { id: 'standings', label: '🏆 Standings' },
  { id: 'live', label: '🟢 Live' },
] as const
type Tab = (typeof GAMES)[number]['id']

// The fairness assumption each table actually rests on. Only the numbers still draws from the
// validator set; the coin flip is now the P2P guessing duel (FlipBook — no randomness anywhere);
// the tables are commit-before-bet + co-signed recompute; the ZK games trust only the proof.
// 'live' is a feed, not a game, so it shows no trust strip.
const VALIDATOR_GAMES = new Set<Tab>(['raffle'])
const P2P_GAMES = new Set<Tab>(['coinflip', 'flipx'])
const ZK_GAMES = new Set<Tab>(['sudoku', 'wordle'])
const trustModelFor = (tab: Tab): TrustModel | null =>
  tab === 'live' || tab === 'standings'
    ? null
    : VALIDATOR_GAMES.has(tab)
      ? 'validator'
      : P2P_GAMES.has(tab)
        ? 'p2p'
        : ZK_GAMES.has(tab)
          ? 'zk'
          : 'cosigned'

// Deep-link state: the active game (and chain) live in the URL query so a refresh, share, or bookmark
// lands back on the same table instead of resetting to Coin Flip.
const readParams = () => new URLSearchParams(window.location.search)
const initialTab = (): Tab => {
  const g = readParams().get('game')
  return GAMES.some((x) => x.id === g) ? (g as Tab) : 'coinflip'
}
const initialDeploymentIndex = (): number => {
  const c = readParams().get('chain')
  const i = c ? deployments.findIndex((d) => String(d.chainId) === c) : -1
  return i >= 0 ? i : 0
}

export const App = () => {
  const [deploymentIndex, setDeploymentIndex] = useState(initialDeploymentIndex)
  const [tab, setTab] = useState<Tab>(initialTab)
  const deployment = deployments[deploymentIndex]

  // Mirror the active game + chain into the URL query (replaceState — no history spam) for refresh routing.
  useEffect(() => {
    const sp = readParams()
    sp.set('game', tab)
    if (deployment) sp.set('chain', String(deployment.chainId))
    window.history.replaceState(null, '', `${window.location.pathname}?${sp}${window.location.hash}`)
  }, [tab, deployment])
  const wallet = useWallet(deployment?.chainId ?? 31337)
  const data = useChainData(deployment ?? null, wallet.address)
  const trustModel = trustModelFor(tab)
  // Gate reflects the CURRENT game's (chain, model) ack — re-sync when either changes so switching
  // from an acknowledged table to a fresh model re-locks (and the banner re-prompts) correctly.
  const [trustAcknowledged, setTrustAcknowledged] = useState(() =>
    deployment && trustModel ? isTrustAcknowledgedFor(deployment.chainId, trustModel) : true,
  )
  useEffect(() => {
    setTrustAcknowledged(
      deployment && trustModel ? isTrustAcknowledgedFor(deployment.chainId, trustModel) : true,
    )
  }, [deployment, trustModel])
  // Collapsed by default — show the tables, not a wall of text. We remember if a player opened it.
  const [pitchOpen, setPitchOpen] = useState(() => localStorage.getItem(PITCH_KEY) === 'false')

  if (!deployment) {
    return (
      <div>
        <h1>MsgBoard Games</h1>
        <div className="banner">
          No deployment configured. For local play run <span className="mono">pnpm dev:seed</span> with anvil up,
          then reload. For PulseChain testnet v4, fill <span className="mono">src/config.ts</span> from the parity
          gate's run log.
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <div className="marquee">
        <div>
          <h1>
            MsgBoard <span className="gold">Games</span>
          </h1>
          <div className="strapline">the back room where the books stay open</div>
        </div>
        <div className="row">
          <Menu
            label="chain"
            options={deployments.map((d) => ({ label: d.label, icon: chainIcon(d.chainId) }))}
            value={deploymentIndex}
            onChange={setDeploymentIndex}
          />
          {wallet.address ? (
            <>
              <span className="tag mono">{short(wallet.address)}</span>
              <button className="secondary" onClick={wallet.disconnect}>
                Disconnect
              </button>
            </>
          ) : (
            <button onClick={() => void wallet.connect()} disabled={wallet.connecting}>
              {wallet.connecting ? 'Connecting…' : 'Connect wallet'}
            </button>
          )}
        </div>
      </div>
      <details
        className="pitch"
        open={pitchOpen}
        onToggle={(e) => {
          const isOpen = (e.target as HTMLDetailsElement).open
          setPitchOpen(isOpen)
          localStorage.setItem(PITCH_KEY, isOpen ? 'false' : 'true')
        }}
      >
        <summary>How the back room stays honest — and cheap</summary>
        <div className="pitch-body">
          <p className="hero-pitch">
            Every table, one promise: <strong>the draw is sealed before you play</strong>, and your own
            browser re-runs the count on every result. The numbers draws its seed from validator
            secrets locked on{' '}
            <a href="https://msgboard.xyz" target="_blank" rel="noreferrer">
              chain
            </a>
            ; the coin flip needs no seed at all — a peer's sealed choice against your open call, escrowed on chain;
            the dice, limbo, crash, plinko, wheel, monte, keno, mines, baccarat, dragon tiger, towers, chicken,
            firewalk, heist, hi-lo, greed dice and the rest lock their seed before the first hand and settle
            off chain, co-signed, with the trail posted to MsgBoard. A trust-me casino asks you to believe the odds;
            this room hands you the books.
          </p>
          <div className="howit">
            <div className="howit-step">
              <span className="howit-num">1</span>
              <strong>Sealed before you play.</strong> On the chain games, validators ink hashed secrets ahead of the
              draw and your entry pins that exact set. At the tables, the seed is committed before the first hand. Either
              way, nothing can change once you've bet.
            </div>
            <div className="howit-step">
              <span className="howit-num">2</span>
              <strong>The reveal is the draw.</strong> Chain games: the seed is the hash of the validators' revealed
              secrets — one honest validator beats any cartel. Tables: each hand reveals the next sealed seed, co-signed
              by you and the house off chain over MsgBoard — no gas per play.
            </div>
            <div className="howit-step">
              <span className="howit-num">3</span>
              <strong>You keep the books.</strong> Your browser recomputes every outcome — re-verifying the chain draw,
              or replaying the co-signed table transcript — and stamps the slip <em>on the level</em> or calls it
              crooked. Don't trust the room; audit it.
            </div>
          </div>
          <p className="howit-footer">
            <strong>Supercharged by MsgBoard:</strong> coordination rides proof-of-work stamps instead of gas, so fees
            never bleed the odds — every settlement leaves a notice on the board (follow the trail from{' '}
            <em>The record</em>). And if a chain's vault ever runs dry, the tables simply pause; nothing breaks, and
            play resumes the moment it's refilled.
          </p>
        </div>
      </details>
      {wallet.error && <div className="banner bad">{wallet.error}</div>}
      {data.error && <div className="banner bad">chain read failed: {data.error}</div>}
      <div className="tabs">
        <Menu
          label="game"
          options={GAMES.map((g) => {
            const m = trustModelFor(g.id)
            return { label: g.label, badge: m ? TRUST_ICON[m].icon : undefined, badgeTitle: m ? TRUST_ICON[m].title : undefined }
          })}
          value={Math.max(0, GAMES.findIndex((g) => g.id === tab))}
          onChange={(i) => setTab(GAMES[i]!.id)}
        />
        <span className="blockline">block {data.blockNumber.toString()}</span>
      </div>
      {trustModel && (
        <TrustBanner
          deployment={deployment}
          model={trustModel}
          onAcknowledged={() => setTrustAcknowledged(true)}
        />
      )}
      {tab === 'coinflip' && (
        <FlipBookScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'flipx' && (
        <FlipBookXScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'raffle' && (
        <RaffleScreen
          deployment={deployment}
          data={data}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'dice' && (
        <DiceScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'dicex2' && (
        <DiceX2Screen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'limbo' && (
        <LimboScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'crash' && (
        <CrashScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'plinko' && (
        <PlinkoScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'pachinko' && (
        <PachinkoScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'wheel' && (
        <WheelScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'monte' && (
        <MonteScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'baccarat' && (
        <BaccaratScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'dragon-tiger' && (
        <DragonTigerScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'andar-bahar' && (
        <AndarBaharScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'craps' && (
        <CrapsScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'three-card' && (
        <ThreeCardPokerScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'video-poker' && (
        <VideoPokerScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'blackjack' && (
        <BlackjackScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'keno' && (
        <KenoScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'mines' && (
        <MinesScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'towers' && (
        <TowersScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'chicken' && (
        <ChickenScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'firewalk' && (
        <FirewalkScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'heist' && (
        <HeistScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'hilo-ladder' && (
        <HiLoScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'greed-dice' && (
        <GreedDiceScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'cascade' && (
        <CascadeScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'lottery' && (
        <LotteryScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'hilo' && (
        <HiLoWarScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'sudoku' && (
        <SudokuScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'wordle' && (
        <WordleScreen
          deployment={deployment}
          walletClient={wallet.walletClient}
          trustAcknowledged={trustAcknowledged}
          myAddress={wallet.address}
        />
      )}
      {tab === 'standings' && <StandingsScreen deployment={deployment} myAddress={wallet.address} />}
      {tab === 'live' && <LiveFeed deployment={deployment} />}
      <div className="colophon">
        <span>
          a{' '}
          <a href="https://msgboard.xyz" target="_blank" rel="noreferrer">
            MsgBoard
          </a>{' '}
          venue · run by valve
        </span>
        <span>
          <a href="https://github.com/gibsfinance/random" target="_blank" rel="noreferrer">
            contracts
          </a>
          {' · '}
          <a href="https://github.com/valve-tech/msgboard" target="_blank" rel="noreferrer">
            msgboard
          </a>
        </span>
      </div>
    </div>
  )
}
