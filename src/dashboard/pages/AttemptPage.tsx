import { useRef } from 'react'
import type { AgentId, AttemptDetail, AttemptId, Module, ModuleId, Run } from '../../shared/api.ts'
import { FlagList } from '../components/ModulePanel.tsx'
import { PageHead } from '../components/PageHead.tsx'
import { Badge, Icon, Spinner, VerdictDot } from '../components/parts.tsx'
import { useAttemptDetail, useBoard } from '../data/hooks.tsx'
import { JOB, VERDICT, figure, gainWords, pWords, plural, short, withUnit } from '../view/format.ts'
import { agentPath } from '../view/routes.ts'
import { NotFound } from './NotFound.tsx'
import './attempt.css'

function JobBadge({ d }: { d: AttemptDetail }) {
  const job = d.attempt.job
  if (job === 'running')
    return (
      <Badge tone="accent" icon={<Spinner size={10} />}>
        Running on {d.runner ?? 'a runner'}
      </Badge>
    )
  if (job === 'queued') return <Badge>Queued for a runner</Badge>
  if (!d.attempt.verdict) return <Badge>{JOB[job]}</Badge>
  return <Badge dot>Judged</Badge>
}

function Tests({ d }: { d: AttemptDetail }) {
  const t = d.tests
  if (!t) {
    if (d.attempt.job === 'running')
      return (
        <span className="with-icon">
          <Spinner size={12} />
          Running the tests
        </span>
      )
    return <span className="faint">{d.attempt.job === 'queued' ? 'Waiting for a runner' : 'No test results'}</span>
  }
  if (t.passed === t.total)
    return (
      <span className="with-icon">
        <Icon name="check" className="icon-ok" />
        {plural(t.total, 'test')} passed
      </span>
    )
  return (
    <span className="with-icon at__bad">
      <VerdictDot verdict="fail" />
      {t.passed} of {plural(t.total, 'test')} passed
    </span>
  )
}

function workWords(best: Run[], next: Run[]) {
  const span = (runs: Run[]) => {
    const w = runs.map((r) => r.work)
    const [lo, hi] = [Math.min(...w), Math.max(...w)]
    return lo === hi ? figure(lo) : `${figure(lo)} to ${figure(hi)}`
  }
  const [b, n] = [span(best), span(next)]
  return { text: b === n ? `${b} per run on both` : `${b} best, ${n} new`, short: Math.min(...next.map((r) => r.work)) < Math.min(...best.map((r) => r.work)) }
}

function Runs({ d, m }: { d: AttemptDetail; m: Module }) {
  // Runs that land while the page is open fill in row by row, as the Job demo does
  const arriving = useRef(d.runs.length === 0)
  const best = d.runs.filter((r) => r.commit === d.bestCommit)
  const next = d.runs.filter((r) => r.commit === d.attempt.commit)
  const unit = m.goal.unit
  const verdict = d.attempt.verdict
  const work = d.runs.length ? workWords(best, next) : null
  const empty =
    d.attempt.job === 'running'
      ? `The runs arrive when ${d.runner ?? 'the runner'} finishes the job.`
      : d.attempt.job === 'queued'
        ? 'The job is waiting for a runner.'
        : d.tests && d.tests.passed < d.tests.total
          ? 'No benchmark runs: the tests failed first.'
          : 'The job ended without benchmark runs.'
  return (
    <div className="card at__runs">
      {d.runs.length === 0 ? (
        <p className="empty at__no-runs">{empty}</p>
      ) : (
        <table className="runs" data-arriving={arriving.current || undefined}>
          <caption className="visually-hidden">Benchmark runs, alternating between the best commit and the new one</caption>
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col" className="num">
                Best <span className="mono">{short(d.bestCommit)}</span>
              </th>
              <th scope="col" className="num">
                New <span className="mono">{short(d.attempt.commit)}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {best.map((b, i) => (
              <tr key={i} style={{ animationDelay: `${i * 90}ms` }}>
                <td className="faint">{i + 1}</td>
                <td className="num">{withUnit(b.value, unit)}</td>
                <td className="num">{next[i] ? withUnit(next[i].value, unit) : '–'}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ animationDelay: `${best.length * 90}ms` }}>
              <th scope="row">Median</th>
              <td className="num">{d.bestMedian === null ? '–' : withUnit(d.bestMedian, unit)}</td>
              <td className="num">{d.attempt.median === null ? '–' : withUnit(d.attempt.median, unit)}</td>
            </tr>
          </tfoot>
        </table>
      )}
      <dl className="at__checks" data-arriving={arriving.current || undefined}>
        {d.gain !== null && (
          <div className="at__check">
            <dt className="card__label">Gain</dt>
            <dd>{gainWords(d.gain, m.goal.minGain, m.goal.direction)}</dd>
          </div>
        )}
        {d.p !== null && d.gain !== null && (
          <div className="at__check">
            <dt className="card__label">Rank test</dt>
            <dd>{pWords(d.p, d.gain)}</dd>
          </div>
        )}
        {work && (
          <div className="at__check">
            <dt className="card__label">Work per run</dt>
            <dd className={work.short ? 'at__warn' : undefined}>{work.text}</dd>
          </div>
        )}
        <div className="at__check">
          <dt className="card__label">Verdict</dt>
          <dd>
            {verdict ? (
              <Badge tone={VERDICT[verdict].tone} dot>
                {VERDICT[verdict].label}
              </Badge>
            ) : (
              <span className="faint">Not judged yet</span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  )
}

export function AttemptPage({ agent, module, attempt }: { agent: AgentId; module: ModuleId; attempt: AttemptId }) {
  const board = useBoard()
  const d = useAttemptDetail(agent, module, attempt)
  const a = board.agents.find((x) => x.id === agent)
  const m = a?.project?.modules.find((x) => x.id === module)
  if (!a || !m || !m.attempts.some((y) => y.id === attempt)) return <NotFound what={`attempt ${attempt} in agent ${agent}’s ${module}`} />
  if (!d) return <p className="empty">Loading attempt {attempt}…</p>
  const x = d.attempt
  const flags = m.flags.filter((f) => f.attempt === x.id)
  return (
    <div className="at-page">
      <PageHead
        title={`Attempt ${x.id}`}
        docTitle={`Attempt ${x.id}`}
        crumbs={[
          { href: '/', label: 'Board' },
          { href: agentPath(a.id), label: `agent ${a.id}` },
        ]}
        meta={
          <span className="page-head__meta">
            {m.title} · step {x.step}
          </span>
        }
        end={<JobBadge d={d} />}
      />
      <div className="page-body at">
        <div className="card at__side">
          <h2 className="card__label">Checkouts</h2>
          <div className="at__commit">
            <span className="mono">{short(d.bestCommit)}</span>
            <span className="faint">best commit</span>
          </div>
          <div className="at__commit">
            <span className="mono">{short(x.commit)}</span>
            <span className="faint">new commit</span>
          </div>
          <div className="at__rule" />
          <div className="at__line">
            <Icon name="lock" className="icon-lock" />
            <span>
              Frozen verifiers <span className="mono">{short(d.verifierHash)}</span> copied over both
            </span>
          </div>
          {d.sandbox && (
            <div className="at__line">
              <Icon name="lock" className="icon-lock" />
              <span>{d.sandbox === 'strict' ? 'Strict sandbox, no network' : 'Open sandbox, on the runner'}</span>
            </div>
          )}
          <div className="at__line">
            <Tests d={d} />
          </div>
          <div className="at__rule" />
          <h2 className="card__label">Note</h2>
          <p className="at__note">{x.note || 'No note.'}</p>
        </div>

        <div className="at__main">
          <Runs d={d} m={m} />

          <div className="card at__touched">
            <h2 className="card__label">Verifier files the commit touched</h2>
            {d.touchedVerifiers.length === 0 ? (
              <p className="empty">{x.verdict ? 'None.' : 'Known once the job finishes.'}</p>
            ) : (
              <ul>
                {d.touchedVerifiers.map((path) => (
                  <li key={path} className="at__file">
                    <span className="mono at__path">{path}</span>
                    <span className="with-icon at__tag">
                      <Icon name="lock" className="icon-lock" />
                      Frozen copy used
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {flags.length > 0 && (
            <div className="card at__flags">
              <h2 className="card__label">Flags</h2>
              <FlagList agent={a} m={m} flags={flags} linkAttempts={false} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
