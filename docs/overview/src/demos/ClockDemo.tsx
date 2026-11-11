import { Badge, Count, Roll, Stage, States, type Act } from '../kit'
import { AppFrame, LOOK } from './shared'
import './clock.css'

// A system story in two scenes, no cursor. First a module that stays flat: its
// clock runs, a runner wait pushes the deadline out, the grace period passes
// with no attempt, and it gets stuck on time. Then a module that keeps
// winning: each win after the first streak buys a smaller extension. The scene
// change is the loop's reset; each scene snaps back while the other shows.

type Dot = { at: number; v: 'win' | 'flat' | 'step' }
type Ext = { from: number; to: number; label: string }
type Scene = {
  now: number
  deadline: number
  waits: [number, number][]
  exts: Ext[]
  dots: Dot[]
  grace: boolean
  state: 'active' | 'stuck' | 'pastTarget'
  note: string
}
type S = { scene: 0 | 1; q: Scene; w: Scene }

const FRESH: Scene = { now: 0, deadline: 90, waits: [], exts: [], dots: [], grace: false, state: 'active', note: 'Clock running' }
const initial: S = { scene: 0, q: FRESH, w: FRESH }
const poster: S = {
  scene: 1,
  q: FRESH,
  w: {
    now: 76,
    deadline: 168.75,
    waits: [],
    exts: [
      { from: 90, to: 135, label: '+45' },
      { from: 135, to: 157.5, label: '+23' },
      { from: 157.5, to: 168.75, label: '+11' },
    ],
    dots: [
      { at: 20, v: 'win' },
      { at: 32, v: 'win' },
      { at: 50, v: 'step' },
      { at: 70, v: 'win' },
    ],
    grace: false,
    state: 'pastTarget',
    note: '3 wins in a row',
  },
}

const SPAN = 180
// 10% of the 90-minute limit
const GRACE = 9
const GEO = { wide: { left: 24, width: 776 }, compact: { left: 18, width: 262 } }
const TICKS = Array.from({ length: 7 }, (_, i) => i * 30)

async function quiet(a: Act<S>) {
  const q = (patch: Partial<Scene> | ((s: Scene) => Partial<Scene>)) => a.set((s) => ({ q: { ...s.q, ...(typeof patch === 'function' ? patch(s.q) : patch) } }))
  const flat = (at: number) => q((s) => ({ dots: [...s.dots, { at, v: 'flat' }] }))
  await q({ now: 15 })
  await a.wait(1100)
  await flat(15)
  await q({ now: 36 })
  await a.wait(1100)
  await flat(36)
  await a.wait(300)
  a.mark('wait')
  await q({ now: 52, waits: [[40, 52]], deadline: 102, note: 'Runner wait doesn’t count' })
  await a.wait(1400)
  await q({ now: 62 })
  await a.wait(900)
  await flat(62)
  await q({ now: 88, note: 'Clock running' })
  await a.wait(1100)
  await flat(88)
  await q({ now: 102 })
  await a.wait(1100)
  a.mark('grace')
  await q({ grace: true, note: 'Time up · 1 attempt left' })
  await a.wait(900)
  await q({ now: 102 + GRACE })
  await a.wait(1100)
  await q({ state: 'stuck', note: 'Stuck · ran out of time' })
}

async function winning(a: Act<S>) {
  const w = (patch: Partial<Scene> | ((s: Scene) => Partial<Scene>)) => a.set((s) => ({ w: { ...s.w, ...(typeof patch === 'function' ? patch(s.w) : patch) } }))
  const win = (at: number) => w((s) => ({ dots: [...s.dots, { at, v: 'win' }] }))
  const extend = (ext: Ext, note: string) => w((s) => ({ exts: [...s.exts, ext], deadline: ext.to, note }))
  await w({ now: 20 })
  await a.wait(1100)
  await win(20)
  await w({ now: 32 })
  await a.wait(900)
  await win(32)
  await a.wait(400)
  a.mark('streak')
  await extend(poster.w.exts[0], '2 wins in a row · target met')
  await w({ state: 'pastTarget' })
  await a.wait(1300)
  await w({ now: 50 })
  await a.wait(1000)
  a.mark('step')
  await w((s) => ({ dots: [...s.dots, { at: 50, v: 'step' }] }))
  await a.wait(300)
  await extend(poster.w.exts[1], 'Step 1 done, metric held')
  await a.wait(1400)
  await w({ now: 70 })
  await a.wait(1000)
  await win(70)
  await a.wait(300)
  await extend(poster.w.exts[2], '3 wins in a row')
  await w({ now: 76 })
}

async function script(a: Act<S>) {
  await a.wait(700)
  await quiet(a)
  await a.wait(2600)
  await a.set({ scene: 1 })
  await a.wait(700)
  await a.snap({ q: FRESH })
  await winning(a)
  await a.wait(2800)
  await a.set({ scene: 0 })
  await a.wait(700)
  await a.snap({ w: FRESH })
  await a.wait(300)
}

const BADGE = {
  active: (
    <Badge tone="accent" dot>
      Active
    </Badge>
  ),
  stuck: (
    <Badge tone="danger" dot>
      Stuck
    </Badge>
  ),
  pastTarget: (
    <Badge tone="success" dot>
      Past target
    </Badge>
  ),
}

function Timeline({ title, sc, on, geo }: { title: string; sc: Scene; on: boolean; geo: { left: number; width: number } }) {
  const LEFT = geo.left
  const WIDTH = geo.width
  const x = (min: number) => LEFT + (min / SPAN) * WIDTH
  return (
    <div className="sh-card ck-card" data-on={on || undefined} aria-hidden={!on || undefined}>
      <div className="ck-head">
        <span className="ck-title">{title}</span>
        <States align="start" value={sc.state} states={BADGE} />
        <span className="ck-note">
          <Roll variant="fade">{sc.note}</Roll>
        </span>
      </div>
      <div className="ck-plot">
        <div className="ck-track" style={{ left: LEFT, width: WIDTH }} />
        <div className="ck-elapsed" style={{ left: LEFT, width: x(sc.now) - LEFT }} />
        {sc.waits.map(([from, to]) => (
          <div key={from} className="ck-wait" style={{ left: x(from), width: x(to) - x(from) }} />
        ))}
        {sc.waits.map(([from, to]) => (
          <span key={from} className="ck-under" style={{ left: (x(from) + x(to)) / 2 }}>
            runner wait
          </span>
        ))}
        {sc.exts.map((e) => (
          <div key={e.from} className="ck-ext" style={{ left: x(e.from), width: x(e.to) - x(e.from) }} />
        ))}
        {sc.exts.map((e) => (
          <span key={e.from} className="ck-ext-label" style={{ left: (x(e.from) + x(e.to)) / 2 }}>
            {e.label}
          </span>
        ))}
        <div className="ck-grace" data-on={sc.grace || undefined} style={{ left: x(sc.deadline), width: x(sc.deadline + GRACE) - x(sc.deadline) }} />
        <span className="ck-under ck-under--grace" data-on={sc.grace || undefined} style={{ left: (x(sc.deadline) + x(sc.deadline + GRACE)) / 2 }}>
          grace
        </span>
        <div className="ck-deadline" style={{ left: x(sc.deadline) }}>
          <span className="ck-deadline__label" data-end={sc.deadline >= 150 || undefined}>
            deadline <Count value={sc.deadline} duration={700} format={(n) => `${Math.round(n)} min`} />
          </span>
        </div>
        {sc.dots.map((d) => (
          <span key={d.at} className="ck-dot" data-v={d.v} style={{ left: x(d.at) }} />
        ))}
        {TICKS.map((t) => (
          <span key={t} className="ck-tick" style={{ left: x(t) }}>
            {t}
          </span>
        ))}
      </div>
    </div>
  )
}

export function ClockDemo() {
  return (
    <Stage width={960} height={400} compact={{ below: 640, width: 358, height: 420 }} initial={initial} poster={poster} script={script} className="sh-demo ck" {...LOOK}>
      {(s, _rect, layout) => (
        <AppFrame url="sherpa.local/agents/1" title="agent 1 · module clock" down={false} meta={<span className="sh-app__meta">minutes since the module became active</span>}>
          <div className="ck-stack">
            <Timeline title="index layout" sc={s.q} on={s.scene === 0} geo={GEO[layout]} />
            <Timeline title="early termination" sc={s.w} on={s.scene === 1} geo={GEO[layout]} />
          </div>
        </AppFrame>
      )}
    </Stage>
  )
}
