import { Fragment } from 'react'
import type { Agent, Module } from '../../shared/api.ts'
import { plural, setPercent, withUnit } from '../view/format.ts'
import { Icon, StateBadge } from './parts.tsx'

function facts(m: Module): string[] {
  const g = m.goal
  // A module that passed or was abandoned early skipped its remaining steps
  const ended = m.status.state === 'passed' || m.status.state === 'abandoned'
  const skipped = ended ? m.steps.filter((x) => !x.done).length : 0
  const out = [`${plural(m.steps.length, 'step')}${skipped ? `, ${skipped} skipped` : ''}`, `${g.metric}, ${setPercent(g.targetGain)} ${g.direction}`]
  if (g.baseline !== null) out.push(`baseline ${withUnit(g.baseline, g.unit)}`)
  if (g.target !== null) out.push(`target ${withUnit(g.target, g.unit)}`)
  return out
}

function Verifiers({ m, agent }: { m: Module; agent: Agent }) {
  const v = m.verifiers
  if (v.kind === 'missing') return <span className="faint">No verifiers</span>
  return (
    <span className="modules__verifiers-text">
      <span className="with-icon">
        <Icon name="lock" className="icon-lock" />
        {v.tests === null ? 'Benchmark' : `${plural(v.tests, 'test')} · benchmark`} on {v.hardware}
      </span>
      {v.from && <span className="faint">Borrowed from {v.from}</span>}
      {v.author === agent.id && <span className="modules__warn">Written by agent {agent.id}</span>}
      {v.openChanges > 0 && <span className="modules__warn">{plural(v.openChanges, 'change request')} open</span>}
    </span>
  )
}

export function ModuleList({ agent }: { agent: Agent }) {
  const p = agent.project
  if (!p) return null
  return (
    <ol className="card modules">
      {p.modules.map((m) => {
        const s = m.status
        return (
          <li key={m.id} className="modules__row" data-current={m.id === p.current || undefined}>
            <span className="modules__pos">{m.position}</span>
            <div className="modules__name">
              <div className="modules__title">
                {m.title} <span className="mono faint">{m.id}</span>
                {m.goal.ambitious && <span className="modules__tag">Ambitious</span>}
              </div>
              <div className="modules__sub">
                {facts(m).map((f, i, all) =>
                  i < all.length - 1 ? (
                    <Fragment key={f}>
                      <span className="modules__fact">{f} ·</span>{' '}
                    </Fragment>
                  ) : (
                    <span key={f} className="modules__fact">
                      {f}
                    </span>
                  ),
                )}
              </div>
              {m.retryOf && <div className="modules__sub">Retries {m.retryOf} with a smaller target</div>}
              {s.state === 'abandoned' && (
                <div className="modules__reason">
                  {s.reason}
                  {s.followUp && ` Follow-up: ${p.modules.find((x) => x.id === s.followUp)?.title ?? s.followUp} (${s.followUp}).`}
                </div>
              )}
            </div>
            <div className="modules__verifiers">
              <Verifiers m={m} agent={agent} />
            </div>
            <div className="modules__state">
              <StateBadge state={s.state} />
            </div>
          </li>
        )
      })}
    </ol>
  )
}
