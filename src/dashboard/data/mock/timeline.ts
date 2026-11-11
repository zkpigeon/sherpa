// What happens on the board after load, one event per tick. Events only move
// forward: each is a call the server would take, at the time it lands.
import { abandon, freezeVerifiers, setBlurb } from '../../../server/domain/commands.ts'
import type { Ms, World } from '../../../server/domain/records.ts'
import { ISOLATED_CONTEXTS, TREE_SHAKING_RETRY, finishStep, landBaseline, post, startBaselines, verifiersFor } from './fixtures.ts'
import { MOCK_CONFIG, claim, finish, jobOfAttempt, must, type Outcome } from './runner.ts'

export interface TimelineEvent {
  label: string
  run: (w: World, at: Ms) => void
}

const event = (label: string, run: TimelineEvent['run']): TimelineEvent => ({
  label,
  run(w, at) {
    run(w, at)
    startBaselines(w, at)
  },
})

const results = (w: World, agent: string, module: string, attempt: string, outcome: Outcome, at: Ms) => finish(w, jobOfAttempt(w, agent, module, attempt), outcome, {}, at)
const blurb = (w: World, agent: string, text: string, at: Ms) => must(setBlurb(w, at, { agent, blurb: text }, MOCK_CONFIG))

export const TIMELINE: TimelineEvent[] = [
  event('agent 1’s a12 wins, meets the target on a streak of 2 and earns the first extension', (w, at) => results(w, '1', 'm5', 'a12', { median: 331 }, at)),
  event('agent 6 posts a5 and it waits for a runner', (w, at) => post(w, '6', 'm1', 'a5', 'Precompile the schema validator.', at)),
  event('agent 5 posts its last attempt in the grace period', (w, at) => {
    post(w, '5', 'm2', 'a8', 'Prefetch the next page on a side stream.', at)
    claim(w, 'gpu-runner-1', { agent: '5', module: 'm2', kind: 'attempt' }, at)
  }),
  event('a runner claims agent 6’s a5', (w, at) => claim(w, 'runner-2', { agent: '6', module: 'm1', kind: 'attempt' }, at)),
  event('agent 1 finishes step 1 and the metric holds', (w, at) => {
    finishStep(w, '1', 'm5', true, at)
    blurb(w, '1', 'Stopping once the top results can’t change.', at)
  }),
  event('agent 5’s last attempt is flat, so kv cache paging runs out of time', (w, at) => results(w, '5', 'm2', 'a8', { median: 1750 }, at)),
  event('agent 3 abandons fixture reuse and proposes isolated contexts', (w, at) => {
    const reason = 'Every attempt assumed browser contexts are safe to share across files, but shared contexts leak state between tests.'
    must(abandon(w, at, { agent: '3', module: 'm2', reason, followUp: ISOLATED_CONTEXTS.spec }, MOCK_CONFIG))
    blurb(w, '3', 'Starting isolated contexts on fixture reuse’s verifiers.', at)
  }),
  event('agent 6’s a5 wins and earns an extension', (w, at) => results(w, '6', 'm1', 'a5', { median: 841 }, at)),
  event('the verifier agent freezes agent 4’s retry, and a runner starts its baseline', (w, at) =>
    must(freezeVerifiers(w, at, { agent: '4', module: 'm3', author: 'verifier', verifiers: verifiersFor('4', TREE_SHAKING_RETRY) }, MOCK_CONFIG)),
  ),
  event('agent 1 posts a13', (w, at) => {
    post(w, '1', 'm5', 'a13', 'Stop scoring once the top 10 can’t change.', at)
    claim(w, 'runner-1', { agent: '1', module: 'm5', kind: 'attempt' }, at)
  }),
  event('agent 2 posts a9', (w, at) => {
    post(w, '2', 'm2', 'a9', 'Pin the two hottest workers to their cores.', at)
    claim(w, 'runner-3', { agent: '2', module: 'm2', kind: 'attempt' }, at)
  }),
  event('agent 4’s retry measures its baseline and starts', (w, at) => {
    landBaseline(w, '4', 'm3', 1151, at)
    blurb(w, '4', 'Marking the date library side-effect free.', at)
  }),
  event('agent 1’s a13 wins again', (w, at) => results(w, '1', 'm5', 'a13', { median: 324 }, at)),
  event('agent 2’s a9 is flat, so parse pool passes and zero-copy reads is next', (w, at) => {
    results(w, '2', 'm2', 'a9', { median: 2138 }, at)
    blurb(w, '2', 'Waiting for the zero-copy baseline.', at)
  }),
  event('the verifier agent freezes agent 3’s follow-up', (w, at) =>
    must(freezeVerifiers(w, at, { agent: '3', module: 'm3', author: 'verifier', verifiers: verifiersFor('3', ISOLATED_CONTEXTS) }, MOCK_CONFIG)),
  ),
  event('agent 2’s zero-copy reads measures its baseline and starts', (w, at) => {
    landBaseline(w, '2', 'm3', 2141, at)
    blurb(w, '2', 'Mapping input files into memory.', at)
  }),
  event('agent 3’s follow-up measures its baseline and starts', (w, at) => {
    landBaseline(w, '3', 'm3', 597, at)
    blurb(w, '3', 'Pooling browser contexts per test file.', at)
  }),
]
