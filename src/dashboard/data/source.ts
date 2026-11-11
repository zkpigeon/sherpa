import type { AgentId, AttemptDetail, AttemptId, Board, ChangeId, ChangeReview, ModuleId } from '../../shared/api.ts'

/**
 * Where the dashboard's data comes from: sherpa-server over HTTP, or the mock.
 * `current` and `attempt` must return the same object until the data changes,
 * because React compares snapshots by identity.
 */
export interface BoardSource {
  current(): Board
  /** Calls the listener after every change. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  /** Null when there is no such attempt, or while it loads. */
  attempt(agent: AgentId, module: ModuleId, attempt: AttemptId): AttemptDetail | null
  /** Approves or rejects a verifier change request, with an optional note for the agent. Resolves to the reason it failed, or null. */
  decide?(change: ChangeId, approve: boolean, note?: string): Promise<string | null>
  /** A change request's diff, for review. */
  review?(change: ChangeId): Promise<ChangeReview | null>
  /** Forgets the dashboard's sign-in. */
  signOut?(): Promise<void>
}
