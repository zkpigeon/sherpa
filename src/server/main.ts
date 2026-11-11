// sherpa-server: the API, the dashboard and the database in one process.
// Configured by environment variables; see .env.example.
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { DEFAULTS, type Config } from './domain/records.ts'
import { createHandler, type Tokens } from './http.ts'
import { createService } from './service.ts'
import { openStore } from './store.ts'

const env = process.env

function token(name: string): string {
  const value = env[name]?.trim()
  if (!value || value.length < 16) throw new Error(`Set ${name} to a random string of at least 16 characters.`)
  return value
}

function minutes(name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number of minutes.`)
  return n
}

const tokens: Tokens = { agent: token('SHERPA_AGENT_TOKEN'), runner: token('SHERPA_RUNNER_TOKEN'), admin: token('SHERPA_ADMIN_TOKEN') }
if (new Set(Object.values(tokens)).size !== 3) throw new Error('The agent, runner and admin tokens must all differ.')

const config: Config = {
  defaultMaxMinutes: minutes('SHERPA_DEFAULT_MAX_MINUTES', DEFAULTS.defaultMaxMinutes),
  maxMinutesCeiling: minutes('SHERPA_MAX_MINUTES_CEILING', DEFAULTS.maxMinutesCeiling),
  leaseMinutes: minutes('SHERPA_LEASE_MINUTES', DEFAULTS.leaseMinutes),
  runs: DEFAULTS.runs,
}
if (config.defaultMaxMinutes > config.maxMinutesCeiling) throw new Error('SHERPA_DEFAULT_MAX_MINUTES is above SHERPA_MAX_MINUTES_CEILING.')

const db = resolve(env.SHERPA_DB ?? 'sherpa.db')
const dashboard = env.SHERPA_DASHBOARD === '' ? null : resolve(env.SHERPA_DASHBOARD ?? 'dist/dashboard')
const port = Number(env.SHERPA_PORT ?? 8080)
const host = env.SHERPA_HOST ?? '127.0.0.1'

const store = openStore(db)
const service = createService(store, config)
const server = createServer(createHandler({ service, tokens, dashboard }))
server.listen(port, host, () => console.log(`sherpa-server listening on http://${host}:${port}, database ${db}`))

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.close()
    store.close()
    process.exit(0)
  })
