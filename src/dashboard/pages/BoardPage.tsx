import { AgentTile } from '../components/AgentTile.tsx'
import { PageHead } from '../components/PageHead.tsx'
import { Badge } from '../components/parts.tsx'
import { useBoard, useNow } from '../data/hooks.tsx'
import { ago, plural } from '../view/format.ts'
import './board.css'

// A board older than this is shown as stale rather than live
const STALE_MS = 30_000

export function BoardPage() {
  const board = useBoard()
  const now = useNow()
  const live = now - new Date(board.generatedAt).getTime() < STALE_MS
  return (
    <>
      <PageHead
        title="Board"
        docTitle="Board"
        meta={<span className="page-head__meta">{plural(board.agents.length, 'agent')}</span>}
        end={
          live ? (
            <Badge tone="success" dot>
              Live
            </Badge>
          ) : (
            <Badge>Updated {ago(board.generatedAt, now)}</Badge>
          )
        }
      />
      <div className="page-body">
        {board.agents.length === 0 ? (
          <p className="empty">
            No agents yet. An agent appears here once it creates a project. To connect one, run <code>sh scripts/connect.sh &lt;checkout&gt; &lt;agent id&gt;</code> in the sherpa folder.
          </p>
        ) : (
          <div className="board-grid">
            {board.agents.map((a) => (
              <AgentTile key={a.id} agent={a} now={now} />
            ))}
          </div>
        )}
      </div>
    </>
  )
}
