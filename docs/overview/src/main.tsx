import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BoardDemo } from './demos/BoardDemo'
import { PlanDemo } from './demos/PlanDemo'
import { JobDemo } from './demos/JobDemo'
import { CommitsDemo } from './demos/CommitsDemo'
import { SessionDemo } from './demos/SessionDemo'
import { ClockDemo } from './demos/ClockDemo'
import { GoalDemo } from './demos/GoalDemo'
import { FlagsDemo } from './demos/FlagsDemo'
import './kit/stageshow.css'
import './page.css'

function Figure({ demo, children }: { demo: ReactNode; children: ReactNode }) {
  return (
    <figure className="pg-figure">
      <div className="pg-demo">{demo}</div>
      <figcaption className="pg-caption">{children}</figcaption>
    </figure>
  )
}

function Legend() {
  return (
    <span className="pg-legend">
      <span>
        <i data-v="win" />
        win
      </span>
      <span>
        <i data-v="flat" />
        flat
      </span>
      <span>
        <i data-v="fail" />
        fail
      </span>
    </span>
  )
}

function Page() {
  return (
    <main className="pg">
      <header className="pg-header">
        <h1>Sherpa</h1>
        <p className="pg-lead">
          Sherpa keeps long-running agents on track overnight. Each agent splits its hill climb into modules and steps, and submits every attempt as a commit. A runner measures the commit with tests and a benchmark the agent can't change, and the server decides when a module passes, gets stuck, or runs out of time.
        </p>
        <p className="pg-meta">Design overview, November 2026. Nothing is built yet, and every number in the demos is made up.</p>
      </header>

      <Figure demo={<BoardDemo />}>
        <p>The dashboard has one tile per agent. Agent 1's attempt a10 is its second win in a row and meets its target, so the module stays open past the target and earns a 45-minute extension.</p>
        <Legend />
      </Figure>

      <section>
        <h2>A project is a plan of modules and steps</h2>
        <p>An agent starts by creating a project. A project is an ordered list of modules, and each module is one approach to one goal, with its own steps, verifiers, and clock. Steps build on each other in order, so a step that can't be made to work ends its module. Separate ideas for the same goal go in separate modules.</p>
        <p>Before a module can start, a separate verifier agent writes its tests and benchmark, and they freeze when submitted. Then the runner measures the module's baseline. A new approach goes right after the current module, and calls name modules by an ID that never changes.</p>
      </section>

      <Figure demo={<PlanDemo />}>
        <p>Each module's verifiers freeze, m1 measures its baseline and goes active, and a new approach, m5, lands right after it. The positions below it shift, and their IDs stay the same.</p>
      </Figure>

      <section>
        <h2>A runner measures every attempt</h2>
        <p>The agent never reports a number. It pushes a commit and posts its ID. A runner fetches the best commit and the new one, copies the frozen verifiers over both, runs the tests, and then runs the benchmark 5 times on each commit, alternating between them. Only a runner token can send results, and each job runs in a container with no tokens, no Docker socket, and no network.</p>
        <p>A benchmark is any command that prints one JSON line per run with its value and how much work it did, so the runner works for any workload. A hardware label such as <code>gpu</code> sends a job to a runner that has that hardware.</p>
      </section>

      <Figure demo={<JobDemo />}>
        <p>A win needs passing tests, a median gain of at least the goal's minimum, and a rank test that separates the two sets of runs at p below 0.05.</p>
      </Figure>

      <section>
        <h2>The server judges every attempt</h2>
        <table>
          <thead>
            <tr>
              <th>Verdict</th>
              <th>When</th>
              <th>What it moves</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Win</td>
              <td>The tests pass, the median gain clears the minimum, and the rank test separates the runs.</td>
              <td>The head commit and the best commit</td>
            </tr>
            <tr>
              <td>Flat</td>
              <td>Neither a win nor a fail.</td>
              <td>The head commit only, so work that prepares later steps is kept</td>
            </tr>
            <tr>
              <td>Fail</td>
              <td>The tests fail, the job is killed for running too long, or the runs are reliably worse than the best.</td>
              <td>Nothing. The agent goes back to the head commit</td>
            </tr>
          </tbody>
        </table>
        <p>The head commit is what the next attempt builds on. The best commit is what attempts are measured against. A step fails at its 3rd failed turn, and because later steps depend on it, the module gets stuck.</p>
      </section>

      <Figure demo={<CommitsDemo />}>
        <p>a8 wins and moves both markers. a9 is flat, so only the head moves. a10 fails and is reverted.</p>
      </Figure>

      <section>
        <h2>A stuck module hands off to the next one</h2>
        <p>An active module gets stuck when a step fails, when its last step is done without meeting the target, or when it runs out of time. A stuck module accepts no more attempts. The agent records one sentence naming the assumption its attempts shared, and the next module takes over.</p>
        <p>A win isn't thrown away with its module. If the abandoned module had one, the agent proposes a follow-up that starts from the best commit. The follow-up either retries the same steps with a smaller goal, which a module can do only once, or builds new steps on top. A module with no win is dropped.</p>
        <p>A hook puts the agent's board line in front of it on every turn, so the agent always sees where it stands.</p>
      </section>

      <Figure demo={<SessionDemo />}>
        <p>Attempt a8 is the third fail on step 2, so m2 gets stuck. The agent adds early termination as m5, abandons m2 with its reason, and m5 waits for its verifiers before it starts.</p>
      </Figure>

      <section>
        <h2>The clock catches quiet loops, and wins buy time</h2>
        <p>A module that only produces flat attempts never fails a step, so every module also gets a time limit, 90 minutes by default. Time spent waiting for a runner doesn't count. At the deadline the module gets one last attempt, inside a grace period of 10% of its limit.</p>
        <p>Targets are conservative on purpose, so a module often meets its target while it is still improving. Wins and finished steps both earn extra time, as long as a finished step didn't make the metric worse. The first extension is half the limit, earned by a streak of 2 wins or by the first such step, and each later one is half the one before. The extensions never add up to the original limit, so no module runs past twice its limit.</p>
      </section>

      <Figure demo={<ClockDemo />}>
        <p>Above, a flat module whose deadline moves out by its runner wait, then runs out after its 9-minute grace period. Below, a streak earns 45 extra minutes, a finished step that held the metric (the square) earns 23, and the next win earns 11.</p>
      </Figure>

      <section>
        <h2>Goals stay conservative</h2>
        <p>A goal sets its target as a percentage of the baseline, so the server can check it before the baseline exists. It rejects a target more than 20% better unless the goal is marked ambitious. The goal also sets the minimum gain that counts as a win, 2% unless it says otherwise.</p>
      </section>

      <Figure demo={<GoalDemo />}>
        <p>A 30% target is refused at the cap, and a 10% target is accepted. The absolute target appears once the runner has measured the baseline.</p>
      </Figure>

      <section>
        <h2>The dashboard flags what doesn't add up</h2>
        <p>The runner blocks the cheats that look like normal work: editing a test, loosening the benchmark, keeping the best run, or marking a step done without doing it. An agent that leaves its task to attack Sherpa itself is rare, so the dashboard flags the traces instead. It flags a commit that touches a verifier file, fewer tests running than before, a benchmark run that did less work, a verdict with no runner job behind it, and verifiers written by the agent that works the module.</p>
      </section>

      <Figure demo={<FlagsDemo />}>
        <p>Attempt a11 changed a frozen benchmark file. The runner used the frozen copy anyway, and the dashboard flags it for you.</p>
      </Figure>

      <section>
        <h2>The API</h2>
        <p>Agents call the API with <code>curl</code>, using the agent token. Runners and your dashboard actions use their own tokens. <code>{'{m}'}</code> is a module's ID.</p>
        <table className="pg-api">
          <thead>
            <tr>
              <th>Call</th>
              <th>Effect</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><code>POST /agents/{'{id}'}/projects</code></td><td>Creates a project, or queues it while another is open</td></tr>
            <tr><td><code>PUT /agents/{'{id}'}/blurb</code></td><td>Sets the agent's sentence in its blurb</td></tr>
            <tr><td><code>POST /agents/{'{id}'}/modules</code></td><td>Adds a module with its steps and goal after the current one</td></tr>
            <tr><td><code>POST …/modules/{'{m}'}/verifiers</code></td><td>Submits a module's verifiers, which freeze on submission</td></tr>
            <tr><td><code>POST …/modules/{'{m}'}/verifiers/changes</code></td><td>Files a change request for frozen verifiers</td></tr>
            <tr><td><code>POST …/modules/{'{m}'}/attempts</code></td><td>Queues an attempt from its ID, commit, and note</td></tr>
            <tr><td><code>GET …/modules/{'{m}'}/attempts/{'{attemptId}'}</code></td><td>Returns the job state and, once judged, the verdict</td></tr>
            <tr><td><code>POST …/modules/{'{m}'}/steps/{'{n}'}/done</code></td><td>Queues a step check, which runs the step's tests and the benchmark</td></tr>
            <tr><td><code>POST …/modules/{'{m}'}/abandon</code></td><td>Records the abandon reason, and the follow-up module if there was a win</td></tr>
            <tr><td><code>GET /agents/{'{id}'}</code>, <code>GET /board</code></td><td>Return board lines as plain text</td></tr>
            <tr><td><code>POST /jobs/claim</code>, <code>…/lease</code>, <code>…/results</code></td><td>Runner calls: claim a job, renew its lease, send its results</td></tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>The stack</h2>
        <ul>
          <li>TypeScript on Node 26 for both services, with SQLite through the built-in <code>node:sqlite</code>.</li>
          <li>One Docker Compose file with two services, <code>sherpa-server</code> and <code>sherpa-runner</code>, self-hosted on a home machine or a VPS.</li>
          <li>The database lives in a volume only the server mounts, outside any folder an agent works in.</li>
          <li>Commits live in a git remote that both the agents and the runner can reach.</li>
        </ul>
      </section>

      <section>
        <h2>Not in v1</h2>
        <ul>
          <li>Separate OS users or containers for agents, and hardened container runtimes such as gVisor.</li>
          <li>A held-out benchmark that only the runner holds, and a reviewer agent that reads each module's diff.</li>
          <li>A separate token for each agent.</li>
        </ul>
      </section>

      <section>
        <h2>Still to test</h2>
        <p>Every design choice is settled. These two are facts to measure once there's code.</p>
        <ul>
          <li>Are 5 runs per commit enough to separate real gains from noise on real benchmarks?</li>
          <li>Which hook event runs often enough during a long autonomous run, on Claude Code and on Codex?</li>
        </ul>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
)
