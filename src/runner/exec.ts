// Where a job's commands run. The Docker executor gives each commit its own
// bare container: the checkout copied in, no network, no environment from
// the runner (so no tokens), and no Docker socket. The local executor runs
// commands on the runner's own machine, for tests and trusted setups only:
// it doesn't isolate anything, or stop processes a command leaves running.
import { run, must, type Exit } from './proc.ts'

export interface Box {
  /** Runs a shell command in the checkout. */
  exec(command: string, timeoutMs: number, signal?: AbortSignal): Promise<Exit>
  close(): Promise<void>
}

export interface Executor {
  open(dir: string, job: { image: string; hardware: string; job: string }): Promise<Box>
  /** Removes containers a runner of this name left behind, such as after a crash. */
  sweep?(): Promise<number>
}

export const localExecutor: Executor = {
  async open(dir) {
    return {
      exec: (command, timeoutMs, signal) => run('sh', ['-c', command], { cwd: dir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir }, timeoutMs, signal }),
      async close() {},
    }
  },
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
      return {
        async exec(command, timeoutMs, signal) {
          const r = await run(docker, ['exec', id, 'sh', '-c', command], { timeoutMs, signal })
          // A killed `docker exec` leaves its process running, so the container goes with it
          if (r.timedOut || r.aborted) await run(docker, ['kill', id])
          // Nothing a command leaves running outlives it: every process but the container's own sleep is killed
          else await run(docker, ['exec', id, 'sh', '-c', 'kill -9 -1 2>/dev/null; true'], { timeoutMs: 30_000 })
          return r
        },
        async close() {
          await run(docker, ['rm', '-f', id])
        },
      }
    },
  }
}
