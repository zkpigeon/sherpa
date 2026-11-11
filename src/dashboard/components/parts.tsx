import type { ReactNode } from 'react'
import type { ModuleStatus, Verdict } from '../../shared/api.ts'
import { stateBadge, type Tone } from '../view/format.ts'
import './parts.css'

export function Badge({ tone = 'neutral', dot, icon, children, className }: { tone?: Tone; dot?: boolean; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={`badge${className ? ` ${className}` : ''}`} data-tone={tone} data-lead={dot || icon ? '' : undefined}>
      {dot && <span className="badge__dot" />}
      {icon}
      <span className="badge__label">{children}</span>
    </span>
  )
}

export function StateBadge({ state, className }: { state: ModuleStatus['state']; className?: string }) {
  const b = stateBadge(state)
  return (
    <Badge tone={b.tone} dot={state !== 'pending' && state !== 'abandoned'} className={className}>
      {b.label}
    </Badge>
  )
}

/** A bar filled to `value` (0 to 1). Revealed with clip-path so the end stays round and nothing re-lays out. */
export function Meter({ value, tone = 'accent', className }: { value: number; tone?: 'accent' | 'warning' | 'ink' | 'success'; className?: string }) {
  const clip = `inset(0 ${(1 - Math.max(0, Math.min(1, value))) * 100}% 0 0 round 3px)`
  return (
    <span className={`meter${className ? ` ${className}` : ''}`} data-tone={tone} aria-hidden>
      <span className="meter__fill" style={{ clipPath: clip }} />
    </span>
  )
}

export function Spinner({ size = 12 }: { size?: number }) {
  return (
    <svg className="spinner" viewBox="0 0 16 16" width={size} height={size} aria-hidden>
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.5" />
      <path d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

// The solid glyphs from docs/overview/src/kit/parts/Icon.tsx (stageshow kit, MIT)
const GLYPHS = {
  lock: 'M8 1.25A3.25 3.25 0 0 0 4.75 4.5v2H4.5A1.5 1.5 0 0 0 3 8v5.25a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V8a1.5 1.5 0 0 0-1.5-1.5h-.25v-2A3.25 3.25 0 0 0 8 1.25Zm-1.75 5.25v-2a1.75 1.75 0 0 1 3.5 0v2Z',
  check: 'M8 1.25a6.75 6.75 0 1 1 0 13.5 6.75 6.75 0 0 1 0-13.5Zm3 4.3-.95-.8-3.3 3.95-1.85-1.8-.85.9 2.8 2.75Z',
}

export function Icon({ name, size = 14, className }: { name: keyof typeof GLYPHS; size?: number; className?: string }) {
  return (
    <svg className={`icon${className ? ` ${className}` : ''}`} viewBox="0 0 16 16" width={size} height={size} aria-hidden>
      <path d={GLYPHS[name]} fill="currentColor" fillRule="evenodd" />
    </svg>
  )
}

/** A verdict as a dot: filled accent for a win, half filled for simpler, a ring for flat, filled danger for a fail. */
export function VerdictDot({ verdict, fresh }: { verdict: Verdict | 'pending'; fresh?: boolean }) {
  return <span className="dot" data-v={verdict} data-fresh={fresh || undefined} aria-hidden />
}
