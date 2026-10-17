import './Screens.css'

export function WakingUp() {
  return (
    <div className="state-panel" role="status">
      <p className="state-title">Waking up the stargazing engine…</p>
      <p className="state-text">The server naps when nobody is looking. This can take up to a minute.</p>
    </div>
  )
}

export function LoadingCards() {
  return (
    <div className="spot-skeletons">
      <p className="sr-only" role="status">
        Finding dark skies…
      </p>
      {[0, 1, 2].map((i) => (
        <div key={i} className="spot-skeleton" aria-hidden="true" />
      ))}
    </div>
  )
}
