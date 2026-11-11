import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CleanResults, Commit } from '../../shared/api.ts'
import {
  abandon,
  addModule,
  claimJob,
  createProject,
  decideChange,
  fileChange,
  freezeVerifiers,
  postAttempt,
  renewLease,
  replaceVerifiers,
  sendResults,
  setBlurb,
  settle,
  stepDone,
  stopProject,
  type Ticket,
} from './commands.ts'
import { agentOf, currentOf, factsOf, locate } from './queries.ts'
import { judge } from './judge.ts'
import { DEFAULTS, MINUTE, emptyWorld, type GoalSpec, type ModuleSpec, type Ms, type VerifierSpec, type World } from './records.ts'
import type { RejectionCode, Result } from './result.ts'
import { resultsTsv } from './resultsTsv.ts'
import { LIFECYCLE, nextState } from './rules.ts'
import { agentProjectOf, attemptDetailOf, attemptStatusOf, boardOf, boardText, changeOf, stepStatusOf } from './view.ts'

const T0 = Date.parse('2026-11-03T00:00:00Z')
const at = (min: number): Ms => T0 + min * MINUTE
const commit = (name: string) => [...name].map((c) => c.charCodeAt(0).toString(16)).join('').padEnd(40, '0').slice(0, 40) as Commit
const START = commit('start')

const GOAL: GoalSpec = { metric: 'p95 latency', unit: 'ms', direction: 'lower', targetGain: 10 }
const mod = (title: string, steps = ['first', 'second'], extra: Partial<ModuleSpec> = {}): ModuleSpec => ({ title, steps, goal: GOAL, ...extra })
const verifiers = (steps: number, hash = 'h1', hardware = 'cpu'): VerifierSpec => ({
  hash,
  paths: ['bench/latency.ts', 'test/regression.test.ts'],
  image: 'node:26-slim',
  commands: { regression: 'npm test -- regression', steps: Array.from({ length: steps }, (_, i) => `npm test -- step-${i + 1}`), benchmark: 'npm run bench' },
  hardware,
  timeLimitMinutes: 20,
})

function must<T>(r: Result<T>): T {
  if (!r.ok) assert.fail(`${r.rejection.code}: ${r.rejection.message}`)
  return r.value
}

/** Checks the call is rejected with `code` and leaves the world exactly as it was. */
function rejects(w: World, when: Ms, call: (w: World) => Result<unknown>, code: RejectionCode) {
  settle(w, when)
  const before = structuredClone(w)
  const r = call(w)
  assert.equal(r.ok, false, `expected ${code}`)
  if (!r.ok) assert.equal(r.rejection.code, code, r.rejection.message)
  assert.deepEqual(w, before, `${code} left the world changed`)
}

const OFFSETS = [0, 1, -1, 2, -2]
const around = (c: Commit, v: number) => OFFSETS.map((k) => ({ commit: c, value: v + k * 0.2, work: 1000 }))

/** A runner claims the next job and reports its runs: `value` on the commit under test, the best value on the best commit. */
function run(w: World, when: Ms, value: number, opts: { tests?: [number, number]; runner?: string; labels?: string[]; took?: number; clean?: CleanResults } = {}): Ticket {
  const runner = opts.runner ?? 'r1'
  const t = must(claimJob(w, when, { runner, labels: opts.labels ?? ['cpu'] }))
  assert.ok(t, 'a job to claim')
  const { p, m } = locate(w, t.agent, t.module)!
  const best = factsOf(p, m, when).bestValue
  const runs = t.commits.length === 1 ? around(t.commit, t.kind === 'baseline' || best === null ? value : best) : around(t.commits[0]!, best!).flatMap((x, i) => [x, around(t.commit, value)[i]!])
  const [passed, total] = opts.tests ?? [10, 10]
  must(sendResults(w, when + (opts.took ?? 0) * MINUTE, { job: t.job, runner, results: { outcome: 'done', tests: { passed, total }, runs, touched: [], ...(opts.clean ? { clean: opts.clean } : {}) } }))
  return t
}

/** One agent with one open project, its first module's verifiers frozen and its baseline measured at minute 1. */
function started(modules: ModuleSpec[] = [mod('cache'), mod('index', ['only'])], baseline = 100) {
  const w = emptyWorld()
  must(createProject(w, at(0), { agent: 'a', spec: { title: 'search', startCommit: START, modules } }))
  must(freezeVerifiers(w, at(0), { agent: 'a', module: 'm1', author: 'verifier', verifiers: verifiers(modules[0]!.steps.length) }))
  run(w, at(1), baseline)
  return w
}

const moduleOf = (w: World, id: string) => locate(w, 'a', id)!.m
const viewOf = (w: World, id: string, now: Ms) => boardOf(w, now).agents[0]!.project!.modules.find((m) => m.id === id)!
const attempt = (w: World, when: Ms, id: string, value: number, opts: Parameters<typeof run>[3] = {}) => {
  must(postAttempt(w, when, { agent: 'a', module: current(w), attempt: id, commit: commit(id), note: `Try ${id}.` }))
  return run(w, when, value, opts)
}
const current = (w: World) => currentOf(agentOf(w, 'a')!.project!)!.id
const step = (w: World, when: Ms, n: number, value: number) => {
  must(stepDone(w, when, { agent: 'a', module: current(w), step: n }))
  return run(w, when, value)
}

/** The runner measures the project: `from` on its start commit, `to` on the commit it has reached. */
function measure(w: World, when: Ms, from: number, to: number) {
  const t = must(claimJob(w, when, { runner: 'r1', labels: ['cpu'] }))!
  assert.equal(t.kind, 'final')
  const runs = around(t.commits[0]!, from).flatMap((x, i) => [x, around(t.commit, to)[i]!])
  must(sendResults(w, when, { job: t.job, runner: 'r1', results: { outcome: 'done', tests: { passed: 0, total: 0 }, runs, touched: [] } }))
  return t
}

const lineOf = (w: World, when: Ms) => boardOf(w, when).agents[0]!.line
const projectView = (w: World, when: Ms) => boardOf(w, when).agents[0]!.project!

const WITH_GOAL = (goal: Partial<NonNullable<Parameters<typeof createProject>[2]['spec']['goal']>>, modules: ModuleSpec[] = [mod('cache', ['one'])]) => ({
  title: 'search',
  startCommit: START,
  goal: { metric: 'p95 latency', unit: 'ms', direction: 'lower' as const, ...goal },
  modules,
})

test('the lifecycle table moves only the states DESIGN.md allows', () => {
  assert.equal(nextState('baselineMeasured', 'pending'), 'active')
  assert.equal(nextState('metTargetStepsLeft', 'active'), 'pastTarget')
  assert.equal(nextState('lastStepDone', 'active'), 'stuck')
  assert.equal(nextState('lastStepDone', 'pastTarget'), 'passed')
  assert.equal(nextState('outOfTime', 'pastTarget'), 'passed')
  assert.equal(nextState('abandoned', 'pastTarget'), null)
  assert.equal(nextState('stepFailed', 'pastTarget'), null)
  // Ended modules never move again, and nothing moves back to pending
  for (const row of Object.values(LIFECYCLE)) {
    assert.ok(!('passed' in row) && !('abandoned' in row))
    assert.ok(!Object.values(row).includes('pending' as never))
  }
})

test('goals stay conservative and specs are checked before anything is stored', () => {
  const w = emptyWorld()
  const create = (spec: object) => (x: World) => createProject(x, at(0), { agent: 'a', spec: { title: 'p', startCommit: START, modules: [mod('m')], ...spec } as never })
  rejects(w, at(0), create({ modules: [mod('m', ['s'], { goal: { ...GOAL, targetGain: 25 } })] }), 'badSpec')
  rejects(w, at(0), create({ modules: [mod('m', ['s'], { goal: { ...GOAL, targetGain: 5, minGain: 6 } })] }), 'badSpec')
  rejects(w, at(0), create({ maxMinutes: 121 }), 'badSpec')
  rejects(w, at(0), create({ modules: [] }), 'badSpec')
  rejects(w, at(0), create({ startCommit: 'main' }), 'badSpec')
  rejects(w, at(0), create({ modules: [mod('m'), mod('m')] }), 'badSpec')
  rejects(w, at(0), create({ modules: [mod('m', ['s'], { retryOf: 'm1' })] }), 'badSpec')
  rejects(w, at(0), (x) => createProject(x, at(0), { agent: 'not an id', spec: { title: 'p', startCommit: START, modules: [mod('m')] } }), 'badSpec')
  assert.equal(w.agents.length, 0)
  // An ambitious goal may go past the cap, and minGain defaults to 2
  must(create({ modules: [mod('m', ['s'], { goal: { ...GOAL, targetGain: 25, ambitious: true } })] })(w))
  assert.equal(moduleOf(w, 'm1').goal.minGain, 2)
  assert.equal(moduleOf(w, 'm1').maxMinutes, 90)
})

test('a module starts once its verifiers freeze and its baseline lands, then passes on its target', () => {
  const w = emptyWorld()
  must(createProject(w, at(0), { agent: 'a', spec: { title: 'search', startCommit: START, modules: [mod('cache'), mod('index', ['only'])] } }))
  assert.deepEqual(viewOf(w, 'm1', at(0)).status, { state: 'pending', waitingFor: 'verifiers' })
  assert.deepEqual(viewOf(w, 'm2', at(0)).status, { state: 'pending', waitingFor: 'turn' })
  rejects(w, at(0), (x) => postAttempt(x, at(0), { agent: 'a', module: 'm1', attempt: 'a0', commit: commit('a0'), note: 'Early.' }), 'wrongState')

  must(freezeVerifiers(w, at(0), { agent: 'a', module: 'm1', author: 'verifier', verifiers: verifiers(2) }))
  assert.deepEqual(viewOf(w, 'm1', at(0)).status, { state: 'pending', waitingFor: 'baseline' })
  const base = run(w, at(1), 100)
  assert.equal(base.kind, 'baseline')
  assert.deepEqual(base.commits, [START])
  const m1 = viewOf(w, 'm1', at(1))
  assert.equal(m1.status.state, 'active')
  assert.equal(m1.goal.baseline, 100)
  assert.equal(m1.goal.target, 90)
  assert.equal(m1.clock.kind, 'running')

  const a1 = attempt(w, at(5), 'a1', 95)
  assert.deepEqual(a1.commits, [START, commit('a1')])
  assert.deepEqual(a1.tests, ['npm test -- regression'])
  assert.equal(viewOf(w, 'm1', at(5)).attempts[0]!.verdict, 'win')
  // The finished step held the metric, so it earns the first extension
  const check = step(w, at(7), 1, 95)
  assert.equal(check.kind, 'stepCheck')
  assert.deepEqual(check.commits, [commit('a1')])
  assert.deepEqual(check.tests, ['npm test -- regression', 'npm test -- step-1'])
  assert.deepEqual(
    factsOf(locate(w, 'a', 'm1')!.p, moduleOf(w, 'm1'), at(7)).extensions.map((e) => [e.minutes, e.cause]),
    [[45, 'step']],
  )
  const a2 = attempt(w, at(10), 'a2', 89)
  assert.deepEqual(a2.tests, ['npm test -- regression', 'npm test -- step-1'])
  // The target fell on the last step, so the module passes instead of going past target
  assert.equal(viewOf(w, 'm1', at(10)).status.state, 'passed')
  assert.equal(boardOf(w, at(10)).agents[0]!.project!.current, 'm2')

  must(freezeVerifiers(w, at(11), { agent: 'a', module: 'm2', author: 'verifier', verifiers: verifiers(1, 'h2') }))
  // The project measures how far it has come in the background, first in line
  measure(w, at(12), 100, 89)
  const next = run(w, at(12), 89)
  assert.deepEqual(next.commits, [commit('a2')], 'the next module starts from the passed module’s head commit')
})

test('a win that meets the target with steps left goes past target, even as the first win', () => {
  const w = started([mod('cache', ['one', 'two', 'three'])])
  attempt(w, at(5), 'a1', 50)
  const m = viewOf(w, 'm1', at(5))
  assert.deepEqual([m.status.state, m.streak], ['pastTarget', 1])
  // It keeps going while it wins, and the first attempt that isn't a win passes it
  attempt(w, at(10), 'a2', 45)
  assert.equal(viewOf(w, 'm1', at(10)).status.state, 'pastTarget')
  attempt(w, at(15), 'a3', 45)
  assert.equal(viewOf(w, 'm1', at(15)).status.state, 'passed')
})

test('a target met on a streak with steps left goes past target, and the first non-win passes it', () => {
  const w = started([mod('cache', ['one', 'two', 'three'])])
  attempt(w, at(5), 'a1', 95)
  attempt(w, at(10), 'a2', 89)
  const m = viewOf(w, 'm1', at(10))
  assert.equal(m.status.state, 'pastTarget')
  assert.equal(m.streak, 2)
  assert.deepEqual(
    m.clock.kind === 'running' && m.clock.extensions.map((e) => [e.minutes, e.cause]),
    [[45, 'streak']],
  )
  attempt(w, at(15), 'a3', 89)
  assert.equal(viewOf(w, 'm1', at(15)).status.state, 'passed')
})

test('the third failed turn on a step makes the module stuck, and abandoning it drops its commits', () => {
  const w = started()
  for (const [i, id] of ['a1', 'a2', 'a3'].entries()) attempt(w, at(5 + i * 5), id, 100, { tests: [8, 10] })
  const m = viewOf(w, 'm1', at(20))
  assert.deepEqual(m.status, { state: 'stuck', cause: 'step' })
  assert.equal(m.steps[0]!.failedTurns, 3)
  assert.equal(boardOf(w, at(20)).agents[0]!.line.endsWith('Stuck. Abandon it with a reason now, then move on.'), true)
  rejects(w, at(21), (x) => postAttempt(x, at(21), { agent: 'a', module: 'm1', attempt: 'a4', commit: commit('a4'), note: 'Again.' }), 'wrongState')
  rejects(w, at(21), (x) => stepDone(x, at(21), { agent: 'a', module: 'm1', step: 1 }), 'wrongState')
  rejects(w, at(21), (x) => abandon(x, at(21), { agent: 'a', module: 'm1', reason: 'Nothing worked.', followUp: mod('cache retry') }), 'followUpNotAllowed')
  rejects(w, at(21), (x) => abandon(x, at(21), { agent: 'a', module: 'm1', reason: '' }), 'badSpec')

  must(abandon(w, at(22), { agent: 'a', module: 'm1', reason: 'Every attempt assumed the cache fits in memory.' }))
  assert.deepEqual(viewOf(w, 'm1', at(22)).status, { state: 'abandoned', reason: 'Every attempt assumed the cache fits in memory.', followUp: null })
  // Repeating the call changes nothing
  const before = structuredClone(w)
  must(abandon(w, at(22), { agent: 'a', module: 'm1', reason: 'Something else.' }))
  assert.deepEqual(w, before)
  must(freezeVerifiers(w, at(23), { agent: 'a', module: 'm2', author: 'verifier', verifiers: verifiers(1, 'h2') }))
  assert.deepEqual(run(w, at(24), 100).commits, [START], 'a module abandoned without a win leaves its start commit')
})

test('abandoning a module with a win takes a follow-up, and a retry aims lower and happens once', () => {
  const w = started()
  attempt(w, at(5), 'a1', 95)
  const reason = 'Every attempt assumed hot keys repeat.'
  const abandonWith = (followUp?: ModuleSpec) => (x: World) => abandon(x, at(10), { agent: 'a', module: 'm1', reason, ...(followUp ? { followUp } : {}) })
  rejects(w, at(10), abandonWith(), 'followUpRequired')
  rejects(w, at(10), abandonWith(mod('cache retry', ['one'], { retryOf: 'm1' })), 'badSpec')
  rejects(w, at(10), abandonWith(mod('cache retry', ['one'], { retryOf: 'm2', goal: { ...GOAL, targetGain: 5 } })), 'badSpec')
  rejects(w, at(10), abandonWith(mod('index', ['one'])), 'titleTaken')

  const r = must(abandonWith(mod('cache retry', ['one', 'two'], { retryOf: 'm1', goal: { ...GOAL, targetGain: 5 } }))(w))
  assert.equal(r.followUp, 'm3')
  const p = boardOf(w, at(10)).agents[0]!.project!
  assert.deepEqual(
    p.modules.map((m) => [m.id, m.position]),
    [
      ['m1', 1],
      ['m3', 2],
      ['m2', 3],
    ],
  )
  assert.equal(p.current, 'm3')
  assert.equal(viewOf(w, 'm3', at(10)).retryOf, 'm1')

  must(freezeVerifiers(w, at(11), { agent: 'a', module: 'm3', author: 'verifier', verifiers: verifiers(2, 'h3') }))
  measure(w, at(12), 100, 95)
  assert.deepEqual(run(w, at(12), 95).commits, [commit('a1')], 'the follow-up starts from the best commit')
  attempt(w, at(15), 'b1', 92)
  rejects(
    w,
    at(20),
    (x) => abandon(x, at(20), { agent: 'a', module: 'm3', reason, followUp: mod('cache retry 2', ['one'], { retryOf: 'm3', goal: { ...GOAL, targetGain: 2 } }) }),
    'badSpec',
  )
  must(abandon(w, at(20), { agent: 'a', module: 'm3', reason, followUp: mod('cache warmup', ['one']) }))
})

test('the last step done without the target makes the module stuck, and a step that slips earns nothing', () => {
  const w = started([mod('cache', ['only'])])
  attempt(w, at(5), 'a1', 99)
  assert.equal(viewOf(w, 'm1', at(5)).attempts[0]!.verdict, 'flat')
  step(w, at(8), 1, 104)
  const m = viewOf(w, 'm1', at(8))
  assert.deepEqual(m.status, { state: 'stuck', cause: 'target' })
  assert.deepEqual(m.clock.kind === 'stopped' && m.clock.extensions, [])
})

test('a step check that fails its tests leaves the step open, and only the current step can be checked', () => {
  const w = started()
  rejects(w, at(2), (x) => stepDone(x, at(2), { agent: 'a', module: 'm1', step: 2 }), 'wrongStep')
  rejects(w, at(2), (x) => stepDone(x, at(2), { agent: 'a', module: 'm1', step: 3 }), 'badSpec')
  must(stepDone(w, at(2), { agent: 'a', module: 'm1', step: 1 }))
  assert.equal(must(stepDone(w, at(2), { agent: 'a', module: 'm1', step: 1 })).done, false, 'a repeat returns the job in flight')
  rejects(w, at(2), (x) => postAttempt(x, at(2), { agent: 'a', module: 'm1', attempt: 'a1', commit: commit('a1'), note: 'Now.' }), 'jobInFlight')
  run(w, at(3), 100, { tests: [9, 10] })
  assert.equal(viewOf(w, 'm1', at(3)).steps[0]!.done, false)
  // The same check again returns the stored result instead of rerunning
  const again = must(stepDone(w, at(4), { agent: 'a', module: 'm1', step: 1 }))
  assert.equal(again.done, false)
  assert.equal(moduleOf(w, 'm1').jobs.filter((j) => j.kind === 'stepCheck').length, 1)
})

test('one job in flight at a time, and a repeat post returns the stored attempt', () => {
  const w = started()
  const posted = must(postAttempt(w, at(5), { agent: 'a', module: 'm1', attempt: 'a1', commit: commit('a1'), note: 'Try.' }))
  assert.deepEqual(must(postAttempt(w, at(6), { agent: 'a', module: 'm1', attempt: 'a1', commit: commit('a1'), note: 'Try.' })), posted)
  rejects(w, at(6), (x) => postAttempt(x, at(6), { agent: 'a', module: 'm1', attempt: 'a1', commit: commit('other'), note: 'Try.' }), 'attemptIdTaken')
  rejects(w, at(6), (x) => postAttempt(x, at(6), { agent: 'a', module: 'm1', attempt: 'a2', commit: commit('a2'), note: 'Try.' }), 'jobInFlight')
  rejects(w, at(6), (x) => postAttempt(x, at(6), { agent: 'a', module: 'm1', attempt: 'bad id', commit: commit('a2'), note: 'Try.' }), 'badSpec')
  rejects(w, at(6), (x) => postAttempt(x, at(6), { agent: 'a', module: 'm9', attempt: 'a2', commit: commit('a2'), note: 'Try.' }), 'noModule')
  rejects(w, at(6), (x) => postAttempt(x, at(6), { agent: 'b', module: 'm1', attempt: 'a2', commit: commit('a2'), note: 'Try.' }), 'noAgent')
  run(w, at(7), 99)
  rejects(w, at(8), (x) => postAttempt(x, at(8), { agent: 'a', module: 'm1', attempt: 'a2', commit: START, note: 'The start.' }), 'alreadyBest')
})

test('reposting a commit returns its stored result instead of rolling the dice again', () => {
  const w = started()
  attempt(w, at(5), 'a1', 99)
  const jobs = moduleOf(w, 'm1').jobs.length
  const r = must(postAttempt(w, at(10), { agent: 'a', module: 'm1', attempt: 'a2', commit: commit('a1'), note: 'Same again.' }))
  const m = moduleOf(w, 'm1')
  assert.equal(m.jobs.length, jobs)
  assert.equal(r.job, m.attempts[0]!.job)
  assert.equal(m.attempts[1]!.judged?.verdict, 'flat')
  assert.equal(attemptStatusOf(w, 'a', 'm1', 'a2', at(10))?.job, 'done')
})

test('a runner repeating its results changes nothing, and results for a cancelled job are ignored', () => {
  const w = started()
  must(postAttempt(w, at(5), { agent: 'a', module: 'm1', attempt: 'a1', commit: commit('a1'), note: 'Try.' }))
  const t = must(claimJob(w, at(5), { runner: 'r1', labels: ['cpu'] }))!
  const results = { outcome: 'done' as const, tests: { passed: 10, total: 10 }, runs: around(START, 100).flatMap((x, i) => [x, around(commit('a1'), 95)[i]!]), touched: [] }
  rejects(w, at(6), (x) => sendResults(x, at(6), { job: t.job, runner: 'r2', results }), 'notYourJob')
  rejects(w, at(6), (x) => sendResults(x, at(6), { job: t.job, runner: 'r1', results: { ...results, runs: [{ commit: commit('elsewhere') as Commit, value: 1, work: 1 }] } }), 'badResults')
  rejects(w, at(6), (x) => sendResults(x, at(6), { job: 'j99', runner: 'r1', results }), 'noJob')
  must(sendResults(w, at(6), { job: t.job, runner: 'r1', results }))
  const before = structuredClone(w)
  assert.deepEqual(must(sendResults(w, at(6), { job: t.job, runner: 'r1', results })), { state: 'done' })
  assert.deepEqual(w, before)

  must(postAttempt(w, at(8), { agent: 'a', module: 'm1', attempt: 'a2', commit: commit('a2'), note: 'Try.' }))
  const t2 = must(claimJob(w, at(8), { runner: 'r1', labels: ['cpu'] }))!
  must(abandon(w, at(9), { agent: 'a', module: 'm1', reason: 'The cache was never the bottleneck.', followUp: mod('cache warmup', ['one']) }))
  assert.deepEqual(must(renewLease(w, at(9), { job: t2.job, runner: 'r1' })), { state: 'cancelled', leaseUntil: null })
  assert.deepEqual(must(sendResults(w, at(10), { job: t2.job, runner: 'r1', results })), { state: 'cancelled' })
  assert.equal(attemptStatusOf(w, 'a', 'm1', 'a2', at(10))?.verdict, null)
  assert.deepEqual(attemptDetailOf(w, 'a' as never, 'm1' as never, 'a2' as never)?.runs, [])
})

test('a lapsed lease puts the job back in the queue, and the wait counts against no one', () => {
  const w = started()
  must(postAttempt(w, at(5), { agent: 'a', module: 'm1', attempt: 'a1', commit: commit('a1'), note: 'Try.' }))
  const t = must(claimJob(w, at(5), { runner: 'r1', labels: ['cpu'] }))!
  assert.equal(must(renewLease(w, at(6), { job: t.job, runner: 'r1' })).leaseUntil, new Date(at(8)).toISOString())
  // r1 goes quiet; its lease ends at minute 8
  settle(w, at(10))
  assert.equal(moduleOf(w, 'm1').jobs.at(-1)!.state, 'queued')
  rejects(w, at(10), (x) => renewLease(x, at(10), { job: t.job, runner: 'r1' }), 'notYourJob')
  const again = must(claimJob(w, at(12), { runner: 'r2', labels: ['cpu'] }))!
  assert.equal(again.job, t.job)
  const f = factsOf(locate(w, 'a', 'm1')!.p, moduleOf(w, 'm1'), at(12))
  assert.equal(f.waited, 4, 'from the lapse at 8 to the new claim at 12')
  assert.equal(f.deadline, at(1 + 90 + 4))
})

test('waiting for a runner stops the clock, even while the wait goes on', () => {
  const w = started()
  must(postAttempt(w, at(5), { agent: 'a', module: 'm1', attempt: 'a1', commit: commit('a1'), note: 'Try.' }))
  const f = (now: number) => factsOf(locate(w, 'a', 'm1')!.p, moduleOf(w, 'm1'), at(now))
  assert.equal(f(15).waited, 10)
  assert.equal(f(15).deadline, at(1 + 90 + 10))
  run(w, at(20), 99)
  assert.equal(f(30).waited, 15)
  assert.deepEqual(viewOf(w, 'm1', at(30)).clock.kind === 'running' && viewOf(w, 'm1', at(30)).clock, {
    kind: 'running',
    startedAt: new Date(at(1)).toISOString(),
    deadline: new Date(at(106)).toISOString(),
    maxMinutes: 90,
    extensions: [],
    waits: [{ at: new Date(at(5)).toISOString(), minutes: 15 }],
    waitedMinutes: 15,
  })
})

test('hardware labels route jobs to runners that have them', () => {
  const w = emptyWorld()
  must(createProject(w, at(0), { agent: 'a', spec: { title: 'decode', startCommit: START, modules: [mod('kernels')] } }))
  must(freezeVerifiers(w, at(0), { agent: 'a', module: 'm1', author: 'verifier', verifiers: verifiers(2, 'h1', 'gpu') }))
  assert.equal(must(claimJob(w, at(1), { runner: 'cpu-1', labels: ['cpu'] })), null)
  assert.equal(must(claimJob(w, at(1), { runner: 'gpu-1', labels: ['cpu', 'gpu'] }))?.hardware, 'gpu')
})

test('the oldest queued job goes first', () => {
  const w = started()
  must(createProject(w, at(2), { agent: 'b', spec: { title: 'ingest', startCommit: START, modules: [mod('batches')] } }))
  must(postAttempt(w, at(3), { agent: 'a', module: 'm1', attempt: 'a1', commit: commit('a1'), note: 'Try.' }))
  must(freezeVerifiers(w, at(4), { agent: 'b', module: 'm1', author: 'verifier', verifiers: verifiers(2) }))
  assert.equal(must(claimJob(w, at(5), { runner: 'r1', labels: ['cpu'] }))?.agent, 'a')
  assert.equal(must(claimJob(w, at(5), { runner: 'r2', labels: ['cpu'] }))?.agent, 'b')
})

test('past the deadline the module gets one last attempt, in the grace period if none was in flight', () => {
  const w = started([mod('cache', ['one', 'two'], { maxMinutes: 30 })])
  // Started at minute 1: the deadline is 31 and grace lasts 3 minutes
  assert.equal(viewOf(w, 'm1', at(32)).clock.kind, 'grace')
  assert.match(boardOf(w, at(32)).agents[0]!.line, /Time is up, 1 attempt left\.$/)
  rejects(w, at(32), (x) => stepDone(x, at(32), { agent: 'a', module: 'm1', step: 1 }), 'timeIsUp')
  attempt(w, at(32), 'a1', 99, { took: 1 })
  assert.deepEqual(viewOf(w, 'm1', at(33)).status, { state: 'stuck', cause: 'time' })
  const stopped = viewOf(w, 'm1', at(33)).clock
  assert.equal(stopped.kind === 'stopped' && stopped.at, new Date(at(33)).toISOString())

  const idle = started([mod('cache', ['one', 'two'], { maxMinutes: 30 })])
  settle(idle, at(40))
  assert.deepEqual(viewOf(idle, 'm1', at(40)).status, { state: 'stuck', cause: 'time' })
  assert.equal(moduleOf(idle, 'm1').stoppedAt, at(34), 'it ran out when the grace period ended')
  rejects(idle, at(40), (x) => postAttempt(x, at(40), { agent: 'a', module: 'm1', attempt: 'late', commit: commit('late'), note: 'Late.' }), 'wrongState')
})

test('an attempt in flight at the deadline is the last one, and a win that extends the deadline carries on', () => {
  const w = started([mod('cache', ['one', 'two', 'three'], { maxMinutes: 30 })])
  attempt(w, at(10), 'a1', 95)
  must(postAttempt(w, at(30), { agent: 'a', module: 'm1', attempt: 'a2', commit: commit('a2'), note: 'Try.' }))
  assert.equal(viewOf(w, 'm1', at(33)).clock.kind, 'running', 'no grace period opens while the last attempt is in flight')
  rejects(w, at(33), (x) => postAttempt(x, at(33), { agent: 'a', module: 'm1', attempt: 'a3', commit: commit('a3'), note: 'Try.' }), 'jobInFlight')
  // The second win in a row earns 15 minutes, which moves the deadline past the present
  run(w, at(36), 92)
  const m = viewOf(w, 'm1', at(36))
  assert.equal(m.status.state, 'active')
  assert.equal(m.clock.kind === 'running' && m.clock.deadline, new Date(at(1 + 30 + 15 + 6)).toISOString(), 'the job waited 6 minutes for a runner')

  const pastTarget = started([mod('cache', ['one', 'two', 'three'], { maxMinutes: 30 })])
  attempt(pastTarget, at(5), 'a1', 95)
  attempt(pastTarget, at(10), 'a2', 89)
  assert.equal(viewOf(pastTarget, 'm1', at(10)).status.state, 'pastTarget')
  settle(pastTarget, at(60))
  assert.equal(viewOf(pastTarget, 'm1', at(60)).status.state, 'passed', 'running out of time passes a module past its target')
})

test('a failed baseline flags the module, and approved verifiers measure it again', () => {
  const w = emptyWorld()
  must(createProject(w, at(0), { agent: 'a', spec: { title: 'search', startCommit: START, modules: [mod('cache')] } }))
  must(freezeVerifiers(w, at(0), { agent: 'a', module: 'm1', author: 'a', verifiers: verifiers(2) }))
  run(w, at(1), 100, { tests: [9, 10] })
  const m = viewOf(w, 'm1', at(1))
  assert.deepEqual(m.status, { state: 'pending', waitingFor: 'verifiers' })
  assert.deepEqual(
    m.flags.map((f) => f.kind),
    ['selfAuthoredVerifiers', 'baselineFailed'],
  )
  assert.equal(must(claimJob(w, at(2), { runner: 'r1', labels: ['cpu'] })), null, 'it waits for new verifiers')
  rejects(w, at(2), (x) => freezeVerifiers(x, at(2), { agent: 'a', module: 'm1', author: 'verifier', verifiers: verifiers(2, 'h2') }), 'verifiersFrozen')
  rejects(w, at(2), (x) => fileChange(x, at(2), { agent: 'a', module: 'm1', reason: 'Same files.', proposed: verifiers(2) }), 'badSpec')

  const { change } = must(fileChange(w, at(2), { agent: 'a', module: 'm1', reason: 'A regression test depends on the network.', proposed: verifiers(2, 'h2') }))
  const frozen = viewOf(w, 'm1', at(2)).verifiers
  assert.equal(frozen.kind === 'frozen' && frozen.openChanges, 1)
  assert.equal(changeOf(w, 'a', 'm1', change)?.state, 'open')
  must(decideChange(w, at(3), { change, approve: true }))
  rejects(w, at(3), (x) => decideChange(x, at(3), { change, approve: false }), 'changeDecided')
  assert.equal(changeOf(w, 'a', 'm1', change)?.state, 'approved')
  const t = run(w, at(4), 100)
  assert.equal(t.verifierHash, 'h2')
  assert.equal(viewOf(w, 'm1', at(4)).status.state, 'active')

  must(replaceVerifiers(w, at(5), { agent: 'a', module: 'm1', verifiers: verifiers(2, 'h3') }))
  const v = viewOf(w, 'm1', at(5)).verifiers
  assert.deepEqual(v.kind === 'frozen' && [v.hash, v.author, v.tests], ['h3', 'admin', 10])
})

test('the admin stops a project: what hasn’t ended is abandoned, a win keeps its commit, and the next queued project opens', () => {
  const w = started([mod('cache', ['one', 'two']), mod('index', ['only'])])
  const next = { title: 'index-size', startCommit: commit('index'), modules: [mod('compression', ['only'])] }
  assert.deepEqual(must(createProject(w, at(2), { agent: 'a', spec: next })), { state: 'queued', position: 1 })
  assert.deepEqual(must(createProject(w, at(2), { agent: 'a', spec: next })), { state: 'queued', position: 1 })
  rejects(w, at(2), (x) => createProject(x, at(2), { agent: 'a', spec: { ...next, startCommit: commit('other') } }), 'titleTaken')
  attempt(w, at(5), 'a1', 95)
  must(postAttempt(w, at(6), { agent: 'a', module: 'm1', attempt: 'a2', commit: commit('a2'), note: 'In flight.' }))

  assert.deepEqual(must(stopProject(w, at(7), { agent: 'a', project: 'search', note: 'Enough for tonight.' })), { project: 'search', stoppedAt: new Date(at(7)).toISOString() })
  assert.equal(attemptStatusOf(w, 'a', 'm1', 'a2', at(7))!.job, 'cancelled')
  const stopped = agentOf(w, 'a')!.past.at(-1)!
  assert.deepEqual(
    stopped.modules.map((m) => [m.id, m.state, m.reason]),
    [
      ['m1', 'abandoned', 'Stopped by the admin. Enough for tonight.'],
      ['m2', 'abandoned', 'Stopped by the admin. Enough for tonight.'],
    ],
  )
  // The win stays: the project is measured up to it
  assert.deepEqual(must(claimJob(w, at(8), { runner: 'r1', labels: ['cpu'] }))!.commits, [START, commit('a1')])
  const a = boardOf(w, at(8)).agents[0]!
  assert.deepEqual([a.project!.title, a.project!.state, a.queued], ['index-size', 'open', []])

  // Naming the project makes a repeat safe after the next one has opened
  const before = structuredClone(w)
  must(stopProject(w, at(9), { agent: 'a', project: 'search', note: 'Again.' }))
  assert.deepEqual(w, before)
  rejects(w, at(9), (x) => stopProject(x, at(9), { agent: 'b' }), 'noOpenProject')
  rejects(w, at(9), (x) => createProject(x, at(9), { agent: 'a', spec: { title: 'search', startCommit: START, modules: [mod('again')] } }), 'titleTaken')
})

test('a new module goes right after the current one, and a repeat returns it', () => {
  const w = started()
  const extra = mod('early termination', ['only'])
  assert.deepEqual(must(addModule(w, at(2), { agent: 'a', spec: extra })), { module: 'm3', position: 2 })
  assert.deepEqual(must(addModule(w, at(3), { agent: 'a', spec: extra })), { module: 'm3', position: 2 })
  // A second addition queues behind the first, not ahead of it
  assert.deepEqual(must(addModule(w, at(3), { agent: 'a', spec: mod('score bound', ['only']) })), { module: 'm4', position: 3 })
  rejects(w, at(3), (x) => addModule(x, at(3), { agent: 'a', spec: mod('early termination', ['other']) }), 'titleTaken')
  rejects(w, at(3), (x) => addModule(x, at(3), { agent: 'a', spec: mod('retry', ['one'], { retryOf: 'm1' }) }), 'badSpec')
  rejects(w, at(3), (x) => addModule(x, at(3), { agent: 'nobody', spec: extra }), 'noAgent')
  assert.deepEqual(
    boardOf(w, at(3)).agents[0]!.project!.modules.map((m) => m.id),
    ['m1', 'm3', 'm4', 'm2'],
  )
})

test('the dashboard flags a touched verifier, fewer tests, and less work', () => {
  const w = started()
  must(postAttempt(w, at(5), { agent: 'a', module: 'm1', attempt: 'a1', commit: commit('a1'), note: 'Try.' }))
  let t = must(claimJob(w, at(5), { runner: 'r1', labels: ['cpu'] }))!
  const runs = (work: number) => around(START, 100).flatMap((x, i) => [x, { ...around(commit('a1'), 99)[i]!, work }])
  must(sendResults(w, at(6), { job: t.job, runner: 'r1', results: { outcome: 'done', tests: { passed: 10, total: 10 }, runs: runs(1000), touched: ['bench/latency.ts'] } }))
  must(postAttempt(w, at(7), { agent: 'a', module: 'm1', attempt: 'a2', commit: commit('a2'), note: 'Try.' }))
  t = must(claimJob(w, at(7), { runner: 'r1', labels: ['cpu'] }))!
  // a1 was flat, so the best commit is still the start commit
  const fewer = around(START, 100).flatMap((x, i) => [x, { ...around(commit('a2'), 97)[i]!, work: 500 }])
  must(sendResults(w, at(8), { job: t.job, runner: 'r1', results: { outcome: 'done', tests: { passed: 8, total: 8 }, runs: fewer, touched: [] } }))
  assert.deepEqual(
    viewOf(w, 'm1', at(8)).flags.map((f) => [f.kind, f.attempt]),
    [
      ['touchedVerifier', 'a1'],
      ['fewerTests', 'a2'],
      ['lessWork', 'a2'],
    ],
  )
})

test('a killed job is a failed turn', () => {
  const w = started()
  must(postAttempt(w, at(5), { agent: 'a', module: 'm1', attempt: 'a1', commit: commit('a1'), note: 'Try.' }))
  const t = must(claimJob(w, at(5), { runner: 'r1', labels: ['cpu'] }))!
  for (let min = 6; min <= 24; min++) must(renewLease(w, at(min), { job: t.job, runner: 'r1' }))
  must(sendResults(w, at(25), { job: t.job, runner: 'r1', results: { outcome: 'killed', tests: null, runs: [], touched: [] } }))
  const m = viewOf(w, 'm1', at(25))
  assert.deepEqual([m.attempts[0]!.job, m.attempts[0]!.verdict, m.steps[0]!.failedTurns], ['killed', 'fail', 1])
})

test('blurbs are one line, and the plain board lists every agent', () => {
  const w = started()
  rejects(w, at(2), (x) => setBlurb(x, at(2), { agent: 'a', blurb: 'two\nlines' }), 'badSpec')
  must(setBlurb(w, at(2), { agent: 'a', blurb: 'Caching parsed queries.' }))
  must(setBlurb(w, at(2), { agent: 'b', blurb: 'Starting up.' }))
  assert.equal(
    boardText(w, at(2)),
    [
      'agent a: Project: search, Module (1 / 2): cache, Progress: 0 / 2, Blurb: Caching parsed queries. Goal: p95 latency 100 -> 90 ms, 10% lower. 89 min left.',
      'agent b: no open project',
    ].join('\n'),
  )
})

test('defaults match DESIGN.md', () => {
  assert.deepEqual(DEFAULTS, { defaultMaxMinutes: 90, maxMinutesCeiling: 120, leaseMinutes: 2, runs: 5 })
})

test('a job the runner couldn’t run goes back in the queue, and after three tries fails without a verdict', () => {
  const w = started()
  must(postAttempt(w, at(5), { agent: 'a', module: 'm1', attempt: 'a1', commit: commit('a1'), note: 'Try.' }))
  const error = { outcome: 'error' as const, tests: null, runs: [], touched: [], error: 'The Docker daemon is down.' }
  for (const [i, runner] of ['r1', 'r2', 'r3'].entries()) {
    const t = must(claimJob(w, at(6 + i), { runner, labels: ['cpu'] }))!
    assert.equal(t.commit, commit('a1'), 'the same job each time')
    must(sendResults(w, at(6 + i), { job: t.job, runner, results: error }))
  }
  const m = viewOf(w, 'm1', at(9))
  assert.deepEqual([m.attempts[0]!.job, m.attempts[0]!.verdict, m.steps[0]!.failedTurns, m.status.state], ['failed', null, 0, 'active'])
  assert.equal(must(claimJob(w, at(9), { runner: 'r1', labels: ['cpu'] })), null)
  // The module takes the next attempt; the runner's trouble wasn't the agent's turn
  must(postAttempt(w, at(10), { agent: 'a', module: 'm1', attempt: 'a2', commit: commit('a2'), note: 'Again.' }))
})

test('a commit the runner can’t fetch is a failed turn, and posting it again once pushed measures it', () => {
  const w = started()
  must(postAttempt(w, at(5), { agent: 'a', module: 'm1', attempt: 'a1', commit: commit('a1'), note: 'Forgot to push.' }))
  const t = must(claimJob(w, at(5), { runner: 'r1', labels: ['cpu'] }))!
  must(sendResults(w, at(6), { job: t.job, runner: 'r1', results: { outcome: 'badCommit', tests: null, runs: [], touched: [], error: 'Not in the remote.' } }))
  assert.equal(viewOf(w, 'm1', at(6)).steps[0]!.failedTurns, 1)
  must(postAttempt(w, at(7), { agent: 'a', module: 'm1', attempt: 'a2', commit: commit('a1'), note: 'Pushed now.' }))
  assert.equal(moduleOf(w, 'm1').jobs.at(-1)!.state, 'queued', 'a new job, not the stored failure')
})

test('a runner that holds a job far past its time limit loses it', () => {
  const w = started()
  must(postAttempt(w, at(5), { agent: 'a', module: 'm1', attempt: 'a1', commit: commit('a1'), note: 'Try.' }))
  const t = must(claimJob(w, at(5), { runner: 'r1', labels: ['cpu'] }))!
  // The job's limit is 20 minutes, plus 30 of grace; the runner keeps renewing
  for (let min = 6; min <= 60; min++) renewLease(w, at(min), { job: t.job, runner: 'r1' })
  const j = moduleOf(w, 'm1').jobs.at(-1)!
  assert.equal(j.state, 'queued')
  assert.equal(j.claims[0]!.endedAt, at(55))
  assert.match(j.claims[0]!.error ?? '', /past its time limit/)
})

test('results must have the asked-for runs on each commit, with positive values', () => {
  const w = started()
  must(postAttempt(w, at(5), { agent: 'a', module: 'm1', attempt: 'a1', commit: commit('a1'), note: 'Try.' }))
  const t = must(claimJob(w, at(5), { runner: 'r1', labels: ['cpu'] }))!
  const send = (runs: { commit: Commit; value: number; work: number }[]) => (x: World) => sendResults(x, at(6), { job: t.job, runner: 'r1', results: { outcome: 'done', tests: { passed: 1, total: 1 }, runs, touched: [] } })
  const twelve = [...around(START, 100), ...around(START, 100), ...around(START, 100).slice(0, 2)]
  rejects(w, at(6), send([...twelve, ...around(commit('a1'), 90)]), 'badResults')
  rejects(w, at(6), send([...around(START, 100), ...around(commit('a1'), 90).map((r) => ({ ...r, value: -r.value }))]), 'badResults')
  // None on the commit under test is how a runner says its benchmark crashed
  must(send(around(START, 100))(w))
  assert.equal(viewOf(w, 'm1', at(6)).attempts[0]!.verdict, 'fail')
})

test('repeating a project after it ended returns the first answer', () => {
  const w = started([mod('cache', ['only'])])
  attempt(w, at(5), 'a1', 89)
  must(stopProject(w, at(6), { agent: 'a' }))
  const spec = { title: 'search', startCommit: START, modules: [mod('cache', ['only'])] }
  assert.deepEqual(must(createProject(w, at(6), { agent: 'a', spec })), { state: 'ended', modules: ['m1'] })
})

test('an attempt’s answer carries its numbers and says why it got its verdict', () => {
  const w = started()
  attempt(w, at(5), 'a1', 95)
  const win = attemptStatusOf(w, 'a', 'm1', 'a1', at(5))!
  assert.deepEqual([win.verdict, win.median, win.bestMedian, win.tests], ['win', 95, 100, { passed: 10, total: 10 }])
  assert.equal(win.gain, 5)
  assert.match(win.why, /^Win: 5\.0% lower than the best commit \(needs 2%\), p = 0\.004 \(needs below 0\.05\)\.$/)
  attempt(w, at(10), 'a2', 94)
  assert.match(attemptStatusOf(w, 'a', 'm1', 'a2', at(10))!.why, /^Flat: 1\.1% lower than the best commit; needs 2%\.$/)
  attempt(w, at(15), 'a3', 110)
  assert.match(attemptStatusOf(w, 'a', 'm1', 'a3', at(15))!.why, /^Fail: 16% higher than the best commit, and the rank test shows it's reliably worse/)
  attempt(w, at(20), 'a4', 90, { tests: [8, 10] })
  assert.equal(attemptStatusOf(w, 'a', 'm1', 'a4', at(20))!.why, 'Fail: 2 of 10 tests failed.')
  must(postAttempt(w, at(25), { agent: 'a', module: 'm1', attempt: 'a5', commit: commit('a5'), note: 'Try.' }))
  assert.equal(attemptStatusOf(w, 'a', 'm1', 'a5', at(25))!.why, 'Queued for a runner.')
})

test('an attempt at a metric no worse is simpler only when it follows the frozen clean rules at a smaller size', () => {
  const goal = { direction: 'lower' as const, minGain: 2 }
  const best = [100, 100.2, 99.8, 100.4, 99.6]
  const passes = { passed: 10, total: 10 }
  const verdict = (next: number[], clean?: CleanResults, tests = passes) => judge({ tests, killed: false, best, next, clean }, goal).verdict
  const sized = (from: number, to: number, ok = { best: true, next: true }): CleanResults => ({ best: ok.best ? { passed: true, size: from } : { passed: false, size: from }, next: ok.next ? { passed: true, size: to } : { passed: false, size: to } })
  // 0.2% better with overlapping runs: short of a win, and no worse
  const equal = [99.8, 100, 99.6, 100.2, 99.4]
  assert.equal(verdict(equal, sized(812, 774)), 'simpler')
  assert.equal(verdict(equal, sized(812, 812)), 'flat', 'the same size is not simpler')
  assert.equal(verdict(equal, sized(812, 774, { best: true, next: false })), 'flat', 'a commit that breaks the clean rules is not simpler')
  assert.equal(verdict(equal, sized(812, 812, { best: false, next: true })), 'simpler', 'following rules the best commit broke, at no larger a size')
  assert.equal(verdict(equal), 'flat', 'without a clean command nothing changes')
  assert.equal(verdict(equal, sized(812, 774), { passed: 9, total: 10 }), 'fail')
  // A median even 0.4% worse is flat, however much smaller, or a run of trims could add up to a slower best commit
  assert.equal(verdict([100.4, 100.6, 100.2, 100.8, 100], sized(812, 700)), 'flat')
  // A real gain is still a win, however large the code
  assert.equal(verdict([95, 95.2, 94.8, 95.4, 94.6], sized(812, 900)), 'win')
})

test('a simpler attempt moves the best commit, but never meets the target or touches the streak', () => {
  const w = emptyWorld()
  const clean = (from: number, to: number): CleanResults => ({ best: { passed: true, size: from }, next: { passed: true, size: to } })
  must(createProject(w, at(0), { agent: 'a', spec: { title: 'search', startCommit: START, modules: [mod('cache', ['one', 'two', 'three'])] } }))
  const v = verifiers(3)
  must(freezeVerifiers(w, at(0), { agent: 'a', module: 'm1', author: 'verifier', verifiers: { ...v, commands: { ...v.commands, clean: 'npm run lint && node size.js' } } }))
  run(w, at(1), 100)
  attempt(w, at(5), 'a1', 91)
  // 1.6% lower is short of minGain, and its median reaches the target of 90, but a simpler attempt can't meet it
  attempt(w, at(10), 'a2', 89.5, { clean: clean(812, 774) })
  const status = attemptStatusOf(w, 'a', 'm1', 'a2', at(10))!
  assert.equal(status.verdict, 'simpler')
  assert.equal(status.why, 'Simpler: 1.6% lower than the best commit, short of a win, and 812 -> 774 in size under the clean rules.')
  let m = viewOf(w, 'm1', at(10))
  assert.deepEqual([m.status.state, m.bestCommit, m.best, m.streak, m.steps[0]!.failedTurns], ['active', commit('a2'), 89.5, 1, 0])
  assert.deepEqual(m.clock.kind === 'running' && m.clock.extensions, [], 'no time for trimming code')
  // The next win is measured against the simpler commit, and makes a streak of 2 with the win before it
  const a3 = attempt(w, at(15), 'a3', 87)
  assert.deepEqual(a3.commits, [commit('a2'), commit('a3')])
  m = viewOf(w, 'm1', at(15))
  assert.deepEqual([m.status.state, m.streak], ['pastTarget', 2])
  assert.deepEqual(m.clock.kind === 'running' && m.clock.extensions.map((e) => e.cause), ['streak'])
  // Past target, a simpler attempt keeps the module going, and a flat one passes it
  attempt(w, at(20), 'a4', 86.9, { clean: clean(774, 700) })
  assert.deepEqual([viewOf(w, 'm1', at(20)).status.state, viewOf(w, 'm1', at(20)).bestCommit], ['pastTarget', commit('a4')])
  attempt(w, at(25), 'a5', 86.9)
  assert.equal(viewOf(w, 'm1', at(25)).status.state, 'passed')
})

test('a step’s answer shows what its check found, and steps a module passed without are skipped', () => {
  const w = started([mod('cache', ['one', 'two', 'three'])])
  must(stepDone(w, at(2), { agent: 'a', module: 'm1', step: 1 }))
  assert.equal(stepStatusOf(w, 'a', 'm1', 1)!.check!.why, 'Queued for a runner.')
  run(w, at(3), 100, { tests: [9, 10] })
  const failed = stepStatusOf(w, 'a', 'm1', 1)!
  assert.deepEqual([failed.done, failed.check!.tests, failed.check!.why], [false, { passed: 9, total: 10 }, '1 of 10 tests failed, so the step stays open.'])
  // Past target on the first win, then passed by the next attempt that isn't a win
  attempt(w, at(5), 'a1', 89)
  attempt(w, at(6), 'a2', 89)
  assert.equal(viewOf(w, 'm1', at(6)).status.state, 'passed')
  assert.deepEqual([stepStatusOf(w, 'a', 'm1', 2)!.skipped, stepStatusOf(w, 'a', 'm1', 2)!.check], [true, null])
  rejects(w, at(6), (x) => stepDone(x, at(6), { agent: 'a', module: 'm1', step: 1 }), 'wrongState')
  assert.equal(stepStatusOf(w, 'a', 'm1', 9), null)
})

test('a verifier change on a started module measures the baseline again, so its target stays on the new scale', () => {
  const w = started([mod('cache', ['one', 'two', 'three'])])
  attempt(w, at(5), 'a1', 96)
  // An attempt in flight keeps its verifiers, and the new baseline waits for it
  must(postAttempt(w, at(6), { agent: 'a', module: 'm1', attempt: 'a2', commit: commit('a2'), note: 'Try.' }))
  must(replaceVerifiers(w, at(7), { agent: 'a', module: 'm1', verifiers: verifiers(3, 'h2') }))
  assert.equal(moduleOf(w, 'm1').jobs.filter((j) => j.kind === 'baseline').length, 1)
  const a2 = run(w, at(8), 95)
  assert.equal(a2.verifierHash, 'h1')
  // Now the baseline job runs on the new verifiers, on the start commit and the best commit
  const again = must(claimJob(w, at(9), { runner: 'r1', labels: ['cpu'] }))!
  assert.deepEqual([again.kind, again.verifierHash, again.commits], ['baseline', 'h2', [commit('a1'), START]])
  rejects(w, at(9), (x) => postAttempt(x, at(9), { agent: 'a', module: 'm1', attempt: 'a3', commit: commit('a3'), note: 'Too soon.' }), 'jobInFlight')
  // The new benchmark reads about half the old one
  const runs = around(commit('a1'), 48).flatMap((x, i) => [x, around(START, 50)[i]!])
  must(sendResults(w, at(10), { job: again.job, runner: 'r1', results: { outcome: 'done', tests: { passed: 10, total: 10 }, runs, touched: [] } }))
  const m = viewOf(w, 'm1', at(10))
  assert.deepEqual([m.goal.baseline, m.goal.target, m.best, m.status.state], [50, 45, 48, 'active'])
  assert.equal(m.clock.kind === 'running' && m.clock.startedAt, new Date(at(1)).toISOString(), 'the clock still runs from the first baseline')
})

test('a finished step earns an extension only if its check measured new work', () => {
  const w = started([mod('cache', ['one', 'two', 'three'])])
  // Nothing has changed since the start, so this check held the metric but earns nothing
  step(w, at(2), 1, 100)
  const f = () => factsOf(locate(w, 'a', 'm1')!.p, moduleOf(w, 'm1'), at(20))
  assert.deepEqual(f().extensions, [])
  assert.match(stepStatusOf(w, 'a', 'm1', 1)!.check!.why, /hadn't changed since the last step check/)
  attempt(w, at(5), 'a1', 99)
  step(w, at(8), 2, 99)
  assert.deepEqual(
    f().extensions.map((e) => [e.minutes, e.cause]),
    [[45, 'step']],
  )
})

test('a decision carries a note, and an approval can also reach modules that haven’t started', () => {
  const w = started([mod('cache', ['one']), mod('index', ['one', 'two'])])
  must(freezeVerifiers(w, at(2), { agent: 'a', module: 'm2', author: 'verifier', verifiers: verifiers(2, 'h2') }))
  const { change } = must(fileChange(w, at(3), { agent: 'a', module: 'm1', reason: 'The benchmark is too short.', proposed: verifiers(1, 'h1b') }))
  rejects(w, at(4), (x) => decideChange(x, at(4), { change, approve: true, others: [{ module: 'm1', verifiers: verifiers(1, 'h9') }] }), 'badSpec')
  const r = must(decideChange(w, at(4), { change, approve: true, note: 'Good catch.', others: [{ module: 'm2', verifiers: verifiers(2, 'h2b') }] }))
  assert.deepEqual(r, { state: 'approved', appliedTo: ['m2'] })
  assert.deepEqual([moduleOf(w, 'm2').verifiers.at(-1)!.hash, moduleOf(w, 'm2').verifiers.at(-1)!.author], ['h2b', 'verifier'])
  assert.deepEqual(changeOf(w, 'a', 'm1', change)!.note, 'Good catch.')
})

test('once every module has ended, the project waits for the next one, which starts where the project got to', () => {
  const w = started([mod('cache', ['one', 'two']), mod('index', ['only'])])
  attempt(w, at(5), 'a1', 85)
  // a flat attempt moves the head, but the module hands the next one its best commit
  attempt(w, at(6), 'a2', 85.5)
  assert.equal(viewOf(w, 'm1', at(6)).status.state, 'passed')
  must(freezeVerifiers(w, at(7), { agent: 'a', module: 'm2', author: 'verifier', verifiers: verifiers(1, 'h2') }))
  assert.deepEqual(measure(w, at(8), 100, 85).commits, [START, commit('a1')])
  assert.deepEqual(run(w, at(8), 85).commits, [commit('a1')])
  attempt(w, at(10), 'b1', 75)
  assert.deepEqual([projectView(w, at(10)).state, projectView(w, at(10)).progress], ['needsModule', { state: 'measuring' }])
  assert.equal(lineOf(w, at(10)), `agent a: Project: search, every module has ended. Add the next module to keep climbing from ${commit('b1').slice(0, 7)}.`)
  // The measurement never holds the agent back
  assert.deepEqual(must(addModule(w, at(11), { agent: 'a', spec: mod('scoring', ['only']) })), { module: 'm3', position: 3 })
  must(freezeVerifiers(w, at(11), { agent: 'a', module: 'm3', author: 'verifier', verifiers: verifiers(1, 'h3') }))
  assert.deepEqual(measure(w, at(12), 100, 76).commits, [START, commit('b1')])
  assert.deepEqual(run(w, at(12), 76).commits, [commit('b1')])
  assert.equal(projectView(w, at(12)).state, 'open')
})

test('a module’s verifiers can ask for more runs per commit', () => {
  const w = emptyWorld()
  must(createProject(w, at(0), { agent: 'a', spec: { title: 'noisy', startCommit: START, modules: [mod('cache')] } }))
  rejects(w, at(0), (x) => freezeVerifiers(x, at(0), { agent: 'a', module: 'm1', author: 'v', verifiers: { ...verifiers(2), runs: 40 } }), 'badSpec')
  must(freezeVerifiers(w, at(0), { agent: 'a', module: 'm1', author: 'v', verifiers: { ...verifiers(2), runs: 9 } }))
  const t = must(claimJob(w, at(1), { runner: 'r1', labels: ['cpu'] }))!
  assert.equal(t.runs, 9)
  rejects(w, at(1), (x) => sendResults(x, at(1), { job: t.job, runner: 'r1', results: { outcome: 'done', tests: { passed: 1, total: 1 }, runs: around(START, 100), touched: [] } }), 'badResults')
})

test('abandoning a module says where the next one starts', () => {
  const w = started([mod('cache', ['one']), mod('index', ['only'])])
  attempt(w, at(5), 'a1', 99)
  const r = must(abandon(w, at(6), { agent: 'a', module: 'm1', reason: 'Nothing here moves latency.' }))
  assert.deepEqual(r, { followUp: null, startsFrom: START }, 'a flat attempt is dropped with the module')
  must(freezeVerifiers(w, at(7), { agent: 'a', module: 'm2', author: 'verifier', verifiers: verifiers(1, 'h2') }))
  assert.match(boardOf(w, at(7)).agents[0]!.line, new RegExp(`Waiting for its baseline\\. It starts from ${START.slice(0, 7)}\\. Meanwhile, read the module and plan its first attempt\\.`))
})

test('results.tsv has a line for every attempt and every abandoned module, oldest project first', () => {
  const w = started([mod('cache', ['only']), mod('index', ['only'])])
  must(createProject(w, at(2), { agent: 'a', spec: { title: 'heap', startCommit: commit('heap'), modules: [mod('arena', ['only'])] } }))
  attempt(w, at(5), 'a1', 95)
  must(postAttempt(w, at(10), { agent: 'a', module: 'm1', attempt: 'a2', commit: commit('a2'), note: 'Cache\tquery plans.' }))
  run(w, at(10), 94)
  attempt(w, at(15), 'a3', 110)
  attempt(w, at(20), 'a4', 85)
  must(abandon(w, at(21), { agent: 'a', module: 'm2', reason: 'The index was never the bottleneck.' }))
  assert.equal(run(w, at(21), 85).kind, 'final', 'the project measures its start against where it got')
  // Only a stop ends a project, and then the queued one opens
  must(stopProject(w, at(21), { agent: 'a', project: 'search' }))
  must(freezeVerifiers(w, at(22), { agent: 'a', module: 'm3', author: 'verifier', verifiers: verifiers(1, 'h3') }))
  run(w, at(23), 50)
  must(postAttempt(w, at(24), { agent: 'a', module: 'm3', attempt: 'b1', commit: commit('b1'), note: 'Pool small objects.' }))

  const [header, ...rows] = resultsTsv(w, 'a').split('\n').slice(0, -1).map((line) => line.split('\t'))
  assert.deepEqual(header, ['project', 'module', 'module_title', 'step', 'attempt', 'commit', 'verdict', 'median', 'best_median', 'gain_pct', 'p', 'tests', 'note'])
  const c = (id: string) => commit(id).slice(0, 7)
  assert.deepEqual(rows, [
    ['search', 'm1', 'cache', '1', 'a1', c('a1'), 'win', '95', '100', '5', '0.00396825', '10/10', 'Try a1.'],
    ['search', 'm1', 'cache', '1', 'a2', c('a2'), 'flat', '94', '95', '1.05263', '0.00396825', '10/10', 'Cache query plans.'],
    ['search', 'm1', 'cache', '1', 'a3', c('a3'), 'fail', '110', '95', '-15.7895', '0.00396825', '10/10', 'Try a3.'],
    ['search', 'm1', 'cache', '1', 'a4', c('a4'), 'win', '85', '95', '10.5263', '0.00396825', '10/10', 'Try a4.'],
    ['search', 'm2', 'index', '', '', '', 'abandoned', '', '', '', '', '', 'The index was never the bottleneck.'],
    ['heap', 'm3', 'arena', '1', 'b1', c('b1'), 'pending', '', '', '', '', '', 'Pool small objects.'],
  ])
  assert.equal(resultsTsv(w, 'nobody'), `${header!.join('\t')}\n`, 'an agent with no attempts gets the header alone')
})

// A project with a goal for its whole climb

test('a project goal is checked, and every module in the project measures its metric', () => {
  const w = emptyWorld()
  rejects(w, at(0), (x) => createProject(x, at(0), { agent: 'a', spec: WITH_GOAL({ target: 70, targetGain: 30 }) }), 'badSpec')
  rejects(w, at(0), (x) => createProject(x, at(0), { agent: 'a', spec: WITH_GOAL({}) }), 'badSpec')
  rejects(w, at(0), (x) => createProject(x, at(0), { agent: 'a', spec: WITH_GOAL({ targetGain: 100 }) }), 'badSpec')
  rejects(w, at(0), (x) => createProject(x, at(0), { agent: 'a', spec: WITH_GOAL({ target: 70, hours: 0 }) }), 'badSpec')
  const other = mod('memory', ['one'], { goal: { ...GOAL, metric: 'heap size', unit: 'MB' } })
  rejects(w, at(0), (x) => createProject(x, at(0), { agent: 'a', spec: WITH_GOAL({ target: 70 }, [mod('cache', ['one']), other]) }), 'badSpec')
  // The project's goal can go past the 20% a module can aim for, since modules add up to it
  must(createProject(w, at(0), { agent: 'a', spec: WITH_GOAL({ targetGain: 60 }) }))
  rejects(w, at(0), (x) => addModule(x, at(0), { agent: 'a', spec: other }), 'badSpec')
  assert.deepEqual(projectView(w, at(0)).goal, { metric: 'p95 latency', unit: 'ms', direction: 'lower', target: null, targetGain: 60, hours: null, budgetEndsAt: null })
})

test('meeting the project goal keeps the project open, and the agent keeps climbing past it', () => {
  const w = emptyWorld()
  must(createProject(w, at(0), { agent: 'a', spec: WITH_GOAL({ target: 90 }) }))
  must(freezeVerifiers(w, at(0), { agent: 'a', module: 'm1', author: 'verifier', verifiers: verifiers(1) }))
  run(w, at(1), 100)
  assert.match(lineOf(w, at(2)), /Project goal: p95 latency 100 -> 90 ms\. Last module in the project\. Plan the next one before this one ends\. 89 min left\.$/)
  attempt(w, at(5), 'a1', 88)
  assert.equal(attemptStatusOf(w, 'a', 'm1', 'a1', at(5))!.lastModule, true)
  measure(w, at(6), 100, 88)
  assert.deepEqual([projectView(w, at(6)).state, agentProjectOf(agentOf(w, 'a')!, at(6))!.state], ['needsModule', 'needsModule'])
  assert.equal(
    lineOf(w, at(6)),
    `agent a: Project: search, every module has ended. Add the next module to keep climbing from ${commit('a1').slice(0, 7)}. Project goal met: p95 latency 100 -> 90 ms, now 88 ms. Keep climbing past it.`,
  )
  // A queued project waits, since this one hasn't ended
  assert.deepEqual(must(createProject(w, at(6), { agent: 'a', spec: { title: 'next', startCommit: START, modules: [mod('later', ['one'])] } })), { state: 'queued', position: 1 })
  assert.deepEqual(must(addModule(w, at(7), { agent: 'a', spec: mod('index', ['only']) })), { module: 'm2', position: 2 })
  assert.equal(projectView(w, at(7)).state, 'open')
})

test('once a project’s hours are up, no module starts, the one running finishes, and the project ends', () => {
  const w = emptyWorld()
  must(createProject(w, at(0), { agent: 'a', spec: WITH_GOAL({ target: 10, hours: 1 }, [mod('cache', ['one', 'two']), mod('index', ['only'])]) }))
  must(freezeVerifiers(w, at(0), { agent: 'a', module: 'm1', author: 'verifier', verifiers: verifiers(2) }))
  run(w, at(1), 100)
  assert.match(lineOf(w, at(30)), /Project goal: p95 latency 100 -> 10 ms\. 0\.5 h left in the project\. \d+ min left\.$/)
  // Past the hour, the module that's running carries on, but nothing new can join
  assert.match(lineOf(w, at(70)), /Its hours are up, so no new module starts\. \d+ min left\.$/)
  rejects(w, at(70), (x) => addModule(x, at(70), { agent: 'a', spec: mod('more', ['one']) }), 'budgetSpent')
  attempt(w, at(75), 'a1', 85)
  assert.equal(moduleOf(w, 'm1').state, 'pastTarget')
  attempt(w, at(80), 'a2', 85.2)
  assert.equal(moduleOf(w, 'm1').state, 'passed')
  // m2 never got its turn
  assert.deepEqual([moduleOf(w, 'm2').state, moduleOf(w, 'm2').reason], ['abandoned', "The project's 1-hour budget ran out before m2 started."])
  assert.deepEqual([projectView(w, at(80)).state, projectView(w, at(80)).end], ['ended', 'budget'])
  measure(w, at(81), 100, 85)
  assert.equal(
    lineOf(w, at(81)),
    `agent a: Project: search ended: 1 passed, 1 abandoned. p95 latency 100 -> 85 ms, 15% lower over the project. It fell short of its goal of 10 ms or lower. Its 1 hour ran out. A new project would start from ${commit('a1').slice(0, 7)}.`,
  )
  rejects(w, at(82), (x) => stopProject(x, at(82), { agent: 'a' }), 'noOpenProject')
})

test('a measurement the project has moved past before a runner took it is dropped', () => {
  const w = emptyWorld()
  must(createProject(w, at(0), { agent: 'a', spec: WITH_GOAL({ targetGain: 60 }, [mod('cache', ['one']), mod('index', ['only'])]) }))
  // m1 measures on a GPU no runner has free, so the measurement after it waits
  must(freezeVerifiers(w, at(0), { agent: 'a', module: 'm1', author: 'verifier', verifiers: verifiers(1, 'h1', 'gpu') }))
  must(freezeVerifiers(w, at(0), { agent: 'a', module: 'm2', author: 'verifier', verifiers: verifiers(1, 'h2') }))
  run(w, at(1), 100, { labels: ['gpu'] })
  attempt(w, at(2), 'a1', 88, { labels: ['gpu'] })
  const stale = moduleOf(w, 'm1').jobs.find((j) => j.kind === 'final')!
  assert.deepEqual([stale.state, stale.commit], ['queued', commit('a1')])
  run(w, at(3), 88)
  attempt(w, at(4), 'b1', 75)
  assert.equal(stale.state, 'cancelled')
  const fresh = moduleOf(w, 'm2').jobs.find((j) => j.kind === 'final')!
  assert.deepEqual([fresh.state, fresh.commit, fresh.bestCommit], ['queued', commit('b1'), START])
  assert.equal(projectView(w, at(4)).progress?.state, 'measuring')
})
