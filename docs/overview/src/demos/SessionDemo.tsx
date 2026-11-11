import { Stage, Window, type Act } from '../kit'
import { AgentTile, type Tile } from '../AgentTile'
import { TermLines, type Looped, LOOK } from './shared'
import './session.css'

// A system story, no cursor. The terminal is agent 1's side: the hook's board
// line, then its calls and the server's replies. The tile is what the
// dashboard shows for the same agent, and it changes only after the reply that
// causes it: stuck, a module added, then the next module waiting to start.

const LINES = [
  { text: '→ POST /agents/1/modules/m2/attempts  a7 · commit 3c1d', kind: 'dim' as const },
  { text: '← fail · tests failed · step 2: 2 of 3 failed turns', kind: 'dim' as const },
  { text: ' ' },
  { text: '[sherpa] agent 1: Project: search-perf, Module (2 / 4): index layout,', kind: 'hook' as const },
  { text: '       Progress: 1 / 2, Blurb: Block-compressing postings. 41 min left.', kind: 'hook' as const },
  { text: '→ POST /agents/1/modules/m2/attempts  a8 · commit 8e2a' },
  { text: '← fail · slower than the best, p = 0.004 · m2 is stuck', kind: 'err' as const },
  { text: ' ' },
  { text: '→ POST /agents/1/modules  "early termination" · 2 steps · 10% lower' },
  { text: '→ POST /agents/1/modules/m2/abandon' },
  { text: '  reason: "Every attempt assumed index reads drive p95."' },
  { text: '← m2 abandoned · m5 is next and waits for its verifiers', kind: 'ok' as const },
]

type S = Looped & { n: number; tile: Tile }

const START: Tile = {
  agent: 'agent 1',
  project: 'search-perf',
  module: { n: 2, total: 4, title: 'index layout' },
  state: 'active',
  blurb: 'Block-compressing postings.',
  steps: { total: 2, done: 1 },
  metric: { name: 'p95 latency', unit: 'ms', best: 371, target: 334 },
  attempts: ['flat', 'flat', 'fail', 'fail'],
  streak: 0,
  job: null,
  minutesLeft: 41,
  maxMinutes: 90,
  timeNote: '',
  flag: null,
}

const NEXT: Tile = {
  ...START,
  module: { n: 3, total: 5, title: 'early termination' },
  state: 'pending',
  blurb: '',
  steps: { total: 2, done: 0 },
  metric: { ...START.metric, target: null },
  attempts: [],
  minutesLeft: null,
  timeNote: 'Waiting for its baseline',
}

const initial: S = { down: false, n: 5, tile: START }
const poster: S = { down: false, n: LINES.length, tile: NEXT }

async function script(a: Act<S>) {
  const tile = (patch: Partial<Tile>) => a.set((s) => ({ tile: { ...s.tile, ...patch } }))
  await a.wait(1200)
  a.mark('attempt')
  await a.set({ n: 6 })
  await a.wait(300)
  await tile({ job: { label: 'a8 · verifying', busy: true } })
  await a.wait(1800)
  await a.set({ n: 7 })
  await a.wait(300)
  await tile({ job: { label: 'a8 · fail', busy: false, verdict: 'fail' }, attempts: [...START.attempts, 'fail'] })
  await a.wait(450)
  await tile({ state: 'stuck', blurb: 'Waiting for an abandon reason.', steps: { total: 2, done: 1, failed: 2 }, minutesLeft: null, timeNote: 'Clock stopped' })
  await a.wait(2000)
  a.mark('add')
  await a.set({ n: 9 })
  await a.wait(450)
  await tile({ module: { ...START.module, total: 5 } })
  await a.wait(1300)
  await a.set({ n: 10 })
  await a.wait(250)
  await a.set({ n: 11 })
  await a.wait(1300)
  a.mark('next')
  await a.set({ n: 12 })
  await a.wait(450)
  await a.set({ tile: NEXT })
  await a.wait(3000)
  // The lines this loop added leave together while the tile hides, then the
  // tile snaps back to module m2 out of sight
  await a.set({ n: initial.n, down: true })
  await a.wait(450)
  await a.snap({ tile: START })
  await a.wait(150)
  await a.set({ down: false })
  await a.wait(700)
}

export function SessionDemo() {
  return (
    <Stage width={960} height={420} compact={{ below: 640, width: 358, height: 600 }} initial={initial} poster={poster} script={script} className="sh-demo sd" {...LOOK}>
      {(s) => (
        <>
          <Window chrome="terminal" title="agent 1 — search-perf" className="sd-term">
            <div className="sd-lines">
              <TermLines lines={LINES} n={s.n} />
            </div>
          </Window>
          <div className="sd-tile-wrap" data-down={s.down || undefined}>
            <AgentTile t={s.tile} className="sd-tile" />
          </div>
        </>
      )}
    </Stage>
  )
}
