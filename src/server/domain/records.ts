// What sherpa-server stores, as plain JSON-safe data. Everything DESIGN.md says
// the server derives (the baseline, start, best and head commits, the streak,
// waits, extensions and the deadline) is computed in queries.ts and never
// stored, so the numbers can't drift apart. Nothing here touches I/O, so the
// dashboard's mock runs the same code in the browser.
import type { AgentId, AttemptId, ChangeId, Commit, Direction, FlagKind, Iso, JobId, JobState, ModuleId, Run, Sandbox } from '../../shared/api.ts'
import type { Judged } from './judge.ts'

/** Milliseconds since the epoch. */
export type Ms = number
export const MINUTE = 60_000
export const iso = (ms: Ms) => new Date(ms).toISOString() as Iso

export type ModuleState = 'pending' | 'active' | 'pastTarget' | 'stuck' | 'passed' | 'abandoned'
export type StuckCause = 'step' | 'target' | 'time'
/**
 * `final` measures the project's start commit against the commit it has
 * reached, in one job, after each module that moves it.
 */
export type JobKind = 'baseline' | 'attempt' | 'stepCheck' | 'final'

export interface Config {
  /** For a module whose project and spec set no maxMinutes. */
  defaultMaxMinutes: number
  /** No maxMinutes may exceed this. Extensions come on top. */
  maxMinutesCeiling: number
  /** How long a claim lasts without a renewal. */
  leaseMinutes: number
  /** Benchmark runs per commit. */
  runs: number
}

export const DEFAULTS: Config = { defaultMaxMinutes: 90, maxMinutesCeiling: 120, leaseMinutes: 2, runs: 5 }

// What callers send

export interface GoalSpec {
  metric: string
  unit: string
  direction: Direction
  targetGain: number
  /** Defaults to 2. */
  minGain?: number
  ambitious?: boolean
}

export interface ModuleSpec {
  title: string
  steps: string[]
  goal: GoalSpec
  maxMinutes?: number
  /** Only on an abandon's follow-up: the abandoned module, when the follow-up retries it. */
  retryOf?: string
}

/** A goal for the whole climb. Every module's goal measures the same metric. */
export interface ProjectGoalSpec {
  metric: string
  unit: string
  direction: Direction
  /** One of these: the value to reach, or the percent better than the start commit. */
  target?: number
  targetGain?: number
  /** Hours from when the project opens. Once they're up, no module starts. */
  hours?: number
}

export interface ProjectSpec {
  title: string
  startCommit: string
  /** The git remote the runner fetches commits from. Without one, the runner uses its default. */
  repo?: string
  maxMinutes?: number
  goal?: ProjectGoalSpec
  modules: ModuleSpec[]
}

/** A verifier set as the HTTP layer hands it over, with the files already stored under `hash`. */
export interface VerifierSpec {
  /** Over the files, image, commands, hardware label and job time limit. */
  hash: string
  paths: string[]
  image: string
  commands: { regression: string; steps: string[]; benchmark: string }
  hardware: string
  timeLimitMinutes: number
  /** Benchmark runs per commit. Without it, the server's default. A noisy benchmark needs more. */
  runs?: number
}

export interface JobResults {
  /**
   * `done`: the job ran. `killed`: it ran past its time limit. `badCommit`: the
   * commit under test can't be fetched. `tampered`: a command changed a frozen
   * verifier file, so the runner threw the job out. `error`: the runner
   * couldn't run it, so it goes back in the queue.
   */
  outcome: 'done' | 'killed' | 'badCommit' | 'tampered' | 'error'
  /** Null when no tests ran. */
  tests: { passed: number; total: number } | null
  runs: Run[]
  /** Verifier files the commit changed. The runner used the frozen copies. */
  touched: string[]
  /** Frozen files a command changed while the job ran. */
  tampered?: string[]
  sandbox?: Sandbox
  error?: string
}

// What the server keeps

export interface Goal {
  metric: string
  unit: string
  direction: Direction
  targetGain: number
  minGain: number
  ambitious: boolean
}

export interface StepRec {
  title: string
  doneAt: Ms | null
  /** Whether the step check showed the metric held. Null until the step is done. */
  held: boolean | null
  /** The head commit the passing check measured. A step that changed nothing earns no extension. */
  commit?: Commit | null
}

export interface VerifierSet extends VerifierSpec {
  /** Who wrote it: the verifier agent's ID, or `admin` for a replacement. */
  author: string
  frozenAt: Ms
}

export interface ChangeRec {
  id: ChangeId
  author: string
  reason: string
  /** The set the change was filed against. */
  base: string
  proposed: VerifierSpec
  /** Paths the change adds, removes, or edits. */
  changed: string[]
  state: 'open' | 'approved' | 'rejected'
  filedAt: Ms
  decidedAt: Ms | null
  /** The admin's note on the decision, for the agent to read. */
  note?: string | null
  /** Modules that hadn't started, which an approval also gave the change. */
  appliedTo?: ModuleId[]
}

export interface Claim {
  runner: string
  at: Ms
  leaseUntil: Ms
  /** When the claim ended: results arrived, the lease lapsed, the runner gave up, or the job was cancelled. */
  endedAt: Ms | null
  lapsed: boolean
  /** Why the runner couldn't run the job, when it couldn't. */
  error: string | null
}

export interface JobRec {
  id: JobId
  /** Kind, module, commits, step and verifier hash. Two jobs with one key are the same job. */
  key: string
  kind: JobKind
  module: ModuleId
  /** 1-based. The attempt's step, or the step being checked. Null for a baseline. */
  step: number | null
  /** The commit under test: the start commit, the attempt's commit, or the head commit. */
  commit: Commit
  /** What it's measured against. Null for a baseline. */
  bestCommit: Commit | null
  verifierHash: string
  /** 1-based steps whose tests run, besides the regression tests. */
  stepTests: number[]
  state: JobState
  queuedAt: Ms
  claims: Claim[]
  finishedAt: Ms | null
  results: JobResults | null
}

export interface AttemptRec {
  id: AttemptId
  /** 1-based. */
  step: number
  commit: Commit
  note: string
  bestCommit: Commit
  job: JobId
  postedAt: Ms
  judgedAt: Ms | null
  judged: Judged | null
}

export interface FlagRec {
  kind: FlagKind
  attempt: AttemptId | null
  detail: string
  at: Ms
}

export interface ModuleRec {
  id: ModuleId
  /** Added to an open project, so later additions queue behind it. */
  added?: boolean
  /** The normalized spec it was created from, so a repeated call can be told from a clash. */
  specKey: string
  title: string
  steps: StepRec[]
  goal: Goal
  maxMinutes: number
  retryOf: ModuleId | null
  /** Every set it has had, oldest first. The last one is current; none means missing. */
  verifiers: VerifierSet[]
  changes: ChangeRec[]
  state: ModuleState
  cause: StuckCause | null
  reason: string | null
  followUp: ModuleId | null
  stoppedAt: Ms | null
  attempts: AttemptRec[]
  jobs: JobRec[]
  flags: FlagRec[]
}

export interface ProjectGoal {
  metric: string
  unit: string
  direction: Direction
  target: number | null
  targetGain: number | null
  hours: number | null
}

export interface ProjectRec {
  title: string
  specKey: string
  startCommit: Commit
  repo: string | null
  maxMinutes: number | null
  /** Frozen when the project opens. Absent on projects stored before goals existed. */
  goal?: ProjectGoal | null
  modules: ModuleRec[]
  openedAt: Ms
  /** When the admin stopped it. Absent while it runs, and on projects stored before stops existed. */
  stoppedAt?: Ms
  /** The admin's note on the stop, for the agent to read. */
  stopNote?: string
}

export interface AgentRec {
  id: AgentId
  blurb: string
  /** The open project, or the last one to end while nothing was queued. */
  project: ProjectRec | null
  queued: ProjectSpec[]
  past: ProjectRec[]
  /** Module IDs run m1, m2, ... across all of an agent's projects. */
  modules: number
}

export interface World {
  agents: AgentRec[]
  jobs: number
  changes: number
}

export const emptyWorld = (): World => ({ agents: [], jobs: 0, changes: 0 })
