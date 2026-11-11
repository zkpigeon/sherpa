// The base styles load first, so each part's own CSS can override them
import './styles/tokens.css'
import './styles/base.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { SourceProvider } from './data/hooks.tsx'
import type { BoardSource } from './data/source.ts'

// sherpa-server serves the built dashboard; the hosted demo and `npm run dev` use the mock
const data = import.meta.env.VITE_DATA ?? (import.meta.env.DEV ? 'mock' : 'http')

async function sourceFor(): Promise<BoardSource> {
  if (data === 'mock') return (await import('./data/mock/source.ts')).createMockSource()
  return (await import('./data/http.ts')).createHttpSource()
}

const root = createRoot(document.getElementById('root')!)
try {
  const source = await sourceFor()
  root.render(
    <StrictMode>
      <SourceProvider source={source}>
        <App />
      </SourceProvider>
    </StrictMode>,
  )
} catch (e) {
  root.render(<p className="empty">Couldn’t load the board from sherpa-server: {(e as Error).message}</p>)
}
