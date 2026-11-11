// Everything the server derives instead of storing. `factsOf` computes a
// module's numbers at one moment, so commands and views read the same values.
import type { Commit, ProjectEnd, ProjectResult } from '../../shared/api.ts'
import { extensionSeries, improve, judge, median } from './judge.ts'
import { MINUTE, type AgentRec, type AttemptRec, type Ms, type JobRec, type ModuleRec, type ProjectRec, type VerifierSet, type World } from './records.ts'
import { GRACE_SHARE, VERDICTS, does, ended, live, type Streak } from './rules.ts'

export const verifiersOf = (m: ModuleRec): VerifierSet | null => m.verifiers.at(-1) ?? null
export const verifierSet = (m: ModuleRec, hash: string): VerifierSet | null => m.verifiers.findLast((v) => v.hash === hash) ?? null
export const inFlight = (m: ModuleRec): JobRec | null => m.jobs.find((j) => j.state === 'queued' || j.state === 'running') ?? null
export const lastWin = (m: ModuleRec): AttemptRec | null => m.attempts.findLast((a) => a.judged?.verdict === 'win') ?? null
/** The latest attempt whose verdict moved the best commit. */
export const lastBest = (m: ModuleRec): AttemptRec | null => m.attempts.findLast((a) => does(a.judged?.verdict, 'movesBest')) ?? null
/** The commit an ended module hands on: its best commit once it has a win. A module without a win drops its commits. */
const keptOf = (m: ModuleRec): Commit | null => (lastWin(m) ? lastBest(m)!.commit : null)
/** When an attempt's job ended, judged or not. Null while it's in flight. */
export const attemptEnd = (m: ModuleRec, a: AttemptRec): Ms | null => a.judgedAt ?? m.jobs.find((j) => j.id === a.job)?.finishedAt ?? null

export const failedTurns = (m: ModuleRec, step: number) => m.attempts.filter((a) => a.step === step && does(a.judged?.verdict, 'failedTurn')).length
/** Every module has passed or been abandoned. The project stays open for the agent's next module. */
export const modulesEnded = (p: ProjectRec) => p.modules.every((m) => ended(m.state))

/** A job that passed its tests and measured something. */
export const measured = (j: JobRec) => j.state === 'done' && !!j.results?.tests && j.results.tests.passed === j.results.tests.total && j.results.runs.length > 0

/** The baseline job that started the module. */
export const baselineJob = (m: ModuleRec): JobRec | null => m.jobs.find((j) => j.kind === 'baseline' && measured(j)) ?? null

/** The latest measured baseline: the first, or one taken again after the module's verifiers changed. */
export const latestBaseline = (m: ModuleRec): JobRec | null => m.jobs.findLast((j) => j.kind === 'baseline' && measured(j)) ?? null

/** 0-based index of the first step not done; steps.length once all are done. */
export function currentStepIndex(m: ModuleRec): number {
  const i = m.steps.findIndex((s) => s.doneAt === null)
  return i === -1 ? m.steps.length : i
}

/** Wins in a row since the last verdict that ended the streak. */
export function streakOf(m: ModuleRec): number {
  let n = 0
  for (const a of m.attempts.filter((x) => x.judged).reverse()) {
    const streak = VERDICTS[a.judged!.verdict].streak
    if (streak === 'ends') break
    if (streak === 'extends') n++
  }
  return n
}

const headOf = (m: ModuleRec, start: Commit | null) => m.attempts.findLast((a) => does(a.judged?.verdict, 'movesHead'))?.commit ?? start

/** Each module's start commit, in project order: what the module before it left behind. Null until that module ends. */
export function startCommits(p: ProjectRec): (Commit | null)[] {
  const out: (Commit | null)[] = []
  let from: Commit | null = p.startCommit
  for (const m of p.modules) {
    out.push(from)
    // An ended module leaves its best commit once it has a win, or its own start without one
    if (from === null || !ended(m.state)) from = null
    else from = keptOf(m) ?? from
  }
  return out
}

/** The commit an ended project left behind, for the next project to start from. Null while it's open. */
export function endCommit(p: ProjectRec): Commit | null {
  const starts = startCommits(p)
  const m = p.modules.at(-1)
  if (!m || !ended(m.state)) return null
  return keptOf(m) ?? starts.at(-1) ?? null
}

/** The commit the project has reached: the start of its first module that hasn't ended, or where it ended. */
export function reachedCommit(p: ProjectRec): Commit | null {
  const i = p.modules.findIndex((m) => !ended(m.state))
  return i === -1 ? endCommit(p) : startCommits(p)[i]!
}

/** The module whose verifiers measure the project: the last one before the reached commit that measured a baseline. */
export function measureHost(p: ProjectRec): ModuleRec | null {
  const i = p.modules.findIndex((m) => !ended(m.state))
  return (i === -1 ? p.modules : p.modules.slice(0, i)).findLast((m) => baselineJob(m) !== null) ?? null
}

/** The job measuring the start commit against the reached commit, if one was queued. */
export function progressJob(p: ProjectRec): { host: ModuleRec; j: JobRec } | null {
  const reached = reachedCommit(p)
  for (const host of [...p.modules].reverse()) {
    const j = host.jobs.findLast((x) => x.kind === 'final' && x.commit === reached && x.bestCommit === p.startCommit && x.state !== 'cancelled')
    if (j) return { host, j }
  }
  return null
}

/** What the start commit and the reached commit measured, side by side in one job. */
export function progressOf(p: ProjectRec): ProjectResult | null {
  const found = progressJob(p)
  if (!found) return null
  const { host, j } = found
  if (j.state === 'queued' || j.state === 'running') return { state: 'measuring' }
  const values = (c: Commit | null) => (j.results?.runs ?? []).filter((r) => r.commit === c).map((r) => r.value)
  const r = judge({ tests: j.results?.tests ?? null, killed: j.state !== 'done', best: values(j.bestCommit), next: values(j.commit) }, { direction: host.goal.direction, minGain: 0 })
  if (r.median === null || r.bestMedian === null || r.gain === null || r.p === null) return { state: 'failed' }
  return { state: 'done', metric: host.goal.metric, unit: host.goal.unit, direction: host.goal.direction, from: r.bestMedian, to: r.median, gain: r.gain, p: r.p }
}

/** When the project's hours are up, or null without a budget. */
export const budgetEndsAt = (p: ProjectRec): Ms | null => (p.goal?.hours ? p.openedAt + p.goal.hours * 60 * MINUTE : null)

/**
 * Where a project stands. It ends only when the admin stops it or its hours
 * run out, both stops a human chose. Until then a project whose modules have
 * all ended waits for the agent's next module, goal or not, measured or not.
 */
export type ProjectStanding = { state: 'open' } | { state: 'needsModule' } | { state: 'ended'; end: ProjectEnd }

export function standingOf(p: ProjectRec, now: Ms): ProjectStanding {
  if (p.stoppedAt !== undefined) return { state: 'ended', end: 'stopped' }
  if (!modulesEnded(p)) return { state: 'open' }
  const budget = budgetEndsAt(p)
  if (budget !== null && now >= budget) return { state: 'ended', end: 'budget' }
  return { state: 'needsModule' }
}

export const projectEnded = (p: ProjectRec, now: Ms) => standingOf(p, now).state === 'ended'

/** The pending module whose turn it is: the first that hasn't ended, if it's pending. */
export function firstInLine(p: ProjectRec): ModuleRec | null {
  const m = p.modules.find((x) => !ended(x.state))
  return m?.state === 'pending' ? m : null
}

/** The module that is active, past target, or stuck, or else the next pending one. */
export function currentOf(p: ProjectRec): ModuleRec | null {
  return p.modules.find((m) => live(m.state) || m.state === 'stuck') ?? p.modules.find((m) => m.state === 'pending') ?? null
}

export interface WaitRec {
  at: Ms
  minutes: number
}

/** Time the module's jobs spent queued after it started, including a wait still going on. */
export function waitsOf(m: ModuleRec, startedAt: Ms | null, now: Ms): WaitRec[] {
  if (startedAt === null) return []
  const out: WaitRec[] = []
  const add = (from: Ms, to: Ms) => {
    const at = Math.max(from, startedAt)
    if (to > at) out.push({ at, minutes: (to - at) / MINUTE })
  }
  for (const j of m.jobs) {
    // A project's final measurement runs after its modules have stopped
    if (j.kind === 'final') continue
    let from: Ms | null = j.queuedAt
    for (const c of j.claims) {
      add(from, c.at)
      // A lapsed lease or a runner error puts the job back in the queue
      from = c.lapsed || c.error !== null ? c.endedAt : null
      if (from === null) break
    }
    if (from !== null) add(from, j.state === 'queued' ? now : (j.finishedAt ?? now))
  }
  return out.sort((x, y) => x.at - y.at)
}

export interface ExtensionRec {
  minutes: number
  cause: 'streak' | 'win' | 'step'
  at: Ms
}

/**
 * The extensions earned so far: half of maxMinutes to the win that makes the
 * first streak of 2 or the first finished step that holds the metric, then
 * half the previous to each later win or held step.
 */
export function extensionsOf(m: ModuleRec, start: Commit | null = null): ExtensionRec[] {
  // A finished step neither extends nor ends a streak
  type Event = { at: Ms; attempt: boolean; streak: Streak; held: boolean }
  // A finished step only counts if its check measured a different head commit than the step before it, or the start
  let checked = start
  const steps = m.steps
    .filter((s) => s.doneAt !== null)
    .sort((x, y) => x.doneAt! - y.doneAt!)
    .map((s): Event => {
      const changed = s.commit === undefined || s.commit === null || s.commit !== checked
      if (s.commit) checked = s.commit
      return { at: s.doneAt!, attempt: false, streak: 'holds', held: s.held === true && changed }
    })
  const attempts = m.attempts.filter((a) => a.judged && a.judgedAt !== null).map((a): Event => ({ at: a.judgedAt!, attempt: true, streak: VERDICTS[a.judged!.verdict].streak, held: false }))
  const events = [...attempts, ...steps].sort((x, y) => x.at - y.at)
  const series = extensionSeries(m.maxMinutes)
  const out: ExtensionRec[] = []
  let run = 0
  for (const e of events) {
    const win = e.streak === 'extends'
    if (e.streak !== 'holds') run = win ? run + 1 : 0
    const minutes = series[out.length]
    if (minutes === undefined) break
    const first = out.length === 0
    const earns = first ? (win && run >= 2) || e.held : win || e.held
    if (earns) out.push({ minutes, cause: e.attempt ? (first ? 'streak' : 'win') : 'step', at: e.at })
  }
  return out
}

/** A module's numbers at one moment. */
export interface Facts {
  start: Commit | null
  best: Commit | null
  head: Commit | null
  baseline: number | null
  target: number | null
  /** The best commit's median: the latest win's, or the baseline. */
  bestValue: number | null
  startedAt: Ms | null
  waits: WaitRec[]
  waited: number
  extensions: ExtensionRec[]
  deadline: Ms | null
  graceMinutes: number
  /** The deadline's last attempt: the one in flight at the deadline, or else the first posted after it. */
  last: AttemptRec | null
  /** 0-based. */
  step: number
  streak: number
  inFlight: JobRec | null
}

export function factsOf(p: ProjectRec, m: ModuleRec, now: Ms): Facts {
  const start = startCommits(p)[p.modules.indexOf(m)] ?? null
  const moved = lastBest(m)
  // The clock starts at the first baseline; the numbers come from the latest, taken again when the verifiers change
  const first = baselineJob(m)
  const latest = latestBaseline(m)
  const on = (c: Commit | null) => latest!.results!.runs.filter((r) => r.commit === c).map((r) => r.value)
  const baseline = latest ? median(on(latest.commit)) : null
  const startedAt = first?.finishedAt ?? null
  // A re-measured baseline also measured the best commit, which stands until the best commit moves
  const remeasured = latest && latest.bestCommit && on(latest.bestCommit).length ? median(on(latest.bestCommit)) : null
  const bestValue = moved?.judged && moved.judgedAt !== null && latest && moved.judgedAt > latest.finishedAt! ? moved.judged.median : (remeasured ?? moved?.judged?.median ?? baseline)
  const waits = waitsOf(m, startedAt, now)
  const waited = waits.reduce((sum, w) => sum + w.minutes, 0)
  const extensions = startedAt === null ? [] : extensionsOf(m, start)
  const extended = extensions.reduce((sum, e) => sum + e.minutes, 0)
  const deadline = startedAt === null ? null : startedAt + (m.maxMinutes + extended + waited) * MINUTE
  const last =
    deadline === null
      ? null
      : (m.attempts.find((a) => {
          const end = attemptEnd(m, a)
          return a.postedAt <= deadline && (end === null || end >= deadline)
        }) ??
        m.attempts.find((a) => a.postedAt > deadline) ??
        null)
  return {
    start,
    best: moved?.commit ?? start,
    head: headOf(m, start),
    baseline,
    target: baseline === null ? null : improve(baseline, m.goal.targetGain, m.goal.direction),
    bestValue,
    startedAt,
    waits,
    waited,
    extensions,
    deadline,
    graceMinutes: m.maxMinutes * GRACE_SHARE,
    last,
    step: currentStepIndex(m),
    streak: streakOf(m),
    inFlight: inFlight(m),
  }
}

/**
 * When a live module runs out of time: once its last attempt is judged, or
 * when the grace period ends without one. A step check in flight at the
 * deadline still finishes first. Null while that can't be known yet.
 */
export function timesOutAt(m: ModuleRec, f: Facts): Ms | null {
  if (f.deadline === null) return null
  const d = f.deadline
  if (f.last) return attemptEnd(m, f.last)
  const check = m.jobs.find((j) => j.kind === 'stepCheck' && j.queuedAt <= d && (j.finishedAt === null || j.finishedAt >= d) && j.state !== 'cancelled')
  const graceEnds = d + f.graceMinutes * MINUTE
  if (!check) return graceEnds
  return check.finishedAt === null ? null : Math.max(graceEnds, check.finishedAt)
}

export interface Located {
  a: AgentRec
  p: ProjectRec
  m: ModuleRec
}

export const agentOf = (w: World, id: string): AgentRec | null => w.agents.find((a) => a.id === id) ?? null

const projectsOf = (a: AgentRec) => (a.project ? [a.project, ...a.past] : a.past)

/** Finds a module in any of the agent's projects. Module IDs are unique per agent. */
export function locate(w: World, agent: string, module: string): Located | null {
  const a = agentOf(w, agent)
  for (const p of a ? projectsOf(a) : []) {
    const m = p.modules.find((x) => x.id === module)
    if (m) return { a: a!, p, m }
  }
  return null
}

export function findJob(w: World, id: string): (Located & { j: JobRec }) | null {
  for (const a of w.agents)
    for (const p of projectsOf(a))
      for (const m of p.modules) {
        const j = m.jobs.find((x) => x.id === id)
        if (j) return { a, p, m, j }
      }
  return null
}
