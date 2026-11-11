import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Board } from '../shared/api.ts'
import { createHandler } from '../server/http.ts'
import { createService } from '../server/service.ts'
import { openStore } from '../server/store.ts'
import { changedSums, dockerExecutor, openExecutor, type Executor } from './exec.ts'
import { createGit } from './git.ts'
import { benchRun, createApi, lastJson, runJob, testCount, type JobDeps } from './job.ts'

const root = mkdtempSync(join(tmpdir(), 'sherpa-runner-'))
after(() => rmSync(root, { recursive: true, force: true }))
const TOKENS = { agent: 'agent-token-0123456789', runner: 'runner-token-0123456789', admin: 'admin-token-0123456789' }

test('test and benchmark output parse the way DESIGN.md describes', () => {
  const exit = (code: number, stdout: string) => ({ code, stdout, stderr: '', timedOut: false, aborted: false })
  assert.deepEqual(lastJson('noise\n{"a": 1}\n{"b": 2}\nmore noise'), { b: 2 })
  assert.deepEqual(testCount(exit(0, 'ok')), { passed: 1, total: 1 })
  assert.deepEqual(testCount(exit(0, '{"passed": 40, "total": 42}')), { passed: 40, total: 42 })
  assert.deepEqual(testCount(exit(1, '{"passed": 42, "total": 42}')), { passed: 41, total: 42 }, 'a nonzero exit is a failure, whatever it prints')
  assert.deepEqual(testCount(exit(2, '')), { passed: 0, total: 1 })
  assert.deepEqual(benchRun(exit(0, 'warming up\n{"value": 331, "work": 12000}')), { value: 331, work: 12000 })
  assert.equal(benchRun(exit(1, '{"value": 331, "work": 12000}')), null)
  assert.equal(benchRun(exit(0, 'no json')), null)
  const sum = 'a'.repeat(64)
  assert.deepEqual(changedSums(`${sum}  bench.sh\n${'b'.repeat(64)}  test.sh`, { 'bench.sh': sum, 'test.sh': sum, 'gone.sh': sum }), ['test.sh', 'gone.sh'], 'a changed or missing frozen file is reported')
})

/** A repo with a start commit and three attempts, one of which edits the benchmark. */
function repo(name: string) {
  const dir = join(root, name)
  mkdirSync(dir)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  git('init', '--quiet', '--initial-branch=main')
  git('config', 'user.email', 'agent@example.com')
  git('config', 'user.name', 'agent')
  const commit = (files: Record<string, string>, message: string) => {
    for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c)
    git('add', '-A')
    git('commit', '--quiet', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  const start = commit({ 'value.txt': '100', 'app.txt': 'base' }, 'start')
  const faster = commit({ 'value.txt': '94', 'app.txt': 'base feature' }, 'faster')
  // Edits the benchmark to report 1; the frozen copy measures 85
  const cheat = commit({ 'value.txt': '85', 'bench.sh': `echo '{"value": 1, "work": 100}'` }, 'cheat')
  return { url: `file://${dir}`, start, faster, cheat }
}

const VERIFIERS = {
  author: 'verifier',
  files: {
    'bench.sh': `echo "{\\"value\\": $(cat value.txt), \\"work\\": 100}"`,
    'test.sh': `test -f app.txt && echo '{"passed": 3, "total": 3}'`,
    'step1.sh': 'grep -q feature app.txt',
  },
  commands: { regression: 'sh test.sh', steps: ['sh step1.sh', 'sh step1.sh'], benchmark: 'sh bench.sh' },
  hardware: 'cpu',
  timeLimitMinutes: 5,
}

const pick = (git: ReturnType<typeof createGit>) => ({ checkout: git.checkout, changed: git.changed })

async function scenario(name: string, executor: Executor, image: string) {
  const r = repo(name)
  const store = openStore(join(root, `${name}.db`))
  const server = createServer(createHandler({ service: createService(store), tokens: TOKENS, dashboard: null }))
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = async (method: string, path: string, body?: unknown, token = TOKENS.agent) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return (await res.json()) as Record<string, any>
  }
  const logs: string[] = []
  const deps: JobDeps = {
    api: createApi(base, TOKENS.runner),
    executor,
    ...pick(createGit(join(root, `${name}-repos`))),
    runner: `${name}-runner`,
    work: join(root, `${name}-work`),
    defaultRepo: null,
    renewEveryMs: 1000,
    log: (m) => logs.push(m),
  }
  const next = async () => {
    const job = await deps.api.claim(deps.runner, ['cpu'])
    assert.ok(job, 'a job to run')
    await runJob(job, deps)
    return job
  }
  const module = async () => ((await call('GET', '/api/board', undefined, TOKENS.admin)) as Board).agents[0]!.project!.modules[0]!

  try {
    await call('POST', '/agents/1/projects', {
      title: 'speed',
      startCommit: r.start,
      repo: r.url,
      modules: [{ title: 'faster', steps: ['Add the feature', 'Polish it'], goal: { metric: 'time', unit: 'ms', direction: 'lower', targetGain: 10 } }],
    })
    await call('POST', '/agents/1/modules/m1/verifiers', { ...VERIFIERS, image })
    const baseline = await next()
    assert.equal(baseline.kind, 'baseline')
    assert.equal((await module()).goal.baseline, 100)

    await call('POST', '/agents/1/modules/m1/attempts', { attemptId: 'a1', commit: r.faster, note: 'Make it faster.' })
    await next()
    assert.deepEqual(await call('GET', '/agents/1/modules/m1/attempts/a1').then((x) => [x.verdict, x.module.state]), ['win', 'active'])
    const detail = await call('GET', '/api/agents/1/modules/m1/attempts/a1', undefined, TOKENS.admin)
    assert.deepEqual(detail.tests, { passed: 3, total: 3 })
    assert.deepEqual(
      detail.runs.map((x: { commit: string; value: number }) => [x.commit.slice(0, 7), x.value]).slice(0, 2),
      [
        [r.start.slice(0, 7), 100],
        [r.faster.slice(0, 7), 94],
      ],
    )

    // The step check runs the step's tests on the head commit
    await call('POST', '/agents/1/modules/m1/steps/1/done')
    assert.equal((await next()).kind, 'stepCheck')
    assert.equal((await module()).steps[0]!.done, true)

    // A commit the runner can't fetch is a failed turn
    await call('POST', '/agents/1/modules/m1/attempts', { attemptId: 'a2', commit: 'deadbeef'.repeat(5), note: 'Forgot to push.' })
    await next()
    assert.equal((await call('GET', '/agents/1/modules/m1/attempts/a2')).verdict, 'fail')

    // Editing the benchmark changes nothing: the frozen copy measures the real value, and the dashboard flags it
    await call('POST', '/agents/1/modules/m1/attempts', { attemptId: 'a3', commit: r.cheat, note: 'Speed up the hot path.' })
    await next()
    const m = await module()
    assert.deepEqual([m.attempts[2]!.verdict, m.attempts[2]!.median, m.status.state], ['win', 85, 'passed'])
    assert.deepEqual(
      m.flags.map((f) => [f.kind, f.attempt]),
      [['touchedVerifier', 'a3']],
    )
    assert.equal((await call('GET', '/api/agents/1/modules/m1/attempts/a3', undefined, TOKENS.admin)).touchedVerifiers[0], 'bench.sh')
  } finally {
    await new Promise<void>((done) => {
      server.close(() => done())
      server.closeAllConnections()
    })
    store.close()
  }
}

test('a runner measures attempts from a real repo with the frozen verifiers (open sandbox)', () => scenario('local', openExecutor(), 'unused'))

const hasBusybox = spawnSync('docker', ['image', 'inspect', 'busybox:1.37'], { stdio: 'ignore' }).status === 0
test('the same in bare Docker containers', { skip: !hasBusybox && 'needs Docker and the busybox:1.37 image', timeout: 120_000 }, () =>
  scenario('docker', dockerExecutor(), 'busybox:1.37'),
)

/** A server and runner for one module whose verifiers are `files`, with `next()` running the next job. */
async function rig(name: string, executor: Executor, image: string, files: Record<string, string>, benchmark: string, regression: string) {
  const store = openStore(join(root, `${name}.db`))
  const server = createServer(createHandler({ service: createService(store), tokens: TOKENS, dashboard: null }))
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = async (method: string, path: string, body?: unknown, token = TOKENS.agent) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return (await res.json()) as Record<string, any>
  }
  const deps: JobDeps = { api: createApi(base, TOKENS.runner), executor, ...pick(createGit(join(root, `${name}-repos`))), runner: `${name}-runner`, work: join(root, `${name}-work`), defaultRepo: null, renewEveryMs: 1000, log: () => {} }
  const next = async (signal?: AbortSignal) => {
    const job = await deps.api.claim(deps.runner, ['cpu'])
    assert.ok(job, 'a job to run')
    await runJob(job, deps, signal)
  }
  const stop = async () => {
    await new Promise<void>((done) => {
      server.close(() => done())
      server.closeAllConnections()
    })
    store.close()
  }
  const start = async (repo: string, startCommit: string) => {
    await call('POST', '/agents/1/projects', { title: name, startCommit, repo, modules: [{ title: 'm', steps: ['s'], goal: { metric: 'time', unit: 'ms', direction: 'lower', targetGain: 10 } }] })
    await call('POST', '/agents/1/modules/m1/verifiers', { author: 'verifier', image, files, commands: { regression, steps: [regression], benchmark }, hardware: 'cpu', timeLimitMinutes: 5 })
  }
  const module = async () => ((await call('GET', '/api/board', undefined, TOKENS.admin)) as Board).agents[0]!.project!.modules[0]!
  return { call, next, stop, start, module }
}

test('symlinks in a commit can’t carry the frozen files out of the checkout', async () => {
  const outside = join(root, 'outside')
  mkdirSync(outside)
  const dir = join(root, 'links')
  mkdirSync(dir)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  git('init', '--quiet', '--initial-branch=main')
  git('config', 'user.email', 'agent@example.com')
  git('config', 'user.name', 'agent')
  writeFileSync(join(dir, 'value.txt'), '100')
  git('add', '-A')
  git('commit', '--quiet', '-m', 'start')
  const start = git('rev-parse', 'HEAD')
  // The attack: a directory link out of the checkout, and a verifier path linked to a device that never ends
  execFileSync('ln', ['-s', outside, join(dir, 'conf')])
  execFileSync('ln', ['-s', '/dev/zero', join(dir, 'bench.sh')])
  writeFileSync(join(dir, 'value.txt'), '80')
  git('add', '-A')
  git('commit', '--quiet', '-m', 'links')
  const attack = git('rev-parse', 'HEAD')

  const files = { 'bench.sh': `echo "{\\"value\\": $(cat value.txt), \\"work\\": 1}"`, 'conf/settings': 'frozen' }
  const r = await rig('links', openExecutor(), 'unused', files, 'sh bench.sh', 'true')
  try {
    await r.start(`file://${dir}`, start)
    await r.next()
    await r.call('POST', '/agents/1/modules/m1/attempts', { attemptId: 'a1', commit: attack, note: 'Link things.' })
    await r.next()
    const m = await r.module()
    assert.deepEqual([m.attempts[0]!.verdict, m.attempts[0]!.median], ['win', 80], 'the frozen benchmark ran, not the link')
    assert.equal(existsSync(join(outside, 'settings')), false, 'nothing was written through the link')
    assert.deepEqual(m.flags.map((f) => f.kind), ['touchedVerifier'])
  } finally {
    await r.stop()
  }
})

test('a process a command leaves running doesn’t outlive it', { skip: !hasBusybox && 'needs Docker and the busybox:1.37 image', timeout: 120_000 }, async () => {
  const r = repo('leftovers')
  // The regression test leaves a sleep running; the benchmark reports 100 plus the sleeps it can see
  const files = { 'bench.sh': `n=$(ps | grep -c "[s]leep 300"); echo "{\\"value\\": $((100 + n)), \\"work\\": 1}"` }
  const rr = await rig('leftovers', dockerExecutor({ runner: 'leftovers-runner' }), 'busybox:1.37', files, 'sh bench.sh', 'sleep 300 >/dev/null 2>&1 &')
  try {
    await rr.start(r.url, r.start)
    await rr.next()
    assert.equal((await rr.module()).goal.baseline, 100)
  } finally {
    await rr.stop()
  }
})

test('a runner that is told to stop drops its job instead of finishing it', async () => {
  const r = repo('stopping')
  // A benchmark slow enough to stop in the middle of
  const files = { 'bench.sh': `sleep 0.3; echo "{\\"value\\": $(cat value.txt), \\"work\\": 1}"` }
  const rr = await rig('stopping', openExecutor(), 'unused', files, 'sh bench.sh', 'true')
  try {
    await rr.start(r.url, r.start)
    // The stop lands between commands, before this job's first one: it must drop the job, not finish it
    const stop = new AbortController()
    stop.abort()
    await rr.next(stop.signal)
    assert.equal((await rr.module()).status.state, 'pending', 'the baseline never landed')
  } finally {
    await rr.stop()
  }
})

test('in the open sandbox, a command that rewrites the frozen benchmark gets the whole job thrown out', async () => {
  const dir = join(root, 'rewrite')
  mkdirSync(dir)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  git('init', '--quiet', '--initial-branch=main')
  git('config', 'user.email', 'agent@example.com')
  git('config', 'user.name', 'agent')
  writeFileSync(join(dir, 'value.txt'), '100')
  writeFileSync(join(dir, 'setup.sh'), 'true')
  git('add', '-A')
  git('commit', '--quiet', '-m', 'start')
  const start = git('rev-parse', 'HEAD')
  // The attack: the regression test runs code from the commit, which makes the frozen benchmark writable again and rewrites it on both checkouts
  writeFileSync(join(dir, 'setup.sh'), `for f in ../*/bench.sh; do chmod u+w "$f"; echo 'echo "{\\"value\\": 1, \\"work\\": 1}"' > "$f"; done`)
  git('add', '-A')
  git('commit', '--quiet', '-m', 'rewrite')
  const attack = git('rev-parse', 'HEAD')

  const files = { 'bench.sh': `echo "{\\"value\\": $(cat value.txt), \\"work\\": 1}"` }
  const r = await rig('rewrite', openExecutor(), 'unused', files, 'sh bench.sh', 'sh setup.sh')
  try {
    await r.start(`file://${dir}`, start)
    await r.next()
    await r.call('POST', '/agents/1/modules/m1/attempts', { attemptId: 'a1', commit: attack, note: 'Speed up setup.' })
    await r.next()
    const status = await r.call('GET', '/agents/1/modules/m1/attempts/a1')
    assert.equal(status.verdict, 'fail', 'a rewritten benchmark never measures')
    assert.match(status.why, /changed the frozen bench\.sh/)
    const m = await r.module()
    assert.deepEqual(m.flags.map((f) => [f.kind, f.attempt]), [['rewroteVerifier', 'a1']])
    assert.equal((await r.call('GET', '/api/agents/1/modules/m1/attempts/a1', undefined, TOKENS.admin)).sandbox, 'open')
  } finally {
    await r.stop()
  }
})

test('in the open sandbox, a process a command leaves running is killed with it', async () => {
  const marker = join(root, 'leftover-alive')
  const box = await openExecutor().open(root, { image: 'unused', hardware: 'cpu', job: 'j0', frozen: {} })
  // A background loop that would keep touching the marker for a minute
  const r = await box.exec(`(for i in $(seq 600); do touch '${marker}'; sleep 0.1; done) >/dev/null 2>&1 & echo started`, 10_000)
  assert.equal(r.stdout.trim(), 'started')
  await new Promise((done) => setTimeout(done, 300))
  rmSync(marker, { force: true })
  await new Promise((done) => setTimeout(done, 500))
  assert.equal(existsSync(marker), false, 'the loop died with its command')
})
