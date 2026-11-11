import { Badge, Icon, Spinner, Stage, States, type Act } from '../kit'
import { AppFrame, reset, type Looped, LOOK } from './shared'
import './job.css'

// A system story, no cursor. One runner job for attempt a10: the frozen
// verifiers are copied over both checkouts, the tests pass, the benchmark
// alternates between the best commit and the new one, and the verdict comes
// from the medians and the rank test, never from a number the agent sent.

const BEST = [352, 349, 351, 350, 353]
const NEW = [331, 329, 333, 330, 332]

type S = Looped & { tests: boolean; runs: number; medians: boolean; gain: boolean; rank: boolean; verdict: boolean }

const initial: S = { down: false, tests: false, runs: 0, medians: false, gain: false, rank: false, verdict: false }
const poster: S = { down: false, tests: true, runs: 10, medians: true, gain: true, rank: true, verdict: true }

async function script(a: Act<S>) {
  await a.wait(1000)
  await a.set({ tests: true })
  await a.wait(700)
  a.mark('runs')
  for (let n = 1; n <= 10; n++) {
    await a.set({ runs: n })
    await a.wait(320)
  }
  await a.wait(400)
  await a.set({ medians: true })
  await a.wait(700)
  await a.set({ gain: true })
  await a.wait(600)
  await a.set({ rank: true })
  await a.wait(600)
  a.mark('verdict')
  await a.set({ verdict: true })
  await a.wait(3000)
  await reset(a, initial)
}

function Cell({ on, children }: { on: boolean; children: string }) {
  return (
    <span className="jb-cell" data-on={on || undefined}>
      {children}
    </span>
  )
}

function Check({ on, label, value }: { on: boolean; label: string; value: string }) {
  return (
    <div className="jb-check" data-on={on || undefined}>
      <span className="sh-card__label">{label}</span>
      <span className="jb-check__value">{value}</span>
    </div>
  )
}

export function JobDemo() {
  return (
    <Stage width={960} height={350} compact={{ below: 640, width: 358, height: 520 }} initial={initial} poster={poster} script={script} className="sh-demo jb" {...LOOK}>
      {(s) => (
        <AppFrame
          url="sherpa.local/jobs/7f3a"
          title="Attempt a10"
          down={s.down}
          meta={
            <>
              <span className="sh-app__meta">agent 1 · early termination · step 2</span>
              <States
                align="end"
                className="sh-app__end"
                value={s.verdict ? 'judged' : 'running'}
                states={{
                  running: (
                    <Badge tone="accent" icon={<Spinner size={10} />}>
                      Running on runner-1
                    </Badge>
                  ),
                  judged: <Badge dot>Judged</Badge>,
                }}
              />
            </>
          }
        >
          <div className="jb-grid">
            <div className="sh-card jb-side">
              <div className="sh-card__label">Checkouts</div>
              <div className="jb-commit">
                <span className="sh-mono">9f3c</span>
                <span className="jb-faint">best commit</span>
              </div>
              <div className="jb-commit">
                <span className="sh-mono">a10e</span>
                <span className="jb-faint">new commit</span>
              </div>
              <div className="jb-rule" />
              <div className="jb-line">
                <Icon name="lock" filled size={14} className="sh-icon-lock" />
                Frozen verifiers <span className="sh-mono">7c1e</span> copied over both
              </div>
              <div className="jb-line">
                <States
                  align="start"
                  value={s.tests ? 'passed' : 'running'}
                  states={{
                    running: (
                      <span className="jb-with-icon">
                        <Spinner size={12} />
                        Running 42 tests
                      </span>
                    ),
                    passed: (
                      <span className="jb-with-icon">
                        <Icon name="check" filled size={14} className="sh-icon-ok" />
                        42 tests passed
                      </span>
                    ),
                  }}
                />
              </div>
            </div>

            <div className="sh-card jb-runs">
              <div className="jb-table">
                <span className="sh-card__label">Run</span>
                <span className="sh-card__label jb-num">Best 9f3c</span>
                <span className="sh-card__label jb-num">New a10e</span>
                {BEST.map((b, i) => (
                  <div key={i} className="jb-tr">
                    <span className="jb-faint">{i + 1}</span>
                    <Cell on={s.runs > i * 2}>{`${b} ms`}</Cell>
                    <Cell on={s.runs > i * 2 + 1}>{`${NEW[i]} ms`}</Cell>
                  </div>
                ))}
                <div className="jb-tr jb-median" data-on={s.medians || undefined}>
                  <span>Median</span>
                  <span className="jb-num">351 ms</span>
                  <span className="jb-num">331 ms</span>
                </div>
              </div>
              <div className="jb-checks">
                <Check on={s.gain} label="Gain" value="5.7% faster, needs 2%" />
                <Check on={s.rank} label="Rank test" value="p = 0.004, needs below 0.05" />
                <div className="jb-check" data-on={s.verdict || undefined}>
                  <span className="sh-card__label">Verdict</span>
                  <Badge tone="success" dot>
                    Win
                  </Badge>
                </div>
              </div>
            </div>
          </div>
        </AppFrame>
      )}
    </Stage>
  )
}
