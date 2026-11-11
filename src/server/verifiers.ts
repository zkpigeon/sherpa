// Verifier uploads: checking the files, hashing the set, and merging a change
// request over the frozen set. The domain only ever sees the hash and paths;
// the files live in the store under that hash.
import { createHash } from 'node:crypto'
import type { VerifierSpec } from './domain/records.ts'
import type { Files } from './store.ts'

/** A verifier set as an agent or the admin sends it. */
export interface VerifierUpload {
  files: Files
  image: string
  commands: VerifierSpec['commands']
  hardware: string
  timeLimitMinutes: number
  /** Benchmark runs per commit; the server's default without it. */
  runs?: number
}

const MAX_FILES = 500
const MAX_BYTES = 10 * 1024 * 1024

/** A relative path inside the checkout: no `..`, no absolute paths, nothing under .git. */
export const safePath = (p: string) => /^[A-Za-z0-9._@+-][A-Za-z0-9._@+/-]*$/.test(p) && !p.split('/').some((s) => s === '..' || s === '.' || s === '') && !/^\.git(\/|$)/.test(p)

export function filesProblem(files: unknown): string | null {
  if (!files || typeof files !== 'object' || Array.isArray(files)) return 'files must map each path to its content.'
  const entries = Object.entries(files)
  if (entries.length === 0) return 'The verifiers need at least one file.'
  if (entries.length > MAX_FILES) return `The verifiers can have at most ${MAX_FILES} files.`
  let bytes = 0
  for (const [path, content] of entries) {
    if (!safePath(path)) return `"${path}" isn't a relative path inside the checkout.`
    if (typeof content !== 'string') return `The content of ${path} must be a string.`
    bytes += Buffer.byteLength(content)
  }
  if (bytes > MAX_BYTES) return 'The verifier files can total at most 10 MB.'
  return null
}

/** One hash over the files, image, commands (the clean command among them), hardware label and job time limit. */
export function hashOf(u: VerifierUpload): string {
  const files = Object.keys(u.files)
    .sort()
    .map((p) => [p, u.files[p]])
  // runs joins the hash only when set, so sets without it keep the hash they had
  const canonical = JSON.stringify({ files, image: u.image, commands: u.commands, hardware: u.hardware, timeLimitMinutes: u.timeLimitMinutes, ...(u.runs === undefined ? {} : { runs: u.runs }) })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

export const specOf = (u: VerifierUpload): VerifierSpec => ({
  hash: hashOf(u),
  paths: Object.keys(u.files).sort(),
  image: u.image,
  commands: u.commands,
  hardware: u.hardware,
  timeLimitMinutes: u.timeLimitMinutes,
  ...(u.runs === undefined ? {} : { runs: u.runs }),
})

/** A change request's body: files to add or replace, null to delete, and any settings to change. */
export interface ChangeBody extends Partial<Omit<VerifierUpload, 'files'>> {
  reason: string
  /** Who wrote the change, when it isn't the agent the module belongs to. */
  author?: string
  files?: Record<string, string | null>
}

export function merge(current: VerifierUpload, change: ChangeBody): { upload: VerifierUpload; changed: string[] } {
  const files: Files = { ...current.files }
  const changed: string[] = []
  for (const [path, content] of Object.entries(change.files ?? {})) {
    if (content === null) delete files[path]
    else files[path] = content
    if (current.files[path] !== (content ?? undefined)) changed.push(path)
  }
  const upload: VerifierUpload = {
    files,
    image: change.image ?? current.image,
    commands: change.commands ?? current.commands,
    hardware: change.hardware ?? current.hardware,
    timeLimitMinutes: change.timeLimitMinutes ?? current.timeLimitMinutes,
    ...((change.runs ?? current.runs) === undefined ? {} : { runs: change.runs ?? current.runs }),
  }
  return { upload, changed: changed.sort() }
}

/**
 * A change's edits, made against `base`, applied to `current`: each file and
 * setting the change touched takes its proposed value, and everything else
 * stays as it is now. So approving one change never undoes another.
 */
export function rebase(base: VerifierUpload, current: VerifierUpload, proposed: VerifierUpload): VerifierUpload {
  const files: Files = { ...current.files }
  for (const path of new Set([...Object.keys(base.files), ...Object.keys(proposed.files)])) {
    if (base.files[path] === proposed.files[path]) continue
    const content = proposed.files[path]
    if (content === undefined) delete files[path]
    else files[path] = content
  }
  const changed = <T>(from: T, to: T) => JSON.stringify(from) !== JSON.stringify(to)
  const pick = <K extends 'image' | 'hardware' | 'timeLimitMinutes' | 'runs'>(key: K): VerifierUpload[K] => (changed(base[key], proposed[key]) ? proposed[key] : current[key])
  // Commands merge one by one; step commands only when both sets have as many steps, since modules differ in steps
  const [b, c, n] = [base.commands, current.commands, proposed.commands]
  const command = <K extends 'regression' | 'benchmark' | 'clean'>(key: K) => (b[key] !== n[key] ? n[key] : c[key])
  const steps = changed(b.steps, n.steps) && n.steps.length === c.steps.length ? n.steps : c.steps
  const clean = command('clean')
  const runs = pick('runs')
  return {
    files,
    image: pick('image'),
    commands: { regression: command('regression'), steps, benchmark: command('benchmark'), ...(clean === undefined ? {} : { clean }) },
    hardware: pick('hardware'),
    timeLimitMinutes: pick('timeLimitMinutes'),
    ...(runs === undefined ? {} : { runs }),
  }
}
