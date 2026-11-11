// One job, start to finish: check out each commit, note which verifier files
// the commit under test changed, copy the frozen files over every checkout,
// run the tests, then the benchmark alternating between commits, and send
// what happened. After every command it checks the frozen files on every
// checkout, and a command that changed one throws the whole job out. The
// lease is renewed throughout; if the server says the job was cancelled or
// taken away, the job stops and sends nothing.
import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { Run } from '../shared/api.ts'
import type { Ticket } from '../server/domain/commands.ts'
import type { JobResults } from '../server/domain/records.ts'
import { safePath } from '../server/verifiers.ts'
import type { Box, Executor } from './exec.ts'
import { MissingCommit } from './git.ts'
import type { Exit } from './proc.ts'

export type Claimed = Ticket & { files: Record<string, string> }

export interface Api {
  claim(runner: string, labels: string[]): Promise<Claimed | null>
  /** False once the runner no longer holds a running job. */
  renew(job: string, runner: string): Promise<boolean>
  results(job: string, runner: string, results: JobResults): Promise<void>
}

export interface JobDeps {
  api: Api
  executor: Executor
  checkout(repo: string, commit: string, into: string, timeoutMs: number): Promise<void>
  /** Which of `paths` differ between two commits. */
  changed(repo: string, from: string, to: string, paths: string[], timeoutMs: number): Promise<string[]>
  runner: string
  work: string
  defaultRepo: string | null
  renewEveryMs: number
  log(message: string): void
}

/** The last line of output that parses as a JSON object. */
export function lastJson(out: string): Record<string, unknown> | null {
  const lines = out.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line.startsWith('{')) continue
    try {
      const v = JSON.parse(line) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch {}
  }
  return null
}

/**
 * A test command's result: the counts it prints as {"passed": n, "total": m},
 * or one test that passed if it exited 0. A nonzero exit always counts as at
 * least one failure, whatever it printed.
 */
export function testCount(r: Exit): { passed: number; total: number } {
  const j = lastJson(r.stdout)
  const sane = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0 && (x as number) <= 1_000_000
  const counted = j && sane(j.passed) && sane(j.total) && (j.total as number) >= (j.passed as number)
  let passed = counted ? (j.passed as number) : r.code === 0 ? 1 : 0
  let total = counted ? (j.total as number) : 1
  if (r.code !== 0) {
    total = Math.max(total, 1)
    passed = Math.min(passed, total - 1)
  }
  return { passed, total }
}

/** One benchmark run: the {"value": n, "work": m} line it prints. Values must be positive, since gains are percentages. */
export function benchRun(r: Exit): { value: number; work: number } | null {
  if (r.code !== 0) return null
  const j = lastJson(r.stdout)
  if (!j || typeof j.value !== 'number' || !Number.isFinite(j.value) || j.value <= 0) return null
  const work = typeof j.work === 'number' && Number.isFinite(j.work) && j.work >= 0 ? j.work : 0
  return { value: j.value, work }
}

class Killed extends Error {}
class Lost extends Error {}
class BadCommit extends Error {}
class Tampered extends Error {
  paths: string[]
  constructor(paths: string[]) {
    super(`A command changed the frozen ${paths.join(', ')}.`)
    this.paths = paths
  }
}
/** The server answered 4xx. */
export class Refused extends Error {}

/**
 * Writes a frozen file into a checkout without following any link the commit
 * planted: every symlink or file in the way is removed first, so the write
 * can't land outside the checkout.
 */
export function overlay(root: string, path: string, content: string) {
  const parts = path.split('/')
  let at = root
  for (const [i, part] of parts.entries()) {
    at = join(at, part)
    const last = i === parts.length - 1
    let st: ReturnType<typeof lstatSync> | null = null
    try {
      st = lstatSync(at)
    } catch {}
    if (st && (last || !st.isDirectory())) rmSync(at, { recursive: true, force: true })
    if (!last && (!st || !st.isDirectory())) mkdirSync(at)
  }
  const real = realpathSync(join(at, '..'))
  if (real !== realpathSync(root) && !real.startsWith(realpathSync(root) + sep)) throw new Error(`Refusing to write ${path} outside the checkout.`)
  // Read-only stops an honest mistake. The check after every command catches the rest
  writeFileSync(at, content, { flag: 'wx', mode: 0o444 })
}

export async function runJob(t: Claimed, d: JobDeps, stop?: AbortSignal): Promise<void> {
  const dir = join(d.work, 'jobs', t.job)
  const lost = new AbortController()
  // Stopping the runner abandons the job; its lease lapses and another runner takes it
  const onStop = () => lost.abort()
  stop?.addEventListener('abort', onStop, { once: true })
  // A stop that already happened won't fire its event
  if (stop?.aborted) lost.abort()
  const deadline = Date.now() + t.timeLimitMinutes * 60_000
  const boxes: Box[] = []
  const renew = setInterval(() => {
    d.api.renew(t.job, d.runner).then(
      (held) => held || lost.abort(),
      (e) => d.log(`couldn't renew the lease on ${t.job}: ${(e as Error).message}`),
    )
  }, d.renewEveryMs)

  const exec = async (box: Box, command: string) => {
    if (lost.signal.aborted) throw new Lost()
    const left = deadline - Date.now()
    if (left <= 0) throw new Killed()
    const r = await box.exec(command, left, lost.signal)
    if (r.aborted) throw new Lost()
    // Every checkout, since in the open sandbox a command can reach the other commit's files too
    const tampered = [...new Set((await Promise.all(boxes.map((b) => b.tampered()))).flat())].sort()
    if (tampered.length) throw new Tampered(tampered)
    if (r.timedOut) throw new Killed()
    return r
  }

  const sandbox = d.executor.sandbox
  let results: JobResults | null
  try {
    const repo = t.repo ?? d.defaultRepo
    if (!repo) throw new Error('The project names no repo, and the runner has no SHERPA_REPO.')
    for (const path of Object.keys(t.files)) if (!safePath(path)) throw new Error(`Refusing the verifier path ${path}.`)

    // Check out each commit. A commit under test that can't be fetched is the agent's to fix
    const commits = [...new Set([...t.commits, t.commit])]
    const dirs = new Map(commits.map((c) => [c, join(dir, c)]))
    const left = () => Math.max(1000, deadline - Date.now())
    for (const c of commits) {
      try {
        await d.checkout(repo, c, dirs.get(c)!, left())
      } catch (e) {
        if (e instanceof MissingCommit && c === t.commit) throw new BadCommit(e.message)
        throw e
      }
      if (lost.signal.aborted) throw new Lost()
    }
    // Verifier files the attempt changed relative to the commit it's measured against
    const best = t.commits.find((c) => c !== t.commit)
    const touched = t.kind === 'attempt' && best ? await d.changed(repo, best, t.commit, Object.keys(t.files), left()) : []
    for (const c of commits) for (const [p, content] of Object.entries(t.files)) overlay(dirs.get(c)!, p, content)

    const box = new Map<string, Box>()
    for (const c of commits) {
      if (lost.signal.aborted) throw new Lost()
      const b = await d.executor.open(dirs.get(c)!, { ...t, frozen: t.files })
      boxes.push(b)
      box.set(c, b)
    }

    // Tests on the commit under test; a failure ends the job, since its verdict can't change
    const tests = { passed: 0, total: 0 }
    for (const command of t.tests) {
      const r = testCount(await exec(box.get(t.commit)!, command))
      tests.passed += r.passed
      tests.total += r.total
    }
    const runs: Run[] = []
    if (tests.passed === tests.total) {
      bench: for (let i = 0; i < t.runs; i++)
        for (const c of t.commits) {
          const r = benchRun(await exec(box.get(c)!, t.benchmark))
          if (!r) {
            // The commit under test broke the benchmark: report no runs for it, which judges it a fail
            if (c === t.commit) {
              runs.splice(0, runs.length, ...runs.filter((x) => x.commit !== c))
              break bench
            }
            throw new Error(`The benchmark failed on ${c}, the commit it's measured against.`)
          }
          runs.push({ commit: c as Run['commit'], value: r.value, work: r.work })
        }
    }
    results = { outcome: 'done', tests, runs, touched, sandbox }
  } catch (e) {
    if (e instanceof Lost) {
      d.log(`${t.job} was cancelled, taken away, or stopped`)
      results = null
    } else if (e instanceof Killed) results = { outcome: 'killed', tests: null, runs: [], touched: [], sandbox }
    else if (e instanceof BadCommit) results = { outcome: 'badCommit', tests: null, runs: [], touched: [], sandbox, error: e.message.slice(0, 500) }
    else if (e instanceof Tampered) {
      d.log(`${t.job} threw out: ${e.message}`)
      results = { outcome: 'tampered', tests: null, runs: [], touched: [], tampered: e.paths, sandbox, error: e.message.slice(0, 500) }
    } else {
      const message = (e as Error).message
      d.log(`${t.job} couldn't run: ${message}`)
      results = { outcome: 'error', tests: null, runs: [], touched: [], error: message.slice(0, 500) }
    }
  } finally {
    clearInterval(renew)
    stop?.removeEventListener('abort', onStop)
    await Promise.all(boxes.map((b) => b.close().catch(() => {})))
    rmSync(dir, { recursive: true, force: true })
  }
  if (!results) return
  try {
    await d.api.results(t.job, d.runner, results)
  } catch (e) {
    // The server refused these results, so say the runner couldn't run the job instead of leaving it to loop
    if (!(e instanceof Refused) || results.outcome === 'error') throw e
    d.log(`sherpa-server refused the results of ${t.job}: ${e.message}`)
    await d.api.results(t.job, d.runner, { outcome: 'error', tests: null, runs: [], touched: [], error: `sherpa-server refused the results: ${e.message}`.slice(0, 500) })
  }
}


export function createApi(base: string, token: string, fetchImpl: typeof fetch = fetch): Api {
  const post = async (path: string, body: unknown) => {
    const res = await fetchImpl(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const text = await res.text()
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null }
  }
  return {
    async claim(runner, labels) {
      const r = await post('/jobs/claim', { runner, labels })
      if (r.status === 204) return null
      if (r.status !== 200) throw new Error(`claim answered ${r.status}: ${r.json?.message ?? ''}`)
      return r.json as unknown as Claimed
    },
    async renew(job, runner) {
      const r = await post(`/jobs/${job}/lease`, { runner })
      if (r.status === 409 || r.status === 404) return false
      if (r.status !== 200) throw new Error(`lease answered ${r.status}`)
      return r.json?.state === 'running'
    },
    async results(job, runner, results) {
      // Results are idempotent on the server, so a retry after a network error is safe
      for (let attempt = 1; ; attempt++) {
        const r = await post(`/jobs/${job}/results`, { runner, ...results }).catch((e: Error) => ({ status: 0, json: { message: e.message } }))
        // 409: the job was taken away, so these results no longer count
        if (r.status === 200 || r.status === 409) return
        if (r.status >= 400 && r.status < 500) throw new Refused(`${r.status} ${r.json?.message ?? ''}`.trim())
        if (attempt >= 5) throw new Error(`results answered ${r.status}: ${r.json?.message ?? ''}`)
        await new Promise((done) => setTimeout(done, 2000 * attempt))
      }
    },
  }
}
