import type { ReactNode } from 'react'

export const GameStage = ({ title, subtitle, action, children }: {
  title: string; subtitle?: string; action?: ReactNode; children: ReactNode
}) => (
  <div className="stage-col">
    <div className="gtitle">
      <h1>{title}</h1>
      {subtitle && <span className="sub">{subtitle}</span>}
      {action && <span className="pf">{action}</span>}
    </div>
    <div className="stage">{children}</div>
  </div>
)
