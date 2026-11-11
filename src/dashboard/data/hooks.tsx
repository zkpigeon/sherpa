import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { AgentId, AttemptId, ModuleId } from '../../shared/api.ts'
import type { BoardSource } from './source.ts'

const SourceContext = createContext<BoardSource | null>(null)

export function SourceProvider({ source, children }: { source: BoardSource; children: ReactNode }) {
  return <SourceContext.Provider value={source}>{children}</SourceContext.Provider>
}

function useSource(): BoardSource {
  const source = useContext(SourceContext)
  if (!source) throw new Error('useBoard needs a SourceProvider')
  return source
}

function useSubscribe(source: BoardSource) {
  return useCallback((listener: () => void) => source.subscribe(listener), [source])
}

export function useBoard() {
  const source = useSource()
  return useSyncExternalStore(useSubscribe(source), () => source.current())
}

/** The source's change-request action, or null when it has none. */
export function useDecide() {
  const source = useSource()
  return source.decide ? source.decide.bind(source) : null
}

/** The source's stop-project action, or null when it has none. */
export function useStop() {
  const source = useSource()
  return source.stop ? source.stop.bind(source) : null
}

/** The source's change-request diff, or null when it has none. */
export function useReview() {
  const source = useSource()
  return source.review ? source.review.bind(source) : null
}

/** The source's sign-out, or null when it has none. */
export function useSignOut() {
  const source = useSource()
  return source.signOut ? source.signOut.bind(source) : null
}

export function useAttemptDetail(agent: AgentId, module: ModuleId, attempt: AttemptId) {
  const source = useSource()
  return useSyncExternalStore(useSubscribe(source), () => source.attempt(agent, module, attempt))
}

// One ticker for the whole page, so every "min left" turns over together
let now = Date.now()
const ticking = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

function subscribeNow(listener: () => void) {
  ticking.add(listener)
  now = Date.now()
  timer ??= setInterval(() => {
    now = Date.now()
    for (const l of ticking) l()
  }, 1000)
  return () => {
    ticking.delete(listener)
    if (ticking.size || timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }
}

/** The current time in ms, updated every second. */
export const useNow = () => useSyncExternalStore(subscribeNow, () => now)
