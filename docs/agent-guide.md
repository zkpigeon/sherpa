# Working under Sherpa

These are the instructions for an agent whose hill climb Sherpa keeps on track, and for the verifier agent that writes its tests and benchmark. `scripts/connect.sh` copies them into the agent's checkout as `.sherpa/guide.md`.

## Keep going until a human stops you

Your project runs until a human stops it on the dashboard, or until the hours they set run out. Nothing else ends it. A met goal doesn't, and neither do modules that end without a win.

- Never pause to ask whether to continue, or which approach to try next. Decide, act, and say what you chose in your blurb.
- When a module ends, add the next one. When every module has ended, the board line asks for the next one. Add it right away.
- When ideas run thin, read the module's attempts and abandon reasons again. Combine two near-misses. Try a bolder approach. Go back to a module that came close.
- While you wait on a runner or the verifier, do what the board line names, such as planning the next attempt or the next module.

## Your settings

Every call carries the agent token. Load your settings with `. .sherpa/env` in the checkout. It sets `$W`, the server's address, `$ID`, your agent ID, `$AUTH`, the header `Authorization: Bearer <agent token>`, and `$REPO`, the remote the runner fetches your commits from. A shell forgets them between commands, so start each command that calls the server with `. .sherpa/env &&`. Every call is safe to repeat: sending the same call twice has no further effect.

## Your board line

The hook shows you a line like this with each prompt and after each round of tool calls:

```
agent 1: Project: search-perf, Module (2 / 5): query cache, Progress: 1 / 3, Blurb: Caching parsed queries. Goal: p95 latency 371 -> 334 ms, 10% lower. Best so far 352 ms. 38 min left.
```

The server writes everything after your sentence: the goal, the best value once you have a win, the streak, and the time left. Read the line to know which module and step you're on, and how long you have. `GET $W/agents/$ID` returns the same line, or `no open project` before you create one.

- **"Last module in the project. Plan the next one before this one ends."** Every other module has ended. Add the next module now, so it can get its verifiers while this one runs.
- **"Project: search-perf, every module has ended. Add the next module to keep climbing from 9be1c04."** The project is waiting for you. Add a module, and it starts from that commit.
- **"a7 is with the runner."** Plan the next attempt while you wait. Each wait on the line names something to do meanwhile.
- **"Project goal: p95 latency 415 -> 250 ms, now 331 ms."** The project has a goal for the whole climb, and this is how far it has come. Once it says "Project goal met", keep climbing past it.
- **When the project ends,** the line sums it up and names the commit a new project would start from, such as `Project: search-perf ended: 4 passed, 1 abandoned. p95 latency 415 -> 331 ms, 20% lower over the project. The admin stopped it. A new project would start from 9be1c04.` If the admin left a note, the line quotes it after the stop. Expand the commit with `git rev-parse 9be1c04` for a new project's `startCommit`.

## Plan the climb as a project

A project is one hill climb, split into modules. Each module is one approach to one goal, with ordered steps that build on each other. A step that fails three times makes its module stuck, so steps must depend on each other, and separate ideas go in separate modules. "Try an LRU cache" and "try an LFU cache" are two modules, not two steps.

Set goals you expect to reach. `targetGain` is the percentage you expect to improve the metric from its baseline. The server refuses more than 20% unless you set `ambitious: true`, and it marks ambitious goals on the dashboard. `minGain`, 2% by default, is the smallest improvement that counts as a win.

```sh
curl -sS -X POST "$W/agents/$ID/projects" -H "$AUTH" -H 'content-type: application/json' -d '{
  "title": "search-perf",
  "startCommit": "3f2a9c1e8d0b4a6f7c5e2d1b9a8f7e6d5c4b3a21",
  "repo": "file:///repos/search.git",
  "goal": { "metric": "p95 latency", "unit": "ms", "direction": "lower", "target": 250, "hours": 8 },
  "modules": [
    { "title": "query cache", "steps": ["Cache parsed queries", "Evict by memory size"],
      "goal": { "metric": "p95 latency", "unit": "ms", "direction": "lower", "targetGain": 10 } },
    { "title": "index layout", "steps": ["Block-compress postings"],
      "goal": { "metric": "p95 latency", "unit": "ms", "direction": "lower", "targetGain": 8 } }
  ]
}'
```

`repo` is your `$REPO`, and `startCommit` a full hash from `git rev-parse HEAD`, pushed as below. The answer lists the module IDs, such as `m1` and `m2`. Calls name a module by its ID, which never changes. While a project is open, a new project waits in your queue and starts only when the open one ends, because a human stopped it or its hours ran out. So new work goes in as a module, right after the current one and behind any you added earlier that haven't started. The answer gives its position:

```sh
curl -sS -X POST "$W/agents/$ID/modules" -H "$AUTH" -H 'content-type: application/json' \
  -d '{ "title": "early termination", "steps": ["Skip low-impact terms"], "goal": { "metric": "p95 latency", "unit": "ms", "direction": "lower", "targetGain": 10 } }'
```

A module can set `maxMinutes`, and so can a project for its modules. The default is 90 minutes and the ceiling is 120. Titles are one line: at most 80 characters for a project or module, 120 for a step, and 500 for an attempt's note.

## Aim the project at your goal

When your instructions give a goal for the whole climb, such as "p95 latency under 250 ms" or "40% lower", put it in the project as `goal`, as in the example above. Give `target` for a value to reach, or `targetGain` for a percentage better than the start commit, and `hours` when the instructions give a time limit. The goal is frozen with the project. Every module's goal measures the same metric, unit, and direction, and each module's `targetGain` stays a step toward it, at most 20% unless the module is ambitious.

- After each module that moves the project, a runner measures the start commit against the commit the project has reached, and the board line shows it. You never wait for this measurement.
- Meeting the goal doesn't end the project. Keep adding modules and climbing past it.
- Once its hours are up, no new module starts. The one running finishes on its own clock, and modules that haven't started are abandoned.

## Keep your blurb current

Each time you start something new, say what it is in one sentence. Don't repeat the goal or the time; the server adds those.

```sh
curl -sS -X PUT "$W/agents/$ID/blurb" -H "$AUTH" -H 'content-type: text/plain' -d 'Caching parsed queries.'
```

## Submit every attempt as a commit

You never report a number. For each attempt, commit your change on top of the module's head commit and push it to the remote `sherpa`, under a ref named after the commit. That keeps it fetchable after you reset your branch, and it never needs `--force`:

```sh
git push -q sherpa "HEAD:refs/sherpa/$(git rev-parse HEAD)"
```

Then post it with the commit's full hash:

```sh
curl -sS -X POST "$W/agents/$ID/modules/m1/attempts" -H "$AUTH" -H 'content-type: application/json' \
  -d "{ \"attemptId\": \"a7\", \"commit\": \"$(git rev-parse HEAD)\", \"note\": \"Cache parsed query trees by their text.\" }"
```

A runner tests and benchmarks it against the best commit, and the server judges it:

- **win**: the tests pass, the median improves by at least `minGain`, and a rank test separates the two commits at p below 0.05. The head and best commits move to your commit.
- **flat**: anything else that passes the tests. Only the head commit moves, so preparation for later steps is kept.
- **fail**: failing tests, a job killed at its time limit, a commit the runner can't fetch, or a reliably worse benchmark. Go back to the head commit.

Poll for the verdict. The answer gives the runner's numbers: `median`, `bestMedian` (the best commit's median in the same job), `gain` (percent better, negative when worse), `p`, and `tests`. It also gives `why`, one sentence such as "Flat: 1.1% lower than the best commit; needs 2%.", plus the step's failed turns, the streak, and the module's state:

```sh
curl -sS "$W/agents/$ID/modules/m1/attempts/a7" -H "$AUTH"
```

Only one job runs per module at a time, so plan the next attempt while you wait for a verdict. Reposting a commit returns its stored result; it won't be measured again. An `attemptId` is unique within its module. The answer's `lastModule` is true when every other module has ended, so add the next module before this one ends.

The test count grows as you go: an attempt runs the regression tests plus the tests of every step that's done, so finishing a step adds that step's tests to later attempts.

To see a module whole, with its steps, attempts, clock, change requests, and its verifiers' commands and file paths, read it:

```sh
curl -sS "$W/agents/$ID/modules/m1" -H "$AUTH"
```

While a job is measuring, don't run heavy work, such as a test suite or your own benchmark, on the machine the runner shares with you. It skews the runs and can turn a real gain into a flat.

## Finish steps

When the current step's work is in the head commit, mark it done. That queues a step check, which runs the step's tests on the head commit:

```sh
curl -sS -X POST "$W/agents/$ID/modules/m1/steps/1/done" -H "$AUTH"
```

The answer says `"done": false` while the check runs. Read the step to see what the check found:

```sh
curl -sS "$W/agents/$ID/modules/m1/steps/1" -H "$AUTH"
```

A module that passes before its last step skips the rest, and the step shows `"skipped": true`. A step whose check finds the same head commit as the step before it, or the start commit, is done but earns no extension: only new work buys time.

## When a module ends or gets stuck

- A module **passes** when an attempt meets its target on the module's last step. If steps remain, it goes **past target** instead and keeps going until an attempt isn't a win, its last step is done, or time runs out. So plan the steps you'd want to try even after a big early win. A passed module hands the next module its best commit, so flat attempts after its last win stay behind, and steps you never marked done are skipped.
- A module is **stuck** when a step fails three times, when its last step is done without meeting the target, or when it runs out of time. A stuck module takes no attempts. Abandon it with one sentence naming the assumption your attempts shared:

```sh
curl -sS -X POST "$W/agents/$ID/modules/m2/abandon" -H "$AUTH" -H 'content-type: application/json' \
  -d '{ "reason": "Every attempt assumed smaller postings would cut latency, but decoding them costs more than the reads save." }'
```

You can also abandon a pending or active module early, when you've learned that its approach won't reach the goal. A module abandoned without a win drops its commits, flat ones included, so the answer's `startsFrom` names the commit the next module starts from: reset your branch to it before you start that module's work. The board line names it too while the next module waits. If the module has a win, the abandon call also takes a follow-up module that starts from its best commit: either a retry of the same steps with a smaller `targetGain` (add `"retryOf": "m2"`, allowed once), or new steps built on that commit. Send it as `"followUp"` with the same fields as a new module.

## Read your results before each new idea

The server keeps one table of everything you have tried, across all your projects, written from its own records. Read it before you plan a module or post an attempt:

```sh
curl -sS "$W/agents/$ID/results.tsv" -H "$AUTH"
```

Each line is one attempt, oldest first, with its module, step, commit, verdict, the runner's numbers, and your note. The verdict is `win`, `flat`, or `fail`, and `pending` while the runner measures it. An attempt that never got a verdict says `cancelled` when you abandoned its module first, or `error` when no runner could run it. `gain_pct` is the percent better than the best commit, negative when worse. Each module you abandoned adds a line with the verdict `abandoned` and your reason.

- Before you try an idea again, check how it did last time. Repeat a flat or failed idea only when you know what is different now.
- Read the abandon reasons first. Each one names an assumption that already failed, so don't plan a module that rests on it.

Add `-o .sherpa/results.tsv` to keep a copy beside your work. Git already ignores `.sherpa/`.

## Time

The board line shows the time left. Time spent waiting for a runner doesn't count. Wins and finished steps that hold the metric earn extensions, each half the one before. When time is up, the module takes one last attempt, and the line says "Time is up, 1 attempt left."

## If you write the verifiers

The verifier agent writes a module's tests and benchmark before the module starts, in its own session. They freeze when submitted: the runner copies them over every checkout, so edits an agent makes to them have no effect, and the dashboard flags a commit that touches them.

- **Tests**: one command for the regression tests, and one for each step. A command passes when it exits 0. To report counts, print a last line such as `{"passed": 40, "total": 42}`.
- **Benchmark**: one command that measures once and prints a last line such as `{"value": 331, "work": 12000}`. The value must be positive. `work` counts what the run did, such as requests served, so the dashboard can flag a run that did less. The runner runs it 5 times on each commit, alternating. If the benchmark is noisy, set `"runs"`, up to 25, in the verifiers.
- **Container**: an image with everything the commands need. Jobs run with no network.

Work in a folder of your own, outside the agent's checkout, so the agent doesn't commit your files. To find the modules that need verifiers, list the project. Each module's `verifiers` is `missing`, `frozen`, or `failed` when the baseline job failed on them:

```sh
curl -sS "$W/agents/$ID/project" -H "$AUTH"
```

Before you submit, run every command yourself on the start commit, with your files copied over it, and check that each test passes and the benchmark prints its line. Once submitted, the verifiers are frozen, and fixing a mistake takes a change request and the admin's approval. Build the request body with a short script that reads your files, such as one in Node or Python, rather than by hand.

```sh
curl -sS -X POST "$W/agents/$ID/modules/m1/verifiers" -H "$AUTH" -H 'content-type: application/json' -d '{
  "author": "verifier",
  "image": "node:26-slim",
  "files": { "bench/latency.mjs": "…", "test/regression.test.mjs": "…", "test/step-1.test.mjs": "…", "test/step-2.test.mjs": "…" },
  "commands": {
    "regression": "node --test test/regression.test.mjs",
    "steps": ["node --test test/step-1.test.mjs", "node --test test/step-2.test.mjs"],
    "benchmark": "node bench/latency.mjs"
  },
  "hardware": "cpu",
  "timeLimitMinutes": 20
}'
```

`$ID` is the agent that works the module, and `author` is your own ID. If the baseline job fails, or a frozen verifier turns out wrong, file a change request with the files to replace, or `null` to delete one, and your ID as `author`. The module keeps running on the old verifiers until the change is approved on the dashboard:

```sh
curl -sS -X POST "$W/agents/$ID/modules/m1/verifiers/changes" -H "$AUTH" -H 'content-type: application/json' \
  -d '{ "reason": "The benchmark reads a cold cache on its first run.", "author": "verifier", "files": { "bench/latency.mjs": "…" } }'
```

The reason is one line of at most 300 characters. Read the request's state, and the admin's note once it's decided, with `GET $W/agents/$ID/modules/m1/verifiers/changes/<change>`, or list them all at `…/verifiers/changes`. An approval also reaches the project's modules that haven't started, when their copies of the changed files match. A module already running measures its baseline again on the new verifiers, so its target moves to the new scale, and its next attempt waits until that's done.
