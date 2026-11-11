import { AgentPage } from './pages/AgentPage.tsx'
import { AttemptPage } from './pages/AttemptPage.tsx'
import { BoardPage } from './pages/BoardPage.tsx'
import { NotFound } from './pages/NotFound.tsx'
import { useSignOut } from './data/hooks.tsx'
import { Link, usePathname } from './router.tsx'
import { matchRoute } from './view/routes.ts'

export function App() {
  const route = matchRoute(usePathname())
  const signOut = useSignOut()
  return (
    <div className="app">
      <div className="app-bar">
        <Link href="/" className="app-bar__brand">
          <span className="app-bar__mark" aria-hidden>
            S
          </span>
          Sherpa
        </Link>
        {signOut && (
          <button type="button" className="app-bar__action" onClick={() => signOut()}>
            Sign out
          </button>
        )}
      </div>
      <main>
        {route.page === 'board' && <BoardPage />}
        {route.page === 'agent' && <AgentPage key={route.agent} id={route.agent} />}
        {route.page === 'attempt' && <AttemptPage key={`${route.agent}/${route.module}/${route.attempt}`} agent={route.agent} module={route.module} attempt={route.attempt} />}
        {route.page === 'notFound' && <NotFound what="page" />}
      </main>
    </div>
  )
}
