import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Agent, AgentId, AttemptId, Clock, Commit, Iso, Module, ModuleId } from './api.ts'
import { boardLine } from './boardLine.ts'

const now = new Date('2026-11-03T02:22:00Z')
const iso = (s: string) => s as Iso

function moduleWith(over: Partial<Module>): Module {
  return {
    id: 'm1' as ModuleId,
    position: 2,
    title: 'query cache',
    status: { state: 'active' },
    steps: [
      { title: 'a', done: true, failedTurns: 0 },
      { title: 'b', done: true, failedTurns: 0 },
      { title: 'c', done: true, failedTurns: 0 },
      { title: 'd', done: false, failedTurns: 1 },
      { title: 'e', done: false, failedTurns: 0 },
      { title: 'f', done: false, failedTurns: 0 },
      { title: 'g', done: false, failedTurns: 0 },
    ],
    goal: { metric: 'p95 latency', unit: 'ms', direction: 'lower', targetGain: 10, minGain: 2, ambitious: false, baseline: 371, target: 334 },
    verifiers: { kind: 'missing' },
    changes: [],
    best: 352,
    bestCommit: null,
    headCommit: null,
    streak: 2,
    attempts: [],
    clock: { kind: 'running', startedAt: iso('2026-11-03T01:00:00Z'), deadline: iso('2026-11-03T03:00:00Z'), maxMinutes: 90, extensions: [], waits: [], waitedMinutes: 0 },
    retryOf: null,
    flags: [],
    ...over,
  }
}

function agentWith(m: Module): Agent {
  const filler = (id: string, position: number) => ({ ...moduleWith({}), id: id as ModuleId, position })
  return {
    id: '1' as AgentId,
    blurb: 'Caching parsed queries.',
    line: '',
    project: { title: 'search-perf', goal: null, end: null, stopNote: null, progress: null, reached: null, state: 'open', modules: [filler('m0', 1), m, filler('m2', 3), filler('m3', 4), filler('m4', 5)], current: m.id },
    queued: [],
  }
}

test('matches the format in DESIGN.md', () => {
  assert.equal(
    boardLine(agentWith(moduleWith({})), now),
    'agent 1: Project: search-perf, Module (2 / 5): query cache, Progress: 3 / 7, Blurb: Caching parsed queries. Goal: p95 latency 371 -> 334 ms, 10% lower. Best so far 352 ms. 2 wins in a row. 38 min left.',
  )
  // No best until a win moves it off the baseline
  assert.doesNotMatch(boardLine(agentWith(moduleWith({ best: 371 })), now), /Best so far/)
})

test('warns while the current module is the last one, so the agent plans the next before it ends', () => {
  const m = moduleWith({})
  const a = agentWith(m)
  a.project!.modules = a.project!.modules.map((x) => (x.id === m.id ? x : { ...x, status: { state: 'passed' } }))
  assert.match(boardLine(a, now), /2 wins in a row\. Last module in the project\. Plan the next one before this one ends\. 38 min left\.$/)
})

test('an ended project sums up what it did and where to start the next one', () => {
  const passed = (id: string, position: number, baseline: number, best: number, head: string) =>
    moduleWith({ id: id as ModuleId, position, status: { state: 'passed' }, goal: { ...moduleWith({}).goal, baseline }, best, bestCommit: head as Commit })
  const a = agentWith(moduleWith({}))
  a.project = {
    title: 'search-perf',
    goal: null,
    state: 'ended',
    end: 'stopped',
    stopNote: null,
    progress: null,
    reached: null,
    current: null,
    modules: [passed('m1', 1, 415, 371, 'a'.repeat(40)), { ...moduleWith({ id: 'm2' as ModuleId, position: 2 }), status: { state: 'abandoned', reason: 'x', followUp: null } }, passed('m3', 3, 371, 331, '9be1c04'.padEnd(40, '0'))],
  }
  // 415 -> 371 and 371 -> 331, chained, plus the abandoned module's 352 against its 371 baseline
  assert.equal(boardLine(a, now), 'agent 1: Project: search-perf ended: 2 passed, 1 abandoned. p95 latency about 24% lower overall. The admin stopped it. A new project would start from 9be1c04.')
  // Once the final job has measured start against end in one job, that's the number
  a.project.progress = { state: 'measuring' }
  assert.match(boardLine(a, now), /abandoned\. Measuring its start against its end in one job now\./)
  a.project.progress = { state: 'done', metric: 'p95 latency', unit: 'ms', direction: 'lower', from: 415, to: 318, gain: 23.4, p: 0.004 }
  assert.match(boardLine(a, now), /abandoned\. p95 latency 415 -> 318 ms, 23% lower over the project\. The admin stopped it\./)
  a.project.stopNote = 'Enough for tonight.'
  assert.match(boardLine(a, now), /The admin stopped it\. "Enough for tonight\." A new project/)
})

test('small values keep three significant figures', () => {
  const m = moduleWith({ goal: { ...moduleWith({}).goal, baseline: 4.49, target: 4.04 }, best: 3.81 })
  assert.match(boardLine(agentWith(m), now), /Goal: p95 latency 4\.49 -> 4\.04 ms, 10% lower\. Best so far 3\.81 ms\./)
})

test('leaves the streak out below 2 wins and the numbers out before a baseline', () => {
  const m = moduleWith({ streak: 1, goal: { ...moduleWith({}).goal, baseline: null, target: null } })
  assert.match(boardLine(agentWith(m), now), /Blurb: Caching parsed queries\. Goal: p95 latency, 10% lower\. 38 min left\.$/)
})

test('says when time is up and one attempt is left', () => {
  const clock: Clock = { kind: 'grace', startedAt: iso('2026-11-03T00:30:00Z'), deadline: iso('2026-11-03T02:00:00Z'), graceEnds: iso('2026-11-03T02:09:00Z'), maxMinutes: 90, extensions: [], waits: [], waitedMinutes: 0 }
  assert.match(boardLine(agentWith(moduleWith({ clock })), now), /Time is up, 1 attempt left\.$/)
})

test('every wait names what to do meanwhile', () => {
  const notStarted: Clock = { kind: 'notStarted' }
  assert.match(boardLine(agentWith(moduleWith({ status: { state: 'stuck', cause: 'step' }, clock: { kind: 'stopped', startedAt: null, at: iso('2026-11-03T02:00:00Z'), maxMinutes: 90, extensions: [], waits: [], waitedMinutes: 0 } })), now), /Stuck\. Abandon it with a reason now, then move on\.$/)
  assert.match(boardLine(agentWith(moduleWith({ status: { state: 'pending', waitingFor: 'verifiers' }, clock: notStarted })), now), /Waiting for its verifiers\. Meanwhile, plan the next module, or work ahead on this one's first step\.$/)
  assert.match(boardLine(agentWith(moduleWith({ status: { state: 'pending', waitingFor: 'baseline' }, clock: notStarted })), now), /Waiting for its baseline\. Meanwhile, read the module and plan its first attempt\. Run nothing heavy, since it skews the runner\.$/)
  const frozen = { kind: 'frozen' as const, hash: 'abc', tests: 1, author: 'verifier', hardware: 'cpu', openChanges: 0 }
  assert.match(
    boardLine(agentWith(moduleWith({ status: { state: 'pending', waitingFor: 'verifiers' }, verifiers: frozen, clock: notStarted })), now),
    /Its baseline failed on its verifiers, so it waits for the verifier's fix\. Meanwhile, plan the next module/,
    'frozen verifiers it still waits for are ones its baseline failed on',
  )
  const verifying = { id: 'a12' as AttemptId, step: 4, commit: 'c0ffee' as Commit, note: '', job: 'running' as const, verdict: null, median: null, postedAt: iso('2026-11-03T02:20:00Z'), judgedAt: null }
  assert.match(boardLine(agentWith(moduleWith({ attempts: [verifying] })), now), /38 min left\. a12 is with the runner\. Meanwhile, plan the next attempt\. Run nothing heavy, since it skews the runner\.$/)
})

test('an agent with no open project says so', () => {
  assert.equal(boardLine({ id: '3' as AgentId, blurb: '', line: '', project: null, queued: [] }, now), 'agent 3: no open project')
})
