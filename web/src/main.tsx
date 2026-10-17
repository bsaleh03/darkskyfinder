import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { makeQueryClient } from './api/queries'
import './theme/tokens.css'
import './theme/red.css'
import './theme/global.css'

const queryClient = makeQueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App client={queryClient} />
  </StrictMode>,
)
