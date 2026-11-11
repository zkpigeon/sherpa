// The dashboard's contract with the server: what GET /api/board and the
// attempt detail call return. The server derives every judged number (best,
// streak, deadline, gain, p), so the UI renders and never recomputes a verdict.

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

export type AgentId = Brand<string, 'AgentId'>
export type ModuleId = Brand<string, 'ModuleId'>
export type AttemptId = Brand<string, 'AttemptId'>
export type Commit = Brand<string, 'Commit'>
export type JobId = Brand<string, 'JobId'>
export type ChangeId = Brand<string, 'ChangeId'>
/** An ISO 8601 timestamp from the server's clock. */
export type Iso = Brand<string, 'Iso'>

export type Verdict = 'win' | 'flat' | 'fail'
export type Direction = 'lower' | 'higher'

export interface Goal {
  metric: string
  unit: string
  direction: Direction
  /** Percent of the baseline. */
  targetGain: number
  /** Percent of the best commit's median. */
  minGain: number
  ambitious: boolean
  /** Null until the baseline job lands. */
  baseline: number | null
  /** The baseline improved by targetGain. Null until the baseline lands. */
  target: number | null
}

export interface Step {
  title: string
  done: boolean
  failedTurns: number
}

/** `killed`: ran past its time limit. `failed`: the runner couldn't run it. `cancelled`: its module was abandoned. */
export type JobState = 'queued' | 'running' | 'done' | 'killed' | 'failed' | 'cancelled'

export interface Attempt {
  id: AttemptId
  /** 1-based index into the module's steps. */
  step: number
  commit: Commit
  note: string
  job: JobState
  verdict: Verdict | null
  /** Median of the new commit's benchmark runs, once judged. */
  median: number | null
  postedAt: Iso
  judgedAt: Iso | null
}

export interface Extension {
  minutes: number
  cause: 'streak' | 'win' | 'step'
  at: Iso
}

/** Time a job spent waiting for a runner after the module became active. */
export interface Wait {
  at: Iso
  minutes: number
}

/** `waitedMinutes` is the sum of `waits`; the list places each wait on the timeline. */
export type Clock =
  | { kind: 'notStarted' }
  | { kind: 'running'; startedAt: Iso; deadline: Iso; maxMinutes: number; extensions: Extension[]; waits: Wait[]; waitedMinutes: number }
  | { kind: 'grace'; startedAt: Iso; deadline: Iso; graceEnds: Iso; maxMinutes: number; extensions: Extension[]; waits: Wait[]; waitedMinutes: number }
  | { kind: 'stopped'; startedAt: Iso | null; at: Iso; maxMinutes: number; extensions: Extension[]; waits: Wait[]; waitedMinutes: number }

export type ModuleStatus =
  | { state: 'pending'; waitingFor: 'turn' | 'verifiers' | 'baseline' }
  | { state: 'active' }
  | { state: 'pastTarget' }
  | { state: 'stuck'; cause: 'step' | 'target' | 'time' }
  | { state: 'passed' }
  | { state: 'abandoned'; reason: string; followUp: ModuleId | null }

export type Verifiers =
  | { kind: 'missing' }
  /** `tests` is the test count of the module's latest job, null until one has run. */
  | { kind: 'frozen'; hash: string; tests: number | null; author: string; hardware: string; openChanges: number }

export type FlagKind = 'touchedVerifier' | 'rewroteVerifier' | 'fewerTests' | 'lessWork' | 'verdictWithoutJob' | 'selfAuthoredVerifiers' | 'baselineFailed'

/** How much a runner isolates the code it measures. README.md and DESIGN.md explain the two. */
export const SANDBOXES = ['strict', 'open'] as const
export type Sandbox = (typeof SANDBOXES)[number]

export interface Flag {
  kind: FlagKind
  attempt: AttemptId | null
  detail: string
  at: Iso
}

export interface ChangeRequest {
  id: ChangeId
  author: string
  reason: string
  /** Paths whose content differs from the frozen verifiers. */
  files: string[]
  state: 'open' | 'approved' | 'rejected'
  filedAt: Iso
  decidedAt: Iso | null
  /** The admin's note on the decision. */
  note: string | null
  /** Modules that hadn't started, which the approval also gave the change. */
  appliedTo: ModuleId[]
}

/** GET /admin/changes/{id}: a change request with what it changes, for review. */
export interface ChangeReview {
  change: ChangeId
  agent: AgentId
  module: ModuleId
  moduleTitle: string
  author: string
  reason: string
  state: ChangeRequest['state']
  note: string | null
  /** The module's verifiers changed after the request was filed; approving applies its edits to the current set. */
  stale: boolean
  /** Null on one side for a file added or deleted, and on both when the contents aren't available. */
  files: { path: string; before: string | null; after: string | null }[]
  settings: { setting: string; before: unknown; after: unknown }[]
}

export interface Module {
  id: ModuleId
  /** 1-based position in the project. Shifts when a module is inserted; the ID never does. */
  position: number
  title: string
  status: ModuleStatus
  steps: Step[]
  goal: Goal
  verifiers: Verifiers
  /** Verifier change requests, oldest first. */
  changes: ChangeRequest[]
  /** The best commit's median. Null before the baseline lands. */
  best: number | null
  bestCommit: Commit | null
  headCommit: Commit | null
  streak: number
  /** Oldest first. */
  attempts: Attempt[]
  clock: Clock
  retryOf: ModuleId | null
  flags: Flag[]
}

/** Why a project ended: the admin stopped it, or its hours were up. */
export type ProjectEnd = 'stopped' | 'budget'

/** The project's start commit measured against the commit it has reached, in one job. */
export type ProjectResult =
  | { state: 'measuring' }
  | { state: 'done'; metric: string; unit: string; direction: Direction; from: number; to: number; gain: number; p: number }
  | { state: 'failed' }

/** A goal for the whole climb, set when the project is created. Every module's goal measures its metric. */
export interface ProjectGoal {
  metric: string
  unit: string
  direction: Direction
  /** The value to reach, or null when the goal is a percentage. */
  target: number | null
  /** Percent better than the start commit, or null when the goal is a value. */
  targetGain: number | null
  /** The project's budget in hours, or null for none. */
  hours: number | null
  /** When those hours are up. */
  budgetEndsAt: Iso | null
}

export interface Project {
  title: string
  goal: ProjectGoal | null
  /**
   * `open` while a module hasn't ended. Once every module has, `needsModule`
   * until the agent adds the next one. `ended` only once the admin stops it or
   * its hours are up.
   */
  state: 'open' | 'needsModule' | 'ended'
  end: ProjectEnd | null
  /** The admin's note on the stop. */
  stopNote: string | null
  /** The start commit measured against the commit the project has reached. Null until a measurement is queued. */
  progress: ProjectResult | null
  /** The commit the project has reached: the next module's start, or where it ended. */
  reached: Commit | null
  /** In position order. */
  modules: Module[]
  /** The module that is active, past target, or stuck, or else the next pending one. Null once every module has ended. */
  current: ModuleId | null
}

export interface Agent {
  id: AgentId
  /** The agent's own sentence, without the server-written parts. */
  blurb: string
  /** The plain-text board line the hook shows the agent. */
  line: string
  project: Project | null
  /** Titles of projects waiting to start, in order. */
  queued: string[]
}

export interface Board {
  generatedAt: Iso
  agents: Agent[]
}

export interface Run {
  commit: Commit
  value: number
  work: number
}

export interface AttemptDetail {
  agent: AgentId
  module: ModuleId
  attempt: Attempt
  bestCommit: Commit
  verifierHash: string
  runner: string | null
  tests: { passed: number; total: number } | null
  /** In the order they ran, alternating between the best commit and the new one. */
  runs: Run[]
  /** Median of the best commit's runs in this job. The module's `best` can't stand in: it moves with later wins. */
  bestMedian: number | null
  /** Percent gain of the new median over the best median. */
  gain: number | null
  /** One-sided Mann-Whitney p-value. */
  p: number | null
  touchedVerifiers: string[]
  /** The sandbox the job ran in, once a runner has sent its results. */
  sandbox: Sandbox | null
}
