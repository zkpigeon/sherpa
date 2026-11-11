import { Badge, Collapse, Icon, Roll, Spinner, Stage, States, type Act } from '../kit'
import { AppFrame, reset, type Looped, LOOK } from './shared'
import './plan.css'

// A system story, no cursor. A fresh plan: the verifier agent writes each
// module's verifiers and they freeze, module m1 measures its baseline and goes
// active, then a new approach lands right after it and the positions below
// renumber while every module keeps its ID.

type V = 'none' | 'writing' | 'frozen'
type Mod = { id: string; title: string; steps: number; tests: number }
type S = Looped & { v: Record<string, V>; m1: 'pending' | 'measuring' | 'active'; inserted: boolean }

const PLAN: Mod[] = [
  { id: 'm1', title: 'query cache', steps: 3, tests: 5 },
  { id: 'm2', title: 'index layout', steps: 2, tests: 4 },
  { id: 'm3', title: 'result scoring', steps: 2, tests: 4 },
  { id: 'm4', title: 'response encoding', steps: 2, tests: 3 },
]
const NEW: Mod = { id: 'm5', title: 'early termination', steps: 2, tests: 4 }

const initial: S = { down: false, v: { m1: 'none', m2: 'none', m3: 'none', m4: 'none', m5: 'none' }, m1: 'pending', inserted: false }
const poster: S = { down: false, v: { m1: 'frozen', m2: 'frozen', m3: 'frozen', m4: 'frozen', m5: 'frozen' }, m1: 'active', inserted: true }

async function script(a: Act<S>) {
  const verify = (id: string, to: V) => a.set((s) => ({ v: { ...s.v, [id]: to } }))
  await a.wait(900)
  a.mark('verifiers')
  for (const m of PLAN) {
    await verify(m.id, 'writing')
    await a.wait(160)
  }
  await a.wait(1300)
  for (const m of PLAN) {
    await verify(m.id, 'frozen')
    await a.wait(260)
  }
  await a.wait(700)
  a.mark('baseline')
  await a.set({ m1: 'measuring' })
  await a.wait(1800)
  await a.set({ m1: 'active' })
  await a.wait(1500)
  a.mark('insert')
  await a.set({ inserted: true })
  await a.wait(800)
  await verify('m5', 'writing')
  await a.wait(1400)
  await verify('m5', 'frozen')
  await a.wait(2800)
  await reset(a, initial)
}

function Verifiers({ m, state }: { m: Mod; state: V }) {
  return (
    <States
      align="start"
      className="pl-verifiers"
      value={state}
      states={{
        none: <span className="pl-faint">No verifiers</span>,
        writing: (
          <span className="pl-with-icon">
            <Spinner size={12} />
            Writing verifiers
          </span>
        ),
        frozen: (
          <span className="pl-with-icon">
            <Icon name="lock" filled size={14} className="sh-icon-lock" />
            {m.tests} tests · benchmark
          </span>
        ),
      }}
    />
  )
}

function Row({ m, pos, s }: { m: Mod; pos: number; s: S }) {
  const first = m.id === 'm1'
  const state = first ? s.m1 : 'pending'
  const sub = first && s.m1 === 'active' ? `${m.steps} steps · baseline 371 ms · target 334 ms` : `${m.steps} steps`
  return (
    <div className="pl-row" data-current={first || undefined}>
      <span className="pl-pos">
        <Roll>{String(pos)}</Roll>
      </span>
      <div className="pl-name">
        <div className="pl-title">
          {m.title} <span className="pl-id">{m.id}</span>
        </div>
        <div className="pl-sub">
          <Roll variant="fade">{sub}</Roll>
        </div>
      </div>
      <Verifiers m={m} state={s.v[m.id]} />
      <States
        align="end"
        value={state}
        states={{
          pending: <Badge>Pending</Badge>,
          measuring: (
            <Badge tone="accent" icon={<Spinner size={10} />}>
              Measuring baseline
            </Badge>
          ),
          active: (
            <Badge tone="accent" dot>
              Active
            </Badge>
          ),
        }}
      />
    </div>
  )
}

export function PlanDemo() {
  return (
    <Stage width={960} height={400} compact={{ below: 640, width: 358, height: 480 }} initial={initial} poster={poster} script={script} className="sh-demo pl" {...LOOK}>
      {(s) => {
        const shift = s.inserted ? 1 : 0
        return (
          <AppFrame
            url="sherpa.local/agents/1"
            title="agent 1 · search-perf"
            down={s.down}
            className="pl-frame"
            meta={
              <span className="sh-app__meta">
                <Roll>{`${PLAN.length + shift} modules`}</Roll>
              </span>
            }
          >
            <div className="sh-card pl-list">
              <Row m={PLAN[0]} pos={1} s={s} />
              <Collapse open={s.inserted}>
                <Row m={NEW} pos={2} s={s} />
              </Collapse>
              {PLAN.slice(1).map((m, i) => (
                <Row key={m.id} m={m} pos={i + 2 + shift} s={s} />
              ))}
            </div>
          </AppFrame>
        )
      }}
    </Stage>
  )
}
