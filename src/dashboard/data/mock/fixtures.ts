// Six agents' nights so far, replayed in time order through the server's own
// commands, so every derived number agrees with DESIGN.md. Times are minutes
// relative to t0, the moment the mock starts.
import type { Direction } from '../../../shared/api.ts'
import { abandon, addModule, createProject, fileChange, freezeVerifiers, postAttempt, setBlurb, settle, stepDone } from '../../../server/domain/commands.ts'
import { factsOf, firstInLine, locate, verifiersOf } from '../../../server/domain/queries.ts'
import { MINUTE, emptyWorld, type ModuleSpec, type Ms, type ProjectGoalSpec, type VerifierSpec, type World } from '../../../server/domain/records.ts'
import { MOCK_CONFIG, claim, finish, must, type BenchName, type Outcome, type ResultOptions } from './runner.ts'

/** A stable fake hash: FNV-1a over the seed, as hex. */
export function hex(seed: string, length = 12): string {
  let out = ''
  for (let round = 0; out.length < length; round++) {
    let h = 0x811c9dc5 ^ round
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193)
    out += (h >>> 0).toString(16).padStart(8, '0')
  }
  return out.slice(0, length)
}

/** A module spec, plus what the mock's verifiers need: its benchmark, test counts, and whether they check the clean rules. */
export interface Plan {
  spec: ModuleSpec
  bench: BenchName
  regressionTests: number
  stepTests: number[]
  clean?: boolean
}

type Metric = { name: string; unit: string; direction: Direction; bench: BenchName }
const LATENCY: Metric = { name: 'p95 latency', unit: 'ms', direction: 'lower', bench: 'latency' }
const THROUGHPUT: Metric = { name: 'throughput', unit: 'docs/s', direction: 'higher', bench: 'ingest' }
const SUITE: Metric = { name: 'suite time', unit: 's', direction: 'lower', bench: 'suite' }
const BUNDLE: Metric = { name: 'bundle size', unit: 'kB', direction: 'lower', bench: 'bundle' }
const DECODE: Metric = { name: 'decode speed', unit: 'tok/s', direction: 'higher', bench: 'decode' }
const STARTUP: Metric = { name: 'startup time', unit: 'ms', direction: 'lower', bench: 'startup' }

type Extra = { ambitious?: boolean; retryOf?: string; clean?: boolean }
const plan = (m: Metric, title: string, targetGain: number, regressionTests: number, steps: [string, number][], { ambitious, retryOf, clean }: Extra = {}): Plan => ({
  spec: {
    title,
    steps: steps.map(([s]) => s),
    goal: { metric: m.name, unit: m.unit, direction: m.direction, targetGain, minGain: 2, ...(ambitious ? { ambitious } : {}) },
    ...(retryOf ? { retryOf } : {}),
  },
  bench: m.bench,
  regressionTests,
  stepTests: steps.map(([, n]) => n),
  ...(clean ? { clean } : {}),
})

/** The mock's verifier files and commands for a plan. The runner reads its test counts off the commands. */
export function verifiersFor(agent: string, p: Plan, hardware = 'cpu', version = 1): VerifierSpec {
  return {
    hash: hex(`${agent}:${p.spec.title}:verifiers:${version}`),
    paths: [`bench/${p.bench}.ts`, 'test/regression.test.ts', ...p.stepTests.map((_, i) => `test/step-${i + 1}.test.ts`), ...(p.clean ? ['clean/size.ts'] : [])],
    image: 'node:26-slim',
    commands: {
      regression: `npm test -- regression  # ${p.regressionTests} tests`,
      steps: p.stepTests.map((n, i) => `npm test -- step-${i + 1}  # ${n} tests`),
      benchmark: `npm run bench -- ${p.bench}`,
      ...(p.clean ? { clean: 'npm run lint && node clean/size.ts' } : {}),
    },
    hardware,
    timeLimitMinutes: 20,
  }
}

const runnerFor = (w: World, agent: string, module: string) => (verifiersOf(locate(w, agent, module)!.m)?.hardware === 'gpu' ? 'gpu-runner-1' : 'runner-1')

/** In the mock, a runner picks up each baseline job the moment it's queued, and measures a project the moment it moves. */
export function startBaselines(w: World, at: Ms) {
  settle(w, at, MOCK_CONFIG)
  for (const a of w.agents) {
    // A project's measurement is queued before the next module's baseline, so the runner takes it first. A stopped project still gets one
    for (const host of [a.project, ...a.past].flatMap((p) => p?.modules ?? []))
      if (host.jobs.some((j) => j.kind === 'final' && j.state === 'queued')) finish(w, claim(w, runnerFor(w, a.id, host.id), { agent: a.id, module: host.id, kind: 'final' }, at), { median: 0 }, {}, at)
    const m = a.project && firstInLine(a.project)
    if (m?.jobs.some((j) => j.kind === 'baseline' && j.state === 'queued')) claim(w, runnerFor(w, a.id, m.id), { agent: a.id, module: m.id, kind: 'baseline' }, at)
  }
}

/** Lands a module's running baseline job at `value`. */
export function landBaseline(w: World, agent: string, module: string, value: number, at: Ms) {
  const job = locate(w, agent, module)!.m.jobs.find((j) => j.kind === 'baseline' && j.state === 'running')
  if (!job) throw new Error(`agent ${agent} ${module} has no baseline job running`)
  finish(w, job.id, { median: value }, {}, at)
}

/** Marks the current step done: queues the step check, and a runner runs it at once. */
export function finishStep(w: World, agent: string, module: string, held: boolean, at: Ms) {
  const { p, m } = locate(w, agent, module)!
  must(stepDone(w, at, { agent, module, step: factsOf(p, m, at).step + 1 }, MOCK_CONFIG))
  finish(w, claim(w, runnerFor(w, agent, module), { agent, module, kind: 'stepCheck' }, at), { held }, {}, at)
}

export const post = (w: World, agent: string, module: string, attempt: string, note: string, at: Ms) =>
  must(postAttempt(w, at, { agent, module, attempt, commit: hex(`${agent}:${module}:${attempt}`, 40), note }, MOCK_CONFIG))

type Event = { at: Ms; run: (w: World, at: Ms) => void }
type AttemptOptions = ResultOptions & { waited?: number; took?: number }

function story(events: Event[], agent: string, t0: Ms) {
  const on = (min: number, run: Event['run']) => events.push({ at: t0 + min * MINUTE, run })
  const plans = new Map<string, Plan>()
  return {
    project(min: number, title: string, modules: Plan[], { maxMinutes, goal }: { maxMinutes?: number; goal?: ProjectGoalSpec } = {}) {
      on(min, (w, at) => {
        const spec = { title, startCommit: hex(`${agent}:${title}:start`, 40), modules: modules.map((m) => m.spec), ...(maxMinutes ? { maxMinutes } : {}), ...(goal ? { goal } : {}) }
        const r = must(createProject(w, at, { agent, spec }, MOCK_CONFIG))
        if (r.state === 'open') r.modules.forEach((id, i) => plans.set(id, modules[i]!))
      })
    },
    add: (min: number, p: Plan) => on(min, (w, at) => plans.set(must(addModule(w, at, { agent, spec: p.spec }, MOCK_CONFIG)).module, p)),
    verifiers(min: number, modules: string[], author = 'verifier', hardware = 'cpu') {
      on(min, (w, at) => {
        for (const m of modules) must(freezeVerifiers(w, at, { agent, module: m, author, verifiers: verifiersFor(agent, plans.get(m)!, hardware) }, MOCK_CONFIG))
      })
    },
    baseline: (min: number, module: string, value: number) => on(min, (w, at) => landBaseline(w, agent, module, value, at)),
    attempt(min: number, module: string, id: string, note: string, outcome: Outcome | null, opts: AttemptOptions = {}) {
      const { waited = 0, took = 8 } = opts
      on(min, (w, at) => post(w, agent, module, id, note, at))
      let job: ReturnType<typeof claim> | undefined
      on(min + waited, (w, at) => (job = claim(w, runnerFor(w, agent, module), { agent, module, kind: 'attempt' }, at)))
      if (outcome) on(min + waited + took, (w, at) => finish(w, job!, outcome, opts, at))
    },
    step: (min: number, module: string, held = true) => on(min, (w, at) => finishStep(w, agent, module, held, at)),
    abandon(min: number, module: string, reason: string, followUp: Plan | null = null) {
      on(min, (w, at) => {
        const r = must(abandon(w, at, { agent, module, reason, ...(followUp ? { followUp: followUp.spec } : {}) }, MOCK_CONFIG))
        if (r.followUp && followUp) plans.set(r.followUp, followUp)
      })
    },
    change(min: number, module: string, reason: string) {
      const proposed = (w: World) => verifiersFor(agent, plans.get(module)!, verifiersOf(locate(w, agent, module)!.m)!.hardware, 2)
      on(min, (w, at) => must(fileChange(w, at, { agent, module, reason, proposed: proposed(w), changed: [`bench/${plans.get(module)!.bench}.ts`] }, MOCK_CONFIG)))
    },
    blurb: (min: number, text: string) => on(min, (w, at) => must(setBlurb(w, at, { agent, blurb: text }, MOCK_CONFIG))),
  }
}

/** The follow-up agent 3 proposes when the timeline abandons fixture reuse. */
export const ISOLATED_CONTEXTS = plan(SUITE, 'isolated contexts', 5, 20, [
  ['Pool browser contexts per test file', 4],
  ['Reset storage between tests', 3],
])

const TREE_SHAKING_STEPS: [string, number][] = [
  ['Mark packages side-effect free', 4],
  ['Split vendor chunks', 3],
]

/** Agent 4's retry, whose verifiers the timeline freezes. */
export const TREE_SHAKING_RETRY = plan(BUNDLE, 'tree shaking retry', 12, 18, TREE_SHAKING_STEPS, { retryOf: 'm1' })

function searchPerf(events: Event[], t0: Ms) {
  const s = story(events, '1', t0)
  s.project(-305, 'search-perf', [
    plan(LATENCY, 'query cache', 10, 24, [
      ['Cache parsed queries', 6],
      ['Evict by memory size', 4],
      ['Warm the cache on start', 3],
    ]),
    plan(LATENCY, 'index layout', 10, 24, [
      ['Block-compress postings', 5],
      ['Add skip-list headers', 4],
    ]),
    plan(LATENCY, 'result scoring', 8, 24, [
      ['Precompute field norms', 4],
      ['Score in batches', 4],
    ]),
    plan(LATENCY, 'response encoding', 5, 24, [
      ['Stream the JSON', 3],
      ['Drop unused fields', 2],
    ]),
  ], { goal: { metric: LATENCY.name, unit: LATENCY.unit, direction: LATENCY.direction, target: 300, hours: 10 } })
  s.project(-305, 'index-size', [plan(LATENCY, 'posting compression', 10, 24, [['Compress postings with PFOR', 5]])])
  s.verifiers(-302, ['m1', 'm2', 'm3', 'm4'])
  s.baseline(-300, 'm1', 415)
  s.attempt(-290, 'm1', 'a1', 'Cache parsed query trees by their text.', { median: 400 })
  s.attempt(-275, 'm1', 'a2', 'Normalize whitespace before the cache lookup.', { median: 390 })
  s.step(-260, 'm1')
  s.attempt(-252, 'm1', 'a3', 'Evict the least recently used entry first.', { median: 389 })
  s.attempt(-238, 'm1', 'a4', 'Evict the largest entries first.', { median: 380 })
  s.step(-224, 'm1')
  s.attempt(-215, 'm1', 'a5', 'Warm the cache from yesterday’s top queries.', { median: 371 })
  s.baseline(-200, 'm2', 371)
  s.attempt(-190, 'm2', 'a6', 'Block-compress postings with varints.', { median: 370 })
  s.step(-176, 'm2')
  s.attempt(-168, 'm2', 'a7', 'Add a skip-list header every 128 postings.', { failedTests: 2 })
  s.attempt(-150, 'm2', 'a8', 'Add a skip-list header every 64 postings.', { median: 384 })
  s.attempt(-132, 'm2', 'a9', 'Inline the headers into each block.', { failedTests: 1 })
  s.add(
    -110,
    plan(LATENCY, 'early termination', 10, 24, [
      ['Skip low-impact terms', 5],
      ['Stop at the score bound', 4],
      ['Tune the bound', 3],
    ]),
  )
  s.verifiers(-100, ['m5'])
  s.abandon(-82, 'm2', 'Every attempt assumed smaller postings would cut latency, but decoding them costs more than the reads save.')
  s.baseline(-76, 'm5', 371)
  s.attempt(-62, 'm5', 'a10', 'Skip terms with an idf below 1.5.', { median: 368 }, { waited: 4 })
  s.attempt(-40, 'm5', 'a11', 'Skip terms with an idf below 2.', { median: 352 })
  s.attempt(-6, 'm5', 'a12', 'Skip terms with an idf below 2.5.', null)
  s.blurb(-6, 'Skipping low-impact query terms.')
}

function ingestRate(events: Event[], t0: Ms) {
  const s = story(events, '2', t0)
  s.project(-210, 'ingest-rate', [
    plan(THROUGHPUT, 'batch writes', 10, 30, [
      ['Batch inserts', 6],
      ['Group commits', 5],
    ]),
    plan(THROUGHPUT, 'parse pool', 12, 30, [
      ['Parse on worker threads', 6],
      ['Size the pool to the cores', 3],
      ['Reuse parser buffers', 4],
      ['Pin hot workers', 3],
    ]),
    plan(THROUGHPUT, 'zero-copy reads', 8, 30, [
      ['Map files into memory', 4],
      ['Parse in place', 5],
    ]),
  ])
  s.verifiers(-205, ['m1', 'm2', 'm3'])
  s.baseline(-200, 'm1', 1610)
  s.attempt(-190, 'm1', 'a1', 'Insert in batches of 500.', { median: 1680 })
  s.attempt(-175, 'm1', 'a2', 'Insert in batches of 2,000.', { median: 1745 })
  s.step(-160, 'm1')
  s.attempt(-150, 'm1', 'a3', 'Group commits every 50 ms.', { median: 1790 })
  s.baseline(-130, 'm2', 1790)
  s.attempt(-120, 'm2', 'a4', 'Parse on 4 worker threads.', { median: 1880 })
  s.attempt(-105, 'm2', 'a5', 'Parse on 8 worker threads.', { median: 1885 }, { touched: ['bench/ingest.ts'] })
  s.step(-92, 'm2')
  s.attempt(-85, 'm2', 'a6', 'One worker per core, no hyperthreads.', { median: 1955 })
  s.attempt(-68, 'm2', 'a7', 'Size the pool to the physical cores.', { median: 2035 })
  s.step(-50, 'm2')
  s.attempt(-40, 'm2', 'a8', 'Reuse parser buffers per worker.', { median: 2140 })
  s.change(-30, 'm2', 'The ingest benchmark reads its corpus from a cold cache only on the first run.')
  s.blurb(-30, 'Reusing parser buffers across batches.')
}

function testSpeed(events: Event[], t0: Ms) {
  const s = story(events, '3', t0)
  s.project(-255, 'test-speed', [
    plan(SUITE, 'parallel workers', 10, 20, [
      ['Split the suite by file', 4],
      ['Balance shards by duration', 3],
    ]),
    plan(SUITE, 'fixture reuse', 8, 20, [
      ['Share database fixtures', 5],
      ['Reuse browser contexts', 4],
    ]),
  ])
  s.verifiers(-250, ['m1', 'm2'])
  s.baseline(-245, 'm1', 702)
  s.attempt(-235, 'm1', 'a1', 'Split the suite across 4 workers by file.', { median: 655 }, { took: 10 })
  s.attempt(-215, 'm1', 'a2', 'Split the suite across 8 workers by file.', { median: 628 }, { took: 10 })
  s.attempt(-195, 'm1', 'a3', 'Balance shards by the last run’s durations.', { median: 626 }, { took: 10 })
  s.baseline(-180, 'm2', 624)
  s.attempt(-170, 'm2', 'a4', 'Create the test database once per worker.', { median: 596 }, { took: 10 })
  s.step(-150, 'm2')
  s.attempt(-140, 'm2', 'a5', 'Share one browser context per worker.', { failedTests: 3 }, { took: 10 })
  s.attempt(-120, 'm2', 'a6', 'Share contexts and clear cookies between files.', { median: 612 }, { took: 10 })
  s.attempt(-100, 'm2', 'a7', 'Share contexts and reset local storage too.', { failedTests: 2 }, { took: 10 })
  s.blurb(-90, 'Reusing browser contexts across test files.')
}

function bundleSize(events: Event[], t0: Ms) {
  const s = story(events, '4', t0)
  s.project(-155, 'bundle-size', [
    plan(BUNDLE, 'tree shaking', 25, 18, TREE_SHAKING_STEPS, { ambitious: true }),
    plan(BUNDLE, 'lazy routes', 10, 18, [
      ['Load routes on demand', 4],
      ['Prefetch on hover', 2],
    ]),
  ])
  s.verifiers(-150, ['m1', 'm2'])
  s.baseline(-148, 'm1', 1240)
  s.attempt(-140, 'm1', 'a1', 'Mark the utility packages side-effect free.', { median: 1180 }, { took: 5 })
  s.attempt(-128, 'm1', 'a2', 'Mark the icon packages side-effect free.', { median: 1150 }, { took: 5 })
  s.step(-120, 'm1')
  s.attempt(-112, 'm1', 'a3', 'Split vendors by package.', { median: 1148 }, { took: 5 })
  s.attempt(-100, 'm1', 'a4', 'Split vendors by route.', { median: 1149 }, { took: 5 })
  s.step(-92, 'm1')
  s.abandon(-20, 'm1', 'Every attempt assumed most of the bundle was dead code, but the largest packages are mostly reachable.', TREE_SHAKING_RETRY)
  s.blurb(-20, 'Retrying tree shaking with a 12% target.')
}

function decodeSpeed(events: Event[], t0: Ms) {
  const s = story(events, '5', t0)
  s.project(
    -145,
    'decode-speed',
    [
      plan(DECODE, 'fused attention', 10, 16, [
        ['Fuse the softmax', 6],
        ['Fuse the projection', 4],
      ]),
      plan(
        DECODE,
        'kv cache paging',
        10,
        16,
        [
          ['Page the KV cache', 5],
          ['Prefetch the next page', 4],
        ],
        { clean: true },
      ),
      plan(DECODE, 'speculative decoding', 15, 16, [
        ['Draft with a small model', 5],
        ['Verify drafts in batches', 4],
      ]),
    ],
    { maxMinutes: 60 },
  )
  s.verifiers(-142, ['m1', 'm2', 'm3'], 'verifier', 'gpu')
  s.baseline(-140, 'm1', 1520)
  s.attempt(-130, 'm1', 'a1', 'Fuse the softmax into the attention kernel.', { median: 1580 })
  s.attempt(-115, 'm1', 'a2', 'Fold the scale into the softmax.', { median: 1640 })
  s.step(-100, 'm1')
  s.attempt(-92, 'm1', 'a3', 'Fuse the output projection.', { median: 1690 })
  s.baseline(-65, 'm2', 1690)
  s.attempt(-60, 'm2', 'a4', 'Page the cache in 16-token blocks.', { median: 1700 }, { waited: 3, took: 7 })
  s.attempt(-45, 'm2', 'a5', 'Page the cache in 64-token blocks.', { median: 1745 }, { took: 7 })
  s.attempt(-32, 'm2', 'a6', 'Page the cache in 128-token blocks.', { median: 1752 }, { took: 7 })
  s.attempt(-18, 'm2', 'a7', 'Share one page table across the layers.', { median: 1749 }, { took: 7, clean: [3120, 2984] })
  s.blurb(-18, 'Paging the KV cache in 64-token blocks.')
}

function coldStart(events: Event[], t0: Ms) {
  const s = story(events, '6', t0)
  s.project(-125, 'cold-start', [
    plan(STARTUP, 'lazy imports', 15, 30, [
      ['Defer plugin imports', 8],
      ['Lazy-load the config schema', 6],
      ['Snapshot the module graph', 5],
    ]),
    plan(STARTUP, 'precompiled templates', 8, 30, [
      ['Compile templates at build time', 4],
      ['Cache compiled templates', 3],
    ]),
  ])
  s.project(-125, 'memory-peak', [plan(STARTUP, 'arena allocation', 10, 30, [['Allocate parse trees in an arena', 5]])])
  s.project(-125, 'gc-pauses', [plan(STARTUP, 'incremental marking', 10, 30, [['Mark the heap in slices', 5]])])
  s.verifiers(-122, ['m1'], '6')
  s.verifiers(-122, ['m2'])
  s.baseline(-115, 'm1', 940)
  s.attempt(-105, 'm1', 'a1', 'Import plugins on first use.', { median: 905 }, { took: 6 })
  s.attempt(-92, 'm1', 'a2', 'Import the CLI parser on first use.', { median: 872 }, { took: 6 })
  s.step(-80, 'm1')
  s.attempt(-72, 'm1', 'a3', 'Load the schema from a prebuilt JSON file.', { failedTests: 2 }, { took: 6 })
  s.attempt(-58, 'm1', 'a4', 'Load the schema on the first validate call.', { median: 869 }, { took: 6, testsTotal: 34 })
  s.blurb(-58, 'Lazy-loading the config schema.')
}

export function initialWorld(t0: Ms): World {
  const w = emptyWorld()
  const events: Event[] = []
  for (const build of [searchPerf, ingestRate, testSpeed, bundleSize, decodeSpeed, coldStart]) build(events, t0)
  events.sort((x, y) => x.at - y.at)
  // The board lists agents in the order they first called
  for (const id of ['1', '2', '3', '4', '5', '6']) must(setBlurb(w, events[0]!.at, { agent: id, blurb: '' }, MOCK_CONFIG))
  for (const e of events) {
    e.run(w, e.at)
    startBaselines(w, e.at)
  }
  settle(w, t0, MOCK_CONFIG)
  return w
}
