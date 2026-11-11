// sherpa-runner: claims jobs from sherpa-server one at a time and runs each in
// throwaway containers. Configured by environment variables; see .env.example.
import { hostname } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { resolve } from 'node:path'
import { dockerExecutor, localExecutor } from './exec.ts'
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
const local = env.SHERPA_EXECUTOR === 'local'
if (local) console.warn('SHERPA_EXECUTOR=local runs jobs on this machine without a container. Use it for tests only.')

const git = createGit(resolve(work, 'repos'), env.SHERPA_GIT_PROTOCOLS)
const deps: JobDeps = {
  api: createApi(server, need('SHERPA_RUNNER_TOKEN')),
  executor: local ? localExecutor : dockerExecutor({ runner, ...(env.SHERPA_CPUSET ? { cpuset: env.SHERPA_CPUSET } : {}), ...(env.SHERPA_MEMORY ? { memory: env.SHERPA_MEMORY } : {}) }),
  checkout: git.checkout,
  changed: git.changed,
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
deps.log(`${runner} claiming ${labels.join(', ')} jobs from ${server}`)
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
