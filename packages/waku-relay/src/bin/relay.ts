#!/usr/bin/env node
import { type Hex } from 'viem'
import { parseCategoryEncoding } from '../category.js'
import { loadConfig, type RelayConfig } from '../config.js'
import { createBoardClient, createBoardPoster } from '../msgboard.js'
import { createRelay } from '../relay.js'
import { createSeenStore } from '../seen.js'
import { createWakuSource } from '../waku.js'

/** Apply CLI flags on top of the env-derived config. Flags win. */
function applyFlags(config: RelayConfig, argv: string[]): RelayConfig {
  const next = { ...config }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--category-encoding': next.categoryEncoding = parseCategoryEncoding(argv[++i]); break
      case '--raw': next.bodyMode = 'raw'; break
      case '--envelope': next.bodyMode = 'envelope'; break
      case '--dry-run': next.dryRun = true; break
      case '--channels': next.channels = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean); break
      case '--seen-path': next.seenPath = argv[++i]; break
      case '--board-rpc': next.boardRpcUrl = argv[++i] ?? next.boardRpcUrl; break
    }
  }
  return next
}

function printHelp(): void {
  console.log(`waku-relay — one-way Waku -> MsgBoard relay

Reads every message on the given Waku channels and re-posts it to the MsgBoard board
(proof-of-work stamped; no wallet, no gas).

Env (required): MSGBOARD_RPC_URL, RELAY_CHANNELS
Env (optional): MSGBOARD_CHAIN_ID, WAKU_APP_NAME, WAKU_BOOTSTRAP, RELAY_CATEGORY_ENCODING,
                RELAY_BODY_MODE, RELAY_SEEN_PATH, RELAY_DRY_RUN, MSGBOARD_WORK_MULTIPLIER/DIVISOR

Flags (override env):
  --category-encoding <keccak256|ascii32>   channel -> category hashing (default keccak256)
  --raw | --envelope                        post raw payload vs origin-tagged envelope (default envelope)
  --channels <a,b,c>                        channels to relay
  --board-rpc <url>                         MsgBoard node RPC
  --seen-path <file>                        persistent dedup log
  --dry-run                                 log what would be posted; do NOT stamp/post
  -h, --help`)
}

const log = (msg: string, meta?: unknown): void =>
  console.log(`[waku-relay] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`)

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) { printHelp(); return }
  const config = applyFlags(loadConfig(), argv)
  log('config', {
    boardRpcUrl: config.boardRpcUrl, channels: config.channels, categoryEncoding: config.categoryEncoding,
    bodyMode: config.bodyMode, dryRun: config.dryRun, seenPath: config.seenPath ?? '(memory)',
  })

  const post = config.dryRun
    ? async (category: Hex, data: Hex): Promise<Hex> => {
        log('DRY-RUN would post', { category, bytes: (data.length - 2) / 2 })
        return '0x' as Hex
      }
    : createBoardPoster(createBoardClient({
        boardRpcUrl: config.boardRpcUrl, workMultiplier: config.workMultiplier, workDivisor: config.workDivisor,
      })).post

  const relay = createRelay({
    source: createWakuSource({ appName: config.wakuAppName, bootstrap: config.wakuBootstrap, log }),
    post,
    seen: createSeenStore({ path: config.seenPath }),
    channels: config.channels,
    categoryEncoding: config.categoryEncoding,
    bodyMode: config.bodyMode,
    log,
    onError: (error) => log('error', { error: String(error) }),
  })

  const shutdown = async (): Promise<void> => {
    log('shutting down', relay.stats())
    await relay.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  await relay.start()
  log('running — ctrl-c to stop')
}

main().catch((error) => {
  console.error(`[waku-relay] fatal: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
