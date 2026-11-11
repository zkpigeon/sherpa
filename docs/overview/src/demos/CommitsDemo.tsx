import { Badge, Stage, type Act } from '../kit'
import { AppFrame, reset, type Looped, LOOK } from './shared'
import './commits.css'

// A system story, no cursor. Three attempts on one module's commit line. A win
// moves both markers, a flat attempt moves only the head (its work is kept),
// and a fail moves neither and is reverted.

type Node = { x: number; y: number; attempt: string; commit: string; verdict?: 'win' | 'flat' | 'fail' }

const LINE: Omit<Node, 'x' | 'y'>[] = [
  { attempt: 'start', commit: '9f3c' },
  { attempt: 'a8', commit: '1d2e', verdict: 'win' },
  { attempt: 'a9', commit: '7b40', verdict: 'flat' },
  { attempt: 'a10', commit: 'c5a9', verdict: 'fail' },
]
const place = (xs: number[]): Node[] => LINE.map((n, i) => ({ ...n, x: xs.at(i)!, y: i === 3 ? 150 : 110 }))
const NODES = { wide: place([90, 320, 550, 740]), compact: place([30, 100, 170, 240]) }

type S = Looped & { shown: number; judged: number; head: number; best: number }

const initial: S = { down: false, shown: 0, judged: 0, head: 0, best: 0 }
const poster: S = { down: false, shown: 3, judged: 3, head: 2, best: 1 }

async function script(a: Act<S>) {
  await a.wait(900)
  for (let i = 1; i <= 3; i++) {
    a.mark(`a${i + 7}`)
    await a.set({ shown: i })
    await a.wait(1100)
    await a.set({ judged: i })
    await a.wait(300)
    const v = LINE[i].verdict
    if (v === 'win') await a.set({ head: i, best: i })
    if (v === 'flat') await a.set({ head: i })
    await a.wait(1300)
  }
  await a.wait(1800)
  await reset(a, initial)
}

const TONE = { win: 'success', flat: 'neutral', fail: 'danger' } as const

export function CommitsDemo() {
  return (
    <Stage width={960} height={380} compact={{ below: 640, width: 358, height: 400 }} initial={initial} poster={poster} script={script} className="sh-demo cm" {...LOOK}>
      {(s, _rect, layout) => {
        const NODES_ = NODES[layout]
        const [n2, n3] = [NODES_[2], NODES_[3]]
        const bend = (n3.x - n2.x) / 2
        return (
        <AppFrame url="sherpa.local/agents/1/modules/m5" title="early termination · commits" down={s.down} meta={<span className="sh-app__meta">m5</span>}>
          <div className="sh-card cm-card">
            <div className="cm-line" style={{ left: NODES_[0].x, width: NODES_[Math.min(s.shown, 2)].x - NODES_[0].x }} />
            <svg className="cm-branch" data-on={s.shown >= 3 || undefined} width="100%" height="240" aria-hidden>
              <path d={`M${n2.x} ${n2.y} C ${n2.x + bend} ${n2.y}, ${n3.x - bend} ${n3.y}, ${n3.x} ${n3.y}`} />
            </svg>
            {NODES_.map((n, i) => {
              const on = i <= s.shown
              const judged = i > 0 && i <= s.judged
              return (
                <div key={n.commit} className="cm-node" data-on={on || undefined} data-v={judged ? n.verdict : undefined} style={{ left: n.x, top: n.y }}>
                  <span className="cm-dot" data-busy={on && i > 0 && !judged ? '' : undefined} />
                  <div className="cm-label">
                    <span className="cm-attempt">{n.attempt}</span>
                    <span className="sh-mono cm-commit">{n.commit}</span>
                  </div>
                  {n.verdict && (
                    <div className="cm-verdict" data-on={judged || undefined}>
                      <Badge tone={TONE[n.verdict]} dot>
                        {n.verdict === 'fail' ? 'fail · reverted' : n.verdict}
                      </Badge>
                    </div>
                  )}
                </div>
              )
            })}
            <div className="cm-pin cm-pin--best" style={{ left: NODES_[s.best].x }}>
              best
            </div>
            <div className="cm-pin cm-pin--head" style={{ left: NODES_[s.head].x }}>
              head
            </div>
          </div>
        </AppFrame>
        )
      }}
    </Stage>
  )
}
