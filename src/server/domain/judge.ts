// How the server turns a job's runs into numbers and a verdict, as DESIGN.md
// sets out. Pure math: nothing here knows about modules or time.
import type { CleanResults, Direction, Verdict } from '../../shared/api.ts'

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  if (s.length === 0) return Number.NaN
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** The baseline improved by `gain` percent, in the goal's direction. */
export const improve = (value: number, gain: number, direction: Direction) => value * (direction === 'lower' ? 1 - gain / 100 : 1 + gain / 100)

/** Percent by which `next` beats `best` in the goal's direction; negative when it's worse. */
export const gainOf = (best: number, next: number, direction: Direction) => ((direction === 'lower' ? best - next : next - best) / best) * 100

export const reaches = (value: number, target: number, direction: Direction) => (direction === 'lower' ? value <= target : value >= target)

function choose(n: number, k: number): number {
  let c = 1
  for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i
  return c
}

/** One-sided p for U at least `observed`, by the normal approximation with a continuity correction. */
function normalP(observed: number, n: number, m: number): number {
  const mean = (n * m) / 2
  const sd = Math.sqrt((n * m * (n + m + 1)) / 12)
  const z = (observed - 0.5 - mean) / sd
  // Upper tail of the standard normal, by the Abramowitz and Stegun erfc approximation
  const t = 1 / (1 + 0.3275911 * Math.abs(z / Math.SQRT2))
  const erfc = t * Math.exp(-((z * z) / 2)) * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  return z >= 0 ? erfc / 2 : 1 - erfc / 2
}

function combinations(n: number, k: number): number[][] {
  const out: number[][] = []
  const pick = (start: number, chosen: number[]) => {
    if (chosen.length === k) return void out.push(chosen)
    for (let i = start; i < n; i++) pick(i + 1, [...chosen, i])
  }
  pick(0, [])
  return out
}

/**
 * Exact one-sided Mann-Whitney p: the share of all ways to split the pooled
 * runs in which `a` beats `b` at least as often as it really did. Ties count
 * half. Exact enumeration is cheap at 5 runs a side (252 splits).
 */
export function rankP(a: readonly number[], b: readonly number[], beats: (x: number, y: number) => boolean): number {
  const u = (xs: readonly number[], ys: readonly number[]) => {
    let sum = 0
    for (const x of xs) for (const y of ys) sum += beats(x, y) ? 1 : x === y ? 0.5 : 0
    return sum
  }
  const observed = u(a, b)
  // Enumeration grows fast; past a few thousand splits the normal approximation is close enough
  if (choose(a.length + b.length, a.length) > 20_000) return normalP(observed, a.length, b.length)
  const pooled = [...a, ...b]
  const splits = combinations(pooled.length, a.length)
  let hits = 0
  for (const idx of splits) {
    const inA = new Set(idx)
    const xs = idx.map((i) => pooled[i]!)
    const ys = pooled.filter((_, i) => !inA.has(i))
    if (u(xs, ys) >= observed - 1e-9) hits++
  }
  return hits / splits.length
}

export interface Judged {
  verdict: Verdict
  median: number | null
  bestMedian: number | null
  gain: number | null
  /** One-sided, in the direction the median moved: better for a gain, worse for a loss. */
  p: number | null
}

export interface JobResult {
  tests: { passed: number; total: number } | null
  killed: boolean
  best: readonly number[]
  next: readonly number[]
  /** The clean rules on both commits. Absent when the verifiers have no clean command. */
  clean?: CleanResults | null
}

const betterIn = (direction: Direction) => (x: number, y: number) => (direction === 'lower' ? x < y : x > y)

/**
 * The new commit follows the clean rules and is smaller than the best commit
 * by their measure. When the best commit breaks the rules, following them at
 * no larger a size is enough. A best commit with no size can't be compared.
 */
export function smaller(c: CleanResults | null | undefined): boolean {
  if (!c || !c.next.passed || c.best.size === null) return false
  return c.best.passed ? c.next.size < c.best.size : c.next.size <= c.best.size
}

export function judge(r: JobResult, goal: { direction: Direction; minGain: number }): Judged {
  const none = { median: null, bestMedian: null, gain: null, p: null }
  if (r.killed || !r.tests || r.tests.passed < r.tests.total || r.next.length === 0) return { verdict: 'fail', ...none }
  const bestMedian = median(r.best)
  const next = median(r.next)
  const gain = gainOf(bestMedian, next, goal.direction)
  const better = betterIn(goal.direction)
  if (gain >= 0) {
    const p = rankP(r.next, r.best, better)
    // Short of a win, smaller code at a median no worse is simpler. A worse median never is, so trims can't add up to a slower best commit
    return { verdict: gain >= goal.minGain && p < 0.05 ? 'win' : smaller(r.clean) ? 'simpler' : 'flat', median: next, bestMedian, gain, p }
  }
  const p = rankP(r.next, r.best, (x, y) => better(y, x))
  return { verdict: p < 0.05 ? 'fail' : 'flat', median: next, bestMedian, gain, p }
}

/** A finished step holds the metric unless the rank test shows the head commit worse than the best at p below 0.05. */
export function holds(best: readonly number[], head: readonly number[], direction: Direction): boolean {
  if (best.length === 0 || head.length === 0) return false
  const better = betterIn(direction)
  return rankP(head, best, (x, y) => better(y, x)) >= 0.05
}

/**
 * Extension sizes in the order they're earned: half of maxMinutes, then half
 * the previous each time, stopping before one would be under 5 minutes.
 */
export function extensionSeries(maxMinutes: number): number[] {
  const out: number[] = []
  for (let next = maxMinutes / 2; next >= 5; next /= 2) out.push(next)
  return out
}
