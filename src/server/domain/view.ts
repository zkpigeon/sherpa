// What the server sends: the records turned into the Board and AttemptDetail
// of src/shared/api.ts, the plain-text board lines, and the small answers to
// an agent's GET calls. Read-only; settle the world first.
import type { Agent, AgentId, Attempt, AttemptDetail, AttemptId, Board, ChangeId, CleanResults, Clock, Commit, Goal, Iso, JobId, Module, ModuleId, ModuleStatus, Project, Verdict } from '../../shared/api.ts'
import { judge, smaller } from './judge.ts'
import { boardLine } from '../../shared/boardLine.ts'
import { budgetEndsAt, currentOf, factsOf, failedTurns, firstInLine, locate, measured, progressOf, reachedCommit, standingOf, verifiersOf, type Facts } from './queries.ts'
import { ended } from './rules.ts'
import { MINUTE, iso, type AgentRec, type AttemptRec, type JobRec, type ModuleRec, type Ms, type ProjectRec, type VerifierSet, type World } from './records.ts'

const jobOf = (m: ModuleRec, x: AttemptRec) => m.jobs.find((j) => j.id === x.job)!

function attemptOf(m: ModuleRec, x: AttemptRec): Attempt {
  return {
    id: x.id,
    step: x.step,
    commit: x.commit,
    note: x.note,
    job: jobOf(m, x).state,
    verdict: x.judged?.verdict ?? null,
    median: x.judged?.median ?? null,
    postedAt: iso(x.postedAt),
    judgedAt: x.judgedAt === null ? null : iso(x.judgedAt),
  }
}

/** A failed baseline leaves the module waiting for new verifiers. */
function baselineFailed(m: ModuleRec): boolean {
  const v = verifiersOf(m)
  const job = v && m.jobs.findLast((j) => j.kind === 'baseline' && j.verifierHash === v.hash)
  return !!job && job.state !== 'queued' && job.state !== 'running' && !measured(job)
}

function statusOf(p: ProjectRec, m: ModuleRec): ModuleStatus {
  switch (m.state) {
    case 'pending':
      if (firstInLine(p) !== m) return { state: 'pending', waitingFor: 'turn' }
      return { state: 'pending', waitingFor: !verifiersOf(m) || baselineFailed(m) ? 'verifiers' : 'baseline' }
    case 'stuck':
      return { state: 'stuck', cause: m.cause ?? 'step' }
    case 'abandoned':
      return { state: 'abandoned', reason: m.reason ?? '', followUp: m.followUp }
    default:
      return { state: m.state }
  }
}

function clockOf(m: ModuleRec, f: Facts, now: Ms): Clock {
  if (f.startedAt === null && m.stoppedAt === null) return { kind: 'notStarted' }
  const shared = {
    maxMinutes: m.maxMinutes,
    extensions: f.extensions.map((e) => ({ ...e, at: iso(e.at) })),
    waits: f.waits.map((w) => ({ at: iso(w.at), minutes: w.minutes })),
    waitedMinutes: f.waited,
  }
  if (m.stoppedAt !== null || f.startedAt === null) return { kind: 'stopped', startedAt: f.startedAt === null ? null : iso(f.startedAt), at: iso(m.stoppedAt ?? now), ...shared }
  const deadline = f.deadline!
  // An attempt in flight at the deadline is the last one, and no grace period opens
  const graceOpen = now >= deadline && !(f.last && f.last.postedAt <= deadline)
  if (!graceOpen) return { kind: 'running', startedAt: iso(f.startedAt), deadline: iso(deadline), ...shared }
  return { kind: 'grace', startedAt: iso(f.startedAt), deadline: iso(deadline), graceEnds: iso(deadline + f.graceMinutes * MINUTE), ...shared }
}

function moduleOf(p: ProjectRec, m: ModuleRec, now: Ms): Module {
  const f = factsOf(p, m, now)
  const v = verifiersOf(m)
  const tests = m.jobs.findLast((j) => j.kind !== 'final' && j.results?.tests)?.results?.tests?.total ?? null
  return {
    id: m.id,
    position: p.modules.indexOf(m) + 1,
    title: m.title,
    status: statusOf(p, m),
    steps: m.steps.map((s, i) => ({ title: s.title, done: s.doneAt !== null, failedTurns: failedTurns(m, i + 1) })),
    goal: { ...m.goal, baseline: f.baseline, target: f.target },
    verifiers: v ? { kind: 'frozen', hash: v.hash, tests, author: v.author, hardware: v.hardware, openChanges: m.changes.filter((c) => c.state === 'open').length } : { kind: 'missing' },
    changes: m.changes.map((c) => ({
      id: c.id,
      author: c.author,
      reason: c.reason,
      files: c.changed,
      state: c.state,
      filedAt: iso(c.filedAt),
      decidedAt: c.decidedAt === null ? null : iso(c.decidedAt),
      note: c.note ?? null,
      appliedTo: c.appliedTo ?? [],
    })),
    best: f.bestValue,
    bestCommit: f.best,
    headCommit: f.head,
    streak: f.streak,
    attempts: m.attempts.map((x) => attemptOf(m, x)),
    clock: clockOf(m, f, now),
    retryOf: m.retryOf,
    flags: m.flags.map((x) => ({ ...x, at: iso(x.at) })),
  }
}

function projectOf(p: ProjectRec, now: Ms): Project {
  const standing = standingOf(p, now)
  const g = p.goal ?? null
  const budget = budgetEndsAt(p)
  return {
    title: p.title,
    goal: g && { ...g, budgetEndsAt: budget === null ? null : iso(budget) },
    state: standing.state,
    end: standing.state === 'ended' ? standing.end : null,
    stopNote: p.stopNote ?? null,
    progress: progressOf(p),
    reached: reachedCommit(p),
    modules: p.modules.map((m) => moduleOf(p, m, now)),
    current: currentOf(p)?.id ?? null,
  }
}

export function agentView(a: AgentRec, now: Ms): Agent {
  const project = a.project && projectOf(a.project, now)
  const agent: Agent = { id: a.id, blurb: a.blurb, line: '', project, queued: a.queued.map((q) => q.title) }
  return { ...agent, line: boardLine(agent, new Date(now)) }
}

export function boardOf(w: World, now: Ms): Board {
  return { generatedAt: iso(now), agents: w.agents.map((a) => agentView(a, now)) }
}

/** GET /agents/{id}/project: the agent's project in brief, so an agent can find its modules and a verifier agent the ones waiting for verifiers. */
export interface AgentProject {
  title: string
  goal: Project['goal']
  state: Project['state']
  progress: Project['progress']
  /** Null once every module has ended. */
  current: ModuleId | null
  /** `failed`: frozen, but the baseline job failed on them, so the module waits for a change request. */
  modules: { id: ModuleId; position: number; title: string; status: ModuleStatus; steps: string[]; goal: Goal; verifiers: 'missing' | 'frozen' | 'failed'; openChanges: number }[]
  /** Titles of the agent's projects waiting to start. */
  queued: string[]
}

export function agentProjectOf(a: AgentRec, now: Ms): AgentProject | null {
  const { project: p, queued } = agentView(a, now)
  if (!p) return null
  const { goal, state, progress } = p
  const modules = p.modules.map((m) => ({
    id: m.id,
    position: m.position,
    title: m.title,
    status: m.status,
    steps: m.steps.map((s) => s.title),
    goal: m.goal,
    verifiers: m.verifiers.kind === 'frozen' && m.status.state === 'pending' && m.status.waitingFor === 'verifiers' ? ('failed' as const) : m.verifiers.kind,
    openChanges: m.verifiers.kind === 'frozen' ? m.verifiers.openChanges : 0,
  }))
  return { title: p.title, goal, state, progress, current: p.current, modules, queued }
}

/** GET /board: every agent's board line. */
export const boardText = (w: World, now: Ms) => w.agents.map((a) => agentView(a, now).line).join('\n')

export function attemptDetailOf(w: World, agent: AgentId, module: ModuleId, attempt: AttemptId): AttemptDetail | null {
  const found = locate(w, agent, module)
  const x = found?.m.attempts.find((y) => y.id === attempt)
  if (!found || !x) return null
  const j = jobOf(found.m, x)
  return {
    agent,
    module,
    attempt: attemptOf(found.m, x),
    bestCommit: x.bestCommit,
    verifierHash: j.verifierHash,
    runner: j.claims.at(-1)?.runner ?? null,
    tests: j.results?.tests ?? null,
    runs: j.results?.runs ?? [],
    bestMedian: x.judged?.bestMedian ?? null,
    gain: x.judged?.gain ?? null,
    p: x.judged?.p ?? null,
    clean: j.results?.clean ?? null,
    touchedVerifiers: j.results?.touched ?? [],
    sandbox: j.results?.sandbox ?? null,
  }
}

/** GET /agents/{id}/modules/{m}/attempts/{attemptId}: what the agent needs to decide its next move. */
export interface AttemptStatus {
  attempt: AttemptId
  job: Attempt['job']
  verdict: Verdict | null
  /** One sentence on why the verdict is what it is, or what the job is doing. */
  why: string
  /** Median of the attempt's runs, and of the best commit's runs in the same job. */
  median: number | null
  bestMedian: number | null
  /** Percent better than the best commit, in the goal's direction; negative when worse. */
  gain: number | null
  p: number | null
  tests: { passed: number; total: number } | null
  /** The clean rules on both commits, when the verifiers have a clean command and the tests passed. */
  clean: CleanResults | null
  step: number
  failedTurns: number
  streak: number
  module: ModuleStatus
  /** Every other module has ended, so the project waits for the next one once this one ends. */
  lastModule: boolean
  line: string
}

/** Whether every other module has ended, so the agent should add the next one before this one ends. */
const isLast = (p: ProjectRec, m: ModuleRec) => p.modules.every((x) => x === m || ended(x.state))

const pct = (n: number) => `${Math.abs(n) < 10 ? Math.abs(n).toFixed(1) : Math.round(Math.abs(n))}%`
const pText = (p: number) => (p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3)}`)
const sizeText = (n: number | null) => (n === null ? 'no size' : n.toLocaleString('en-US'))

/** Why a job's verdict came out as it did, in one sentence, so a flat result can be told from a noisy one. */
function why(m: ModuleRec, x: AttemptRec, j: JobRec): string {
  const state = j.state
  if (state === 'queued') return 'Queued for a runner.'
  if (state === 'running') return `Running on ${j.claims.at(-1)?.runner ?? 'a runner'}.`
  if (state === 'cancelled') return 'Cancelled when the module was abandoned or the project stopped.'
  const r = j.results
  if (!x.judged || !r) {
    const error = j.claims.findLast((c) => c.error)?.error
    return `No verdict: no runner could run the job${error ? ` (${error})` : ''}. It doesn't count as a failed turn.`
  }
  const d = x.judged
  if (r.outcome === 'killed') return 'Fail: the job ran past its time limit.'
  if (r.outcome === 'tampered') return `Fail: a command changed the frozen ${(r.tampered ?? []).join(', ') || 'verifier files'}, so the runner threw the job out. Leave the verifier files alone.`
  if (r.outcome === 'badCommit') return `Fail: the runner couldn't fetch the commit${r.error ? `: ${r.error}` : ''}`.replace(/\.?$/, '.')
  if (r.tests && r.tests.passed < r.tests.total) return `Fail: ${r.tests.total - r.tests.passed} of ${r.tests.total} tests failed.`
  if (d.gain === null || d.p === null) return 'Fail: the benchmark measured nothing on this commit.'
  const { direction, minGain } = m.goal
  const way = d.gain >= 0 ? direction : direction === 'lower' ? 'higher' : 'lower'
  const moved = `${pct(d.gain)} ${way} than the best commit`
  if (d.verdict === 'win') return `Win: ${moved} (needs ${minGain}%), ${pText(d.p)} (needs below 0.05).`
  if (d.verdict === 'fail') return `Fail: ${moved}, and the rank test shows it's reliably worse (${pText(d.p)}).`
  const sizes = r.clean && `${sizeText(r.clean.best.size)} -> ${sizeText(r.clean.next.size)} in size under the clean rules`
  if (d.verdict === 'simpler') return `Simpler: ${moved}, short of a win, and ${sizes}.`
  // Smaller code that is still flat has a worse median, since one no worse would be simpler
  const clean = !r.clean ? '' : !r.clean.next.passed ? ' Not simpler: it breaks the clean rules.' : smaller(r.clean) ? ` Not simpler: ${sizes}, but its median is worse.` : ` Not simpler: ${sizes}.`
  if (d.gain < 0) return `Flat: ${moved}, but not reliably worse (${pText(d.p)}).${clean}`
  const short = [d.gain < minGain && `needs ${minGain}%`, d.p >= 0.05 && `${pText(d.p)}, needs below 0.05`].filter(Boolean).join('; ')
  return `Flat: ${moved}; ${short}.${clean}`
}

export function attemptStatusOf(w: World, agent: string, module: string, attempt: string, now: Ms): AttemptStatus | null {
  const found = locate(w, agent, module)
  const x = found?.m.attempts.find((y) => y.id === attempt)
  if (!found || !x) return null
  const { a, p, m } = found
  const j = jobOf(m, x)
  return {
    attempt: x.id,
    job: j.state,
    verdict: x.judged?.verdict ?? null,
    why: why(m, x, j),
    median: x.judged?.median ?? null,
    bestMedian: x.judged?.bestMedian ?? null,
    gain: x.judged?.gain ?? null,
    p: x.judged?.p ?? null,
    tests: j.results?.tests ?? null,
    clean: j.results?.clean ?? null,
    step: x.step,
    failedTurns: failedTurns(m, x.step),
    streak: factsOf(p, m, now).streak,
    module: statusOf(p, m),
    lastModule: isLast(p, m),
    line: agentView(a, now).line,
  }
}

/** GET /agents/{id}/modules/{m}: the module as the dashboard sees it, plus its verifiers' commands and files. */
export type AgentModule = Module & { lastModule: boolean; commands: VerifierSet['commands'] | null; paths: string[]; image: string | null; timeLimitMinutes: number | null }

export function agentModuleOf(w: World, agent: string, module: string, now: Ms): AgentModule | null {
  const found = locate(w, agent, module)
  if (!found) return null
  const { p, m } = found
  const v = verifiersOf(m)
  return { ...moduleOf(p, m, now), lastModule: isLast(p, m), commands: v?.commands ?? null, paths: v?.paths ?? [], image: v?.image ?? null, timeLimitMinutes: v?.timeLimitMinutes ?? null }
}

/** GET /agents/{id}/modules/{m}/steps/{n}: a step, and what its latest check found. */
export interface StepStatus {
  step: number
  title: string
  done: boolean
  /** Whether the finished step held the metric. Null until it's done. */
  held: boolean | null
  failedTurns: number
  /** Passed or abandoned before this step was done. */
  skipped: boolean
  check: { job: JobId; state: Attempt['job']; tests: { passed: number; total: number } | null; why: string } | null
  module: ModuleStatus
}

export function stepStatusOf(w: World, agent: string, module: string, n: number): StepStatus | null {
  const found = locate(w, agent, module)
  const step = found?.m.steps[n - 1]
  if (!found || !step || !Number.isInteger(n)) return null
  const { p, m } = found
  const j = m.jobs.findLast((x) => x.kind === 'stepCheck' && x.step === n) ?? null
  const checkWhy = (job: JobRec) => {
    if (job.state === 'queued') return 'Queued for a runner.'
    if (job.state === 'running') return `Running on ${job.claims.at(-1)?.runner ?? 'a runner'}.`
    if (job.state === 'cancelled') return 'Cancelled when the module was abandoned or the project stopped.'
    const r = job.results
    if (!r) return `No result: no runner could run the check. Mark the step done again to retry.`
    if (r.outcome === 'killed') return 'The check ran past its time limit, so the step stays open.'
    if (r.outcome === 'tampered') return 'A command changed a frozen verifier file, so the runner threw the check out and the step stays open.'
    if (r.outcome === 'badCommit') return "The runner couldn't fetch the head commit, so the step stays open."
    if (r.tests && r.tests.passed < r.tests.total) return `${r.tests.total - r.tests.passed} of ${r.tests.total} tests failed, so the step stays open.`
    if (step.held === false) return 'The tests passed and the step is done, but the metric got worse, so it earned no extension.'
    // A check on the same head commit as the step before it, or the start, did no new work
    const earlier = m.steps.filter((x) => x !== step && x.doneAt !== null && x.doneAt <= step.doneAt!).sort((x, y) => x.doneAt! - y.doneAt!).at(-1)
    const before = earlier?.commit ?? factsOf(p, m, step.doneAt ?? 0).start
    if (step.commit && step.commit === before) return "The tests passed and the step is done. The head commit hadn't changed since the last step check, so it earned no extension."
    return 'The tests passed, the step is done, and the metric held.'
  }
  return {
    step: n,
    title: step.title,
    done: step.doneAt !== null,
    held: step.held,
    failedTurns: failedTurns(m, n),
    skipped: step.doneAt === null && (m.state === 'passed' || m.state === 'abandoned'),
    check: j && { job: j.id, state: j.state, tests: j.results?.tests ?? null, why: checkWhy(j) },
    module: statusOf(p, m),
  }
}

export interface ChangeStatus {
  change: ChangeId
  module: ModuleId
  state: 'open' | 'approved' | 'rejected'
  reason: string
  filedAt: Iso
  decidedAt: Iso | null
  /** The admin's note on the decision. */
  note: string | null
  appliedTo: ModuleId[]
}

export function changeOf(w: World, agent: string, module: string, change: string): ChangeStatus | null {
  const c = locate(w, agent, module)?.m.changes.find((x) => x.id === change)
  if (!c) return null
  return {
    change: c.id,
    module: module as ModuleId,
    state: c.state,
    reason: c.reason,
    filedAt: iso(c.filedAt),
    decidedAt: c.decidedAt === null ? null : iso(c.decidedAt),
    note: c.note ?? null,
    appliedTo: c.appliedTo ?? [],
  }
}
