import { useState, type ReactNode } from 'react'

export const MetaPanel = ({ tabs, children }: { tabs: string[]; children: ReactNode }) => {
  const [active, setActive] = useState(0)
  return (
    <div className="meta">
      <div className="tabs">
        {tabs.map((t, i) => (
          <div key={t} className={i === active ? 'on' : ''} onClick={() => setActive(i)}>{t}</div>
        ))}
      </div>
      <div className="pl">{children}</div>
    </div>
  )
}
