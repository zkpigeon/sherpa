// The module lifecycle as one table, what each verdict does as another, which
// states take which calls, and the checks a spec passes before the server
// stores it. Commands consult these instead of testing states inline, so each
// rule lives in one place.
import type { Verdict } from '../../shared/api.ts'
import type { Config, Goal, GoalSpec, ModuleSpec, ModuleState, ProjectGoal, ProjectGoalSpec, ProjectSpec, StuckCause, VerifierSpec } from './records.ts'

/** Every event that moves a module, and where it moves each state that allows it. */
export const LIFECYCLE = {
  /** The baseline job measured the start commit. */
  baselineMeasured: { pending: 'active' },
  /** A win reached the target. */
  metTarget: { active: 'passed' },
  /** A win reached the target with steps after the current one left, so the module keeps going while it wins. */
  metTargetStepsLeft: { active: 'pastTarget' },
  /** The current step's 3rd failed turn. */
  stepFailed: { active: 'stuck' },
  /** The last step's check passed. */
  lastStepDone: { active: 'stuck', pastTarget: 'passed' },
  /** An attempt that isn't a win, once past target. */
  streakEnded: { pastTarget: 'passed' },
  /** The last attempt was judged, or the grace period ended without one. */
  outOfTime: { active: 'stuck', pastTarget: 'passed' },
  /** The agent recorded an abandon reason. */
  abandoned: { pending: 'abandoned', active: 'abandoned', stuck: 'abandoned' },
  /** The admin stopped the project. */
  stopped: { pending: 'abandoned', active: 'abandoned', pastTarget: 'abandoned', stuck: 'abandoned' },
} as const satisfies Record<string, Partial<Record<ModuleState, ModuleState>>>

export type ModuleEvent = keyof typeof LIFECYCLE

/** What a move to stuck records. When one result triggers several, the first in this order wins. */
export const CAUSE: Partial<Record<ModuleEvent, StuckCause>> = { stepFailed: 'step', lastStepDone: 'target', outOfTime: 'time' }

export function nextState(event: ModuleEvent, from: ModuleState): ModuleState | null {
  const row: Partial<Record<ModuleState, ModuleState>> = LIFECYCLE[event]
  return row[from] ?? null
}

/** The states that take each agent call. */
export const TAKES = {
  attempt: ['active', 'pastTarget'],
  stepCheck: ['active', 'pastTarget'],
  abandon: ['pending', 'active', 'stuck'],
  verifiers: ['pending', 'active', 'pastTarget', 'stuck'],
} as const satisfies Record<string, readonly ModuleState[]>

export const takes = (call: keyof typeof TAKES, state: ModuleState) => (TAKES[call] as readonly ModuleState[]).includes(state)

/** How a verdict touches a run of wins. */
export type Streak = 'extends' | 'holds' | 'ends'

/**
 * What each verdict does to its module, so queries and commands read an
 * effect instead of naming verdicts. Only a verdict that extends a streak
 * earns an extension, and only one that ends it passes a module past its
 * target. A simpler attempt keeps the module's code smaller at an equal
 * metric, so it moves the best commit but buys no time and no progress.
 */
export const VERDICTS = {
  win: { movesHead: true, movesBest: true, streak: 'extends', canMeetTarget: true, failedTurn: false },
  simpler: { movesHead: true, movesBest: true, streak: 'holds', canMeetTarget: false, failedTurn: false },
  flat: { movesHead: true, movesBest: false, streak: 'ends', canMeetTarget: false, failedTurn: false },
  fail: { movesHead: false, movesBest: false, streak: 'ends', canMeetTarget: false, failedTurn: true },
} as const satisfies Record<Verdict, { movesHead: boolean; movesBest: boolean; streak: Streak; canMeetTarget: boolean; failedTurn: boolean }>

/** Whether a judged verdict has an effect. An attempt not yet judged has none. */
export const does = (verdict: Verdict | undefined, effect: 'movesHead' | 'movesBest' | 'canMeetTarget' | 'failedTurn') => verdict !== undefined && VERDICTS[verdict][effect]

export const ended = (state: ModuleState) => state === 'passed' || state === 'abandoned'
/** The states whose clock runs. */
export const live = (state: ModuleState) => state === 'active' || state === 'pastTarget'

export const TARGET_CAP = 20
export const DEFAULT_MIN_GAIN = 2
export const FAILED_TURNS = 3
export const GRACE_SHARE = 0.1
/** Runs of a job the runner couldn't run before it stops trying. */
export const MAX_RUNNER_ERRORS = 3
/** How long past its time limit a runner can hold a job before the server takes it back. */
export const HOLD_GRACE_MINUTES = 30
export const MAX_PROJECT_HOURS = 168

// Spec checks. Each returns the problem as a sentence, or null. They check
// types too, because the HTTP layer passes parsed JSON straight through.

export const isText = (x: unknown, max = 200): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= max && !/[\r\n]/.test(x)
const number = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
/** A full commit hash, SHA-1 or SHA-256. Abbreviations would let one commit pass as two. */
export const isCommit = (x: unknown): x is string => typeof x === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(x)
export const isAgentId = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(x)

export function maxMinutesProblem(x: unknown, config: Config): string | null {
  if (x === undefined) return null
  if (!number(x) || x <= 0) return 'maxMinutes must be a positive number.'
  if (x > config.maxMinutesCeiling) return `maxMinutes can be at most ${config.maxMinutesCeiling}.`
  return null
}

export function goalProblem(g: GoalSpec | undefined): string | null {
  if (!g || typeof g !== 'object') return 'A module needs a goal.'
  if (!isText(g.metric, 80)) return 'The goal needs a metric of at most 80 characters.'
  if (typeof g.unit !== 'string' || g.unit.length > 20) return 'The goal needs a unit, such as ms.'
  if (g.direction !== 'lower' && g.direction !== 'higher') return 'The goal direction must be lower or higher.'
  if (g.ambitious !== undefined && typeof g.ambitious !== 'boolean') return 'ambitious must be true or false.'
  if (!number(g.targetGain) || g.targetGain <= 0) return 'targetGain must be a positive percentage.'
  if (g.targetGain > TARGET_CAP && !g.ambitious) return `targetGain can be at most ${TARGET_CAP}% unless the goal sets ambitious: true.`
  if (g.direction === 'lower' && g.targetGain >= 100) return 'A lower goal can cut the metric by less than 100%.'
  const minGain = g.minGain ?? DEFAULT_MIN_GAIN
  if (!number(minGain) || minGain <= 0) return 'minGain must be a positive percentage.'
  if (minGain > g.targetGain) return `minGain (${minGain}%) can't exceed targetGain (${g.targetGain}%).`
  return null
}

export const goalOf = (g: GoalSpec): Goal => ({
  metric: g.metric.trim(),
  unit: g.unit.trim(),
  direction: g.direction,
  targetGain: g.targetGain,
  minGain: g.minGain ?? DEFAULT_MIN_GAIN,
  ambitious: g.ambitious ?? false,
})

export function projectGoalProblem(g: ProjectGoalSpec): string | null {
  if (!g || typeof g !== 'object') return 'A project goal must be an object.'
  if (!isText(g.metric, 80)) return 'The project goal needs a metric of at most 80 characters.'
  if (typeof g.unit !== 'string' || g.unit.length > 20) return 'The project goal needs a unit, such as ms.'
  if (g.direction !== 'lower' && g.direction !== 'higher') return 'The project goal direction must be lower or higher.'
  if ((g.target === undefined) === (g.targetGain === undefined)) return 'The project goal takes either target, the value to reach, or targetGain, the percent better than the start commit.'
  if (g.target !== undefined && (!number(g.target) || g.target <= 0)) return 'The project goal\'s target must be a positive number.'
  if (g.targetGain !== undefined && (!number(g.targetGain) || g.targetGain <= 0)) return 'The project goal\'s targetGain must be a positive percentage.'
  if (g.direction === 'lower' && g.targetGain !== undefined && g.targetGain >= 100) return 'A lower project goal can cut the metric by less than 100%.'
  if (g.hours !== undefined && (!number(g.hours) || g.hours <= 0 || g.hours > MAX_PROJECT_HOURS)) return `The project goal's hours must be a positive number of at most ${MAX_PROJECT_HOURS}.`
  return null
}

export const projectGoalOf = (g: ProjectGoalSpec): ProjectGoal => ({
  metric: g.metric.trim(),
  unit: g.unit.trim(),
  direction: g.direction,
  target: g.target ?? null,
  targetGain: g.targetGain ?? null,
  hours: g.hours ?? null,
})

/** A project with a goal measures every module on its metric, so their gains add up to it. */
export function goalMismatch(project: ProjectGoal | ProjectGoalSpec | null | undefined, m: ModuleSpec): string | null {
  if (!project) return null
  const g = m.goal
  const same = g.metric.trim() === project.metric.trim() && g.unit.trim() === project.unit.trim() && g.direction === project.direction
  return same ? null : `Module "${m.title}" measures ${g.metric} (${g.unit}, ${g.direction}), but the project's goal is ${project.metric} (${project.unit}, ${project.direction}). Every module in a project with a goal measures its metric.`
}

export function moduleProblem(s: ModuleSpec | undefined, config: Config): string | null {
  if (!s || typeof s !== 'object') return 'A module spec must be an object.'
  if (!isText(s.title, 80)) return 'A module needs a one-line title of at most 80 characters.'
  if (!Array.isArray(s.steps) || s.steps.length === 0) return `Module "${s.title}" needs at least one step.`
  if (s.steps.length > 20) return `Module "${s.title}" has more than 20 steps. Split it into modules.`
  if (!s.steps.every((x) => isText(x, 120))) return `Every step of "${s.title}" needs a one-line title of at most 120 characters.`
  return goalProblem(s.goal) ?? maxMinutesProblem(s.maxMinutes, config)
}

export function projectProblem(s: ProjectSpec | undefined, config: Config): string | null {
  if (!s || typeof s !== 'object') return 'A project spec must be an object.'
  if (!isText(s.title, 80)) return 'A project needs a one-line title of at most 80 characters.'
  if (!isCommit(s.startCommit)) return 'startCommit must be a full commit hash, such as the output of git rev-parse HEAD.'
  if (s.repo !== undefined && (!isText(s.repo, 300) || /\s/.test(s.repo))) return 'repo must be a git remote URL.'
  if (!Array.isArray(s.modules) || s.modules.length === 0) return 'A project needs at least one module.'
  if (s.modules.length > 50) return 'A project can have at most 50 modules.'
  if (s.goal !== undefined) {
    const problem = projectGoalProblem(s.goal)
    if (problem) return problem
  }
  const titles = new Set<string>()
  for (const m of s.modules) {
    const problem = moduleProblem(m, config) ?? goalMismatch(s.goal, m)
    if (problem) return problem
    if (m.retryOf !== undefined) return 'Only an abandon follow-up can retry a module.'
    if (titles.has(m.title.trim())) return `Two modules are titled "${m.title}".`
    titles.add(m.title.trim())
  }
  return maxMinutesProblem(s.maxMinutes, config)
}

export function verifierProblem(v: VerifierSpec | undefined, steps: number): string | null {
  if (!v || typeof v !== 'object') return 'Verifiers must be an object.'
  if (!isText(v.hash, 128)) return 'The verifiers need a hash.'
  if (!Array.isArray(v.paths) || v.paths.length === 0 || !v.paths.every((p) => isText(p, 300))) return 'The verifiers need the paths of their files.'
  if (!isText(v.image, 200) || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(v.image)) return 'The verifiers need a container image, such as node:26-slim.'
  const c = v.commands
  if (!c || !isText(c.regression, 500) || !isText(c.benchmark, 500)) return 'The verifiers need a regression test command and a benchmark command.'
  if (!Array.isArray(c.steps) || c.steps.length !== steps || !c.steps.every((x) => isText(x, 500))) return `The verifiers need one test command for each of the module's ${steps} steps.`
  if (c.clean !== undefined && !isText(c.clean, 500)) return 'The clean command must be one line of at most 500 characters.'
  if (!isText(v.hardware, 40)) return 'The verifiers need a hardware label, such as cpu.'
  if (!number(v.timeLimitMinutes) || v.timeLimitMinutes <= 0 || v.timeLimitMinutes > 240) return 'timeLimitMinutes must be between 0 and 240.'
  if (v.runs !== undefined && (!Number.isInteger(v.runs) || v.runs < 3 || v.runs > 25)) return 'runs must be a whole number from 3 to 25.'
  return null
}
