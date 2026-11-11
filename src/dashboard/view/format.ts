import type { Clean, CleanResults, Commit, Direction, Flag, JobState, ModuleStatus, Verdict } from '../../shared/api.ts'

/** A measured value: whole numbers from 100 up, so it reads like the board line, and a decimal or two below. */
export function figure(n: number): string {
  const abs = Math.abs(n)
  return n.toLocaleString('en-US', { maximumFractionDigits: abs >= 100 ? 0 : abs >= 10 ? 1 : 2 })
}

export const withUnit = (n: number, unit: string) => `${figure(n)} ${unit}`

/** A goal's percentage, as the agent set it. */
export const setPercent = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`

/** A measured percentage, always to one decimal so columns of them line up. */
export const measuredPercent = (n: number) => `${Math.abs(n).toFixed(1)}%`

const opposite = (d: Direction): Direction => (d === 'lower' ? 'higher' : 'lower')

/** "5.7% lower, needs 2%", or for a loss "3.1% higher, needs 2% lower". */
export function gainWords(gain: number, minGain: number, direction: Direction): string {
  if (gain >= 0) return `${measuredPercent(gain)} ${direction}, needs ${setPercent(minGain)}`
  return `${measuredPercent(gain)} ${opposite(direction)}, needs ${setPercent(minGain)} ${direction}`
}

export const pValue = (p: number) => (p < 0.001 ? '< 0.001' : `= ${p.toFixed(3)}`)

/** Both commits' sizes under the clean rules, such as "812 best; 774 new", naming a commit that breaks them. */
export function sizeWords(c: CleanResults): string {
  const one = (x: Clean, which: string) => `${x.size === null ? 'no size' : figure(x.size)} ${which}${x.passed ? '' : ', breaks the rules'}`
  return `${one(c.best, 'best')}; ${one(c.next, 'new')}`
}

/** The rank test against 0.05. For a loss the p-value is for "worse", which fails below 0.05. */
export function pWords(p: number, gain: number): string {
  return gain >= 0 ? `p ${pValue(p)}, needs below 0.05` : `p ${pValue(p)} for worse, fails below 0.05`
}

/** Whole minutes, or "under 1 min" for a sliver. */
export const minutes = (n: number) => (n > 0 && n < 1 ? 'under 1 min' : `${Math.round(n)} min`)

/** An extension's label: the server halves exactly and shows it rounded. */
export const extensionLabel = (n: number) => `+${Math.round(n)}`

export const short = (commit: Commit | string) => commit.slice(0, 7)

export function clockTime(at: string | number | Date): string {
  return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function ago(at: string | number | Date, now: number): string {
  const min = Math.floor((now - new Date(at).getTime()) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  return `${h} h ${min % 60} min ago`
}

export type Tone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning'

const STATE: Record<ModuleStatus['state'], { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'neutral' },
  active: { label: 'Active', tone: 'accent' },
  pastTarget: { label: 'Past target', tone: 'success' },
  stuck: { label: 'Stuck', tone: 'danger' },
  passed: { label: 'Passed', tone: 'success' },
  abandoned: { label: 'Abandoned', tone: 'neutral' },
}
export const stateBadge = (state: ModuleStatus['state']) => STATE[state]

export const VERDICT: Record<Verdict, { label: string; tone: Tone }> = {
  win: { label: 'Win', tone: 'success' },
  simpler: { label: 'Simpler', tone: 'accent' },
  flat: { label: 'Flat', tone: 'neutral' },
  fail: { label: 'Fail', tone: 'danger' },
}

export const JOB: Record<JobState, string> = {
  queued: 'Queued for a runner',
  running: 'Verifying',
  done: 'Judged',
  killed: 'Killed',
  failed: 'Job failed',
  cancelled: 'Cancelled',
}

export const WAITING: Record<Extract<ModuleStatus, { state: 'pending' }>['waitingFor'], string> = {
  turn: 'Waiting for its turn',
  verifiers: 'Waiting for its verifiers',
  baseline: 'Measuring its baseline',
}

export function flagTitle(f: Pick<Flag, 'kind' | 'attempt'>): string {
  const who = f.attempt ?? 'A commit'
  switch (f.kind) {
    case 'touchedVerifier':
      return `${who} touched a verifier file`
    case 'rewroteVerifier':
      return `${who} changed a frozen file while it ran`
    case 'fewerTests':
      return `${who} ran fewer tests than the job before`
    case 'lessWork':
      return `${who} did less work than the best commit`
    case 'verdictWithoutJob':
      return `${f.attempt ?? 'An attempt'} has a verdict with no runner job`
    case 'selfAuthoredVerifiers':
      return 'The agent wrote its own verifiers'
    case 'baselineFailed':
      return 'The baseline job failed'
  }
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
