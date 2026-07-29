import type { ReactNode } from 'react'
import { StakeInput } from '../StakeInput'

export const BetTray = ({ amount, onAmount, min, quick, action, children }: {
  amount: string; onAmount: (v: string) => void; min?: string; quick?: ReactNode; action: ReactNode; children?: ReactNode
}) => (
  <div className="bet">
    <div className="top"><span>Amount</span>{min && <span>{min}</span>}</div>
    <StakeInput value={amount} onChange={onAmount} placeholder="stake" />
    {quick}
    {children}
    {action}
    <div className="pf-link">🤝 Provably fair — replay the transcript ↗</div>
  </div>
)
