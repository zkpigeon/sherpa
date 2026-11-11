# Sherpa design

Sherpa keeps long-running agents on track. Each agent splits its hill climb into modules and steps, submits every attempt as a commit, and keeps a short blurb current. A runner measures each attempt with tests and a benchmark the agent can't change, and the server judges the result. An active module that fails a step, finishes its steps without reaching its target, or runs out of time becomes stuck, and the agent moves on to a different task or implementation. A module that keeps winning earns more time and can run past its target.

## Terms

| Term | Meaning |
|---|---|
| Project | An agent's plan for one hill climb, as an ordered list of modules. |
| Module | One approach to one goal, with its own steps, goal, verifiers, and clock. |
| Step | One piece of work inside a module, also called a submodule. |
| Current module | The module the agent is on: the one that is active, past target, or stuck, or else the next pending module. |
| Current step | The first step of the current module that is not done. |
| Attempt | One change the agent submits as a commit for the current step. |
| Verdict | The server's judgment of an attempt: win, flat, or fail. |
| Failed turn | An attempt whose verdict is fail. |
| Head commit | The module's latest kept commit. The next attempt builds on it. |
| Best commit | The commit of the module's latest win, or its start commit before any win. Attempts are measured against it. |
| Board line | One line of plain text per agent. |
| Dashboard | The web page that shows a tile per agent and takes your actions. |

## The board line and the dashboard

Every board line has this format:

```
agent {id}: Project: {title}, Module ({position} / {total}): {title}, Progress: {done steps} / {total steps}, Blurb: {blurb}
```

The agent writes one sentence about what it is working on. The server appends the rest of the blurb from its own records: the goal and its metric, the best value once a win has moved it, the streak when there is one, the project goal and how far the project has come toward it, a warning when the current module is the project's last, and the time left. So the blurb always matches what the server has measured. Once the project ends, the line sums it up instead: how many modules passed and were abandoned, the metric's change over the project, and the commit a new project would start from. A final job measures that change: it runs the benchmark on the project's start commit and its final commit, alternating, on the last module's verifiers. Until it lands, the line gives an estimate that chains each module's gain. Values under 100 show three significant figures, so small numbers still show progress.

```
agent 1: Project: search-perf, Module (2 / 5): query cache, Progress: 3 / 7, Blurb: Caching parsed queries. Goal: p95 latency 371 -> 334 ms, 10% lower. Best so far 352 ms. 2 wins in a row. 38 min left.
```

`sherpa-server` also serves the dashboard, a web page with one tile per agent. A tile shows everything in the board line, plus a time-left bar, the next queued project, the module's verifiers, open verifier change requests, and flags. Your actions, such as approving a verifier change, happen on the dashboard.

## Data model

| Record | Fields |
|---|---|
| Agent | `id`, open project, queued projects, blurb sentence |
| Project | `title` (unique per agent), start commit, git remote (optional), ordered modules, `maxMinutes` (optional) |
| Module | `id` (never changes), position, `title` (unique in its project), ordered steps, goal, verifiers, state, start commit, head commit, best commit, attempts, `startedAt`, `maxMinutes` (optional), stuck cause (`step`, `target`, or `time`), `abandonReason`, `retryOf` (the module it retries, if any) |
| Step | `title`, `done`, failed turns |
| Goal | `metric`, `direction` (`lower` or `higher`), `targetGain` (percent of the baseline), `minGain` (percent of the best commit's median), `ambitious` |
| Verifiers | frozen files, verifier hash, container image, test commands for each step and for regressions, benchmark command (prints one JSON line per run), hardware label, job time limit, author |
| Change request | `id`, module, author, reason, proposed files, state (`open`, `approved`, or `rejected`) |
| Attempt | `attemptId` (chosen by the agent), module, step, `commit`, `note`, job, `verdict` (`win`, `flat`, or `fail`), posted and judged times |
| Job | `id` (from its kind, commits, step, and verifier hash), module, kind (`baseline`, `attempt`, `step check`, or `final`), state, verifier hash, hardware label, holding runner, lease expiry, queued, claimed, and finished times for each claim, each benchmark run's commit, value, and work count, test results and test count, verifier files the commit touched |

The server derives the baseline, the best value, the streak, the extensions, and the deadline from the attempts and jobs instead of storing them, so they can't drift out of step. It stores each module's state, and on every request it applies any transition that has come due.

## Projects and modules

An agent starts by creating a project with its start commit and its modules, each with steps and a goal. Steps build on each other in order, and a failed step makes its module stuck, so separate ideas for the same goal go in separate modules. The server can't check this, so the agent's instructions state it with an example: "try an LRU cache" and "try an LFU cache" are two modules, not two steps.

Each agent has one open project at a time. A project sent while another is open joins the agent's queue and starts when the open project ends. A project without a goal ends when every module in it has passed or been abandoned.

### A project can climb toward a set goal

You give the agent a goal for the whole climb in its prompt, such as "p95 latency under 250 ms within 8 hours", and the agent puts it in the project when it creates it. The goal names a metric, a unit, and a direction, and either a `target` value or a `targetGain` percentage over the start commit, with optional `hours`. It's frozen with the project, so the agent can't lower it later, and the dashboard shows it. Every module in the project measures the goal's metric, so their gains add up to it. Module targets stay within the 20% cap, and only the project goal can go past it, since modules chain.

- **Measured, not estimated.** Each time a module ends and moves the commit the project has reached, a final job runs the benchmark on the start commit and that commit, alternating, on the verifiers of the last module that got there. A measurement still queued for a commit the project has moved past is dropped. The board line shows the goal on every line, with where the project started and where it is now.
- **The goal holds the project open.** When every module has ended, the project waits for the measurement. If it shows the goal unmet, the project is short of its goal: the board line tells the agent to add a module, which goes last and starts from the reached commit.
- **What ends it.** A measurement that shows the goal met. Its hours, counted from when the project opened: after them, no module starts, the one running finishes on its own clock, and pending modules are abandoned. Or 3 modules in a row that started and ended without a win, since an agent churning on an unreachable goal is better stopped and flagged. A planned module always gets its turn, so the last two rules only stop a project whose planned modules have run out.

New work that belongs to the open project becomes a module instead of a project. So does another approach to a goal. A new module comes with its own steps and goal, goes right after the current module, behind any modules added earlier that haven't started, and needs verifiers before it can start. The answer gives its position.

Calls name a module by its ID, which never changes. The server gives each module an ID when its project opens, `m1`, `m2`, and so on across all of an agent's projects. The board line shows its position, which shifts when a module is inserted.

## Module lifecycle

A module is `pending`, `active`, `pastTarget`, `stuck`, `passed`, or `abandoned`. A module ends when it passes or is abandoned. A stuck module has not ended.

1. A pending module becomes active once it is first in line, its verifiers are frozen, and the runner has measured its baseline. It is first in line when its project has just started, or when the module before it has ended. Its clock starts when it becomes active.
2. An active module passes when an attempt meets its target on its last step. If steps after the current step remain, the module becomes past target instead, and keeps going while it wins.
3. A past-target module passes at its first attempt that isn't a win, when its last step is done, or when it runs out of time.
4. An active module becomes stuck when its current step fails (cause `step`), when its last step is done without meeting the target (cause `target`), or when it runs out of time (cause `time`). If one result triggers more than one cause, the server records the first in that order. The server accepts no attempts or step checks on a stuck module.
5. A stuck module becomes abandoned when the agent records `abandonReason`. The reason is one sentence that names the assumption the attempts shared. The agent can also abandon a pending or active module early. Abandoning cancels any job in flight, and a result that arrives later changes nothing.
6. A module abandoned with a win keeps it. The abandon call then has to propose a follow-up module that starts from the abandoned module's best commit. The follow-up either retries the same steps with a smaller `targetGain`, or adds new steps built on that commit. A module can be retried only once, so a retry can only be built on. The follow-up goes right after the current module, starts with every step undone, and needs its own verifiers and baseline.
7. A module abandoned without a win has nothing worth keeping, so its commits are dropped.
8. Each module starts from the commit the module before it left behind: the best commit of a module that passed or was abandoned with a win, or the start commit of a module abandoned without one. A passed module's flat attempts after its last win stay behind, since the steps they prepared won't run, and a module abandoned without a win drops its flat commits too. The first module starts from the project's start commit. The abandon call and the waiting module's board line name the commit, so the agent can reset its branch to it.

## Verifiers come first

Every module needs verifiers before it can start: tests that prove each step works, regression tests for the module, and a benchmark that measures the goal's metric. A separate verifier agent writes them from the plan, in its own session, ideally for every module when the project is created.

- Verifiers freeze when they are submitted. The server keeps the files and one verifier hash over the files, the container image, the commands, the hardware label, and the job time limit.
- Each submission names its author, so the dashboard can flag verifiers written by the agent that works the module.
- You can review verifiers on the dashboard and replace any of them. A replacement takes effect like an approved change.
- An agent that finds a frozen verifier wrong files a change request. You review its diff on the dashboard, and approve or reject it with an optional note. The agent can read the request's state and your note, and until you decide, the module keeps running on the old verifiers.
- An approved change freezes the new files under a new hash. The change's edits apply to the verifiers as they are when you approve it, so approving one change never undoes another, and the verifiers keep their author. Jobs queued after that use them, and a job already in flight keeps the verifiers it was queued with. Every attempt job measures the best commit again, so later verdicts use the new verifiers on both commits. Earlier verdicts stand, and a change doesn't reopen a stuck module.
- A change to an active or past-target module measures its baseline again on the new verifiers, on the start commit and the best commit, as soon as no job is in flight. The target keeps its `targetGain` on the new baseline, so a benchmark that reads on a different scale can't make the target trivial. The clock keeps running from the first baseline, and earned extensions and the streak stand. If that baseline job fails, the module keeps its old baseline and the dashboard flags it.
- An approved change also reaches the project's modules that haven't started, when the files it changes are still what it was written against. Their baselines are then measured on the new verifiers from the start.

## A runner verifies every attempt

The agent never reports a number. For each attempt it commits its change on top of the head commit, pushes the commit where the runner can fetch it, and posts the attempt's ID, commit, and a note. Each module has at most one job in flight, and the server refuses a new attempt or step check while one is queued or running.

- **Frozen copies.** The runner fetches the best commit and the new commit and copies the frozen verifier files over each checkout. Edits the agent made to tests or the benchmark have no effect.
- **Attempts.** On the new commit, the runner runs the regression tests and the tests of every step that is done. Then it runs the benchmark 5 times on each commit, alternating. A module's verifiers can ask for more runs, up to 25, when its benchmark is noisy, since 5 runs a side can only confirm a gain when the two sets barely overlap. It sends each run's commit, value, and work count, the test results and test count, and which verifier files the commit touched.
- **Step checks.** Marking the current step done queues a step check, which is allowed while the module is active or past target. The runner runs that step's tests and the regression tests on the head commit, and the step is done only when they pass. It also runs the benchmark 5 times on the head commit and the best commit, alternating, so the server can tell whether the finished step held the metric.
- **Any workload.** The runner knows nothing about the workload. A benchmark is any command that prints each run's value and work count as one JSON line, such as `{"value": 331, "work": 12000}`. Values must be positive, because gains are percentages of them. A test command passes when it exits 0, and it can report counts as a last line such as `{"passed": 40, "total": 42}`; without one it counts as one test. A hardware label such as `gpu` sends a job to a runner that has that hardware, and the runner passes it into the job container.
- **Fetching commits.** The runner fetches commits from the project's git remote, or its own default. Commits are named by their full hash, so one commit can't pass as two. A commit it can't fetch fails the job the same way failing tests do, and so does a benchmark that crashes on the commit under test. The frozen files are written without following any symlink the commit contains, so a link can't carry them out of the checkout.
- **Baselines.** Before a module becomes active, a baseline job runs the regression tests and the benchmark 5 times on the module's start commit. The median is the baseline, and the target is the baseline improved by `targetGain`. If the baseline job fails or is killed, the module stays pending until its verifiers change or the agent abandons it, and the dashboard flags it.
- **Tokens.** Agents, runners, and you hold different tokens. Only a runner token can send results, and only the admin token can approve changes or replace verifiers.
- **Bare containers.** A job container gets its checkout and nothing else: no tokens, no Docker socket, and no network. Each commit has its own container, and every process a command leaves running is killed before the next command, so nothing slows the other commit's benchmark.
- **Leases and time limits.** The runner holding a job renews its lease while the job runs. If the lease lapses, the runner is presumed gone and the job returns to the queue for any runner to claim. A job that runs past its time limit is killed, and the time limit covers fetching the commits. A runner that holds a job 30 minutes past its time limit loses it, as if it had given up.
- **Repeat runs.** A job is identified by its kind, its commits, its step, and the verifier hash, so running it twice returns the same stored result. Reposting a commit as a new attempt gets the stored verdict instead of another roll of the dice. A job the runner couldn't run at all, such as when Docker is down, goes back in the queue. After three such tries it fails without a verdict, which doesn't count as a failed turn.

## The server judges every attempt

The server sets each attempt's verdict from the runner's results.

- A win passes the tests, its median beats the best commit's median by at least `minGain`, and a rank test (Mann-Whitney) separates the two sets of runs at p below 0.05.
- A fail has failing tests, a job killed for running past its time limit, a commit the runner can't fetch or benchmark, or runs that the rank test shows are worse than the best commit's at p below 0.05.
- Any other attempt is flat.
- A win moves both the head commit and the best commit to the new commit. A flat attempt moves only the head commit, so work that prepares later steps is kept. A fail moves neither, and the agent goes back to the head commit.
- An attempt meets the target when it is a win and its median reaches the target.
- A finished step holds the metric when the rank test doesn't show the head commit worse than the best commit at p below 0.05.
- While a module is active, its current step fails at the step's 3rd failed turn. The later steps depend on it, so the module becomes stuck. Once a module is past target, its first attempt that isn't a win passes it instead.
- A retried post with the same `attemptId` returns the stored attempt, so a retry never counts twice.
- Every verdict also goes into one table per agent, with the runner's numbers and the attempt's note. The table holds each abandoned module's reason too, so before each new idea the agent can read what it already tried and which assumptions failed.

## Modules have a time limit

Each module gets `maxMinutes` of wall-clock time from when it becomes active. The project's `maxMinutes` is the default for its modules, a module can override it, and without either the server's default of 90 minutes applies. The server refuses any `maxMinutes` above a ceiling you configure, 120 minutes by default. The ceiling caps `maxMinutes` only, and extensions come on top of it.

- The deadline is the start time plus `maxMinutes`, plus any extensions, plus the time the module's jobs spent waiting for a runner after it became active. Only one job is in flight at a time, so waits never overlap.
- No timer runs. On every request, the server recomputes the deadline and applies any transition that has come due, such as running out of time. Nothing has to survive a restart.
- Once the deadline passes, the module accepts no step checks and gets one last attempt. If an attempt is in flight at the deadline, it is the last attempt. Otherwise the module accepts one last attempt during a grace period that starts at the deadline and lasts 10% of its `maxMinutes`, 9 minutes for a 90-minute module. A step check in flight at the deadline still finishes, and the module doesn't run out of time until it has.
- The module runs out of time when its last attempt has been judged, or when the grace period ends without one. If the last attempt is a win that earns an extension moving the deadline past the present, the module carries on instead.
- Running out of time makes an active module stuck with cause `time`, and makes a past-target module pass.
- The time limit catches a module whose attempts stay flat, and an agent that stops posting attempts. Neither one fails a step, so the step rule alone never stops them.
- The dashboard and the board line show the time left, such as "38 min left". The hook shows the agent the same line. During the grace period, both say that time is up and one attempt is left.

## A module on a streak keeps going

Conservative targets are often met while a module is still improving. A streak is a run of consecutive wins in one module, and a flat or failed attempt ends it.

- **Extensions shrink.** The first extension is half the module's `maxMinutes`. It goes to the win that makes the module's first streak of 2, or to the first finished step that holds the metric, whichever comes first. After that, every win and every finished step that holds the metric earns half the previous extension. A finished step that makes the metric worse earns nothing, and so does one whose check measured the same head commit as the step before it, or the start commit: marking a step done without new work doesn't buy time. The series never restarts, and it stops once the next extension would be under 5 minutes.
- **Past target.** A target met with steps after the current step left doesn't end the module, even on its first win. It goes past target, as the lifecycle describes.
- **The blurb shows it.** While a streak lasts, the blurb says so, such as "2 wins in a row".

The server halves each extension exactly and shows it rounded. A 90-minute module earns at most 45, 22.5, 11.25, and 5.625 more minutes, shown as 45, 23, 11, and 6. The total stays under the original limit, so no module runs past twice its `maxMinutes`, not counting runner waits, the grace period, or a last attempt still in flight at the deadline.

## Goals stay conservative

The server checks every goal when it is set.

- `targetGain` is a percentage of the baseline, so the cap can be checked before the baseline is measured. The server rejects a `targetGain` above 20% unless the goal sets `ambitious: true`, and the dashboard marks ambitious goals.
- `minGain` is a percentage of the best commit's median. It defaults to 2%, and it can't exceed `targetGain`.
- A retry's `targetGain` must be smaller than the `targetGain` of the module it retries.

## The dashboard flags what doesn't add up

The defenses above block the cheats that look like normal work, such as editing a test, loosening the benchmark, keeping the best run, or marking a step done without doing it. An agent that leaves its task to attack Sherpa itself is rare, so v1 detects that instead of preventing it. The dashboard flags:

- a commit that touches a verifier file, as the runner reports it,
- fewer tests running than in the module's previous job,
- a benchmark run whose work count is below the best commit's,
- a verdict with no runner job behind it,
- verifiers whose author is the agent that works the module,
- a baseline job that failed or was killed.

## API

Agent calls carry the agent ID in the path and the agent token. Runner calls carry a runner token, and dashboard actions carry the admin token. Agents call the API with `curl`, and a thin CLI can wrap the same calls later. `{m}` is a module's ID. Repeating an agent call has no further effect.

| Call | Token | Effect |
|---|---|---|
| `POST /agents/{id}/projects` | agent | Creates a project with its start commit, modules, steps, and goals, and an optional goal for the whole climb, and returns the module IDs. While another project is open, queues it instead |
| `PUT /agents/{id}/blurb` | agent | Sets the agent's sentence in its blurb |
| `POST /agents/{id}/modules` | agent | Adds a module with its steps and goal right after the current module, and returns its ID |
| `POST /agents/{id}/modules/{m}/verifiers` | agent | Submits a module's verifiers, which freeze on submission |
| `POST /agents/{id}/modules/{m}/verifiers/changes` | agent | Files a change request for a module's frozen verifiers |
| `GET /agents/{id}/modules/{m}/verifiers/changes` | agent | Lists the module's change requests, with each decision's note |
| `GET /agents/{id}/modules/{m}/verifiers/changes/{change}` | agent | Returns a change request's state and the admin's note |
| `GET /agents/{id}/modules/{m}` | agent | Returns the module: its state, steps, goal, attempts, clock, change requests, and its verifiers' commands and file paths |
| `POST /agents/{id}/modules/{m}/attempts` | agent | Queues an attempt from its `attemptId`, `commit`, and `note` |
| `GET /agents/{id}/modules/{m}/attempts/{attemptId}` | agent | Returns the attempt's job state, and once it is judged, its verdict with the runner's medians, gain, p and test counts, a sentence on why, the step's failed turns, the streak, and the module's state |
| `GET /agents/{id}/modules/{m}/steps/{n}` | agent | Returns whether the step is done or skipped, and what its latest step check found |
| `POST /agents/{id}/modules/{m}/steps/{n}/done` | agent | Queues a step check for the current step, and marks it done when the check passes |
| `POST /agents/{id}/modules/{m}/abandon` | agent | Records the abandon reason for a pending, active, or stuck module. If the module has a win, it also takes the follow-up module. Returns the commit the next module starts from |
| `GET /agents/{id}/project` | agent | Returns the agent's project in brief: its goal, standing, and latest measurement, and each module's ID, state, steps, goal, and whether its verifiers are missing, frozen, or failed at the baseline, so a verifier agent can find the modules that need verifiers |
| `GET /agents/{id}` | agent | Returns the agent's board line, or `no open project` before its first one |
| `GET /agents/{id}/results.tsv` | agent or admin | Returns one tab-separated line for each of the agent's attempts across its projects, in the order they were posted, with its verdict, the runner's numbers, and its note, plus one for each abandoned module with its reason. An agent with no attempts gets the header alone |
| `GET /board` | agent or admin | Returns every agent's board line as plain text |
| `GET /` | admin | Serves the dashboard. Any page load (`Accept: text/html`) gets the dashboard, so `/agents/1` is a page in a browser and the board line for `curl`. A browser without the dashboard's cookie gets a sign-in page that asks for the admin token |
| `POST /signin`, `POST /signout` | none | Trades the admin token for the dashboard's cookie, and clears it. The cookie holds an HMAC of the admin token, so changing the token signs every browser out |
| `GET /api/board`, `GET /api/agents/{id}/modules/{m}/attempts/{a}` | admin | The dashboard's data: the board and an attempt's runs |
| `GET /admin/changes/{change}` | admin | Returns a change request with each changed file before and after, for review |
| `POST /admin/changes/{change}` | admin | Approves or rejects a change request, with an optional note for the agent |
| `PUT /admin/agents/{id}/modules/{m}/verifiers` | admin | Replaces a module's verifiers |
| `GET /admin/verifiers/{hash}` | admin | Returns a frozen verifier set's files, for reviewing a change request |
| `POST /jobs/claim` | runner | Claims the next job whose hardware label the runner has |
| `POST /jobs/{job}/lease` | runner | Renews the lease on a job the runner holds |
| `POST /jobs/{job}/results` | runner | Sends a job's runs, test results, and the verifier files its commit touched |

## Hooks put the board line in front of the agent

A Claude Code or Codex hook calls `GET /agents/{id}` and adds the board line to the agent's context before every model request. `UserPromptSubmit` covers the first request of each prompt. In Claude Code, `PostToolBatch` covers the rest of a long autonomous run, once per round of tool calls. Codex has no batch event, so there `PostToolUse` covers them, once per tool call. Only `SessionStart` and `UserPromptSubmit` pass plain stdout to the model, so for the other events the hook prints the line as `hookSpecificOutput.additionalContext` JSON. Codex's `PreModelRequest` fires before every model request, which would suit the line best, but Codex 0.165.0 drops its output. If the server is unreachable, the hook prints a warning and lets the agent continue, because blocking every agent on one outage would end the whole overnight run.

## Stack

- TypeScript on Node 26 for both services. Node runs `.ts` files directly, and `tsc --noEmit` checks the types.
- SQLite through the built-in `node:sqlite`. `sherpa-server` is the only writer.
- Self-hosted with one Docker Compose file and two services. `sherpa-server` runs the API, the dashboard, and the database. `sherpa-runner` claims jobs and starts a throwaway container for each one. The same file runs on a home machine or a VPS.
- The database lives in a Docker volume that only `sherpa-server` mounts, outside any project folder an agent works in.
- Commits live in a git remote that both the agents and the runner can reach. `scripts/connect.sh` makes one per repo, a bare copy in a host folder the runner mounts, and the agent pushes each commit under a ref named after it, so a reset branch never makes a measured commit unreachable.
- Benchmarks can run on their own CPU cores (`--cpuset-cpus`) when other work shares the machine.

## Not in v1

- Separate OS users or containers for agents, and hardened container runtimes such as gVisor. The dashboard's flags cover the rare agent that leaves its task.
- A held-out benchmark that only the runner holds, and a reviewer agent that reads each module's diff before it passes.
- A separate token for each agent.

## Still to test

These two are facts to measure, not choices to make.

- How many runs per commit do real benchmarks need? In three demo runs, the same commit drifted about ±5% between jobs, and with 5 runs a side, real gains under about 6% came out flat. Verifiers can now ask for more runs; what default real benchmarks need is still to measure.
- Does the board line come back soon enough after the agent's context is compacted? The hook tests never ran long enough to compact. The next round of tool calls adds the line again, but the request right after compaction may go without it.
