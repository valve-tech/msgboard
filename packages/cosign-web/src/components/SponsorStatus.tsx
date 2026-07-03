import { useEffect, useState } from 'react'
import { formatEther } from 'viem'
import { Icon } from '@iconify/react'
import { chainMeta } from '../lib/config'
import { fetchRelayConfig, type SponsorInfo } from '../lib/gasless'
import { short } from './ui'

/** Trims a `formatEther` string to a few decimals without padding it back out with zeros. */
function trimBalance(wei: string): string {
  let asEther: string
  try {
    asEther = formatEther(BigInt(wei))
  } catch {
    return '0'
  }
  const [whole, frac = ''] = asEther.split('.')
  const trimmedFrac = frac.slice(0, 4).replace(/0+$/, '')
  return trimmedFrac ? `${whole}.${trimmedFrac}` : whole
}

function SponsorRow(props: { sponsor: SponsorInfo }) {
  const { sponsor } = props
  const meta = chainMeta(sponsor.chainId)
  const [copied, setCopied] = useState(false)

  const copy = () => {
    void navigator.clipboard?.writeText(sponsor.address).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div className="sponsor-row">
      <span className="pill">
        {meta.name} {sponsor.chainId}
      </span>
      <span className="mono trunc sponsor-addr">{short(sponsor.address, 8, 6)}</span>
      <button type="button" className="edit" onClick={copy} title="Copy sponsor address">
        <Icon icon={copied ? 'mdi:check' : 'mdi:content-copy'} />
      </button>
      <span className="mono sponsor-balance">
        {trimBalance(sponsor.balance)} {meta.symbol}
      </span>
    </div>
  )
}

/**
 * Ambient footer status for the gasless-deploy relay — its per-chain sponsor address + current
 * native balance, so anyone can see how much gas is left and top it up themselves. Shown
 * regardless of which mode/chain the user is on; renders nothing if the relay is unreachable or
 * currently sponsors no chains (mirrors `fetchRelayConfig`'s "degrade to invisible" contract).
 */
export function SponsorStatus() {
  const [sponsors, setSponsors] = useState<SponsorInfo[]>([])

  useEffect(() => {
    let cancelled = false
    void fetchRelayConfig().then((cfg) => {
      if (!cancelled) setSponsors(cfg.sponsors)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (sponsors.length === 0) return null

  return (
    <div className="sponsor-status">
      <p className="hint" style={{ margin: '0 0 8px' }}>
        Gasless Safe deploys on these chains are paid for by the relay's own address below — anyone
        can keep them running by sending it native gas.
      </p>
      {sponsors.map((s) => (
        <SponsorRow key={s.chainId} sponsor={s} />
      ))}
    </div>
  )
}
