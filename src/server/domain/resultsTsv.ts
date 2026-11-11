// GET /agents/{id}/results.tsv: one row for every attempt an agent has made,
// and one for every module it abandoned, so before each new idea it can read
// what won, what stayed flat, what failed, and why each module was given up.
import type { JobState } from '../../shared/api.ts'
import { agentOf } from './queries.ts'
import type { AttemptRec, ModuleRec, World } from './records.ts'

const COLUMNS = ['project', 'module', 'module_title', 'step', 'attempt', 'commit', 'verdict', 'median', 'best_median', 'gain_pct', 'p', 'tests', 'note'] as const
type Row = Partial<Record<(typeof COLUMNS)[number], string | number | null>>

/** An attempt whose job ended without a verdict. Any other attempt without one is still pending. */
const NO_VERDICT: Partial<Record<JobState, string>> = { cancelled: 'cancelled', failed: 'error' }

// Six significant digits, but every whole digit and never an exponent, so a tiny p and a large count both read plainly
const NUMBER = new Intl.NumberFormat('en-US', { useGrouping: false, maximumSignificantDigits: 6, maximumFractionDigits: 0, roundingPriority: 'morePrecision' })

const cell = (v: Row[keyof Row]) => (v === null || v === undefined ? '' : typeof v === 'number' ? NUMBER.format(v) : v.replace(/[\t\r\n]+/g, ' '))

function attemptRow(m: ModuleRec, x: AttemptRec): Row {
  const job = m.jobs.find((j) => j.id === x.job)!
  const d = x.judged
  const tests = job.results?.tests
  return {
    step: x.step,
    attempt: x.id,
    commit: x.commit.slice(0, 7),
    verdict: d?.verdict ?? NO_VERDICT[job.state] ?? 'pending',
    median: d?.median,
    best_median: d?.bestMedian,
    gain_pct: d?.gain,
    p: d?.p,
    tests: tests && `${tests.passed}/${tests.total}`,
    note: x.note,
  }
}

/** Past projects, then the open one. Modules run in project order, so the attempts come out in the order they were posted. */
export function resultsTsv(w: World, agent: string): string {
  const a = agentOf(w, agent)
  const rows: Row[] = []
  for (const p of a ? [...a.past, ...(a.project ? [a.project] : [])] : [])
    for (const m of p.modules) {
      const base = { project: p.title, module: m.id, module_title: m.title }
      for (const x of m.attempts) rows.push({ ...base, ...attemptRow(m, x) })
      if (m.state === 'abandoned') rows.push({ ...base, verdict: 'abandoned', note: m.reason })
    }
  return [COLUMNS.join('\t'), ...rows.map((r) => COLUMNS.map((c) => cell(r[c])).join('\t'))].join('\n') + '\n'
}
