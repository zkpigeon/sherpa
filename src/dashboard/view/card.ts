// Card A: the nine lines an agent's card shows, worked out from the agent.
// Every state fills the same lines in the same order; a state changes a tone
// or a word and adds at most one callout, never removes a line.
import type { Agent, Module, Project } from '../../shared/api.ts'
import { minutesBetween, minutesLeft } from '../../shared/clock.ts'
import { goalNumbers, metGoal } from '../../shared/projectGoal.ts'
import { WAITING, figure, flagTitle, plural } from './format.ts'
import { currentModule, currentStep, inFlight } from './module.ts'

export type CardTone = 'idle' | 'accent' | 'warning' | 'danger' | 'success'

export interface CardView {
  /** The status dot. `busy` turns it into a spinner while an attempt is with the runner. */
  dot: { tone: CardTone; busy: boolean }
  /** Time left, or the state when time isn't the point. */
  corner: { text: string; tone: CardTone | 'faint' }
  sub: string
  metric: string
  value: { kind: 'number'; best: number; unit: string } | { kind: 'none'; text: string }
  target: string
  bar: { share: number; tone: 'accent' | 'ink' | 'success' }
  under: { text: string; chip: string | null }
  /** The project's goal and how far the project has come toward it. Null without one. */
  goal: { text: string; now: string | null; share: number; tone: 'accent' | 'success' | 'warning' } | null
  blurb: string | null
  callout: { tone: 'warning' | 'danger'; text: string } | null
}

/** How far the best value has come from the baseline toward the target, 0 to 1. */
export function progress(m: Module): number {
  const { baseline, target, direction } = m.goal
  if (m.best === null || baseline === null || target === null || baseline === target) return 0
  const share = direction === 'lower' ? (baseline - m.best) / (baseline - target) : (m.best - baseline) / (target - baseline)
  return Math.min(1, Math.max(0, share))
}

/** Percent past the target, or 0 when the best value hasn't passed it. */
export function beyond(m: Module): number {
  const { target, direction } = m.goal
  if (m.best === null || target === null || target === 0) return 0
  const past = direction === 'lower' ? (target - m.best) / target : (m.best - target) / target
  return Math.max(0, Math.round(past * 100))
}

const ABANDON = 'The agent has to abandon it with a reason.'

function callout(m: Module, now: number): CardView['callout'] {
  const s = m.status
  if (s.state === 'stuck') {
    const step = (currentStep(m) ?? 0) + 1
    const why = s.cause === 'step' ? `Step ${step} failed 3 times.` : s.cause === 'target' ? 'It finished its steps without reaching the target.' : 'It ran out of time.'
    return { tone: 'danger', text: `${why} ${ABANDON}` }
  }
  if (m.clock.kind === 'grace') {
    if (inFlight(m)) return { tone: 'warning', text: 'Its last attempt is with the runner.' }
    const left = Math.max(0, Math.ceil(minutesBetween(new Date(now), m.clock.graceEnds)))
    return { tone: 'warning', text: `1 attempt left. The module times out in ${left} min.` }
  }
  const flag = m.flags.at(-1)
  if (flag) return { tone: 'warning', text: `${plural(m.flags.length, 'flag')} to review: ${flagTitle(flag)}` }
  return null
}

function under(m: Module): CardView['under'] {
  const s = m.status
  if (s.state === 'pending') return { text: WAITING[s.waitingFor], chip: null }
  if (s.state === 'pastTarget') return { text: `Past target by ${beyond(m)}%`, chip: m.streak >= 2 ? `${m.streak} in a row` : null }
  if (s.state === 'passed') return { text: 'Met its target', chip: null }
  if (s.state === 'abandoned') return { text: 'Abandoned', chip: null }
  if (m.goal.baseline === null) return { text: 'No baseline yet', chip: null }
  return { text: `${Math.round(progress(m) * 100)}% of the way from ${figure(m.goal.baseline)}`, chip: null }
}

function corner(m: Module, now: number): CardView['corner'] {
  const s = m.status.state
  if (s === 'pending') return { text: 'Not started', tone: 'faint' }
  if (s === 'stuck') return { text: 'Stuck', tone: 'danger' }
  if (s === 'passed') return { text: 'Passed', tone: 'success' }
  if (s === 'abandoned') return { text: 'Abandoned', tone: 'faint' }
  if (m.clock.kind === 'grace') return { text: 'Time is up', tone: 'warning' }
  const left = minutesLeft(m.clock, new Date(now))
  return { text: left === null ? 'Clock stopped' : `${left} min left`, tone: 'faint' }
}

function dotTone(m: Module): CardTone {
  const s = m.status.state
  if (s === 'pending' || s === 'abandoned') return 'idle'
  if (s === 'stuck') return 'danger'
  if (s === 'pastTarget' || s === 'passed') return 'success'
  return m.clock.kind === 'grace' ? 'warning' : 'accent'
}

function goalLine(p: Project): CardView['goal'] {
  const g = p.goal
  if (!g) return null
  const { target, now, share } = goalNumbers(p)
  const met = metGoal(p)
  const aim = target === null ? `${g.targetGain}% ${g.direction}` : `${figure(target)} ${g.unit}`
  const short = p.state === 'ended' && !met
  return {
    text: met ? `Project goal met: ${aim}` : short ? `Short of its goal: ${aim}` : `Project goal: ${aim}`,
    now: now === null ? null : `now ${figure(now)} ${g.unit}`,
    share,
    tone: met ? 'success' : short || p.state === 'needsModule' ? 'warning' : 'accent',
  }
}

/** The project's standing, which outranks the module's once every module has ended. */
function standing(p: Project): Pick<CardView, 'corner' | 'callout'> | null {
  if (p.state === 'needsModule') return { corner: { text: 'Needs a module', tone: 'warning' }, callout: { tone: 'warning', text: 'Every module has ended. The agent has to add the next one.' } }
  if (p.state !== 'ended') return null
  return { corner: { text: p.end === 'stopped' ? 'Stopped' : 'Hours up', tone: 'faint' }, callout: null }
}

/** The module a card is about: the current one, or the last one once the project has ended. */
export function cardModule(a: Agent): Module | null {
  return currentModule(a) ?? a.project?.modules.at(-1) ?? null
}

/** Null for an agent with no project, which gets a smaller card. */
export function cardView(a: Agent, now: number): CardView | null {
  const p = a.project
  const m = cardModule(a)
  if (!p || !m) return null
  const s = m.status.state
  const met = s === 'pastTarget' || s === 'passed'
  const project = standing(p)
  return {
    dot: { tone: p.state === 'needsModule' ? 'warning' : dotTone(m), busy: inFlight(m) !== null || p.progress?.state === 'measuring' },
    corner: project?.corner ?? corner(m, now),
    sub: `${p.title} · ${m.title}`,
    metric: m.goal.metric,
    value: m.best === null ? { kind: 'none', text: 'Not measured yet' } : { kind: 'number', best: m.best, unit: m.goal.unit },
    target: m.goal.target === null ? `target ${m.goal.targetGain}%` : `target ${figure(m.goal.target)}`,
    bar: { share: met ? 1 : progress(m), tone: met ? 'success' : s === 'stuck' ? 'ink' : 'accent' },
    under: under(m),
    goal: goalLine(p),
    blurb: a.blurb || null,
    callout: project ? project.callout : callout(m, now),
  }
}
