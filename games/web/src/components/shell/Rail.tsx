// games/web/src/components/shell/Rail.tsx
export const Rail = ({ games, active, onPick }: {
  games: { id: string; label: string }[]; active: string; onPick: (id: string) => void
}) => (
  <nav className="rail">
    <div className="mark">M</div>
    {games.map((g) => (
      <div key={g.id} className={`ico${g.id === active ? ' on' : ''}`} title={g.label} onClick={() => onPick(g.id)}>
        {g.label.split(' ')[0]}
      </div>
    ))}
  </nav>
)
