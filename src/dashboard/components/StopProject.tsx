import { useState } from 'react'
import type { Agent } from '../../shared/api.ts'
import { useStop } from '../data/hooks.tsx'
import './stop-project.css'

/** The one way an open project ends early: you stop it here, after a confirm step, with an optional note for the agent. */
export function StopProject({ agent }: { agent: Agent }) {
  const stop = useStop()
  const [confirming, setConfirming] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const p = agent.project
  if (!stop || !p || p.state === 'ended') return null

  const confirm = async () => {
    setBusy(true)
    setError(null)
    const message = await stop(agent.id, p.title, note.trim() || undefined)
    setBusy(false)
    if (message) return setError(message)
    setConfirming(false)
    setNote('')
  }
  const cancel = () => {
    setConfirming(false)
    setError(null)
  }

  return (
    <section aria-labelledby="stop-title">
      <h2 id="stop-title" className="section-label">
        Stop the project
      </h2>
      <div className="card stop">
        <div className="stop__head">
          <p className="stop__text">
            {p.goal?.hours ? `${p.title} runs until you stop it or its ${p.goal.hours} h are up.` : `${p.title} runs until you stop it.`} Until then, the agent keeps adding modules.
          </p>
          {!confirming && (
            <button type="button" className="stop__button" onClick={() => setConfirming(true)}>
              Stop project
            </button>
          )}
        </div>
        {confirming && (
          <div className="stop__confirm">
            <p className="stop__text">
              Stopping cancels the job in flight and abandons every module that hasn't ended. Wins keep their commits. {agent.queued[0] ? `${agent.queued[0]} opens next.` : 'No project is queued, so the agent waits for a new one.'} This can't be undone.
            </p>
            <input className="stop__input" placeholder="A note for the agent, sent with the stop" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
            {error && <p className="stop__error">{error}</p>}
            <div className="stop__actions">
              <button type="button" className="stop__button" disabled={busy} onClick={cancel}>
                Keep it running
              </button>
              <button type="button" className="stop__button" data-danger disabled={busy} onClick={confirm}>
                {busy ? 'Stopping…' : `Stop ${p.title}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
