import type { AttemptDetail, Board } from '../../../shared/api.ts'
import type { BoardSource } from '../source.ts'
import { changeRecord, decideChange, settle, stopProject } from '../../../server/domain/commands.ts'
import type { World } from '../../../server/domain/records.ts'
import { attemptDetailOf, boardOf } from '../../../server/domain/view.ts'
import { initialWorld } from './fixtures.ts'
import { MOCK_CONFIG } from './runner.ts'
import { TIMELINE } from './timeline.ts'

export interface MockOptions {
  /** ms between timeline events. After the last one the board still refreshes at this pace. */
  every?: number
  now?: () => number
}

export function createMockSource({ every = 3500, now = Date.now }: MockOptions = {}): BoardSource {
  let world: World = initialWorld(now())
  let next = 0
  let stopped = false
  let board: Board = boardOf(world, now())
  let details = new Map<string, AttemptDetail | null>()
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setInterval> | undefined

  const publish = (at: number) => {
    settle(world, at, MOCK_CONFIG)
    board = boardOf(world, at)
    details = new Map()
    for (const listener of listeners) listener()
  }

  const tick = () => {
    const at = now()
    const event = TIMELINE[next++]
    const draft = structuredClone(world)
    try {
      event?.run(draft, at)
      world = draft
    } catch (e) {
      // Once you stop a project, the script's later events for its agent have nowhere to land
      if (!stopped) throw e
      world = structuredClone(world)
    }
    publish(at)
  }

  return {
    current: () => board,
    subscribe(listener) {
      listeners.add(listener)
      timer ??= setInterval(tick, every)
      return () => {
        listeners.delete(listener)
        if (listeners.size || timer === undefined) return
        clearInterval(timer)
        timer = undefined
      }
    },
    attempt(agent, module, attempt) {
      const key = `${agent}/${module}/${attempt}`
      if (!details.has(key)) details.set(key, attemptDetailOf(world, agent, module, attempt))
      return details.get(key) ?? null
    },
    async review(change) {
      const found = changeRecord(world, change)
      if (!found) return null
      const { a, m, c } = found
      // The mock keeps no verifier files, only their paths
      return { change: c.id, agent: a.id, module: m.id, moduleTitle: m.title, author: c.author, reason: c.reason, state: c.state, note: c.note ?? null, stale: false, files: c.changed.map((path) => ({ path, before: null, after: null })), settings: [] }
    },
    async decide(change, approve, note) {
      const at = now()
      world = structuredClone(world)
      const r = decideChange(world, at, { change, approve, ...(note ? { note } : {}) }, MOCK_CONFIG)
      if (!r.ok) return r.rejection.message
      publish(at)
      return null
    },
    async stop(agent, project, note) {
      const at = now()
      world = structuredClone(world)
      const r = stopProject(world, at, { agent, project, ...(note ? { note } : {}) }, MOCK_CONFIG)
      if (!r.ok) return r.rejection.message
      stopped = true
      publish(at)
      return null
    },
  }
}
