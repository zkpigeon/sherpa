// sherpa-runner: claims jobs from sherpa-server one at a time and runs each in
// its sandbox: throwaway containers when strict, plain processes when open.
// Configured by environment variables; see .env.example.
import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolve } from 'node:path'
import { dockerExecutor, openExecutor } from './exec.ts'
import { SANDBOXES, type Sandbox } from '../shared/api.ts'
import { createGit } from './git.ts'
import { createApi, runJob, type JobDeps } from './job.ts'

const env = process.env
const need = (name: string) => {
  const v = env[name]?.trim()
  if (!v) throw new Error(`Set ${name}.`)
  return v
}

const server = need('SHERPA_URL').replace(/\/$/, '')
const runner = env.SHERPA_RUNNER_NAME?.trim() || hostname()
const labels = (env.SHERPA_LABELS ?? 'cpu').split(',').map((l) => l.trim()).filter(Boolean)
const work = resolve(env.SHERPA_WORK ?? '/tmp/sherpa-runner')
const pollMs = Number(env.SHERPA_POLL_SECONDS ?? 5) * 1000
const sandbox = (env.SHERPA_SANDBOX?.trim() || 'strict') as Sandbox
if (!SANDBOXES.includes(sandbox)) throw new Error(`SHERPA_SANDBOX is strict or open, not ${env.SHERPA_SANDBOX}.`)
// Open jobs run as plain processes, so in the Compose runner, which holds the Docker socket, they could drive the host's Docker. It stands down instead
if (sandbox === 'open' && existsSync('/.dockerenv') && existsSync('/var/run/docker.sock')) {
  console.log('SHERPA_SANDBOX=open: this runner holds the Docker socket, so it runs no jobs. Start the open runner on the host with sh scripts/open-runner.sh.')
  await new Promise((done) => ['SIGINT', 'SIGTERM'].forEach((s) => process.once(s, done)))
  process.exit(0)
}
if (sandbox === 'open') console.warn('SHERPA_SANDBOX=open: jobs run as processes on this machine, with its network and files. The frozen verifier files are still checked after every command.')
// On the host, the bare repos the Compose runner sees at /repos live in SHERPA_REPOS
const hostRepos = env.SHERPA_REPOS?.trim() ? resolve(env.SHERPA_REPOS.trim()) : null
const where = (repo: string) => (hostRepos && repo.startsWith('file:///repos/') ? `file://${hostRepos}/${repo.slice('file:///repos/'.length)}` : repo)

const git = createGit(resolve(work, 'repos'), env.SHERPA_GIT_PROTOCOLS)
const deps: JobDeps = {
  api: createApi(server, need('SHERPA_RUNNER_TOKEN')),
  executor: sandbox === 'open' ? openExecutor() : dockerExecutor({ runner, ...(env.SHERPA_CPUSET ? { cpuset: env.SHERPA_CPUSET } : {}), ...(env.SHERPA_MEMORY ? { memory: env.SHERPA_MEMORY } : {}) }),
  checkout: (repo, ...rest) => git.checkout(where(repo), ...rest),
  changed: (repo, ...rest) => git.changed(where(repo), ...rest),
  runner,
  work,
  defaultRepo: env.SHERPA_REPO?.trim() || null,
  renewEveryMs: Number(env.SHERPA_RENEW_SECONDS ?? 30) * 1000,
  log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
}

// Stopping abandons the current job and removes its containers; its lease lapses and another runner takes it
const stop = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (stop.signal.aborted) process.exit(1)
    deps.log('stopping')
    stop.abort()
  })

const swept = (await deps.executor.sweep?.()) ?? 0
if (swept) deps.log(`removed ${swept} containers a previous run left behind`)
deps.log(`${runner} claiming ${labels.join(', ')} jobs from ${server}, in the ${sandbox} sandbox`)
while (!stop.signal.aborted) {
  try {
    const job = await deps.api.claim(runner, labels)
    if (!job) {
      await sleep(pollMs, null, { signal: stop.signal }).catch(() => {})
      continue
    }
    deps.log(`running ${job.job}: ${job.kind} for agent ${job.agent} ${job.module}`)
    await runJob(job, deps, stop.signal)
    deps.log(`finished ${job.job}`)
  } catch (e) {
    deps.log(`error: ${(e as Error).message}`)
    await sleep(pollMs, null, { signal: stop.signal }).catch(() => {})
  }
}
