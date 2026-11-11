import type { Project } from '../../shared/api.ts'
import { minutesBetween } from '../../shared/clock.ts'
import { goalNumbers, metGoal } from '../../shared/projectGoal.ts'
import { figure, short, type Tone } from '../view/format.ts'
import { Badge, Meter } from './parts.tsx'
import './project-goal.css'

const END = { stopped: 'Stopped on the dashboard', budget: 'Its hours ran out' } as const

/** The project's goal: where it started, what it aims for, where it is now, and what it waits for or what ended it. */
export function ProjectGoal({ project: p, now }: { project: Project; now: number }) {
  const g = p.goal
  if (!g) return null
  const { from, target, now: at, share } = goalNumbers(p)
  const met = metGoal(p)
  const unit = (n: number) => `${figure(n)} ${g.unit}`
  const aim = g.target !== null ? `${unit(g.target)} or ${g.direction}` : `${g.targetGain}% ${g.direction} than the start`
  const badge: { tone: Tone; text: string } = met
    ? { tone: 'success', text: 'Met' }
    : p.state === 'ended'
      ? { tone: 'neutral', text: 'Ended short' }
      : p.state === 'needsModule'
        ? { tone: 'warning', text: 'Needs a module' }
        : { tone: 'accent', text: 'Climbing' }
  const left = g.budgetEndsAt === null ? null : minutesBetween(new Date(now), g.budgetEndsAt) / 60
  const notes = [
    g.hours !== null && (left !== null && left > 0 ? `${left < 10 ? left.toFixed(1) : Math.round(left)} of ${g.hours} h left` : `Its ${g.hours} h are up, so no new module starts`),
    met && p.state !== 'ended' && 'The project keeps climbing past it',
    p.state === 'needsModule' && p.reached && `The agent has to add a module, which starts from ${short(p.reached)}`,
    p.end && END[p.end],
    p.stopNote && `Note: ${p.stopNote}`,
  ].filter(Boolean)
  return (
    <section aria-labelledby="goal-title">
      <h2 id="goal-title" className="section-label">
        Project goal
      </h2>
      <div className="card goal">
        <div className="goal__head">
          <p className="goal__aim">
            {g.metric} {aim}
          </p>
          <Badge tone={badge.tone} dot={badge.tone === 'success'}>
            {badge.text}
          </Badge>
        </div>
        <Meter value={share} tone={met ? 'success' : p.state === 'needsModule' ? 'warning' : 'accent'} className="goal__bar" />
        <div className="goal__numbers">
          <span>{from === null ? 'Start not measured yet' : `Started at ${unit(from)}`}</span>
          <span>{at === null ? 'Not measured since' : `Now ${unit(at)}, ${Math.round(share * 100)}% of the way`}</span>
          {target !== null && <span className="goal__target">Target {unit(target)}</span>}
        </div>
        {notes.length > 0 && <p className="goal__notes">{notes.join(' · ')}</p>}
      </div>
    </section>
  )
}
