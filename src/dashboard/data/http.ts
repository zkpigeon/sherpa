// The dashboard's data from sherpa-server. It polls GET /api/board, loads an
// attempt's detail when a page asks for it, and reloads that detail when the
// board shows the attempt has moved on. The browser sends the cookie it got
// at sign-in; once that stops working, the page reloads to the sign-in page.
import type { AgentId, AttemptDetail, AttemptId, Board, ChangeId, ChangeReview, ModuleId } from '../../shared/api.ts'
import type { BoardSource } from './source.ts'

export interface HttpOptions {
  /** ms between polls. */
  every?: number
  base?: string
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  // Signed out, or the admin token changed
  if (res.status === 401) location.reload()
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  return (await res.json()) as T
}

/** Resolves once the first board has loaded, so no page renders an empty board. */
export async function createHttpSource({ every = 3000, base = '' }: HttpOptions = {}): Promise<BoardSource> {
  let board = await getJson<Board>(`${base}/api/board`)
  const details = new Map<string, AttemptDetail | null>()
  const loading = new Set<string>()
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setInterval> | undefined
  const notify = () => {
    for (const l of listeners) l()
  }

  const key = (agent: string, module: string, attempt: string) => `${agent}/${module}/${attempt}`
  function load(agent: AgentId, module: ModuleId, attempt: AttemptId) {
    const k = key(agent, module, attempt)
    if (loading.has(k)) return
    loading.add(k)
    getJson<AttemptDetail>(`${base}/api/agents/${agent}/modules/${module}/attempts/${attempt}`)
      .then((d) => details.set(k, d))
      .catch(() => details.set(k, details.get(k) ?? null))
      .finally(() => {
        loading.delete(k)
        notify()
      })
  }

  async function poll() {
    try {
      board = await getJson<Board>(`${base}/api/board`)
    } catch (e) {
      console.warn(`Couldn't refresh the board: ${(e as Error).message}`)
      return
    }
    // Reload a detail whose attempt has moved on; keep showing the old one meanwhile
    for (const [k, d] of details) {
      const [agent, module, attempt] = k.split('/') as [AgentId, ModuleId, AttemptId]
      const now = board.agents.find((a) => a.id === agent)?.project?.modules.find((m) => m.id === module)?.attempts.find((x) => x.id === attempt)
      if (now && (!d || d.attempt.job !== now.job || d.attempt.verdict !== now.verdict)) load(agent, module, attempt)
    }
    notify()
  }

  return {
    current: () => board,
    subscribe(listener) {
      listeners.add(listener)
      timer ??= setInterval(poll, every)
      return () => {
        listeners.delete(listener)
        if (listeners.size || timer === undefined) return
        clearInterval(timer)
        timer = undefined
      }
    },
    attempt(agent, module, attempt) {
      const k = key(agent, module, attempt)
      if (!details.has(k)) load(agent, module, attempt)
      return details.get(k) ?? null
    },
    review: (change: ChangeId) => getJson<ChangeReview>(`${base}/admin/changes/${change}`).catch(() => null),
    async decide(change: ChangeId, approve: boolean, note?: string) {
      const res = await fetch(`${base}/admin/changes/${change}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve, ...(note ? { note } : {}) }) })
      if (res.ok) {
        await poll()
        return null
      }
      const body = (await res.json().catch(() => null)) as { message?: string } | null
      return body?.message ?? `sherpa-server answered ${res.status}`
    },
    async signOut() {
      await fetch(`${base}/signout`, { method: 'POST' }).catch(() => {})
      location.reload()
    },
  }
}
