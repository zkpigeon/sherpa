import type { ReactNode } from 'react'
import { Window, type Act } from '../kit'
import './shared.css'

export type Looped = { down: boolean }

// Every demo shares one look: the kit's dark theme with a cyan that holds up on it
export const LOOK = { theme: 'dark', accent: '#22b8d8' } as const

// The loop's reset. What the story changed fades out under the frame, snaps
// back to the opening while hidden, and fades in again. The window and its
// header stay put, so the reset reads as the view refreshing, not rewinding.
export async function reset<S extends Looped>(a: Act<S>, initial: S) {
  await a.set({ down: true } as Partial<S>)
  await a.wait(450)
  await a.snap({ ...initial, down: true })
  await a.wait(150)
  await a.set({ down: false } as Partial<S>)
  await a.wait(700)
}

export function AppFrame({ url, title, meta, down, className, children }: { url: string; title: string; meta?: ReactNode; down: boolean; className?: string; children: ReactNode }) {
  return (
    <Window url={url} urlShape="pill" className={`sh-frame${className ? ` ${className}` : ''}`}>
      <div className="sh-app">
        <div className="sh-app__head">
          <div className="sh-app__title">{title}</div>
          {meta}
        </div>
        <div className="sh-app__body" data-down={down || undefined}>
          {children}
        </div>
      </div>
    </Window>
  )
}

export function TermLines({ lines, n }: { lines: { text: string; kind?: 'dim' | 'ok' | 'err' | 'hook' }[]; n: number }) {
  return (
    <>
      {lines.map((l, i) => (
        <div key={i} className={`sh-line${l.kind ? ` ${l.kind}` : ''}`} data-on={i < n || undefined}>
          {l.text}
        </div>
      ))}
    </>
  )
}
