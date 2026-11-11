import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Board } from '../shared/api.ts'
import { MINUTE } from './domain/records.ts'
import { createHandler } from './http.ts'
import { createService } from './service.ts'
import { openStore } from './store.ts'

const dir = mkdtempSync(join(tmpdir(), 'sherpa-http-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const dashboard = join(dir, 'dashboard')
mkdirSync(join(dashboard, 'assets'), { recursive: true })
writeFileSync(join(dashboard, 'index.html'), '<!doctype html><title>Sherpa</title>')
writeFileSync(join(dashboard, 'assets', 'app.js'), 'console.log(1)')

// Stops every server, including one whose test failed partway
const running: (() => Promise<void>)[] = []
after(() => Promise.all(running.map((stop) => stop())))

const TOKENS = { agent: 'agent-token-0123456789', runner: 'runner-token-0123456789', admin: 'admin-token-0123456789' }
let now = Date.parse('2026-11-03T00:00:00Z')
const tick = (minutes: number) => (now += minutes * MINUTE)

async function boot(db: string) {
  const store = openStore(db)
  const server: Server = createServer(createHandler({ service: createService(store, undefined, () => now), tokens: TOKENS, dashboard }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = async (method: string, path: string, opts: { token?: keyof typeof TOKENS | null; body?: unknown; headers?: Record<string, string> } = {}) => {
    const token = opts.token === undefined ? 'agent' : opts.token
    const headers: Record<string, string> = { ...(token ? { authorization: `Bearer ${TOKENS[token]}` } : {}), ...opts.headers }
    if (opts.body !== undefined) headers['content-type'] = typeof opts.body === 'string' ? 'text/plain' : 'application/json'
    const res = await fetch(base + path, { method, headers, ...(opts.body !== undefined ? { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) } : {}) })
    const text = await res.text()
    const type = res.headers.get('content-type') ?? ''
    return { status: res.status, type, text, headers: res.headers, json: type.includes('json') ? JSON.parse(text) : null }
  }
  let stopped: Promise<void> | null = null
  const stop = () =>
    (stopped ??= new Promise<void>((r) => {
      server.close(() => (store.close(), r()))
      server.closeAllConnections()
    }))
  running.push(stop)
  return { call, stop }
}

const START = 'a'.repeat(40)
const NEXT = 'b'.repeat(40)
const VERIFIERS = {
  author: 'verifier',
  image: 'node:26-slim',
  files: { 'bench/latency.js': 'console.log(JSON.stringify({ value: 100, work: 1 }))', 'test/regression.test.js': 'ok' },
  commands: { regression: 'node --test test/regression.test.js', steps: ['node --test test/step-1.test.js'], benchmark: 'node bench/latency.js' },
  hardware: 'cpu',
  timeLimitMinutes: 20,
}
const runs = (commit: string, value: number) => [0, 1, -1, 2, -2].map((k) => ({ commit, value: value + k * 0.2, work: 1000 }))

test('agents, runners and the admin drive a module through HTTP, and the data survives a restart', async () => {
  const db = join(dir, 'sherpa.db')
  let s = await boot(db)

  // Tokens
  const anonymous = await s.call('GET', '/api/board', { token: null })
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.headers.get('www-authenticate'), null, 'no browser password prompt: the dashboard has its own sign-in page')
  // curl -u takes a token as the Basic password
  const viaBasic = await s.call('GET', '/api/board', { token: null, headers: { authorization: `Basic ${Buffer.from(`me:${TOKENS.admin}`).toString('base64')}` } })
  assert.equal(viaBasic.status, 200)
  assert.equal((await s.call('POST', '/jobs/claim', { body: { runner: 'r1', labels: ['cpu'] } })).status, 403)
  assert.equal((await s.call('GET', '/api/board', { token: 'agent' })).status, 403)
  assert.equal((await s.call('GET', '/healthz', { token: null })).text, 'ok\n')

  const created = await s.call('POST', '/agents/1/projects', {
    body: { title: 'search-perf', startCommit: START, repo: 'https://git.example/search.git', modules: [{ title: 'query cache', steps: ['Cache parsed queries'], goal: { metric: 'p95 latency', unit: 'ms', direction: 'lower', targetGain: 10 } }] },
  })
  assert.deepEqual(created.json, { state: 'open', modules: ['m1'] })
  const tooBold = await s.call('POST', '/agents/1/modules', { body: { title: 'x', steps: ['a'], goal: { metric: 'm', unit: 'ms', direction: 'lower', targetGain: 40 } } })
  assert.equal(tooBold.status, 400)
  assert.equal(tooBold.json.error, 'badSpec')
  assert.equal((await s.call('PUT', '/agents/1/blurb', { body: 'Caching parsed queries.' })).status, 200)

  // The project in brief, where a verifier agent finds the modules that need verifiers
  const brief = await s.call('GET', '/agents/1/project')
  assert.deepEqual([brief.json.title, brief.json.current, brief.json.queued, brief.json.goal, brief.json.state, brief.json.progress], ['search-perf', 'm1', [], null, 'open', null])
  assert.deepEqual(brief.json.modules.map((m: { id: string; verifiers: string; steps: string[]; status: unknown }) => [m.id, m.verifiers, m.steps, m.status]), [['m1', 'missing', ['Cache parsed queries'], { state: 'pending', waitingFor: 'verifiers' }]])
  // A goal for the whole climb comes back with the brief, frozen as sent
  const goal = { metric: 'p95 latency', unit: 'ms', direction: 'lower', target: 250, hours: 8 }
  const aimed = await s.call('POST', '/agents/7/projects', {
    body: { title: 'aimed', startCommit: START, goal, modules: [{ title: 'cache', steps: ['Cache'], goal: { metric: 'p95 latency', unit: 'ms', direction: 'lower', targetGain: 10 } }] },
  })
  assert.equal(aimed.status, 200)
  const aimedBrief = (await s.call('GET', '/agents/7/project')).json
  assert.deepEqual([aimedBrief.goal.target, aimedBrief.goal.targetGain, aimedBrief.goal.hours, aimedBrief.state], [250, null, 8, 'open'])
  assert.match(aimedBrief.goal.budgetEndsAt, /^2026-11-03T08:00/)
  const offMetric = await s.call('POST', '/agents/8/projects', {
    body: { title: 'off', startCommit: START, goal, modules: [{ title: 'heap', steps: ['Shrink'], goal: { metric: 'heap', unit: 'MB', direction: 'lower', targetGain: 10 } }] },
  })
  assert.deepEqual([offMetric.status, offMetric.json.error], [400, 'badSpec'])
  const none = await s.call('GET', '/agents/9/project')
  assert.deepEqual([none.status, none.json.message], [404, 'There is no project for agent 9. Create one with POST /agents/9/projects.'])

  const badPath = await s.call('POST', '/agents/1/modules/m1/verifiers', { body: { ...VERIFIERS, files: { '../escape.sh': 'x' } } })
  assert.equal(badPath.status, 400)
  const frozen = await s.call('POST', '/agents/1/modules/m1/verifiers', { body: VERIFIERS })
  assert.equal(frozen.status, 200)
  assert.match(frozen.json.hash, /^[0-9a-f]{16}$/)
  assert.equal((await s.call('GET', '/agents/1/project')).json.modules[0].verifiers, 'frozen')

  // The baseline job, with the frozen files and the project's remote
  const claim = await s.call('POST', '/jobs/claim', { token: 'runner', body: { runner: 'r1', labels: ['cpu'] } })
  assert.equal(claim.json.kind, 'baseline')
  assert.equal(claim.json.repo, 'https://git.example/search.git')
  assert.deepEqual(claim.json.files, VERIFIERS.files)
  assert.equal((await s.call('POST', '/jobs/claim', { token: 'runner', body: { runner: 'r1', labels: ['cpu'] } })).status, 204)
  tick(1)
  assert.equal((await s.call('POST', `/jobs/${claim.json.job}/lease`, { token: 'runner', body: { runner: 'r1' } })).json.state, 'running')
  const landed = await s.call('POST', `/jobs/${claim.json.job}/results`, { token: 'runner', body: { runner: 'r1', outcome: 'done', tests: { passed: 4, total: 4 }, runs: runs(START, 100), touched: [] } })
  assert.deepEqual(landed.json, { state: 'done' })

  // An agent the server hasn't heard from yet has no project, which isn't an error
  assert.deepEqual(await s.call('GET', '/agents/9').then((r) => [r.status, r.text]), [200, 'agent 9: no open project\n'])
  const line = await s.call('GET', '/agents/1')
  assert.equal(line.type, 'text/plain; charset=utf-8')
  assert.equal(line.text, 'agent 1: Project: search-perf, Module (1 / 1): query cache, Progress: 0 / 1, Blurb: Caching parsed queries. Goal: p95 latency 100 -> 90 ms, 10% lower. Last module in the project. 90 min left.\n')

  tick(5)
  const posted = await s.call('POST', '/agents/1/modules/m1/attempts', { body: { attemptId: 'a1', commit: NEXT, note: 'Cache parsed query trees.' } })
  assert.deepEqual([posted.json.job, posted.json.verdict, posted.json.module.state], ['queued', null, 'active'])
  const busy = await s.call('POST', '/agents/1/modules/m1/attempts', { body: { attemptId: 'a2', commit: 'c'.repeat(40), note: 'Too soon.' } })
  assert.deepEqual([busy.status, busy.json.error], [409, 'jobInFlight'])
  const job = (await s.call('POST', '/jobs/claim', { token: 'runner', body: { runner: 'r1', labels: ['cpu'] } })).json
  assert.deepEqual(job.commits, [START, NEXT])
  tick(1)
  await s.call('POST', `/jobs/${job.job}/results`, { token: 'runner', body: { runner: 'r1', outcome: 'done', tests: { passed: 4, total: 4 }, runs: runs(START, 100).flatMap((x, i) => [x, runs(NEXT, 88)[i]]) } })
  const judged = await s.call('GET', '/agents/1/modules/m1/attempts/a1')
  assert.deepEqual([judged.json.verdict, judged.json.module.state, judged.json.median, judged.json.bestMedian], ['win', 'passed', 88, 100])
  assert.match(judged.json.why, /^Win: 12% lower than the best commit/)
  const results = await s.call('GET', '/agents/1/results.tsv')
  const [header, row] = results.text.split('\n')
  assert.deepEqual([results.status, results.type], [200, 'text/tab-separated-values; charset=utf-8'])
  assert.match(row!, /^search-perf\tm1\tquery cache\t1\ta1\tbbbbbbb\twin\t88\t100\t12\t/)
  assert.deepEqual(await s.call('GET', '/agents/9/results.tsv').then((r) => [r.status, r.text]), [200, `${header}\n`], 'an agent the server hasn’t heard from gets the header alone')
  const step = await s.call('GET', '/agents/1/modules/m1/steps/1')
  assert.deepEqual([step.json.done, step.json.skipped, step.json.check], [false, true, null])

  // The dashboard's JSON and attempt detail, with the admin token
  const board = (await s.call('GET', '/api/board', { token: 'admin' })).json as Board
  assert.equal(board.agents[0]!.project!.modules[0]!.best, 88)
  const detail = await s.call('GET', '/api/agents/1/modules/m1/attempts/a1', { token: 'admin' })
  assert.equal(detail.json.runs.length, 10)
  assert.equal(detail.json.runner, 'r1')

  // A browser without the cookie gets the sign-in page, which trades the admin token for it
  const html = { accept: 'text/html' }
  const signin = await s.call('GET', '/agents/1', { token: null, headers: html })
  assert.deepEqual([signin.status, signin.headers.get('www-authenticate')], [401, null])
  assert.match(signin.text, /<title>Sign in · Sherpa/)
  assert.equal((await s.call('GET', '/assets/app.js', { token: null })).status, 401)
  const wrong = await s.call('POST', '/signin', { token: null, body: { token: TOKENS.agent } })
  assert.deepEqual([wrong.status, wrong.json.message], [401, "That's the agent token. The dashboard takes the admin token, SHERPA_ADMIN_TOKEN."])
  assert.equal(wrong.headers.get('set-cookie'), null)
  assert.equal((await s.call('POST', '/signin', { token: null, body: { token: 'nope' } })).status, 401)
  assert.equal((await s.call('POST', '/signin', { token: null, body: { token: TOKENS.admin }, headers: { origin: 'https://evil.example' } })).status, 403)
  const signed = await s.call('POST', '/signin', { token: null, body: { token: ` ${TOKENS.admin}\n` } })
  assert.equal(signed.status, 204)
  const set = signed.headers.get('set-cookie') ?? ''
  assert.match(set, /^sherpa_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/)
  assert.equal(set.includes(TOKENS.admin), false, 'the cookie holds a value derived from the token, not the token')
  const cookie = { cookie: `theme=dark; ${set.split(';')[0]}` }
  const page = await s.call('GET', '/agents/1', { token: null, headers: { ...html, ...cookie } })
  assert.equal(page.status, 200)
  assert.match(page.text, /<title>Sherpa/)
  const asset = await s.call('GET', '/assets/app.js', { token: null, headers: cookie })
  assert.match(asset.type, /javascript/)
  assert.equal((await s.call('GET', '/assets/..%2F..%2Fsherpa.db', { token: null, headers: cookie })).text.includes('SQLite'), false)
  assert.equal((await s.call('GET', '/api/board', { token: null, headers: cookie })).status, 200)
  assert.equal((await s.call('GET', '/api/board', { token: null, headers: { cookie: 'sherpa_session=' + '0'.repeat(64) } })).status, 401)
  // The cookie is the admin's only: it opens no agent call
  assert.equal((await s.call('GET', '/agents/1', { token: null, headers: cookie })).status, 403)
  const out = await s.call('POST', '/signout', { token: null, headers: cookie })
  assert.deepEqual([out.status, out.headers.get('set-cookie')], [204, 'sherpa_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'])
  assert.equal((await s.call('GET', '/signin', { token: null })).status, 405)

  // Restart: everything comes back from the database
  const before = (await s.call('GET', '/board')).text
  await s.stop()
  s = await boot(db)
  assert.equal((await s.call('GET', '/board')).text, before)
  assert.equal((await s.call('GET', '/agents/1/modules/m1/attempts/a1')).json.verdict, 'win')
  await s.stop()
})

test('change requests merge over the frozen files and wait for the admin', async () => {
  const s = await boot(join(dir, 'changes.db'))
  await s.call('POST', '/agents/2/projects', {
    body: { title: 'ingest', startCommit: START, modules: [{ title: 'batch writes', steps: ['Batch inserts'], goal: { metric: 'throughput', unit: 'docs/s', direction: 'higher', targetGain: 10 } }] },
  })
  assert.equal((await s.call('POST', '/agents/2/modules/m1/verifiers/changes', { body: { reason: 'Too early.', files: {} } })).json.error, 'verifiersMissing')
  const { hash } = (await s.call('POST', '/agents/2/modules/m1/verifiers', { body: VERIFIERS })).json
  const filed = await s.call('POST', '/agents/2/modules/m1/verifiers/changes', {
    body: { reason: 'The benchmark reads a cold cache on its first run.', files: { 'bench/latency.js': 'warm(); bench()', 'test/regression.test.js': null } },
  })
  assert.equal(filed.status, 200)
  const change = filed.json.change
  assert.equal((await s.call('GET', `/agents/2/modules/m1/verifiers/changes/${change}`)).json.state, 'open')
  const board = (await s.call('GET', '/api/board', { token: 'admin' })).json as Board
  assert.deepEqual(board.agents[0]!.project!.modules[0]!.changes[0]!.files, ['bench/latency.js', 'test/regression.test.js'])

  assert.equal((await s.call('POST', `/admin/changes/${change}`, { body: { approve: true } })).status, 403)
  assert.deepEqual((await s.call('POST', `/admin/changes/${change}`, { token: 'admin', body: { approve: true } })).json, { state: 'approved', appliedTo: [] })
  // The baseline queued before the approval keeps the verifiers it was queued with
  const first = (await s.call('POST', '/jobs/claim', { token: 'runner', body: { runner: 'r1', labels: ['cpu'] } })).json
  assert.equal(first.verifierHash, hash)
  await s.call('POST', `/jobs/${first.job}/results`, { token: 'runner', body: { runner: 'r1', outcome: 'done', tests: { passed: 3, total: 4 }, runs: [] } })
  // It failed, so the module measures its baseline again on the approved set
  const claim = (await s.call('POST', '/jobs/claim', { token: 'runner', body: { runner: 'r1', labels: ['cpu'] } })).json
  assert.notEqual(claim.verifierHash, hash)
  assert.deepEqual(claim.files, { 'bench/latency.js': 'warm(); bench()' })
  const files = await s.call('GET', `/admin/verifiers/${hash}`, { token: 'admin' })
  assert.deepEqual(files.json, VERIFIERS.files)
  await s.stop()
})

test('the admin reviews a change line by line, and an approval reaches the project’s modules that haven’t started', async () => {
  const s = await boot(join(dir, 'review.db'))
  const goal = { metric: 'p95 latency', unit: 'ms', direction: 'lower', targetGain: 10 }
  await s.call('POST', '/agents/5/projects', { body: { title: 'review', startCommit: START, modules: [{ title: 'first', steps: ['One'], goal }, { title: 'second', steps: ['One', 'Two'], goal }, { title: 'third', steps: ['One'], goal }] } })
  const steps = (n: number) => ({ ...VERIFIERS.commands, steps: Array.from({ length: n }, () => 'node --test') })
  await s.call('POST', '/agents/5/modules/m1/verifiers', { body: { ...VERIFIERS, commands: steps(1) } })
  await s.call('POST', '/agents/5/modules/m2/verifiers', { body: { ...VERIFIERS, commands: steps(2) } })
  // m3's benchmark already differs, so the change doesn't apply to it
  await s.call('POST', '/agents/5/modules/m3/verifiers', { body: { ...VERIFIERS, commands: steps(1), files: { ...VERIFIERS.files, 'bench/latency.js': 'other()' } } })
  const { change } = (await s.call('POST', '/agents/5/modules/m1/verifiers/changes', { body: { reason: 'Run the benchmark longer.', files: { 'bench/latency.js': 'longer()' } } })).json
  const review = (await s.call('GET', `/admin/changes/${change}`, { token: 'admin' })).json
  assert.deepEqual(review.files, [{ path: 'bench/latency.js', before: VERIFIERS.files['bench/latency.js'], after: 'longer()' }])
  assert.deepEqual([review.stale, review.moduleTitle, review.author], [false, 'first', '5'])
  const r = (await s.call('POST', `/admin/changes/${change}`, { token: 'admin', body: { approve: true, note: 'Thanks.' } })).json
  assert.deepEqual(r, { state: 'approved', appliedTo: ['m2'] })
  const m2 = (await s.call('GET', '/agents/5/modules/m2')).json
  assert.equal(m2.commands.steps.length, 2, 'm2 keeps its own step commands')
  const files = (await s.call('GET', `/admin/verifiers/${m2.verifiers.hash}`, { token: 'admin' })).json
  assert.equal(files['bench/latency.js'], 'longer()')
  const changes = (await s.call('GET', '/agents/5/modules/m1/verifiers/changes')).json
  assert.deepEqual([changes[0].note, changes[0].appliedTo], ['Thanks.', ['m2']])
  assert.equal((await s.call('GET', `/agents/5/modules/m1/verifiers/changes/${change}`)).json.note, 'Thanks.')
  await s.stop()
})

test('approving one change request never undoes another', async () => {
  const s = await boot(join(dir, 'rebase.db'))
  await s.call('POST', '/agents/3/projects', {
    body: { title: 'suite', startCommit: START, modules: [{ title: 'workers', steps: ['Split'], goal: { metric: 'suite time', unit: 's', direction: 'lower', targetGain: 10 } }] },
  })
  await s.call('POST', '/agents/3/modules/m1/verifiers', { body: VERIFIERS })
  // Both filed against the same set: one edits the benchmark, the other the regression test
  const c1 = (await s.call('POST', '/agents/3/modules/m1/verifiers/changes', { body: { reason: 'Warm the cache first.', files: { 'bench/latency.js': 'warm()' } } })).json.change
  const c2 = (await s.call('POST', '/agents/3/modules/m1/verifiers/changes', { body: { reason: 'Test the edge case.', author: 'verifier', files: { 'test/regression.test.js': 'edge()' } } })).json.change
  await s.call('POST', `/admin/changes/${c1}`, { token: 'admin', body: { approve: true } })
  await s.call('POST', `/admin/changes/${c2}`, { token: 'admin', body: { approve: true } })
  const m = ((await s.call('GET', '/api/board', { token: 'admin' })).json as Board).agents[0]!.project!.modules[0]!
  const frozen = m.verifiers.kind === 'frozen' ? m.verifiers : null
  assert.equal(frozen?.author, 'verifier', 'approved edits keep the verifiers’ author')
  assert.equal(m.changes[1]!.author, 'verifier')
  const now = (await s.call('GET', `/admin/verifiers/${frozen!.hash}`, { token: 'admin' })).json
  assert.deepEqual(now, { 'bench/latency.js': 'warm()', 'test/regression.test.js': 'edge()' })
  await s.stop()
})

test('requests from other sites, form posts, and broken paths are refused', async () => {
  const s = await boot(join(dir, 'guards.db'))
  const basic = `Basic ${Buffer.from(`me:${TOKENS.admin}`).toString('base64')}`
  const form = await s.call('POST', '/admin/changes/c1', { token: null, body: '{"approve":true}', headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' } })
  assert.deepEqual([form.status, form.json.error], [415, 'badContentType'])
  const crossSite = await s.call('POST', '/admin/changes/c1', { token: null, body: { approve: true }, headers: { authorization: basic, 'sec-fetch-site': 'cross-site' } })
  assert.deepEqual([crossSite.status, crossSite.json.error], [403, 'crossSite'])
  const otherOrigin = await s.call('POST', '/admin/changes/c1', { token: null, body: { approve: true }, headers: { authorization: basic, origin: 'https://evil.example' } })
  assert.equal(otherOrigin.status, 403)
  const broken = await s.call('GET', '/agents/%E0%A4%A')
  assert.deepEqual([broken.status, broken.json.error], [400, 'badPath'])
  const page = await s.call('GET', '/', { token: null, headers: { authorization: basic, accept: 'text/html' } })
  assert.equal(page.headers.get('x-frame-options'), 'DENY')
  await s.stop()
})
