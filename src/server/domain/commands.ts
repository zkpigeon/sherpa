// The calls that change the world, one per API route. Each settles the world
// at the call's time first, as the server does on every request. Then it
// either rejects without touching anything, or applies the change and
// returns what the caller needs. Repeating a call has no further effect.
import { SANDBOXES, type AgentId, type AttemptId, type ChangeId, type Commit, type FlagKind, type Iso, type JobId, type JobState, type ModuleId } from '../../shared/api.ts'
import { holds, judge, reaches } from './judge.ts'
import {
  agentOf,
  budgetEndsAt,
  endCommit,
  baselineJob,
  inFlight,
  latestBaseline,
  currentOf,
  factsOf,
  failedTurns,
  findJob,
  firstInLine,
  lastWin,
  locate,
  measureHost,
  measured,
  progressJob,
  projectEnded,
  reachedCommit,
  startCommits,
  timesOutAt,
  verifierSet,
  verifiersOf,
  type Located,
} from './queries.ts'
import {
  DEFAULTS,
  MINUTE,
  iso,
  type AgentRec,
  type AttemptRec,
  type Config,
  type JobKind,
  type JobRec,
  type JobResults,
  type ModuleRec,
  type ModuleSpec,
  type Ms,
  type ProjectGoalSpec,
  type ProjectRec,
  type ProjectSpec,
  type VerifierSpec,
  type World,
} from './records.ts'
import { conflict, invalid, notFound, ok, type Failure, type Result } from './result.ts'
import {
  CAUSE,
  FAILED_TURNS,
  HOLD_GRACE_MINUTES,
  MAX_RUNNER_ERRORS,
  VERDICTS,
  goalMismatch,
  goalOf,
  ended,
  isAgentId,
  isCommit,
  isText,
  live,
  moduleProblem,
  nextState,
  projectGoalOf,
  projectProblem,
  takes,
  verifierProblem,
  type ModuleEvent,
} from './rules.ts'

// Moving modules and raising flags

function move(m: ModuleRec, event: ModuleEvent, at: Ms) {
  const next = nextState(event, m.state)
  if (!next) throw new Error(`${event} can't move ${m.id} from ${m.state}`)
  m.cause = CAUSE[event] ?? (next === 'abandoned' ? m.cause : null)
  m.state = next
  if (next !== 'pending' && !live(next)) m.stoppedAt ??= at
}

function flag(m: ModuleRec, kind: FlagKind, attempt: AttemptId | null, detail: string, at: Ms) {
  m.flags.push({ kind, attempt, detail, at })
}

// Specs

const normalModule = (s: ModuleSpec): ModuleSpec => ({
  title: s.title.trim(),
  steps: s.steps.map((x) => x.trim()),
  goal: goalOf(s.goal),
  ...(s.maxMinutes === undefined ? {} : { maxMinutes: s.maxMinutes }),
  ...(s.retryOf === undefined ? {} : { retryOf: s.retryOf }),
})

const normalGoal = (g: ProjectGoalSpec): ProjectGoalSpec => ({
  metric: g.metric.trim(),
  unit: g.unit.trim(),
  direction: g.direction,
  ...(g.target === undefined ? {} : { target: g.target }),
  ...(g.targetGain === undefined ? {} : { targetGain: g.targetGain }),
  ...(g.hours === undefined ? {} : { hours: g.hours }),
})

const normalProject = (s: ProjectSpec): ProjectSpec => ({
  title: s.title.trim(),
  startCommit: s.startCommit.toLowerCase(),
  ...(s.repo === undefined ? {} : { repo: s.repo }),
  ...(s.maxMinutes === undefined ? {} : { maxMinutes: s.maxMinutes }),
  ...(s.goal === undefined ? {} : { goal: normalGoal(s.goal) }),
  modules: s.modules.map(normalModule),
})

const normalVerifiers = (v: VerifierSpec): VerifierSpec => ({
  hash: v.hash,
  paths: [...v.paths],
  image: v.image,
  commands: { regression: v.commands.regression, steps: [...v.commands.steps], benchmark: v.commands.benchmark },
  hardware: v.hardware,
  timeLimitMinutes: v.timeLimitMinutes,
  ...(v.runs === undefined ? {} : { runs: v.runs }),
})

const keyOf = (s: ModuleSpec | ProjectSpec) => JSON.stringify(s)

function moduleFrom(a: AgentRec, spec: ModuleSpec, projectMax: number | null, config: Config): ModuleRec {
  const s = normalModule(spec)
  a.modules++
  return {
    id: `m${a.modules}` as ModuleId,
    specKey: keyOf(s),
    title: s.title,
    steps: s.steps.map((title) => ({ title, doneAt: null, held: null })),
    goal: goalOf(s.goal),
    maxMinutes: s.maxMinutes ?? projectMax ?? config.defaultMaxMinutes,
    retryOf: (s.retryOf ?? null) as ModuleId | null,
    verifiers: [],
    changes: [],
    state: 'pending',
    cause: null,
    reason: null,
    followUp: null,
    stoppedAt: null,
    attempts: [],
    jobs: [],
    flags: [],
  }
}

function open(a: AgentRec, spec: ProjectSpec, at: Ms, config: Config) {
  if (a.project) a.past.push(a.project)
  const maxMinutes = spec.maxMinutes ?? null
  const goal = spec.goal ? projectGoalOf(spec.goal) : null
  const p: ProjectRec = { title: spec.title, specKey: keyOf(spec), startCommit: spec.startCommit as Commit, repo: spec.repo ?? null, maxMinutes, goal, modules: [], openedAt: at }
  p.modules = spec.modules.map((s) => moduleFrom(a, s, maxMinutes, config))
  a.project = p
}

function ensureAgent(w: World, id: string): AgentRec {
  const found = agentOf(w, id)
  if (found) return found
  const a: AgentRec = { id: id as AgentId, blurb: '', project: null, queued: [], past: [], modules: 0 }
  w.agents.push(a)
  return a
}

const badAgent = (): Failure => invalid('badSpec', 'An agent ID is 1 to 40 letters, digits, dashes, or underscores.')

// Jobs

const jobKey = (kind: JobKind, a: AgentRec, m: ModuleRec, commit: Commit, bestCommit: Commit | null, step: number | null, hash: string) =>
  [kind, a.id, m.id, commit, bestCommit ?? '-', step ?? '-', hash].join(':')

/** Queues a job, or returns the stored one when the same job has already run. */
function queue(w: World, a: AgentRec, m: ModuleRec, kind: JobKind, fields: Pick<JobRec, 'step' | 'commit' | 'bestCommit' | 'stepTests'>, at: Ms): JobRec {
  const hash = verifiersOf(m)!.hash
  const key = jobKey(kind, a, m, fields.commit, fields.bestCommit, fields.step, hash)
  const ran = m.jobs.findLast((j) => j.key === key && (j.state === 'done' || j.state === 'killed'))
  if (ran) return ran
  w.jobs++
  const job: JobRec = { id: `j${w.jobs}` as JobId, key, kind, module: m.id, ...fields, verifierHash: hash, state: 'queued', queuedAt: at, claims: [], finishedAt: null, results: null }
  m.jobs.push(job)
  return job
}

function cancel(j: JobRec, at: Ms) {
  const claim = j.claims.at(-1)
  if (j.state === 'running' && claim) claim.endedAt = at
  j.state = 'cancelled'
  j.finishedAt = at
}

/** A runner couldn't run the job: it goes back in the queue, and after a few tries it fails without a verdict. */
function runnerError(m: ModuleRec, j: JobRec, error: string, at: Ms) {
  const claim = j.claims.at(-1)!
  claim.endedAt = at
  claim.error = error.slice(0, 500)
  if (j.claims.filter((c) => c.error !== null).length < MAX_RUNNER_ERRORS) return void (j.state = 'queued')
  j.state = 'failed'
  j.finishedAt = at
  if (j.kind === 'baseline') flag(m, 'baselineFailed', null, `No runner could run the baseline job: ${claim.error} ${m.id} waits for new verifiers or an abandon.`, at)
}

/** A lapsed lease puts the job back in the queue for any runner, and a runner that holds a job far past its time limit loses it. */
function expire(m: ModuleRec, j: JobRec, now: Ms) {
  const claim = j.claims.at(-1)
  if (j.state !== 'running' || !claim) return
  const held = claim.at + (verifierSet(m, j.verifierHash)!.timeLimitMinutes + HOLD_GRACE_MINUTES) * MINUTE
  if (held <= now && held < claim.leaseUntil) return runnerError(m, j, `${claim.runner} held the job past its time limit.`, held)
  if (claim.leaseUntil > now) return
  claim.lapsed = true
  claim.endedAt = claim.leaseUntil
  j.state = 'queued'
}

/**
 * Stops a project whose hours are up, measures how far it has come, opens
 * the next queued project once the open one ends, and queues the baseline of
 * the module whose turn it is.
 */
function advance(w: World, a: AgentRec, at: Ms, config: Config) {
  if (a.project) {
    stopForBudget(a.project, at)
    measureProject(w, a, a.project, at)
  }
  if (a.project && projectEnded(a.project, at) && a.queued.length) open(a, a.queued.shift()!, at, config)
  const p = a.project
  if (!p) return
  for (const m of p.modules) remeasure(w, a, p, m, at)
  const m = firstInLine(p)
  const v = m && verifiersOf(m)
  if (!m || !v) return
  const start = startCommits(p)[p.modules.indexOf(m)]
  if (!start) return
  // One in flight keeps the verifiers it was queued with, and one that failed waits for new verifiers, which change the key
  const key = jobKey('baseline', a, m, start, null, null, v.hash)
  if (m.jobs.some((j) => j.kind === 'baseline' && (j.state === 'queued' || j.state === 'running'))) return
  if (m.jobs.some((j) => j.key === key && j.state !== 'cancelled')) return
  queue(w, a, m, 'baseline', { step: null, commit: start, bestCommit: null, stepTests: [] }, at)
}

/**
 * Measures the project's start commit against the commit it has reached, in
 * one job on the verifiers of the last module that got there, so the result
 * isn't pieced together from modules measured in different jobs. It runs each
 * time a module moves the project, and nothing waits for it.
 */
function measureProject(w: World, a: AgentRec, p: ProjectRec, at: Ms) {
  const reached = reachedCommit(p)
  // A measurement still waiting for a commit the project has moved past would measure nothing anyone reads
  for (const m of p.modules) for (const j of m.jobs) if (j.kind === 'final' && j.state === 'queued' && j.commit !== reached) cancel(j, at)
  const host = measureHost(p)
  const v = host && verifiersOf(host)
  if (!host || !v || !reached || reached === p.startCommit || progressJob(p)) return
  queue(w, a, host, 'final', { step: null, commit: reached, bestCommit: p.startCommit, stepTests: [] }, at)
}

/** Once a project's hours are up, no module starts: as soon as none is live or stuck, the pending ones are abandoned. */
function stopForBudget(p: ProjectRec, at: Ms) {
  const ends = budgetEndsAt(p)
  if (ends === null || at < ends || p.modules.some((m) => live(m.state) || m.state === 'stuck')) return
  const when = Math.max(ends, ...p.modules.map((m) => m.stoppedAt ?? 0))
  for (const m of p.modules) {
    if (m.state !== 'pending') continue
    const flight = inFlight(m)
    if (flight) cancel(flight, when)
    m.reason = `The project's ${p.goal!.hours}-hour budget ran out before ${m.id} started.`
    move(m, 'abandoned', when)
  }
}

/**
 * A live module whose verifiers changed after its baseline measures the
 * baseline again on them, together with the best commit, so its target and
 * best stay on the scale its attempts are now measured on. It waits for any
 * job in flight, which keeps the verifiers it was queued with.
 */
function remeasure(w: World, a: AgentRec, p: ProjectRec, m: ModuleRec, at: Ms) {
  if (!live(m.state)) return
  const v = verifiersOf(m)
  const latest = latestBaseline(m)
  if (!v || !latest || latest.verifierHash === v.hash || inFlight(m)) return
  const f = factsOf(p, m, at)
  if (!f.start) return
  const best = f.best && f.best !== f.start ? f.best : null
  const key = jobKey('baseline', a, m, f.start, best, null, v.hash)
  // One that failed stays failed until the verifiers change again
  if (m.jobs.some((j) => j.key === key && j.state !== 'cancelled')) return
  queue(w, a, m, 'baseline', { step: null, commit: f.start, bestCommit: best, stepTests: [] }, at)
}

/** Applies every transition that has come due by `now`: lapsed leases, then modules out of time. */
export function settle(w: World, now: Ms, config: Config = DEFAULTS) {
  for (const a of w.agents) {
    const p = a.project
    if (!p) continue
    for (const m of p.modules) {
      for (const j of m.jobs) expire(m, j, now)
      if (!live(m.state)) continue
      const f = factsOf(p, m, now)
      if (f.deadline === null || now < f.deadline) continue
      const out = timesOutAt(m, f)
      if (out === null || now < out) continue
      move(m, 'outOfTime', out)
      advance(w, a, out, config)
    }
    advance(w, a, now, config)
  }
}

// Applying a job's results

const valuesOn = (j: JobRec, commit: Commit | null) => j.results!.runs.filter((r) => r.commit === commit)

function workFlags(m: ModuleRec, j: JobRec, attempt: AttemptId | null, at: Ms) {
  const best = valuesOn(j, j.bestCommit)
  const next = valuesOn(j, j.commit)
  if (!best.length || j.commit === j.bestCommit) return
  const least = Math.min(...best.map((r) => r.work))
  if (next.some((r) => r.work < least)) flag(m, 'lessWork', attempt, `A run on ${j.commit.slice(0, 7)} did less work than the best commit's runs.`, at)
}

function landBaseline(m: ModuleRec, j: JobRec, at: Ms) {
  // A baseline taken again on a live module only moves the numbers, which are derived
  if (measured(j)) return m.state === 'pending' ? move(m, 'baselineMeasured', at) : undefined
  const r = j.results!
  const why =
    r.outcome === 'killed'
      ? 'ran past its time limit'
      : r.outcome === 'tampered'
        ? `was thrown out because a command changed the frozen ${(r.tampered ?? []).join(', ')}`
      : r.outcome === 'badCommit'
        ? `couldn't fetch the start commit: ${r.error ?? ''}`.trim()
        : r.tests && r.tests.passed < r.tests.total
          ? `failed its tests on the start commit: ${r.tests.passed} of ${r.tests.total} passed`
          : 'measured nothing'
  const next = m.state === 'pending' ? `${m.id} waits for an approved change request, or an abandon.` : `${m.id} keeps its old baseline, which its new verifiers may not match.`
  flag(m, 'baselineFailed', null, `The baseline job ${why}. ${next}`, at)
}

function judgeAttempt(p: ProjectRec, m: ModuleRec, x: AttemptRec, j: JobRec, at: Ms, fresh: boolean) {
  const r = j.results!
  const values = (c: Commit | null) => valuesOn(j, c).map((run) => run.value)
  x.judged = judge({ tests: r.tests, killed: r.outcome !== 'done', best: values(j.bestCommit), next: values(j.commit) }, m.goal)
  x.judgedAt = at

  if (fresh) {
    if (r.touched.length) flag(m, 'touchedVerifier', x.id, `${r.touched.join(', ')} changed. The runner used the frozen copy.`, at)
    const before = m.attempts.slice(0, m.attempts.indexOf(x)).findLast((y) => m.jobs.find((k) => k.id === y.job)?.results?.tests)
    const was = before && m.jobs.find((k) => k.id === before.job)!.results!.tests!.total
    if (r.tests && was && r.tests.total < was) flag(m, 'fewerTests', x.id, `${r.tests.total} tests ran, ${was - r.tests.total} fewer than in ${before.id}.`, at)
    workFlags(m, j, x.id, at)
  }

  const f = factsOf(p, m, at)
  const verdict = VERDICTS[x.judged.verdict]
  if (m.state === 'active') {
    if (verdict.canMeetTarget && f.target !== null && reaches(x.judged.median!, f.target, m.goal.direction))
      move(m, x.step < m.steps.length ? 'metTargetStepsLeft' : 'metTarget', at)
    else if (verdict.failedTurn && failedTurns(m, x.step) >= FAILED_TURNS) move(m, 'stepFailed', at)
  } else if (m.state === 'pastTarget' && verdict.streak === 'ends') move(m, 'streakEnded', at)
}

function checkStep(m: ModuleRec, j: JobRec, at: Ms, fresh: boolean) {
  const r = j.results!
  if (r.outcome !== 'done' || !r.tests || r.tests.passed < r.tests.total) return
  const step = m.steps[j.step! - 1]!
  const values = (c: Commit | null) => valuesOn(j, c).map((run) => run.value)
  step.doneAt = at
  step.commit = j.commit
  step.held = j.commit === j.bestCommit || holds(values(j.bestCommit), values(j.commit), m.goal.direction)
  if (fresh) workFlags(m, j, null, at)
  if (m.steps.every((s) => s.doneAt !== null)) move(m, 'lastStepDone', at)
}

function apply(p: ProjectRec, m: ModuleRec, j: JobRec, at: Ms, fresh: boolean) {
  const r = j.results!
  const attempt = j.kind === 'attempt' ? (m.attempts.findLast((y) => y.job === j.id)?.id ?? null) : null
  if (fresh && r.outcome === 'tampered') flag(m, 'rewroteVerifier', attempt, `${(r.tampered ?? []).join(', ') || 'A frozen file'} changed while the ${j.kind} job ran on ${j.commit.slice(0, 7)}, so the runner threw the job out.`, at)
  // A project's final measurement only feeds the summary, which is derived
  if (j.kind === 'final') return
  if (j.kind === 'baseline') return landBaseline(m, j, at)
  if (j.kind === 'stepCheck') return checkStep(m, j, at, fresh)
  const x = m.attempts.findLast((y) => y.job === j.id && y.judged === null)
  if (x) judgeAttempt(p, m, x, j, at, fresh)
}

// Agent calls

const JOB_NAME = { baseline: 'a baseline job', attempt: 'an attempt', stepCheck: 'a step check', final: 'a project measurement' } satisfies Record<JobKind, string>

/** A stuck module only waits for the agent, so a refusal says what to do. */
const stuckNext = (m: ModuleRec) => (m.state === 'stuck' ? ' Abandon it with a reason now, then move on.' : '')

function find(w: World, agent: string, module: string): Result<Located> {
  const found = locate(w, agent, module)
  if (found) return ok(found)
  return agentOf(w, agent) ? notFound('noModule', `Agent ${agent} has no module ${module}.`) : notFound('noAgent', `There is no agent ${agent}.`)
}

export type Created = { state: 'open' | 'ended'; modules: ModuleId[] } | { state: 'queued'; position: number }

export function createProject(w: World, at: Ms, args: { agent: string; spec: ProjectSpec }, config: Config = DEFAULTS): Result<Created> {
  settle(w, at, config)
  if (!isAgentId(args.agent)) return badAgent()
  const problem = projectProblem(args.spec, config)
  if (problem) return invalid('badSpec', problem)
  const spec = normalProject(args.spec)
  const a = agentOf(w, args.agent)
  const openOne = a?.project && !projectEnded(a.project, at) ? a.project : null
  const queuedAt = a?.queued.findIndex((q) => q.title === spec.title) ?? -1

  if (openOne?.title === spec.title) {
    if (openOne.specKey !== keyOf(spec)) return conflict('titleTaken', `Project "${spec.title}" is open with a different plan.`)
    return ok({ state: 'open', modules: openOne.modules.map((m) => m.id) })
  }
  if (a && queuedAt !== -1) {
    if (keyOf(a.queued[queuedAt]!) !== keyOf(spec)) return conflict('titleTaken', `Project "${spec.title}" is queued with a different plan.`)
    return ok({ state: 'queued', position: queuedAt + 1 })
  }
  const done = a && [a.project, ...a.past].find((x) => x?.title === spec.title)
  if (done) return done.specKey === keyOf(spec) ? ok({ state: 'ended', modules: done.modules.map((m) => m.id) }) : conflict('titleTaken', `Agent ${a!.id} already had a project titled "${spec.title}".`)

  const agent = ensureAgent(w, args.agent)
  if (openOne) {
    agent.queued.push(spec)
    return ok({ state: 'queued', position: agent.queued.length })
  }
  open(agent, spec, at, config)
  advance(w, agent, at, config)
  return ok({ state: 'open', modules: agent.project!.modules.map((m) => m.id) })
}

export function setBlurb(w: World, at: Ms, args: { agent: string; blurb: string }, config: Config = DEFAULTS): Result<null> {
  settle(w, at, config)
  if (!isAgentId(args.agent)) return badAgent()
  if (typeof args.blurb !== 'string' || args.blurb.length > 280 || /[\r\n]/.test(args.blurb)) return invalid('badSpec', 'A blurb is one line of at most 280 characters.')
  ensureAgent(w, args.agent).blurb = args.blurb.trim()
  return ok(null)
}

export function addModule(w: World, at: Ms, args: { agent: string; spec: ModuleSpec }, config: Config = DEFAULTS): Result<{ module: ModuleId; position: number }> {
  settle(w, at, config)
  const a = agentOf(w, args.agent)
  if (!a) return notFound('noAgent', `There is no agent ${args.agent}.`)
  const p = a.project
  if (!p || projectEnded(p, at)) return conflict('noOpenProject', `Agent ${a.id} has no open project. Create a project instead.`)
  const ends = budgetEndsAt(p)
  if (ends !== null && at >= ends) return conflict('budgetSpent', `Project "${p.title}" has used its ${p.goal!.hours === 1 ? '1 hour' : `${p.goal!.hours} hours`}, so no new module can start.`)
  const problem = moduleProblem(args.spec, config) ?? goalMismatch(p.goal, args.spec)
  if (problem) return invalid('badSpec', problem)
  if (args.spec.retryOf !== undefined) return invalid('badSpec', 'Only an abandon follow-up can retry a module.')
  const spec = normalModule(args.spec)
  const same = p.modules.find((m) => m.title === spec.title)
  if (same) return same.specKey === keyOf(spec) ? ok({ module: same.id, position: p.modules.indexOf(same) + 1 }) : conflict('titleTaken', `Project "${p.title}" already has a module titled "${spec.title}".`)
  const m = moduleFrom(a, spec, p.maxMinutes, config)
  m.added = true
  // Right after the current module, behind any modules added before it that haven't started. With every module ended, last
  const now = currentOf(p)
  let i = now ? p.modules.indexOf(now) + 1 : p.modules.length
  while (p.modules[i]?.added && p.modules[i]!.state === 'pending') i++
  p.modules.splice(i, 0, m)
  advance(w, a, at, config)
  return ok({ module: m.id, position: i + 1 })
}

export function freezeVerifiers(w: World, at: Ms, args: { agent: string; module: string; author: string; verifiers: VerifierSpec }, config: Config = DEFAULTS): Result<{ hash: string }> {
  settle(w, at, config)
  const found = find(w, args.agent, args.module)
  if (!found.ok) return found
  const { a, m } = found.value
  if (!isText(args.author, 40)) return invalid('badSpec', 'Verifiers need an author: the ID of the agent that wrote them.')
  const problem = verifierProblem(args.verifiers, m.steps.length)
  if (problem) return invalid('badSpec', problem)
  if (!takes('verifiers', m.state)) return conflict('wrongState', `${m.id} has ${m.state === 'passed' ? 'passed' : 'been abandoned'}, so its verifiers can't change.`)
  const current = verifiersOf(m)
  if (current) return current.hash === args.verifiers.hash ? ok({ hash: current.hash }) : conflict('verifiersFrozen', `${m.id}'s verifiers are frozen. File a change request instead.`)
  m.verifiers.push({ ...normalVerifiers(args.verifiers), author: args.author, frozenAt: at })
  if (args.author === a.id) flag(m, 'selfAuthoredVerifiers', null, `Agent ${a.id} wrote the verifiers for ${m.id}, the module it works.`, at)
  advance(w, a, at, config)
  return ok({ hash: args.verifiers.hash })
}

export function fileChange(
  w: World,
  at: Ms,
  args: { agent: string; module: string; reason: string; proposed: VerifierSpec; changed?: string[]; author?: string },
  config: Config = DEFAULTS,
): Result<{ change: ChangeId }> {
  settle(w, at, config)
  const found = find(w, args.agent, args.module)
  if (!found.ok) return found
  const { a, m } = found.value
  const current = verifiersOf(m)
  if (!current) return conflict('verifiersMissing', `${m.id} has no verifiers to change. Submit them instead.`)
  if (!takes('verifiers', m.state)) return conflict('wrongState', `${m.id} has ended, so its verifiers can't change.`)
  if (!isText(args.reason, 300)) return invalid('badSpec', 'A change request needs a one-line reason of at most 300 characters.')
  const problem = verifierProblem(args.proposed, m.steps.length)
  if (problem) return invalid('badSpec', problem)
  if (args.proposed.hash === current.hash) return invalid('badSpec', 'The proposed verifiers are the frozen ones.')
  if (args.author !== undefined && !isText(args.author, 40)) return invalid('badSpec', 'author must be the ID of the agent that wrote the change.')
  const reason = args.reason.trim()
  // The same request again, open or already rejected, is a repeat
  const same = m.changes.find((c) => c.state !== 'approved' && c.proposed.hash === args.proposed.hash && c.reason === reason)
  if (same) return ok({ change: same.id })
  w.changes++
  const id = `c${w.changes}` as ChangeId
  const changed = Array.isArray(args.changed) ? args.changed.filter((x) => typeof x === 'string').slice(0, 200) : [...args.proposed.paths]
  m.changes.push({ id, author: args.author ?? a.id, reason, base: current.hash, proposed: normalVerifiers(args.proposed), changed, state: 'open', filedAt: at, decidedAt: null })
  return ok({ change: id })
}

export function postAttempt(
  w: World,
  at: Ms,
  args: { agent: string; module: string; attempt: string; commit: string; note: string },
  config: Config = DEFAULTS,
): Result<{ attempt: AttemptId; job: JobId }> {
  settle(w, at, config)
  const found = find(w, args.agent, args.module)
  if (!found.ok) return found
  const { a, p, m } = found.value
  if (typeof args.attempt !== 'string' || !/^[A-Za-z0-9_.-]{1,60}$/.test(args.attempt)) return invalid('badSpec', 'An attemptId is 1 to 60 letters, digits, dots, dashes, or underscores.')
  if (!isCommit(args.commit)) return invalid('badSpec', 'commit must be a full commit hash, such as the output of git rev-parse HEAD.')
  if (!isText(args.note, 500)) return invalid('badSpec', 'An attempt needs a one-line note of at most 500 characters.')
  const commit = args.commit.toLowerCase() as Commit
  const posted = m.attempts.find((x) => x.id === args.attempt)
  if (posted) return posted.commit === commit ? ok({ attempt: posted.id, job: posted.job }) : conflict('attemptIdTaken', `Attempt ${posted.id} was posted with commit ${posted.commit}.`)
  if (!takes('attempt', m.state)) return conflict('wrongState', `${m.id} is ${m.state}, so it takes no attempts.${stuckNext(m)}`)
  const f = factsOf(p, m, at)
  if (f.inFlight) return conflict('jobInFlight', `${m.id} already has ${JOB_NAME[f.inFlight.kind]} in flight. Plan the next attempt meanwhile, and post it once the job is done.`)
  if (f.deadline !== null && at >= f.deadline && f.last) return conflict('timeIsUp', `Time is up for ${m.id}, and its last attempt was ${f.last.id}.`)
  if (commit === f.best) return conflict('alreadyBest', `${commit} is already ${m.id}'s best commit.`)

  const step = f.step + 1
  const job = queue(w, a, m, 'attempt', { step, commit, bestCommit: f.best!, stepTests: Array.from({ length: f.step }, (_, i) => i + 1) }, at)
  const x: AttemptRec = { id: args.attempt as AttemptId, step, commit, note: args.note.trim(), bestCommit: f.best!, job: job.id, postedAt: at, judgedAt: null, judged: null }
  m.attempts.push(x)
  // The same job ran before, so its stored result stands
  if (job.state !== 'queued') judgeAttempt(p, m, x, job, at, false)
  settle(w, at, config)
  return ok({ attempt: x.id, job: job.id })
}

export function stepDone(w: World, at: Ms, args: { agent: string; module: string; step: number }, config: Config = DEFAULTS): Result<{ job: JobId | null; done: boolean }> {
  settle(w, at, config)
  const found = find(w, args.agent, args.module)
  if (!found.ok) return found
  const { a, p, m } = found.value
  const n = args.step
  if (!Number.isInteger(n) || n < 1 || n > m.steps.length) return invalid('badSpec', `${m.id} has steps 1 to ${m.steps.length}.`)
  if (m.steps[n - 1]!.doneAt !== null) return ok({ job: null, done: true })
  if (!takes('stepCheck', m.state))
    return conflict('wrongState', m.state === 'passed' ? `${m.id} has passed, so its remaining steps are skipped and it takes no step checks.` : `${m.id} is ${m.state}, so it takes no step checks.${stuckNext(m)}`)
  const f = factsOf(p, m, at)
  if (f.inFlight?.kind === 'stepCheck' && f.inFlight.step === n) return ok({ job: f.inFlight.id, done: false })
  if (f.inFlight) return conflict('jobInFlight', `${m.id} already has ${JOB_NAME[f.inFlight.kind]} in flight. Plan the next attempt meanwhile, and mark the step done once the job is done.`)
  if (n !== f.step + 1) return conflict('wrongStep', `Step ${f.step + 1} is ${m.id}'s current step.`)
  if (f.deadline !== null && at >= f.deadline) return conflict('timeIsUp', `Time is up for ${m.id}, so it takes no step checks.`)

  const job = queue(w, a, m, 'stepCheck', { step: n, commit: f.head!, bestCommit: f.best!, stepTests: [n] }, at)
  if (job.state !== 'queued') checkStep(m, job, at, false)
  settle(w, at, config)
  return ok({ job: job.id, done: m.steps[n - 1]!.doneAt !== null })
}

export function abandon(
  w: World,
  at: Ms,
  args: { agent: string; module: string; reason: string; followUp?: ModuleSpec },
  config: Config = DEFAULTS,
): Result<{ followUp: ModuleId | null; startsFrom: Commit | null }> {
  settle(w, at, config)
  const found = find(w, args.agent, args.module)
  if (!found.ok) return found
  const { a, p, m } = found.value
  // The commit the module after this one starts from, so the agent can reset its branch to it
  const startsFrom = () => startCommits(p)[p.modules.indexOf(m) + 1] ?? endCommit(p)
  if (m.state === 'abandoned') return ok({ followUp: m.followUp, startsFrom: startsFrom() })
  if (!takes('abandon', m.state)) return conflict('wrongState', `${m.id} is ${m.state}, and only a pending, active, or stuck module can be abandoned.`)
  if (!isText(args.reason, 300)) return invalid('badSpec', 'The abandon reason is one sentence of at most 300 characters, naming the assumption the attempts shared.')
  const won = lastWin(m) !== null
  const spec = args.followUp
  if (won && !spec)
    return invalid('followUpRequired', `${m.id} has a win, so abandoning it takes a follow-up built on its best commit: a retry with a smaller targetGain, or new steps.`)
  if (!won && spec) return invalid('followUpNotAllowed', `${m.id} has no win to build on, so its commits are dropped. Add a new module instead.`)
  if (spec) {
    const problem = moduleProblem(spec, config) ?? goalMismatch(p.goal, spec)
    if (problem) return invalid('badSpec', problem)
    if (p.modules.some((x) => x.title === spec.title.trim())) return conflict('titleTaken', `Project "${p.title}" already has a module titled "${spec.title}".`)
    if (spec.retryOf !== undefined) {
      if (spec.retryOf !== m.id) return invalid('badSpec', `A follow-up can only retry the module it follows, ${m.id}.`)
      if (m.retryOf !== null) return invalid('badSpec', `${m.id} is already a retry, so its follow-up can only build on it.`)
      if (spec.goal.targetGain >= m.goal.targetGain) return invalid('badSpec', `A retry's targetGain must be below ${m.id}'s ${m.goal.targetGain}%.`)
    }
  }

  const flight = m.jobs.find((j) => j.state === 'queued' || j.state === 'running')
  if (flight) cancel(flight, at)
  m.reason = args.reason.trim()
  if (spec) {
    const next = moduleFrom(a, spec, p.maxMinutes, config)
    p.modules.splice(p.modules.indexOf(m) + 1, 0, next)
    m.followUp = next.id
  }
  move(m, 'abandoned', at)
  advance(w, a, at, config)
  return ok({ followUp: m.followUp, startsFrom: startsFrom() })
}

// Admin calls

/**
 * Ends an agent's open project for good: cancels the jobs in flight, abandons
 * every module that hasn't ended, measures where the project got, and opens
 * the next queued project. `project` names the one to stop, so a repeat after
 * the next one has opened stops nothing.
 */
export function stopProject(w: World, at: Ms, args: { agent: string; project?: string; note?: string }, config: Config = DEFAULTS): Result<{ project: string; stoppedAt: Iso }> {
  settle(w, at, config)
  if (args.project !== undefined && !isText(args.project, 80)) return invalid('badSpec', 'project is the title of the project to stop.')
  if (args.note !== undefined && args.note !== '' && !isText(args.note, 300)) return invalid('badSpec', 'A stop note is one line of at most 300 characters.')
  const a = agentOf(w, args.agent)
  const title = args.project?.trim()
  const p = !a ? null : title === undefined ? a.project : ([a.project, ...a.past].find((x) => x?.title === title) ?? null)
  if (p?.stoppedAt !== undefined) return ok({ project: p.title, stoppedAt: iso(p.stoppedAt) })
  if (!a || !p || p !== a.project || projectEnded(p, at)) return conflict('noOpenProject', `Agent ${args.agent} has no open project${title ? ` titled "${title}"` : ''} to stop.`)
  const note = args.note?.trim() || null
  for (const m of p.modules) {
    if (ended(m.state)) continue
    const flight = inFlight(m)
    if (flight) cancel(flight, at)
    m.reason = note ? `Stopped by the admin. ${note}` : 'Stopped by the admin.'
    move(m, 'stopped', at)
  }
  p.stoppedAt = at
  if (note) p.stopNote = note
  advance(w, a, at, config)
  return ok({ project: p.title, stoppedAt: iso(at) })
}

function findChange(w: World, id: string) {
  for (const a of w.agents)
    for (const p of a.project ? [a.project, ...a.past] : a.past)
      for (const m of p.modules) {
        const c = m.changes.find((x) => x.id === id)
        if (c) return { a, p, m, c }
      }
  return null
}

/** The change request with its module, for the HTTP layer to rebase it before approval. */
export function changeRecord(w: World, id: string) {
  return findChange(w, id)
}

/**
 * Approves or rejects a change request. When the verifiers changed after it
 * was filed, approval takes `rebased`: the request's edits applied to the
 * current set, so an approval never undoes another one.
 */
export function decideChange(
  w: World,
  at: Ms,
  args: { change: string; approve: boolean; rebased?: VerifierSpec; note?: string; others?: { module: string; verifiers: VerifierSpec }[] },
  config: Config = DEFAULTS,
): Result<{ state: 'approved' | 'rejected'; appliedTo: ModuleId[] }> {
  settle(w, at, config)
  const found = findChange(w, args.change)
  if (!found) return notFound('noChange', `There is no change request ${args.change}.`)
  const { a, m, c } = found
  const state = args.approve ? 'approved' : 'rejected'
  if (c.state !== 'open') return c.state === state ? ok({ state, appliedTo: c.appliedTo ?? [] }) : conflict('changeDecided', `${c.id} was already ${c.state}.`)
  if (args.note !== undefined && args.note !== '' && !isText(args.note, 1000)) return invalid('badSpec', 'A note is one line of at most 1,000 characters.')
  if (args.approve && !takes('verifiers', m.state)) return conflict('wrongState', `${m.id} has ended, so its verifiers can't change. Reject the request instead.`)
  const current = verifiersOf(m)!
  const next = c.base === current.hash ? c.proposed : args.rebased
  if (args.approve && !next) return conflict('changeStale', `${m.id}'s verifiers changed after ${c.id} was filed. Apply its edits to the current set and approve that.`)
  // The same edits for the project's modules that haven't started, each against its own set
  const others: { m: ModuleRec; v: VerifierSpec }[] = []
  for (const o of args.approve ? (args.others ?? []) : []) {
    const om = found.p.modules.find((x) => x.id === o.module)
    if (!om || om === m || om.state !== 'pending' || baselineJob(om)) return invalid('badSpec', `${o.module} isn't a module of ${found.p.title} that has yet to start.`)
    const problem = verifierProblem(o.verifiers, om.steps.length)
    if (problem) return invalid('badSpec', `${om.id}: ${problem}`)
    others.push({ m: om, v: o.verifiers })
  }
  if (args.approve && next) {
    const problem = verifierProblem(next, m.steps.length)
    if (problem) return invalid('badSpec', problem)
    // The reviewed edits join the set its author wrote, so the author stays
    if (next.hash !== current.hash) m.verifiers.push({ ...normalVerifiers(next), author: current.author, frozenAt: at })
    for (const o of others) {
      const was = verifiersOf(o.m)
      if (was?.hash !== o.v.hash) o.m.verifiers.push({ ...normalVerifiers(o.v), author: was?.author ?? current.author, frozenAt: at })
    }
    c.appliedTo = others.map((o) => o.m.id)
  }
  c.state = state
  c.decidedAt = at
  c.note = args.note ? args.note.trim() : null
  advance(w, a, at, config)
  return ok({ state, appliedTo: c.appliedTo ?? [] })
}

export function replaceVerifiers(w: World, at: Ms, args: { agent: string; module: string; verifiers: VerifierSpec }, config: Config = DEFAULTS): Result<{ hash: string }> {
  settle(w, at, config)
  const found = find(w, args.agent, args.module)
  if (!found.ok) return found
  const { a, m } = found.value
  const problem = verifierProblem(args.verifiers, m.steps.length)
  if (problem) return invalid('badSpec', problem)
  if (!takes('verifiers', m.state)) return conflict('wrongState', `${m.id} has ended, so its verifiers can't change.`)
  if (verifiersOf(m)?.hash === args.verifiers.hash) return ok({ hash: args.verifiers.hash })
  m.verifiers.push({ ...normalVerifiers(args.verifiers), author: 'admin', frozenAt: at })
  advance(w, a, at, config)
  return ok({ hash: args.verifiers.hash })
}

// Runner calls

/** What a runner needs to run a job. */
export interface Ticket {
  job: JobId
  kind: JobKind
  agent: AgentId
  module: ModuleId
  step: number | null
  /** Where to fetch the commits. Null means the runner's default remote. */
  repo: string | null
  /** The commits to benchmark, alternating in this order: the best commit first, then the one under test. */
  commits: Commit[]
  /** The commit whose tests run. */
  commit: Commit
  verifierHash: string
  image: string
  hardware: string
  timeLimitMinutes: number
  /** Test commands, regression tests first. */
  tests: string[]
  benchmark: string
  runs: number
  leaseUntil: Iso
}

export function claimJob(w: World, at: Ms, args: { runner: string; labels: string[] }, config: Config = DEFAULTS): Result<Ticket | null> {
  settle(w, at, config)
  if (!isText(args.runner, 60)) return invalid('badSpec', 'A runner needs a name.')
  if (!Array.isArray(args.labels) || args.labels.length === 0 || !args.labels.every((l) => isText(l, 40))) return invalid('badSpec', 'A runner needs its hardware labels, such as cpu.')
  // The oldest queued job whose hardware the runner has
  // Ended projects too, for their final measurement
  const projects = (a: AgentRec) => (a.project ? [a.project, ...a.past] : a.past)
  const queued = w.agents.flatMap((a) => projects(a).flatMap((p) => p.modules.flatMap((m) => m.jobs.filter((j) => j.state === 'queued').map((j) => ({ a, m, j })))))
  const pick = queued
    .filter(({ m, j }) => args.labels.includes(verifierSet(m, j.verifierHash)!.hardware))
    .sort((x, y) => x.j.queuedAt - y.j.queuedAt || Number(x.j.id.slice(1)) - Number(y.j.id.slice(1)))[0]
  if (!pick) return ok(null)
  const { a, m, j } = pick
  const repo = locate(w, a.id, m.id)!.p.repo
  const leaseUntil = at + config.leaseMinutes * MINUTE
  j.state = 'running'
  j.claims.push({ runner: args.runner, at, leaseUntil, endedAt: null, lapsed: false, error: null })
  const v = verifierSet(m, j.verifierHash)!
  return ok({
    job: j.id,
    kind: j.kind,
    agent: a.id,
    module: m.id,
    step: j.step,
    repo,
    commits: j.bestCommit === null || j.bestCommit === j.commit ? [j.commit] : [j.bestCommit, j.commit],
    commit: j.commit,
    verifierHash: v.hash,
    image: v.image,
    hardware: v.hardware,
    timeLimitMinutes: v.timeLimitMinutes,
    tests: j.kind === 'final' ? [] : [v.commands.regression, ...j.stepTests.map((n) => v.commands.steps[n - 1]!)],
    benchmark: v.commands.benchmark,
    runs: v.runs ?? config.runs,
    leaseUntil: iso(leaseUntil),
  })
}

export function renewLease(w: World, at: Ms, args: { job: string; runner: string }, config: Config = DEFAULTS): Result<{ state: JobState; leaseUntil: Iso | null }> {
  settle(w, at, config)
  const found = findJob(w, args.job)
  if (!found) return notFound('noJob', `There is no job ${args.job}.`)
  const { j } = found
  const claim = j.claims.at(-1)
  if (!claim || claim.runner !== args.runner || claim.lapsed || claim.error !== null) return conflict('notYourJob', `${args.runner} doesn't hold ${j.id}. Its lease lapsed, or another runner holds it.`)
  if (j.state !== 'running') return ok({ state: j.state, leaseUntil: null })
  claim.leaseUntil = at + config.leaseMinutes * MINUTE
  return ok({ state: j.state, leaseUntil: iso(claim.leaseUntil) })
}

function resultsProblem(r: JobResults | undefined, j: JobRec, runs: number): string | null {
  if (!r || typeof r !== 'object') return 'Results must be an object.'
  if (!['done', 'killed', 'badCommit', 'tampered', 'error'].includes(r.outcome)) return 'outcome must be done, killed, badCommit, tampered, or error.'
  if (r.sandbox !== undefined && !SANDBOXES.includes(r.sandbox)) return `sandbox must be ${SANDBOXES.join(' or ')}.`
  if (r.tampered !== undefined && (!Array.isArray(r.tampered) || r.tampered.length > 1000 || !r.tampered.every((x) => typeof x === 'string'))) return 'tampered must be a list of file paths.'
  const t = r.tests ?? null
  const count = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0
  if (t !== null && (typeof t !== 'object' || !count(t.passed) || !count(t.total) || t.passed > t.total)) return 'tests must be null or whole numbers with passed no more than total.'
  if (!Array.isArray(r.runs)) return 'runs must be a list.'
  const commits = new Set([j.commit, j.bestCommit].filter(Boolean))
  for (const run of r.runs) {
    if (!run || typeof run.commit !== 'string' || !commits.has(run.commit.toLowerCase() as Commit)) return `Every run's commit must be one of the job's commits: ${[...commits].join(', ')}.`
    if (!Number.isFinite(run.value) || run.value <= 0) return 'Every run needs a positive value, because gains are percentages of it.'
    if (!Number.isFinite(run.work) || run.work < 0) return "Every run needs a work count that isn't negative."
  }
  // Exactly the runs asked for on each commit, or none for a commit the benchmark couldn't measure
  for (const c of commits) {
    const n = r.runs.filter((run) => run.commit.toLowerCase() === c).length
    if (n !== 0 && n !== runs) return `Send ${runs} runs on ${c}, or none if its benchmark failed; got ${n}.`
  }
  if (!Array.isArray(r.touched) || r.touched.length > 1000 || !r.touched.every((x) => typeof x === 'string')) return 'touched must be a list of file paths.'
  return null
}

export function sendResults(w: World, at: Ms, args: { job: string; runner: string; results: JobResults }, config: Config = DEFAULTS): Result<{ state: JobState }> {
  settle(w, at, config)
  const found = findJob(w, args.job)
  if (!found) return notFound('noJob', `There is no job ${args.job}.`)
  const { p, m, j } = found
  // A repeat gets the stored result; a cancelled job's late result changes nothing
  if (j.state === 'done' || j.state === 'killed' || j.state === 'failed' || j.state === 'cancelled') return ok({ state: j.state })
  const claim = j.claims.at(-1)
  if (j.state !== 'running' || !claim || claim.runner !== args.runner || claim.endedAt !== null) return conflict('notYourJob', `${args.runner} doesn't hold ${j.id}. Its lease lapsed, or another runner holds it.`)
  const problem = resultsProblem(args.results, j, verifierSet(m, j.verifierHash)?.runs ?? config.runs)
  if (problem) return invalid('badResults', problem)

  const r = args.results
  if (r.outcome === 'error') {
    runnerError(m, j, String(r.error ?? 'The runner gave no reason.'), at)
    settle(w, at, config)
    return ok({ state: j.state })
  }
  j.results = {
    outcome: r.outcome,
    tests: r.tests && { passed: r.tests.passed, total: r.tests.total },
    runs: r.runs.map((run) => ({ commit: run.commit.toLowerCase() as Commit, value: run.value, work: run.work })),
    touched: r.touched.slice(0, 1000),
    ...(r.tampered?.length ? { tampered: r.tampered.slice(0, 1000) } : {}),
    ...(r.sandbox ? { sandbox: r.sandbox } : {}),
    ...(r.error ? { error: String(r.error).slice(0, 500) } : {}),
  }
  // A commit the runner can't fetch fails like failing tests, but isn't stored as a result to reuse
  j.state = r.outcome === 'done' ? 'done' : r.outcome === 'killed' ? 'killed' : 'failed'
  j.finishedAt = at
  claim.endedAt = at
  apply(p, m, j, at, true)
  settle(w, at, config)
  return ok({ state: j.state })
}
