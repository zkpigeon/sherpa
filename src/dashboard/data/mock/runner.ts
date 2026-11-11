// The mock's runner. It claims jobs through the same calls a real runner
// makes, and makes up the runs, test counts and touched files it would send.
// Test counts come from the mock verifiers' commands, such as
// "npm test -- regression  # 24 tests", and benchmark behavior from BENCHES.
import type { Commit, JobId, Run } from '../../../shared/api.ts'
import { claimJob, sendResults } from '../../../server/domain/commands.ts'
import { factsOf, findJob, locate, verifierSet } from '../../../server/domain/queries.ts'
import { DEFAULTS, type Config, type JobKind, type Ms, type World } from '../../../server/domain/records.ts'
import type { Result } from '../../../server/domain/result.ts'

/** No real runner renews leases in the mock, so they last a day. */
export const MOCK_CONFIG: Config = { ...DEFAULTS, leaseMinutes: 24 * 60 }

/** Run-to-run spread and work per run of each mock benchmark. */
export const BENCHES = {
  latency: { spread: 1, work: 12_000 },
  ingest: { spread: 6, work: 50_000 },
  suite: { spread: 2, work: 1_312 },
  bundle: { spread: 1, work: 2_310 },
  decode: { spread: 4, work: 4_096 },
  startup: { spread: 2, work: 200 },
}
export type BenchName = keyof typeof BENCHES

export function must<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.rejection.code}: ${r.rejection.message}`)
  return r.value
}

const labelsOf = (runner: string) => (runner.startsWith('gpu') ? ['gpu'] : ['cpu'])

/** Claims the next job as `runner` would, and checks it's the one the story expects. */
export function claim(w: World, runner: string, expect: { agent: string; module: string; kind: JobKind }, at: Ms): JobId {
  const t = must(claimJob(w, at, { runner, labels: labelsOf(runner) }, MOCK_CONFIG))
  const what = (x: { agent: string; module: string; kind: string }) => `agent ${x.agent} ${x.module} ${x.kind}`
  if (!t || t.agent !== expect.agent || t.module !== expect.module || t.kind !== expect.kind)
    throw new Error(`${runner} expected the ${what(expect)} job but claimed ${t ? what(t) : 'nothing'}`)
  return t.job
}

export type Outcome = { median: number } | { failedTests: number } | { killed: true } | { held: boolean }

export interface ResultOptions {
  touched?: string[]
  /** Overrides the test count, for a job that ran fewer tests than it should. */
  testsTotal?: number
  /** Work per run on the new commit, when it differs from the benchmark's usual. */
  work?: number
  /** Sizes under the clean rules on the best commit and the new one, both following them. */
  clean?: [best: number, next: number]
}

// Offsets in spreads, in run order. Both sets are centered, so each median is exact
const BEST_ORDER = [1, -1, 2, 0, -2]
const NEW_ORDER = [0, 2, -2, 1, -1]
const count = (command: string) => Number(/# (\d+) tests/.exec(command)?.[1] ?? 0)

/** Sends a claimed job's results: runs around the outcome's median, against the best commit's median. */
export function finish(w: World, job: JobId, outcome: Outcome, opts: ResultOptions, at: Ms) {
  const found = findJob(w, job)!
  const { p, m, j } = found
  const runner = j.claims.at(-1)!.runner
  const v = verifierSet(m, j.verifierHash)!
  const touched = opts.touched ?? []
  const send = (results: Parameters<typeof sendResults>[2]['results']) => must(sendResults(w, at, { job, runner, results: { sandbox: 'strict', ...results } }, MOCK_CONFIG))
  if ('killed' in outcome) return send({ outcome: 'killed', tests: null, runs: [], touched })

  const total = opts.testsTotal ?? [v.commands.regression, ...j.stepTests.map((n) => v.commands.steps[n - 1]!)].reduce((sum, c) => sum + count(c), 0)
  if ('failedTests' in outcome) return send({ outcome: 'done', tests: { passed: total - outcome.failedTests, total }, runs: [], touched })

  const { spread, work } = BENCHES[v.commands.benchmark.split(' ').at(-1) as BenchName]
  const best = factsOf(p, m, at).bestValue
  const on = (commit: Commit, center: number, order: number[], perRun = work): Run[] => order.map((k) => ({ commit, value: center + k * spread, work: perRun }))
  let runs: Run[]
  if (j.kind === 'final') {
    // The start commit reads as the first module's baseline, and the reached commit as the module's best
    const from = factsOf(p, p.modules[0]!, at).baseline!
    const a = on(j.bestCommit!, from, BEST_ORDER)
    const b = on(j.commit, best!, NEW_ORDER)
    return send({ outcome: 'done', tests: { passed: 0, total: 0 }, runs: a.flatMap((x, i) => [x, b[i]!]), touched })
  }
  if (j.kind === 'baseline') runs = on(j.commit, 'median' in outcome ? outcome.median : 0, BEST_ORDER)
  else if (j.bestCommit === j.commit) runs = on(j.commit, best!, BEST_ORDER)
  else {
    // A step that doesn't hold runs its head commit 3% worse
    const worse = m.goal.direction === 'lower' ? 1.03 : 0.97
    const center = 'median' in outcome ? outcome.median : 'held' in outcome && !outcome.held ? best! * worse : best!
    const a = on(j.bestCommit!, best!, BEST_ORDER)
    const b = on(j.commit, center, NEW_ORDER, opts.work ?? work)
    runs = a.flatMap((x, i) => [x, b[i]!])
  }
  const clean = opts.clean && { clean: { best: { passed: true as const, size: opts.clean[0] }, next: { passed: true as const, size: opts.clean[1] } } }
  send({ outcome: 'done', tests: { passed: total, total }, runs, touched, ...clean })
}

/** The job behind an attempt. */
export const jobOfAttempt = (w: World, agent: string, module: string, attempt: string): JobId => locate(w, agent, module)!.m.attempts.find((x) => x.id === attempt)!.job
