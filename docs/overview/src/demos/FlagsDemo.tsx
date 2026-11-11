import { Badge, Collapse, Icon, Stage, type Act } from '../kit'
import { AppFrame, reset, type Looped, LOOK } from './shared'
import './flags.css'

// A system story, no cursor. The runner's report for attempt a11 lists the
// files its commit touched. One is a frozen benchmark file, so the frozen copy
// was used anyway, and the dashboard raises a flag for you to look at.

type S = Looped & { files: number; marked: boolean; flagged: boolean }

const FILES = [
  { path: 'src/search/terms.ts', change: '+18 −4', verifier: false },
  { path: 'bench/latency.ts', change: '+2 −2', verifier: true },
]

const initial: S = { down: false, files: 1, marked: false, flagged: false }
const poster: S = { down: false, files: 2, marked: true, flagged: true }

async function script(a: Act<S>) {
  await a.wait(1100)
  await a.set({ files: 2 })
  await a.wait(1000)
  a.mark('marked')
  await a.set({ marked: true })
  await a.wait(1100)
  a.mark('flag')
  await a.set({ flagged: true })
  await a.wait(3200)
  await reset(a, initial)
}

export function FlagsDemo() {
  return (
    <Stage width={960} height={330} compact={{ below: 640, width: 358, height: 520 }} initial={initial} poster={poster} script={script} className="sh-demo fl" {...LOOK}>
      {(s) => (
        <AppFrame url="sherpa.local/agents/1" title="agent 1 · attempt a11" down={s.down} meta={<span className="sh-app__meta">early termination · step 2</span>}>
          <div className="fl-grid">
            <div className="sh-card fl-files">
              <div className="sh-card__label">Files the commit changed</div>
              {FILES.map((f, i) => (
                <Collapse key={f.path} open={s.files > i}>
                  <div className="fl-file">
                    <span className="sh-mono fl-path">{f.path}</span>
                    <span className="sh-mono fl-change">{f.change}</span>
                    {f.verifier && (
                      <span className="fl-tag" data-on={s.marked || undefined}>
                        <Icon name="lock" filled size={14} className="sh-icon-lock" />
                        Frozen verifier, frozen copy used
                      </span>
                    )}
                  </div>
                </Collapse>
              ))}
              <div className="fl-verdict">
                <span className="sh-card__label">Verdict</span>
                <Badge dot>Flat</Badge>
              </div>
            </div>
            <div className="sh-card fl-flags">
              <div className="sh-card__label">Flags</div>
              <Collapse open={s.flagged} reveal="drop">
                <div className="fl-flag">
                  <div className="fl-flag__title">a11 touched a verifier file</div>
                  <div className="fl-flag__body">bench/latency.ts changed. The runner used the frozen copy.</div>
                </div>
              </Collapse>
              <Collapse open={!s.flagged}>
                <div className="fl-none">No flags</div>
              </Collapse>
            </div>
          </div>
        </AppFrame>
      )}
    </Stage>
  )
}
