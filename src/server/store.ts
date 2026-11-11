// sherpa-server's database, through node:sqlite. The world lives in memory and
// is written back as one JSON document per agent, only for the agents whose
// document changed. Verifier files are kept by hash, and every call that
// could change something is logged. sherpa-server is the only writer.
import { DatabaseSync } from 'node:sqlite'
import { emptyWorld, type AgentRec, type World } from './domain/records.ts'

export type Files = Record<string, string>

export interface CallLog {
  at: number
  call: string
  args: unknown
  /** `ok`, or the rejection code. */
  outcome: string
}

export interface Store {
  load(): World
  /** Writes the agents whose document changed, and the counters, in one transaction. */
  save(w: World): void
  putFiles(hash: string, files: Files): void
  files(hash: string): Files | null
  log(entry: CallLog): void
  calls(limit: number): CallLog[]
  close(): void
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, position INTEGER NOT NULL, doc TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS verifier_files (hash TEXT PRIMARY KEY, files TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS calls (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, call TEXT NOT NULL, args TEXT NOT NULL, outcome TEXT NOT NULL);
`
const VERSION = '1'

export function openStore(path: string): Store {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  const meta = db.prepare('SELECT value FROM meta WHERE key = ?')
  const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
  const version = (meta.get('schema') as { value: string } | undefined)?.value
  if (version === undefined) setMeta.run('schema', VERSION)
  else if (version !== VERSION) throw new Error(`The database at ${path} has schema ${version}; this server reads ${VERSION}.`)

  const putAgent = db.prepare('INSERT INTO agents (id, position, doc) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET position = excluded.position, doc = excluded.doc')
  const putFiles = db.prepare('INSERT INTO verifier_files (hash, files) VALUES (?, ?) ON CONFLICT (hash) DO NOTHING')
  const getFiles = db.prepare('SELECT files FROM verifier_files WHERE hash = ?')
  const putCall = db.prepare('INSERT INTO calls (at, call, args, outcome) VALUES (?, ?, ?, ?)')
  const getCalls = db.prepare('SELECT at, call, args, outcome FROM calls ORDER BY seq DESC LIMIT ?')

  // What each agent's row holds now, so a save writes only what changed
  let written = new Map<string, string>()
  let counters = ''

  const transaction = (run: () => void) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      run()
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }

  return {
    load() {
      const w = emptyWorld()
      const rows = db.prepare('SELECT id, doc FROM agents ORDER BY position').all() as { id: string; doc: string }[]
      w.agents = rows.map((r) => JSON.parse(r.doc) as AgentRec)
      w.jobs = Number((meta.get('jobs') as { value: string } | undefined)?.value ?? 0)
      w.changes = Number((meta.get('changes') as { value: string } | undefined)?.value ?? 0)
      written = new Map(rows.map((r) => [r.id, r.doc]))
      counters = `${w.jobs}/${w.changes}`
      return w
    },
    save(w) {
      const docs = w.agents.map((a, i) => ({ id: a.id, i, doc: JSON.stringify(a) }))
      const changed = docs.filter((d) => written.get(d.id) !== d.doc)
      const nextCounters = `${w.jobs}/${w.changes}`
      if (!changed.length && nextCounters === counters) return
      transaction(() => {
        for (const d of changed) putAgent.run(d.id, d.i, d.doc)
        setMeta.run('jobs', String(w.jobs))
        setMeta.run('changes', String(w.changes))
      })
      for (const d of changed) written.set(d.id, d.doc)
      counters = nextCounters
    },
    putFiles(hash, files) {
      putFiles.run(hash, JSON.stringify(files))
    },
    files(hash) {
      const row = getFiles.get(hash) as { files: string } | undefined
      return row ? (JSON.parse(row.files) as Files) : null
    },
    log(entry) {
      putCall.run(entry.at, entry.call, JSON.stringify(entry.args ?? null), entry.outcome)
    },
    calls(limit) {
      const rows = getCalls.all(limit) as { at: number; call: string; args: string; outcome: string }[]
      return rows.map((r) => ({ ...r, args: JSON.parse(r.args) as unknown }))
    },
    close() {
      db.close()
    },
  }
}
