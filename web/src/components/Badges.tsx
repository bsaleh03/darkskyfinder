interface Props {
  darkSky: boolean
  recommended: boolean
  crossesBorder: boolean
}

export function Badges({ darkSky, recommended, crossesBorder }: Props) {
  if (!darkSky && !recommended && !crossesBorder) return null
  return (
    <ul className="badges">
      {darkSky && <li className="badge badge--dark-sky">Dark Sky place</li>}
      {recommended && <li className="badge badge--recommended">Recommended</li>}
      {crossesBorder && <li className="badge badge--border">{'Crosses border 🇨🇦'}</li>}
    </ul>
  )
}
