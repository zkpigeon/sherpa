import type { ReactNode } from 'react'
import { Collapse, Count, Icon, Spinner, Stage, States, type Act } from '../kit'
import { AppFrame, reset, type Looped, LOOK } from './shared'
import './goal.css'

// A system story, no cursor. The agent asks for a 30% gain and the server
// refuses it at the 20% cap; it asks again for 10% and the goal is set. The
// target only becomes a number once the runner has measured the baseline.

type S = Looped & { tries: number; baseline: 'none' | 'measuring' | 'done' }

const initial: S = { down: false, tries: 0, baseline: 'none' }
const poster: S = { down: false, tries: 2, baseline: 'done' }

async function script(a: Act<S>) {
  await a.wait(900)
  a.mark('rejected')
  await a.set({ tries: 1 })
  await a.wait(1900)
  await a.set({ tries: 2 })
  await a.wait(1300)
  a.mark('baseline')
  await a.set({ baseline: 'measuring' })
  await a.wait(1900)
  await a.set({ baseline: 'done' })
  await a.wait(3000)
  await reset(a, initial)
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="gl-field">
      <span className="sh-card__label">{label}</span>
      <span className="gl-value">{children}</span>
    </div>
  )
}

export function GoalDemo() {
  return (
    <Stage width={960} height={340} compact={{ below: 640, width: 358, height: 560 }} initial={initial} poster={poster} script={script} className="sh-demo gl" {...LOOK}>
      {(s) => (
        <AppFrame url="sherpa.local/agents/1/modules/m5" title="early termination · goal" down={s.down} meta={<span className="sh-app__meta">m5</span>}>
          <div className="gl-grid">
            <div className="sh-card gl-goal">
              <Field label="Metric">p95 latency, lower is better</Field>
              <Field label="Target gain">
                <States
                  align="start"
                  value={s.tries >= 2 ? 'ok' : s.tries === 1 ? 'over' : 'none'}
                  states={{
                    none: <span className="gl-faint">Not set</span>,
                    over: <span className="gl-over">30%, over the 20% cap</span>,
                    ok: '10%',
                  }}
                />
              </Field>
              <Field label="Minimum gain">2%</Field>
              <Field label="Baseline">
                <States
                  align="start"
                  value={s.baseline}
                  states={{
                    none: <span className="gl-faint">Measured when the module starts</span>,
                    measuring: (
                      <span className="gl-with-icon">
                        <Spinner size={12} />
                        Measuring 5 runs
                      </span>
                    ),
                    done: <Count value={371} format={(n) => `${Math.round(n)} ms`} />,
                  }}
                />
              </Field>
              <Field label="Target">
                <States
                  align="start"
                  value={s.baseline === 'done' ? 'set' : 'none'}
                  states={{
                    none: <span className="gl-faint">Baseline minus 10%</span>,
                    set: '334 ms',
                  }}
                />
              </Field>
            </div>

            <div className="sh-card gl-log">
              <div className="sh-card__label">Requests</div>
              <Collapse open={s.tries >= 1} reveal="drop">
                <div className="gl-req" data-v="no">
                  <span className="sh-mono">targetGain 30</span>
                  <span className="gl-req__result">422 · over the 20% cap</span>
                </div>
              </Collapse>
              <Collapse open={s.tries >= 2} reveal="drop">
                <div className="gl-req" data-v="ok">
                  <span className="sh-mono">targetGain 10</span>
                  <span className="gl-req__result gl-with-icon">
                    <Icon name="check" filled size={14} className="sh-icon-ok" />
                    201 · goal set
                  </span>
                </div>
              </Collapse>
            </div>
          </div>
        </AppFrame>
      )}
    </Stage>
  )
}
