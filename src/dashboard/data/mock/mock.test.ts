import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Agent, AttemptId, Board, Module, ModuleId } from '../../../shared/api.ts'
import { boardLine } from '../../../shared/boardLine.ts'
import { deadlineMinutes, minutesBetween } from '../../../shared/clock.ts'
import { settle } from '../../../server/domain/commands.ts'
import { extensionSeries, gainOf, improve, judge, median, rankP, reaches } from '../../../server/domain/judge.ts'
import type { World } from '../../../server/domain/records.ts'
import { attemptDetailOf, boardOf } from '../../../server/domain/view.ts'
import { initialWorld } from './fixtures.ts'
import { MOCK_CONFIG } from './runner.ts'
import { createMockSource } from './source.ts'
import { TIMELINE } from './timeline.ts'

const t0 = Date.parse('2026-11-03T03:00:00Z')
const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} ${a} != ${b}`)

/** The initial board and the board after each timeline event, with the world behind each. */
function frames() {
  let w = initialWorld(t0)
  const out: { label: string; board: Board; world: World }[] = [{ label: 'initial', board: boardOf(w, t0), world: w }]
  TIMELINE.forEach((e, i) => {
    const at = t0 + (i + 1) * 3500
    w = structuredClone(w)
    e.run(w, at)
    settle(w, at, MOCK_CONFIG)
    out.push({ label: e.label, board: boardOf(w, at), world: w })
  })
  return out
}
const FRAMES = frames()

const modules = (b: Board) => b.agents.flatMap((a) => (a.project?.modules ?? []).map((m) => ({ a, m })))
const current = (a: Agent) => a.project?.modules.find((m) => m.id === a.project?.current)

test('median, the rank test and the verdict follow DESIGN.md', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  const lower = (x: number, y: number) => x < y
  // Every new run below every best run: 1 of the 252 ways to split 10 runs
  close(rankP([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], lower), 1 / 252)
  assert.ok(rankP([5, 6, 7, 8, 9], [5, 6, 7, 8, 9], lower) > 0.4)
  const goal = { direction: 'lower' as const, minGain: 2 }
  const best = [351, 349, 352, 350, 348]
  assert.equal(judge({ tests: { passed: 42, total: 42 }, killed: false, best, next: [331, 333, 329, 332, 330] }, goal).verdict, 'win')
  assert.equal(judge({ tests: { passed: 42, total: 42 }, killed: false, best, next: [349, 351, 347, 350, 348] }, goal).verdict, 'flat')
  assert.equal(judge({ tests: { passed: 42, total: 42 }, killed: false, best, next: [361, 363, 359, 362, 360] }, goal).verdict, 'fail')
  assert.equal(judge({ tests: { passed: 41, total: 42 }, killed: false, best: [], next: [] }, goal).verdict, 'fail')
  assert.equal(judge({ tests: null, killed: true, best: [], next: [] }, goal).verdict, 'fail')
})

test('extensions halve from half of maxMinutes and stop under 5 minutes', () => {
  assert.deepEqual(extensionSeries(90), [45, 22.5, 11.25, 5.625])
  assert.deepEqual(extensionSeries(60), [30, 15, 7.5])
  assert.deepEqual(extensionSeries(120), [60, 30, 15, 7.5])
})

test('the initial board shows every state the dashboard has to handle', () => {
  const b = FRAMES[0]!.board
  const cur = b.agents.map(current).filter((m): m is Module => !!m)
  const all = modules(b).map((x) => x.m)
  assert.ok(b.agents.length >= 4)
  assert.ok(
    cur.some((m) => m.status.state === 'active' && m.attempts.some((a) => a.job === 'running')),
    'an active module with a job verifying',
  )
  assert.ok(
    cur.some((m) => m.status.state === 'pastTarget' && m.streak >= 2),
    'past target on a streak',
  )
  assert.ok(
    cur.some((m) => m.status.state === 'stuck'),
    'a stuck module',
  )
  assert.ok(
    cur.some((m) => m.status.state === 'pending' && m.verifiers.kind === 'frozen' && m.verifiers.from),
    'pending on verifiers borrowed from the module before',
  )
  assert.ok(
    cur.some((m) => m.clock.kind === 'grace'),
    'in its grace period',
  )
  assert.ok(
    cur.some((m) => m.flags.length > 0),
    'a module with a flag',
  )
  assert.ok(
    b.agents.some((a) => a.queued.length > 0),
    'an agent with a queued project',
  )
  assert.ok(
    all.some((m) => m.status.state === 'passed'),
    'a passed module',
  )
  assert.ok(all.some((m) => m.status.state === 'abandoned' && m.status.followUp !== null) && all.some((m) => m.retryOf !== null), 'abandoned with a follow-up')
  assert.ok(
    all.some((m) => m.attempts.some((a) => a.verdict === 'simpler')),
    'a simpler attempt',
  )
})

for (const { label, board, world } of FRAMES) {
  test(`numbers agree with each other and with DESIGN.md: ${label}`, () => {
    const now = new Date(board.generatedAt)
    for (const a of board.agents) {
      assert.equal(a.line, boardLine(a, now))
      const p = a.project!
      p.modules.forEach((m, i) => assert.equal(m.position, i + 1))
      const live = p.modules.find((m) => ['active', 'pastTarget', 'stuck'].includes(m.status.state))
      assert.equal(p.current, (live ?? p.modules.find((m) => m.status.state === 'pending'))?.id ?? null)
    }

    for (const { a, m } of modules(board)) {
      const g = m.goal
      const where = `agent ${a.id} ${m.id}`
      assert.ok(g.targetGain <= 20 || g.ambitious, `${where} target cap`)
      assert.ok(g.minGain <= g.targetGain, `${where} minGain`)
      if (g.baseline === null) assert.equal(g.target, null)
      else close(g.target!, improve(g.baseline, g.targetGain, g.direction), `${where} target`)

      const judged = m.attempts.filter((x) => x.verdict)
      const wins = judged.filter((x) => x.verdict === 'win')
      const moved = judged.filter((x) => x.verdict === 'win' || x.verdict === 'simpler')
      assert.equal(m.best, moved.at(-1)?.median ?? g.baseline, `${where} best`)
      if (moved.length) assert.equal(m.bestCommit, moved.at(-1)!.commit, `${where} best commit`)
      // A simpler attempt neither extends nor ends a streak
      const counted = judged.filter((x) => x.verdict !== 'simpler')
      const trailing = counted.length - 1 - counted.findLastIndex((x) => x.verdict !== 'win')
      assert.equal(m.streak, trailing, `${where} streak`)
      m.steps.forEach((s, i) => assert.equal(s.failedTurns, judged.filter((x) => x.step === i + 1 && x.verdict === 'fail').length, `${where} failed turns`))

      if (m.status.state === 'pastTarget' || m.status.state === 'passed') assert.ok(reaches(m.best!, g.target!, g.direction), `${where} met its target`)
      if (m.status.state === 'stuck' && m.status.cause === 'step')
        assert.ok(
          m.steps.some((s) => s.failedTurns >= 3),
          `${where} failed a step`,
        )
      if (m.status.state === 'stuck' && m.status.cause === 'target') assert.ok(m.steps.every((s) => s.done) && !reaches(m.best!, g.target!, g.direction))
      if (m.status.state === 'abandoned') {
        assert.equal(m.status.followUp !== null, wins.length > 0, `${where} follow-up iff a win`)
        const next = a.project!.modules[m.position]
        if (m.status.followUp) assert.equal(next?.id, m.status.followUp, `${where} follow-up goes right after`)
      }
      if (m.retryOf) {
        const of = a.project!.modules.find((x) => x.id === m.retryOf)!
        assert.ok(m.goal.targetGain < of.goal.targetGain, `${where} a retry aims lower`)
      }

      const c = m.clock
      if (c.kind === 'notStarted') {
        assert.equal(m.status.state === 'pending' || m.status.state === 'abandoned', true)
        continue
      }
      close(
        c.waitedMinutes,
        c.waits.reduce((sum, w) => sum + w.minutes, 0),
        `${where} waits`,
      )
      const series = extensionSeries(c.maxMinutes)
      c.extensions.forEach((e, i) => assert.equal(e.minutes, series[i], `${where} extension ${i}`))
      assert.ok(c.extensions.reduce((sum, e) => sum + e.minutes, 0) < c.maxMinutes)
      if (c.extensions[0]) assert.notEqual(c.extensions[0].cause, 'win', `${where} the first extension comes from a streak or a step`)
      if (c.kind === 'running' || c.kind === 'grace') {
        close(minutesBetween(c.startedAt, c.deadline), deadlineMinutes(c)!, `${where} deadline`)
        assert.ok(m.status.state === 'active' || m.status.state === 'pastTarget')
      }
      if (c.kind === 'grace') {
        close(minutesBetween(c.deadline, c.graceEnds), c.maxMinutes / 10)
        assert.ok(now >= new Date(c.deadline) && now < new Date(c.graceEnds))
      }
      if (m.status.state === 'stuck' && m.status.cause === 'time' && c.kind === 'stopped' && c.startedAt) assert.ok(minutesBetween(c.startedAt, c.at) >= deadlineMinutes(c)!)
    }

    for (const { a, m } of modules(board)) {
      for (const x of m.attempts) {
        const d = attemptDetailOf(world, a.id, m.id, x.id)!
        assert.ok(d, `${a.id}/${m.id}/${x.id} has a detail`)
        const where = `agent ${a.id} ${x.id}`
        if (!x.verdict) {
          assert.equal(d.runs.length, 0)
          continue
        }
        const best = d.runs.filter((r) => r.commit === d.bestCommit)
        const next = d.runs.filter((r) => r.commit === x.commit)
        if (d.runs.length) {
          assert.equal(best.length, 5)
          assert.equal(next.length, 5)
          d.runs.forEach((r, i) => assert.equal(r.commit, i % 2 ? x.commit : d.bestCommit, `${where} runs alternate`))
          assert.equal(x.median, median(next.map((r) => r.value)))
          assert.equal(d.bestMedian, median(best.map((r) => r.value)))
          close(d.gain!, gainOf(d.bestMedian!, x.median!, m.goal.direction), `${where} gain`)
          const better = (u: number, v: number) => (m.goal.direction === 'lower' ? u < v : u > v)
          const p =
            d.gain! >= 0
              ? rankP(
                  next.map((r) => r.value),
                  best.map((r) => r.value),
                  better,
                )
              : rankP(
                  next.map((r) => r.value),
                  best.map((r) => r.value),
                  (u, v) => better(v, u),
                )
          close(d.p!, p, `${where} p`)
        }
        const testsPass = d.tests !== null && d.tests.passed === d.tests.total
        const flat = d.clean && d.gain! >= -m.goal.minGain && d.clean.next.passed && d.clean.best.size !== null && d.clean.next.size! < d.clean.best.size ? 'simpler' : 'flat'
        const expected = !testsPass ? 'fail' : d.gain! >= m.goal.minGain && d.p! < 0.05 ? 'win' : d.gain! < 0 && d.p! < 0.05 ? 'fail' : flat
        assert.equal(x.verdict, expected, `${where} verdict`)
      }
      for (const f of m.flags) {
        const x = f.attempt && attemptDetailOf(world, a.id, m.id, f.attempt)
        if (f.kind === 'touchedVerifier') assert.ok(x && x.touchedVerifiers.length > 0)
        if (f.kind === 'selfAuthoredVerifiers') assert.equal(m.verifiers.kind === 'frozen' && m.verifiers.author, a.id)
        if (f.kind === 'fewerTests') {
          const i = m.attempts.findIndex((y) => y.id === f.attempt)
          const before = m.attempts.slice(0, i).findLast((y) => attemptDetailOf(world, a.id, m.id, y.id)!.tests)
          assert.ok(x && x.tests && before && x.tests.total < attemptDetailOf(world, a.id, m.id, before.id)!.tests!.total)
        }
      }
    }
  })
}

const ORDER = ['pending', 'active', 'pastTarget', 'stuck', 'passed', 'abandoned']
test('the timeline never rewinds', () => {
  for (let i = 1; i < FRAMES.length; i++) {
    const [before, after] = [FRAMES[i - 1]!.board, FRAMES[i]!.board]
    assert.ok(after.generatedAt > before.generatedAt)
    assert.notDeepEqual(after, { ...before, generatedAt: after.generatedAt }, `event ${i} changes the board`)
    for (const { a, m } of modules(before)) {
      const later = after.agents.find((x) => x.id === a.id)!.project!.modules.find((x) => x.id === m.id)!
      const where = `event ${i}: agent ${a.id} ${m.id}`
      assert.ok(later, where)
      assert.ok(ORDER.indexOf(later.status.state) >= ORDER.indexOf(m.status.state) || (m.status.state === 'stuck' && later.status.state === 'abandoned'), `${where} state`)
      m.attempts.forEach((x, k) => {
        const y = later.attempts[k]!
        assert.equal(y.id, x.id, where)
        if (x.verdict) assert.equal(y.verdict, x.verdict, where)
      })
      m.steps.forEach((s, k) => assert.ok(!s.done || later.steps[k]!.done, where))
      if (m.clock.kind !== 'notStarted' && later.clock.kind !== 'notStarted') assert.deepEqual(later.clock.extensions.slice(0, m.clock.extensions.length), m.clock.extensions, where)
    }
  }
})

test('the mock source steps through the timeline and keeps snapshots stable', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let now = t0
  const source = createMockSource({ every: 3500, now: () => now })
  const first = source.current()
  const [agent, module, a12] = [first.agents[0]!.id, first.agents[0]!.project!.current!, 'a12' as AttemptId]
  const running = source.attempt(agent, module, a12)
  assert.equal(source.current(), first)
  assert.equal(running?.attempt.job, 'running')
  assert.equal(source.attempt(agent, module, a12), running)
  assert.equal(source.attempt(agent, 'm404' as ModuleId, a12), null)

  let calls = 0
  const stop = source.subscribe(() => calls++)
  now += 3500
  t.mock.timers.tick(3500)
  assert.equal(calls, 1)
  assert.notEqual(source.current(), first)
  assert.equal(source.attempt(agent, module, a12)?.attempt.verdict, 'win')
  stop()
  t.mock.timers.tick(3500)
  assert.equal(calls, 1)
})
