export function SourcesList({ sources }: { sources: { name: string; url: string }[] }) {
  if (sources.length === 0) return null
  return (
    <div className="spot-section">
      <h4 className="spot-heading">Recommended by</h4>
      <ul className="sources">
        {sources.map((s) => (
          <li key={s.url}>
            <a href={s.url} target="_blank" rel="noopener noreferrer">
              {s.name}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
