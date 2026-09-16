/**
 * Operator ops CLI for the table-maintainer substrate — bankroll deposit/withdraw, per-table exposure
 * caps, validator-policy config, and a read-only status view. A thin wrapper over the operator-only
 * entrypoints on GameEscrow / OperatorCoinFlip / DefaultValidatorPolicy; it sends no funds anywhere the
 * on-chain checks would not already allow.
 *
 * Roles: the caller supplies the OPERATOR's own key. Nothing here reads the chip-faucet key.
 *
 *   PRIVATE_KEY="$(op read op://valve/valve_deployer/pk)" \
 *   RPC_URL=https://rpc.v4.testnet.pulsechain.com \
 *   CMD=status npx tsx scripts/operator-ops.ts
 *
 * Commands (CMD env, else argv[2]; remaining args from argv):
 *   deposit <amount>                                    — approve + escrow.depositBankroll(op, CHIPS, amount)
 *   withdraw <amount>                                   — escrow.withdrawBankroll(CHIPS, amount), bounded to bankrollOf
 *   set-cap <tableId> <amount>                          — game.setTableCap(tableId, amount)
 *   rebalance <tableId>=<amount> [<tableId>=<amount> ...] — one setTableCap per pair
 *   set-policy <tableId> <policyAddr>                   — game.setValidatorPolicy(tableId, policyAddr)
 *   set-config <tableId> <minCount> <requireOperator:true|false> [wl...] — DefaultValidatorPolicy.setConfig
 *   status [tableId]                                    — read-only per-table view (no sends)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import * as viem from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { loadDeployment, sendAs, operatorTables } from './actor-common'

const __dirname = dirname(fileURLToPath(import.meta.url))

const RPC = process.env.RPC_URL ?? 'https://rpc.v4.testnet.pulsechain.com'
const CHAIN = 943
const chain = { id: CHAIN, name: 'pulse-943', nativeCurrency: { name: 'PLS', symbol: 'PLS', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function loadAbi(contractName: string): viem.Abi {
  const p = resolve(__dirname, `../../contracts/artifacts/contracts/games/operator/${contractName}.sol/${contractName}.json`)
  return JSON.parse(readFileSync(p, 'utf8')).abi as viem.Abi
}
function loadSubstrate(): { random: viem.Hex; contracts: Record<string, viem.Hex> } {
  const p = resolve(__dirname, '../../contracts/deployments/943-operator-substrate.json')
  return JSON.parse(readFileSync(p, 'utf8'))
}

async function main() {
  /* eslint-disable no-console */
  const pk = process.env.PRIVATE_KEY
  if (!pk) throw new Error('set PRIVATE_KEY (operator)')

  const sub = loadSubstrate()
  const ESCROW = (process.env.ESCROW ?? sub.contracts.GameEscrow) as viem.Hex
  const GAME = (process.env.GAME ?? sub.contracts.OperatorCoinFlip) as viem.Hex
  const POLICY = (process.env.POLICY ?? sub.contracts.DefaultValidatorPolicy) as viem.Hex

  const cfg = loadDeployment(CHAIN)
  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as viem.Hex)

  const pc = viem.createPublicClient({ chain, transport: viem.http(RPC) })
  const op = viem.createWalletClient({ account, chain, transport: viem.http(RPC) })

  const gameAbi = loadAbi('OperatorCoinFlip')
  const escrowAbi = loadAbi('GameEscrow')
  const policyAbi = loadAbi('DefaultValidatorPolicy')
  const chipsAbi = [
    { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: '', type: 'address' }, { name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  ] as const satisfies viem.Abi

  // token: reuse the live Chips (source of truth = live CoinFlipTables).
  const CFT = cfg.coinFlipTables!
  const cftAbi = [{ name: 'chips', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }] as const satisfies viem.Abi
  const CHIPS = (await pc.readContract({ address: CFT, abi: cftAbi, functionName: 'chips' })) as viem.Hex

  // Retry transient valve-RPC hiccups ("all upstream attempts failed" / InternalRpcError) — a real contract
  // revert has a decodable reason and is rethrown immediately, so a genuine failure still fails fast.
  const send = async (call: { address: viem.Hex; abi: viem.Abi; functionName: string; args: readonly unknown[] }): Promise<viem.TransactionReceipt> => {
    for (let attempt = 1; ; attempt++) {
      try { return await sendAs(pc, op, call) }
      catch (e) {
        const m = (e as Error).message
        const transient = /all upstream attempts failed|InternalRpcError|internal error|timeout|fetch failed|ECONNRESET/i.test(m)
        if (!transient || attempt >= 6) throw e
        console.log(`  ${call.functionName} attempt ${attempt} hit an RPC hiccup — retrying`)
        await sleep(6000)
      }
    }
  }

  const bankrollOf = () => pc.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'bankrollOf', args: [account.address, CHIPS] }) as Promise<bigint>
  const lockedOf = () => pc.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'lockedOf', args: [account.address, CHIPS] }) as Promise<bigint>
  const tableCapOf = (tableId: viem.Hex) => pc.readContract({ address: GAME, abi: gameAbi, functionName: 'tableCap', args: [tableId] }) as Promise<bigint>
  const tableLockedOf = (tableId: viem.Hex) => pc.readContract({ address: GAME, abi: gameAbi, functionName: 'tableLocked', args: [tableId] }) as Promise<bigint>
  const readTable = (tableId: viem.Hex) => pc.readContract({ address: GAME, abi: gameAbi, functionName: 'tables', args: [tableId] }) as Promise<readonly unknown[]>

  const cmd = process.env.CMD ?? process.argv[2]
  const args = process.env.CMD ? process.argv.slice(2) : process.argv.slice(3)
  if (!cmd) throw new Error('usage: CMD=<deposit|withdraw|set-cap|rebalance|set-policy|set-config|status> npx tsx scripts/operator-ops.ts [args...]')

  console.log(`\n=== operator-ops: ${cmd} ===\n game ${GAME}\n escrow ${ESCROW}\n policy ${POLICY}\n token(Chips) ${CHIPS}\n operator ${account.address}\n`)

  switch (cmd) {
    case 'deposit': {
      const amount = viem.parseEther(args[0] ?? '')
      if (amount <= 0n) throw new Error('usage: deposit <amount>')
      const allowance = (await pc.readContract({ address: CHIPS, abi: chipsAbi, functionName: 'allowance', args: [account.address, ESCROW] })) as bigint
      if (allowance < amount) await send({ address: CHIPS, abi: chipsAbi, functionName: 'approve', args: [ESCROW, viem.maxUint256] })
      await send({ address: ESCROW, abi: escrowAbi, functionName: 'depositBankroll', args: [account.address, CHIPS, amount] })
      console.log(`  deposited ${viem.formatEther(amount)} Chips — bankroll now ${viem.formatEther(await bankrollOf())}`)
      break
    }
    case 'withdraw': {
      const amount = viem.parseEther(args[0] ?? '')
      if (amount <= 0n) throw new Error('usage: withdraw <amount>')
      const bankroll = await bankrollOf()
      const locked = await lockedOf()
      console.log(`  bankroll ${viem.formatEther(bankroll)}  locked ${viem.formatEther(locked)}`)
      // In this escrow, bankrollOf is already net of locked exposure (exposure moves OUT of bankroll
      // into locked at lock time) — so the withdrawable idle balance is bankrollOf itself.
      if (amount > bankroll) {
        console.error(`  refusing: withdraw ${viem.formatEther(amount)} exceeds withdrawable bankroll ${viem.formatEther(bankroll)}`)
        process.exit(1)
      }
      await send({ address: ESCROW, abi: escrowAbi, functionName: 'withdrawBankroll', args: [CHIPS, amount] })
      console.log(`  withdrew ${viem.formatEther(amount)} Chips — bankroll now ${viem.formatEther(await bankrollOf())}`)
      break
    }
    case 'set-cap': {
      const [tableId, amountStr] = args
      if (!tableId || !amountStr) throw new Error('usage: set-cap <tableId> <amount>')
      const amount = viem.parseEther(amountStr)
      await send({ address: GAME, abi: gameAbi, functionName: 'setTableCap', args: [tableId as viem.Hex, amount] })
      console.log(`  table ${tableId} cap set to ${viem.formatEther(amount)}`)
      break
    }
    case 'rebalance': {
      if (args.length === 0) throw new Error('usage: rebalance <tableId>=<amount> [<tableId>=<amount> ...]')
      for (const pair of args) {
        const [tableId, amountStr] = pair.split('=')
        if (!tableId || !amountStr) throw new Error(`bad pair "${pair}" — expected <tableId>=<amount>`)
        const amount = viem.parseEther(amountStr)
        await send({ address: GAME, abi: gameAbi, functionName: 'setTableCap', args: [tableId as viem.Hex, amount] })
        console.log(`  table ${tableId} cap set to ${viem.formatEther(amount)}`)
      }
      break
    }
    case 'set-policy': {
      const [tableId, policyAddr] = args
      if (!tableId || !policyAddr) throw new Error('usage: set-policy <tableId> <policyAddr>')
      await send({ address: GAME, abi: gameAbi, functionName: 'setValidatorPolicy', args: [tableId as viem.Hex, policyAddr as viem.Hex] })
      console.log(`  table ${tableId} validatorPolicy set to ${policyAddr}`)
      break
    }
    case 'set-config': {
      const [tableId, minCountStr, requireOperatorStr, ...wl] = args
      if (!tableId || !minCountStr || !requireOperatorStr) {
        throw new Error('usage: set-config <tableId> <minCount> <requireOperator:true|false> [wl...]')
      }
      const minCount = BigInt(minCountStr)
      const requireOperator = requireOperatorStr === 'true'
      await send({
        address: POLICY,
        abi: policyAbi,
        functionName: 'setConfig',
        args: [GAME, tableId as viem.Hex, minCount, requireOperator, wl as viem.Hex[]],
      })
      console.log(`  table ${tableId} policy config set — minCount=${minCount} requireOperator=${requireOperator} whitelist=[${wl.join(', ')}]`)
      break
    }
    case 'status': {
      const explicit = args[0] as viem.Hex | undefined
      const tables = explicit
        ? [{ tableId: explicit, token: CHIPS, minStake: 0n, maxStake: 0n, open: (await readTable(explicit))[5] as boolean }]
        : await operatorTables(pc, cfg)
      const bankroll = await bankrollOf()
      const locked = await lockedOf()
      console.log(`  bankroll ${viem.formatEther(bankroll)}  locked ${viem.formatEther(locked)}`)
      for (const t of tables) {
        const cap = await tableCapOf(t.tableId)
        const tLocked = await tableLockedOf(t.tableId)
        // bankrollOf is already net of locked exposure (exposure moves OUT of bankroll into locked
        // at lock time — see EscrowLib.lock and the withdraw command above), so the idle/withdrawable
        // balance IS bankroll. Subtracting locked here would double-count it and understate headroom.
        const idle = bankroll
        const available = cap === 0n ? idle : (cap - tLocked < idle ? cap - tLocked : idle)
        const row = await readTable(t.tableId)
        const validatorPolicy = row[6] as viem.Hex
        console.log(
          `  table ${t.tableId}\n` +
          `    token ${t.token}  open ${t.open}\n` +
          `    cap ${viem.formatEther(cap)}  locked ${viem.formatEther(tLocked)}  available ${viem.formatEther(available)}\n` +
          `    validatorPolicy ${validatorPolicy}`,
        )
      }
      break
    }
    default:
      throw new Error(`unknown command "${cmd}" — expected deposit|withdraw|set-cap|rebalance|set-policy|set-config|status`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
