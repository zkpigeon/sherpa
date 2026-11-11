import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Agent, AgentId, Attempt, AttemptId, Clock, Commit, Iso, Module, ModuleId } from '../../shared/api.ts'
import { beyond, cardView, progress } from './card.ts'

const start = Date.parse('2026-11-03T01:00:00Z')
const at = (min: number) => new Date(start + min * 60_000).toISOString() as Iso
const now = start + 72 * 60_000

const running: Clock = { kind: 'running', startedAt: at(0), deadline: at(90), maxMinutes: 90, extensions: [], waits: [], waitedMinutes: 0 }

function moduleWith(over: Partial<Module>): Module {
  return {
    id: 'm5' as ModuleId,
    position: 3,
    title: 'early termination',
    status: { state: 'active' },
    steps: [
      { title: 'a', done: true, failedTurns: 0 },
      { title: 'b', done: false, failedTurns: 0 },
      { title: 'c', done: false, failedTurns: 0 },
    ],
    goal: { metric: 'p95 latency', unit: 'ms', direction: 'lower', targetGain: 10, minGain: 2, ambitious: false, baseline: 371, target: 334 },
    verifiers: { kind: 'missing' },
    changes: [],
    best: 352,
    bestCommit: null,
    headCommit: null,
    streak: 1,
    attempts: [],
    clock: running,
    retryOf: null,
    flags: [],
    ...over,
  }
}

function agentWith(m: Module | null, over: Partial<Agent> = {}): Agent {
  return {
    id: '1' as AgentId,
    blurb: 'Skipping low-impact query terms.',
    line: '',
    project: m ? { title: 'search-perf', goal: null, end: null, stopNote: null, progress: null, reached: null, state: m.status.state === 'passed' ? 'needsModule' : 'open', modules: [m], current: m.status.state === 'passed' ? null : m.id } : null,
    queued: [],
    ...over,
  }
}

const verifying: Attempt = { id: 'a12' as AttemptId, step: 2, commit: 'c0ffee' as Commit, note: '', job: 'running', verdict: null, median: null, postedAt: at(70), judgedAt: null }

test('active: progress from the baseline, time left, and a spinner while an attempt is with the runner', () => {
  const c = cardView(agentWith(moduleWith({ attempts: [verifying] })), now)!
  assert.deepEqual(c.dot, { tone: 'accent', busy: true })
  assert.deepEqual(c.corner, { text: '18 min left', tone: 'faint' })
  assert.equal(c.sub, 'search-perf · early termination')
  assert.equal(c.metric, 'p95 latency')
  assert.deepEqual(c.value, { kind: 'number', best: 352, unit: 'ms' })
  assert.equal(c.target, 'target 334')
  assert.deepEqual(c.under, { text: '51% of the way from 371', chip: null })
  assert.equal(c.blurb, 'Skipping low-impact query terms.')
  assert.equal(c.callout, null)
  assert.equal(cardView(agentWith(moduleWith({})), now)!.dot.busy, false)
})

test('stuck keeps the blurb and adds the reason as its one callout', () => {
  const c = cardView(agentWith(moduleWith({ status: { state: 'stuck', cause: 'step' }, clock: { kind: 'stopped', startedAt: at(0), at: at(60), maxMinutes: 90, extensions: [], waits: [], waitedMinutes: 0 } })), now)!
  assert.deepEqual(c.dot, { tone: 'danger', busy: false })
  assert.deepEqual(c.corner, { text: 'Stuck', tone: 'danger' })
  assert.equal(c.bar.tone, 'ink')
  assert.equal(c.blurb, 'Skipping low-impact query terms.')
  assert.deepEqual(c.callout, { tone: 'danger', text: 'Step 2 failed 3 times. The agent has to abandon it with a reason.' })
  const time = cardView(agentWith(moduleWith({ status: { state: 'stuck', cause: 'time' } })), now)!
  assert.equal(time.callout?.text, 'It ran out of time. The agent has to abandon it with a reason.')
})

test('grace: time is up, and the callout counts down the last attempt', () => {
  const grace: Clock = { kind: 'grace', startedAt: at(0), deadline: at(70), graceEnds: at(79), maxMinutes: 90, extensions: [], waits: [], waitedMinutes: 0 }
  const c = cardView(agentWith(moduleWith({ clock: grace })), now)!
  assert.deepEqual(c.dot, { tone: 'warning', busy: false })
  assert.deepEqual(c.corner, { text: 'Time is up', tone: 'warning' })
  assert.deepEqual(c.callout, { tone: 'warning', text: '1 attempt left. The module times out in 7 min.' })
  assert.equal(cardView(agentWith(moduleWith({ clock: grace, attempts: [verifying] })), now)!.callout?.text, 'Its last attempt is with the runner.')
})

test('pending: nothing measured yet, the target as a percentage, and what it waits for', () => {
  const m = moduleWith({ status: { state: 'pending', waitingFor: 'verifiers' }, clock: { kind: 'notStarted' }, best: null, goal: { ...moduleWith({}).goal, baseline: null, target: null } })
  const c = cardView(agentWith(m, { blurb: '' }), now)!
  assert.deepEqual(c.dot, { tone: 'idle', busy: false })
  assert.deepEqual(c.corner, { text: 'Not started', tone: 'faint' })
  assert.deepEqual(c.value, { kind: 'none', text: 'Not measured yet' })
  assert.equal(c.target, 'target 10%')
  assert.equal(c.bar.share, 0)
  assert.deepEqual(c.under, { text: 'Waiting for its verifiers', chip: null })
  assert.equal(c.blurb, null)
})

test('past target: a full green bar, how far past, the streak, and a flag as the callout', () => {
  const flag = { kind: 'touchedVerifier' as const, attempt: 'a5' as AttemptId, detail: '', at: at(40) }
  const c = cardView(agentWith(moduleWith({ status: { state: 'pastTarget' }, best: 311, streak: 3, flags: [flag] })), now)!
  assert.deepEqual(c.dot, { tone: 'success', busy: false })
  assert.deepEqual(c.bar, { share: 1, tone: 'success' })
  assert.deepEqual(c.under, { text: 'Past target by 7%', chip: '3 in a row' })
  assert.equal(c.callout?.tone, 'warning')
  assert.match(c.callout?.text ?? '', /^1 flag to review: /)
})

test('every module ended: the project stays open, and the card says the agent owes the next module', () => {
  const c = cardView(agentWith(moduleWith({ status: { state: 'passed' }, best: 330, clock: { kind: 'stopped', startedAt: at(0), at: at(80), maxMinutes: 90, extensions: [], waits: [], waitedMinutes: 0 } }), { queued: ['index-size'] }), now)!
  assert.deepEqual(c.corner, { text: 'Needs a module', tone: 'warning' })
  assert.deepEqual(c.under, { text: 'Met its target', chip: null })
  assert.deepEqual(c.callout, { tone: 'warning', text: 'Every module has ended. The agent has to add the next one.' })
})

test('an agent with no project gets the small card', () => {
  assert.equal(cardView(agentWith(null), now), null)
})

test('progress and how far past the target work in both directions', () => {
  assert.equal(progress(moduleWith({})), 19 / 37)
  const higher = moduleWith({ goal: { metric: 'throughput', unit: 'docs/s', direction: 'higher', targetGain: 12, minGain: 2, ambitious: false, baseline: 1790, target: 2005 }, best: 2140 })
  assert.equal(progress(higher), 1)
  assert.equal(beyond(higher), 7)
  assert.equal(beyond(moduleWith({})), 0)
})
