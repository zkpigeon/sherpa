import { Badge, Stage, type Act } from '../kit'
import { AgentTile, FillerTile, type Tile } from '../AgentTile'
import { AppFrame, reset, type Looped, LOOK } from './shared'
import './board.css'

// A system story, no cursor. Agent 1's attempt a10 is with the runner. The
// verdict lands on its tile in order: the win, the new best, the streak, the
// module going past its target, then the first extension moving the deadline.

type S = Looped & { a1: Tile }

const BASE: Omit<Tile, 'agent' | 'project' | 'module' | 'blurb' | 'steps' | 'metric' | 'attempts'> = {
  state: 'active',
  streak: 0,
  job: null,
  minutesLeft: 52,
  maxMinutes: 90,
  timeNote: '',
  flag: null,
}

const A1: Tile = {
  ...BASE,
  agent: 'agent 1',
  project: 'search-perf',
  module: { n: 3, total: 5, title: 'early termination' },
  blurb: 'Skipping low-impact query terms.',
  steps: { total: 3, done: 1 },
  metric: { name: 'p95 latency', unit: 'ms', best: 352, target: 334 },
  attempts: ['win'],
  streak: 1,
  minutesLeft: 18,
}

const A2: Tile = {
  ...BASE,
  agent: 'agent 2',
  project: 'ingest-rate',
  module: { n: 2, total: 3, title: 'parse pool' },
  blurb: 'Parsing on 8 worker threads.',
  steps: { total: 2, done: 1 },
  metric: { name: 'throughput', unit: 'docs/s', best: 2140, target: 2250 },
  attempts: ['win', 'flat', 'flat'],
  job: { label: 'b7 · verifying', busy: true },
}

const A3: Tile = {
  ...BASE,
  agent: 'agent 3',
  project: 'test-speed',
  module: { n: 2, total: 2, title: 'fixture reuse' },
  state: 'stuck',
  blurb: 'Waiting for an abandon reason.',
  steps: { total: 2, done: 1, failed: 2 },
  metric: { name: 'suite time', unit: 's', best: 541, target: 500 },
  attempts: ['win', 'fail', 'fail', 'fail'],
  minutesLeft: null,
  timeNote: 'Clock stopped',
}

const WON: Tile = {
  ...A1,
  state: 'pastTarget',
  metric: { ...A1.metric, best: 331 },
  attempts: ['win', 'win'],
  streak: 2,
  job: { label: 'a10 · win, 5.7% faster', busy: false, verdict: 'win' },
  minutesLeft: 63,
}

const initial: S = { down: false, a1: A1 }
const poster: S = { down: false, a1: WON }

async function script(a: Act<S>) {
  const step = (patch: Partial<Tile>) => a.set((s) => ({ a1: { ...s.a1, ...patch } }))
  await a.wait(1100)
  a.mark('verifying')
  await step({ job: { label: 'a10 · verifying', busy: true } })
  await a.wait(2300)
  a.mark('verdict')
  await step({ job: WON.job, attempts: WON.attempts })
  await a.wait(350)
  await step({ metric: WON.metric })
  await a.wait(900)
  await step({ streak: WON.streak })
  await a.wait(500)
  await step({ state: WON.state })
  await a.wait(700)
  await step({ minutesLeft: WON.minutesLeft })
  await a.wait(2800)
  await reset(a, initial)
}

export function BoardDemo() {
  return (
    <Stage width={960} height={520} compact={{ below: 640, width: 358, height: 520 }} initial={initial} poster={poster} script={script} className="sh-demo bd" {...LOOK}>
      {(s) => (
        <AppFrame
          url="sherpa.local"
          title="Board"
          down={false}
          className="bd-frame"
          meta={
            <>
              <span className="sh-app__meta">6 agents</span>
              <Badge tone="success" dot className="sh-app__end">
                Live
              </Badge>
            </>
          }
        >
          <div className="bd-grid">
            {/* Only the tile the story changed hides for the reset */}
            <div className="bd-focus" data-down={s.down || undefined}>
              <AgentTile t={s.a1} target="a1" />
            </div>
            <AgentTile t={A2} className="bd-wide-only" />
            <AgentTile t={A3} />
            <FillerTile />
            <FillerTile />
            <FillerTile />
          </div>
        </AppFrame>
      )}
    </Stage>
  )
}
