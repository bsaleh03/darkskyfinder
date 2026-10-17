/** Only absolute http(s) links are clickable; anything else (javascript:, data:, relative) is plain text. */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function SourcesList({ sources }: { sources: { name: string; url: string }[] }) {
  if (sources.length === 0) return null
  return (
    <div className="spot-section">
      <h4 className="spot-heading">Recommended by</h4>
      <ul className="sources">
        {sources.map((s) => (
          <li key={`${s.name}|${s.url}`}>
            {isWebUrl(s.url) ? (
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                {s.name}
              </a>
            ) : (
              s.name
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
