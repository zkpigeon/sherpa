import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const hook = fileURLToPath(new URL('../../scripts/sherpa-hook.sh', import.meta.url))
const TOKEN = 'agent-token-0123456789'
// A board line with the characters JSON has to escape
const LINE = 'agent 1: Project: search-perf, Module (1 / 2): query cache, Progress: 0 / 2, Blurb: Trying "LRU"\tin C:\\cache. 38 min left.'

// Rejects if the hook exits nonzero, which would block the agent
const runHook = async (env: Record<string, string>, event?: string) =>
  (await promisify(execFile)('sh', [hook, ...(event ? [event] : [])], { env: { PATH: process.env.PATH ?? '', ...env } })).stdout
const context = (stdout: string, event: string) => {
  const out = JSON.parse(stdout)
  assert.equal(out.hookSpecificOutput.hookEventName, event)
  return out.hookSpecificOutput.additionalContext as string
}

test('the hook prints the board line as plain text or as an event’s JSON, and lets the agent carry on when the server is down', async () => {
  // Answers GET /agents/1 the way sherpa-server does
  const server = createServer((req, res) => {
    const ok = req.url === '/agents/1' && req.headers.authorization === `Bearer ${TOKEN}`
    res.writeHead(ok ? 200 : 401, { 'content-type': 'text/plain; charset=utf-8' }).end(ok ? `${LINE}\n` : 'no\n')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const env = { SHERPA_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, SHERPA_AGENT_ID: '1', SHERPA_AGENT_TOKEN: TOKEN }
  try {
    assert.equal(await runHook(env), `${LINE}\n`)
    assert.equal(await runHook(env, 'Post"Tool'), `${LINE}\n`, 'an event name that isn’t letters gets the plain line')
    assert.equal(context(await runHook(env, 'PostToolBatch'), 'PostToolBatch'), LINE.replace('\t', ' '), 'a tab becomes a space')
    assert.match(context(await runHook({ ...env, SHERPA_AGENT_TOKEN: 'wrong' }, 'PostToolUse'), 'PostToolUse'), /sherpa-server answered 401 \(no\)\. Check SHERPA_URL/, 'a refusal is told apart from an outage')
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }

  assert.match(await runHook(env), /^Sherpa: sherpa-server didn't answer .*Carry on/)
  assert.match(context(await runHook(env, 'PostToolUse'), 'PostToolUse'), /didn't answer/)
  assert.match(context(await runHook({}, 'PostToolBatch'), 'PostToolBatch'), /set SHERPA_URL, SHERPA_AGENT_ID and SHERPA_AGENT_TOKEN/)
})

test('the hook reads its settings from the env file beside it, as connect.sh lays out .sherpa/', async () => {
  const server = createServer((req, res) => {
    const ok = req.url === '/agents/7' && req.headers.authorization === `Bearer ${TOKEN}`
    res.writeHead(ok ? 200 : 401, { 'content-type': 'text/plain; charset=utf-8' }).end(ok ? 'agent 7: no open project\n' : 'no\n')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const dir = mkdtempSync(join(tmpdir(), 'sherpa-hook-'))
  try {
    copyFileSync(hook, join(dir, 'hook.sh'))
    writeFileSync(join(dir, 'env'), `SHERPA_URL=http://127.0.0.1:${(server.address() as AddressInfo).port}\nSHERPA_AGENT_ID=7\nSHERPA_AGENT_TOKEN=${TOKEN}\n`)
    const run = async () => (await promisify(execFile)('sh', [join(dir, 'hook.sh')], { env: { PATH: process.env.PATH ?? '' } })).stdout
    assert.equal(await run(), 'agent 7: no open project\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await new Promise<void>((r) => server.close(() => r()))
  }
})
