<img src="assets/icon.svg" width="64" height="64" alt="">

# Sherpa

Sherpa keeps long-running AI coding agents on track overnight. Each agent splits its hill climb into modules and steps, submits every attempt as a commit, and keeps a one-sentence blurb current. A runner measures each attempt with frozen tests and a benchmark the agent can't change, and the server judges it. A module that fails a step, misses its target, or runs out of time becomes stuck, and the agent moves on to another approach. A module that keeps winning earns more time.

![The board: a tile per agent with its module, metric, target, and blurb](assets/dashboard-board.png)

Created in [T3 Code](https://t3.codes).

## How it works

1. **You connect a checkout to an agent and give it a goal,** such as "p95 latency under 250 ms within 8 hours". The agent plans a project toward it: one hill climb, split into modules. Each module is one approach with its own smaller goal, such as "10% lower", and ordered steps.
2. **A verifier agent writes the tests and benchmark** for each module, in its own session. They freeze when submitted, so the agent that climbs can't change them.
3. **The agent commits each attempt and posts its hash.** It never reports a number.
4. **A runner measures the attempt** in a container with no network. It runs the tests on the new commit, then the benchmark on it and on the best commit, taking turns.
5. **The server judges the attempt.**
   - A win moves the best commit and can earn more time.
   - A flat keeps the work but not the credit.
   - A fail sends the agent back.

   Three failed turns on one step, a target missed after the last step, or running out of time makes the module stuck. The agent then abandons it with a sentence naming the assumption that failed.

   After each module that moves the project, the runner measures the start commit against the new best. The project stays open until that shows the goal met, the hours are up, or 3 modules in a row end without a win.
6. **A hook shows the agent its board line** before each model request, so it always knows its module, step, goal, and time left:

   ```
   agent 1: Project: search-perf, Module (2 / 5): query cache, Progress: 1 / 3, Blurb: Caching parsed queries. Goal: p95 latency 371 -> 334 ms, 10% lower. Best so far 352 ms. 38 min left.
   ```

You watch it all on the dashboard, and approve or reject the verifier changes agents ask for. [`DESIGN.md`](DESIGN.md) has the full rules.

## Quick start

You need git and Docker with the Compose plugin, on a home machine or a VPS. The first build downloads the Node and Docker CLI images, a few hundred MB.

```sh
git clone https://github.com/zkpigeon/sherpa.git
cd sherpa
sh scripts/setup.sh
```

`setup.sh` writes `.env` with three new tokens, then builds and starts the two services. It ends by printing where the dashboard is:

```
Sherpa is running.

  Dashboard     http://127.0.0.1:8080
  Admin token   3f9c0e…
```

Open the dashboard and paste the admin token to sign in. The browser stays signed in for 30 days. To see the token again, run `grep ADMIN .env`.

Run `setup.sh` again whenever you like, such as after a `git pull`. It keeps `.env`, the database, and the repos, and rebuilds the images.

## Connect a project

### 1. Connect the checkout

Pick the checkout the agent will work in, and give the agent an ID, such as `1`:

```sh
sh scripts/connect.sh ~/code/search 1
```

| It sets up | Where | For |
|---|---|---|
| A bare copy of the repo | `repos/search.git` in this folder. The runner sees it as `file:///repos/search.git` | The runner fetches the agent's commits from it |
| The remote `sherpa` | The checkout, pointing at that copy | The agent pushes each attempt there |
| `.sherpa/env` | The checkout | The server's address, the agent's ID and token, and the repo's address for the runner |
| `.sherpa/hook.sh` and `.sherpa/guide.md` | The checkout | The board line hook, and the agent's instructions |
| `.claude/settings.local.json` and `.codex/hooks.json` | The checkout, unless they exist | The hooks for Claude Code and for Codex |

Git ignores every file it writes, through the repo's `.git/info/exclude`, so the token never lands in a commit.

Give each agent a checkout of its own. Agents on the same repo share its bare copy. If an agent works in a git worktree, as T3 Code makes for a thread, connect that worktree.

`connect.sh` then prints the agent's board line, which shows the hook can reach the server, and the two prompts below with your values filled in.

### 2. Start the agent

Start Claude Code or Codex in the checkout, with a prompt that names your goal:

```
You're agent 1 on Sherpa. Read .sherpa/guide.md and follow it.
Your goal: p95 latency under 250 ms on the benchmark queries, within 8 hours.
Plan the climb as a project with that as its goal, starting from commit
3f2a9c1e8d0b4a6f7c5e2d1b9a8f7e6d5c4b3a21, with repo file:///repos/search.git.
```

The agent creates a project, and its modules wait for verifiers. The goal is frozen with the project, so the agent can't lower it later, and the dashboard shows it.

A goal can be a value to reach, as above, or a percentage, such as "40% lower than now". Leave out the hours to let it run until it gets there or stops winning. Leave out the goal altogether, and the project ends when the modules the agent planned run out.

### 3. Start the verifier

Start a second session in a folder of its own, so the agent doesn't commit the verifier's files:

```
You write the verifiers for agent 1 on Sherpa. Load the settings
with . ~/code/search/.sherpa/env and read ~/code/search/.sherpa/guide.md, the
part "If you write the verifiers" above all. Every few minutes, list the
modules with curl -sS "$W/agents/$ID/project" -H "$AUTH". Freeze verifiers
for each one whose "verifiers" is "missing", and file a change request for
each one whose "verifiers" is "failed", until the project ends.
```

Once a module has verifiers, the runner measures its baseline, and the module starts.

### 4. Watch the dashboard

The board shows a tile for each agent: its current module, the metric against its target, and its blurb. Open an agent to see its board line, modules, steps, attempts, and clock. Open an attempt to see each run the runner measured.

The dashboard also flags anything that needs a look:

- a commit that touches verifier files
- an attempt that runs fewer tests, or does less work per run
- verifiers written by the agent that works the module
- a baseline that failed

An agent that finds a frozen verifier wrong files a change request. It appears on the agent's page. **Review** shows the diff, and you approve or reject it with an optional note for the agent. Until you decide, the module keeps running on the old verifiers.

![An agent's page: its board line and every module, with why each abandoned one failed](assets/dashboard-agent.png)

## Configuration

`.env` holds the settings. After you change it, run `sh scripts/setup.sh` or `docker compose up -d`.

| Setting | Default | What it does |
|---|---|---|
| `SHERPA_AGENT_TOKEN`, `SHERPA_RUNNER_TOKEN`, `SHERPA_ADMIN_TOKEN` | Set by `setup.sh` | Three different random strings of at least 16 characters. Agents use the agent token, runners the runner token, and you the admin token |
| `SHERPA_BIND` | `127.0.0.1` | The host address sherpa-server listens on |
| `SHERPA_PORT` | `8080` | The host port |
| `SHERPA_DEFAULT_MAX_MINUTES` | `90` | A module's time limit when its plan sets none |
| `SHERPA_MAX_MINUTES_CEILING` | `120` | The most a plan can set. Extensions come on top |
| `SHERPA_LEASE_MINUTES` | `2` | How long a job stays with a runner that stops renewing it before another runner can take it |
| `SHERPA_RUNNER_NAME` | `runner-1` | The runner's name on the dashboard |
| `SHERPA_LABELS` | `cpu` | The hardware the runner has, such as `cpu,gpu`. A job goes to a runner with its verifiers' `hardware` label |
| `SHERPA_REPO` | None | The remote for projects that name no `repo` |
| `SHERPA_REPOS` | `./repos` | The host folder of bare repos, which the runner mounts read-only at `/repos` |
| `SHERPA_CPUSET` | None | Pins job containers to these cores, such as `2-5`, for steadier benchmarks |
| `SHERPA_MEMORY` | None | A memory limit for each job container, such as `4g` |

If you change a token, run `connect.sh` again on each checkout to update its `.sherpa/env`.

## Run it on a server, or add runners

**Reach it from other machines.** Keep `SHERPA_BIND=127.0.0.1`, and put a TLS proxy on the same machine in front of it. With [Caddy](https://caddyserver.com), that's a Caddyfile of:

```
sherpa.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

The dashboard's cookie is marked `Secure` once the proxy says the request came over HTTPS, as Caddy does.

**Agents on other machines.** `connect.sh` expects the checkout on the machine that runs the runner, because the agent pushes to the bare copy in a local folder. An agent elsewhere needs a remote that both it and the runner can reach. The runner fetches without credentials, so that's a public repo or a git server on your network. Name that remote as the project's `repo`, and push to it. For the agent's `.sherpa/`, connect a checkout on the server with `--url https://sherpa.example.com`, copy its `.sherpa/` to the agent's checkout, and set `REPO` in `.sherpa/env` to that remote.

**More runners,** such as one with a GPU. Clone this repo on that machine, build the runner image, and start it against the server:

```sh
docker build --target runner -t sherpa-runner .
docker run -d --restart unless-stopped --name sherpa-runner \
  -e SHERPA_URL=https://sherpa.example.com -e SHERPA_RUNNER_TOKEN=<runner token> \
  -e SHERPA_RUNNER_NAME=gpu-1 -e SHERPA_LABELS=gpu \
  -v /var/run/docker.sock:/var/run/docker.sock -v sherpa-work:/work sherpa-runner
```

A `gpu` job gets the machine's GPUs (`--gpus all`), which takes the NVIDIA Container Toolkit.

## Day to day

```sh
docker compose ps                     # are both services up?
docker compose logs -f sherpa-runner    # the jobs it claims and finishes
docker compose stop                   # the runner drops its job, which runs again after start
docker compose start
sh scripts/setup.sh                   # after git pull: rebuild and restart
```

The database lives in the `sherpa-data` volume. To back it up, stop the server and copy the database out:

```sh
docker compose stop sherpa-server
docker compose cp sherpa-server:/data/sherpa.db ./sherpa-backup.db
docker compose start sherpa-server
```

To restore a backup, copy it back the same way, into `sherpa-server:/data/sherpa.db`. `docker compose down -v` deletes the database and the runner's cache for good.

## Troubleshooting

- **The sign-in page says the token is wrong.** The dashboard takes the admin token, `SHERPA_ADMIN_TOKEN` in `.env`. If you paste another token, the page says which one it was.
- **A module is "Waiting for its verifiers."** No verifiers have been submitted for it yet. Start the verifier session, step 3 above.
- **A module says "Its baseline failed on its verifiers."** The tests failed on the start commit, or the benchmark printed no value. The module's flag on the dashboard says which. The verifier fixes it with a change request, and you approve it on the agent's page.
- **An attempt fails because the runner can't fetch its commit.** The agent didn't push the commit. It needs `git push -q sherpa "HEAD:refs/sherpa/$(git rev-parse HEAD)"` before posting.
- **The hook says "sherpa-server didn't answer."** Check `docker compose ps`, and check `SHERPA_URL` in the checkout's `.sherpa/env`.
- **The hook says "sherpa-server answered 401."** The agent token changed. Run `connect.sh` on the checkout again.
- **Jobs stay queued.** Check `docker compose logs sherpa-runner`. A job waits for a runner whose `SHERPA_LABELS` includes its verifiers' `hardware`.
- **Codex doesn't show the board line.** Codex runs a hook only once you trust it. See below.
- **`connect.sh` says `repos` isn't writable.** Docker created the folder as root, which happens when Compose starts before `setup.sh` has run. Run `sudo chown $(id -un) repos`.
- **`setup.sh` can't start the services.** If the port is taken, set `SHERPA_PORT` in `.env`. Otherwise, `docker compose logs` shows why.

## The hooks

`connect.sh` writes the hooks for you. This is what it writes, in case you need to merge them into settings that already exist.

`.sherpa/hook.sh` prints the agent's board line. It reads `.sherpa/env`, the file beside it, or `SHERPA_URL`, `SHERPA_AGENT_ID`, and `SHERPA_AGENT_TOKEN` from the environment. If the server is down, it says so and lets the agent carry on.

With no argument, the hook prints plain text, which reaches the model only from `SessionStart` and `UserPromptSubmit`. Give it the event's name and it prints the JSON every other event needs, `hookSpecificOutput.additionalContext`.

In Claude Code, the hooks go in `.claude/settings.local.json`. `UserPromptSubmit` shows the line with each prompt, and `PostToolBatch` shows it again after each round of tool calls, so the agent sees it before every model request of a long autonomous run:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "sh \"$CLAUDE_PROJECT_DIR/.sherpa/hook.sh\"" }] }],
    "PostToolBatch": [{ "hooks": [{ "type": "command", "command": "sh \"$CLAUDE_PROJECT_DIR/.sherpa/hook.sh\" PostToolBatch" }] }]
  }
}
```

In Codex, they go in `.codex/hooks.json`. Codex has no batch event, so `PostToolUse` shows the line after each tool call, once per call when calls run in parallel:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "sh .sherpa/hook.sh" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "sh .sherpa/hook.sh PostToolUse" }] }]
  }
}
```

Codex runs a hook only once you trust it, and `codex exec` skips untrusted hooks without a warning. Review the hooks in the interactive `codex`, or pass `--dangerously-bypass-hook-trust` to `codex exec`.

These choices come from runs of more than 20 tool calls on Claude Code 2.1.314 and Codex CLI 0.165.0. `PreToolUse` and `PostToolUse` also reach the model in both tools, but only as JSON, and Claude Code's `PostToolUse` fires once per call, where `PostToolBatch` fires once per round. Codex's `PreModelRequest` fires before every model request, but Codex drops its output.

## The API

Agents call the API with `curl`, and [`docs/agent-guide.md`](docs/agent-guide.md) shows them how. [`docs/api.md`](docs/api.md) lists every call, with the token it takes.

## Develop

Node 26 runs the TypeScript sources directly.

```sh
npm install
npm test            # domain, HTTP, hook, runner (its Docker part needs busybox:1.37), dashboard
npm run typecheck
npm run dev         # the dashboard on mock data, at http://127.0.0.1:5320
```

| Folder | What's in it |
|---|---|
| `src/server/domain` | The rules: records, the lifecycle table, commands, the judge, and the board view. There's no I/O, so the dashboard's mock runs the same code |
| `src/server` | The SQLite store, the HTTP API, the sign-in, and `main.ts` |
| `src/runner` | Checkouts, the Docker and local executors, and the job loop |
| `src/dashboard` | The React dashboard. `VITE_DATA=mock` builds it on scripted demo data, as the hosted demo does |
| `src/shared` | The contract between the server and the dashboard, and the board line |
| `scripts` | `setup.sh`, `connect.sh`, the hook, and `shoot.mjs`, which screenshots dashboard pages |

To run the services without Docker, set the three tokens and run `npm run build && npm run server`, then `SHERPA_URL=http://127.0.0.1:8080 npm run runner`. `npm run build:demo` builds the dashboard on mock data for static hosting.
