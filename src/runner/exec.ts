// Where a job's commands run. job.ts copies the frozen verifier files over
// each checkout first. The executor decides what else a command can reach,
// and after every command it reports any frozen file that no longer matches.
//
// The strict executor (Docker) gives each commit its own bare container: the
// checkout copied in, no network, no environment from the runner (so no
// tokens), no Docker socket, and every process killed between commands.
//
// The open executor runs commands as processes on the runner's machine, in
// the checkout, with the network and the machine's own toolchain. It passes
// on no secrets from the runner's environment and kills each command's
// process group when the command ends, but it doesn't isolate anything else.
import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { Sandbox } from '../shared/api.ts'
import { run, must, type Exit } from './proc.ts'

export interface Box {
  /** Runs a shell command in the checkout. */
  exec(command: string, timeoutMs: number, signal?: AbortSignal): Promise<Exit>
  /** The frozen files that changed since the box opened. */
  tampered(): Promise<string[]>
  close(): Promise<void>
}

export interface Job {
  image: string
  hardware: string
  job: string
  /** The frozen verifier files, by path, as job.ts wrote them into the checkout. */
  frozen: Record<string, string>
}

export interface Executor {
  sandbox: Sandbox
  open(dir: string, job: Job): Promise<Box>
  /** Removes containers a runner of this name left behind, such as after a crash. */
  sweep?(): Promise<number>
}

/** Settings the open executor passes on from the runner's environment. Tokens and everything else stay behind. */
const PASSED = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'CUDA_VISIBLE_DEVICES']

export function openExecutor(env: NodeJS.ProcessEnv = process.env): Executor {
  const kept = Object.fromEntries(PASSED.flatMap((k) => (env[k] === undefined ? [] : [[k, env[k]!]])))
  return {
    sandbox: 'open',
    async open(dir, job) {
      // Any write to a file, even one that puts the same bytes back, moves its ctime
      const stamp = (path: string) => {
        try {
          const s = lstatSync(join(dir, path), { bigint: true })
          return s.isFile() ? `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.mode}` : 'not a file'
        } catch {
          return 'missing'
        }
      }
      const paths = Object.keys(job.frozen)
      const stamps = new Map(paths.map((p) => [p, stamp(p)]))
      return {
        exec: (command, timeoutMs, signal) => run('sh', ['-c', command], { cwd: dir, env: { PATH: '/usr/bin:/bin', ...kept, HOME: dir }, timeoutMs, signal, group: true }),
        tampered: async () => paths.filter((p) => stamp(p) !== stamps.get(p)),
        async close() {},
      }
    },
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** The frozen paths whose `sha256sum` line is missing or differs from `sums`. */
export function changedSums(out: string, sums: Record<string, string>): string[] {
  const seen = new Map<string, string>()
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)
    if (m) seen.set(m[2]!, m[1]!)
  }
  return Object.keys(sums).filter((p) => seen.get(p) !== sums[p])
}

export interface DockerOptions {
  /** Labels the containers, so a restarted runner can remove the ones it left behind. */
  runner?: string
  /** Pins job containers to these CPUs, such as "2-5", so other work doesn't skew benchmarks. */
  cpuset?: string
  memory?: string
  docker?: string
}

export function dockerExecutor({ runner = 'runner', cpuset, memory, docker = 'docker' }: DockerOptions = {}): Executor {
  return {
    sandbox: 'strict',
    async sweep() {
      const ids = (await run(docker, ['ps', '-aq', '--filter', `label=sherpa.runner=${runner}`])).stdout.split('\n').filter(Boolean)
      if (ids.length) await run(docker, ['rm', '-f', ...ids])
      return ids.length
    },
    async open(dir, job) {
      const args = ['create', '--network', 'none', '--pids-limit', '4096', '--workdir', '/work', '--label', `sherpa.job=${job.job}`, '--label', `sherpa.runner=${runner}`, '--entrypoint', 'sleep']
      if (cpuset) args.push('--cpuset-cpus', cpuset)
      if (memory) args.push('--memory', memory)
      if (job.hardware === 'gpu') args.push('--gpus', 'all')
      args.push('--', job.image, 'infinity')
      const id = (await must(docker, args, { timeoutMs: 15 * 60_000 })).trim()
      try {
        await must(docker, ['cp', `${dir}/.`, `${id}:/work`], { timeoutMs: 10 * 60_000 })
        await must(docker, ['start', id], { timeoutMs: 60_000 })
      } catch (e) {
        await run(docker, ['rm', '-f', id])
        throw e
      }
      const sums = Object.fromEntries(Object.entries(job.frozen).map(([p, content]) => [p, sha256(content)]))
      return {
        async exec(command, timeoutMs, signal) {
          const r = await run(docker, ['exec', id, 'sh', '-c', command], { timeoutMs, signal })
          // A killed `docker exec` leaves its process running, so the container goes with it
          if (r.timedOut || r.aborted) await run(docker, ['kill', id])
          // Nothing a command leaves running outlives it: every process but the container's own sleep is killed
          else await run(docker, ['exec', id, 'sh', '-c', 'kill -9 -1 2>/dev/null; true'], { timeoutMs: 30_000 })
          return r
        },
        async tampered() {
          const r = await run(docker, ['exec', id, 'sha256sum', '--', ...Object.keys(sums)], { timeoutMs: 60_000 })
          if (r.code === 127 || r.code === 126) throw new Error(`The image ${job.image} has no sha256sum, which the runner needs to check the frozen files.`)
          return changedSums(r.stdout, sums)
        },
        async close() {
          await run(docker, ['rm', '-f', id])
        },
      }
    },
  }
}
