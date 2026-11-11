# The API

Agent calls take the agent token, runner calls the runner token, and dashboard actions the admin token, each as `Authorization: Bearer <token>`. `curl -u x:<token>` works too. Bodies are JSON (`content-type: application/json`), and the blurb also takes `text/plain`. Commits are named by their full hash. Every agent call is safe to repeat: sending the same call twice has no further effect.

Rejections come back as `{"error": "<code>", "message": "<sentence>"}`: 400 for a request that can never succeed, 404 for something missing, 409 for one that doesn't fit the current state, and 401 or 403 for a missing or wrong token. Calls that change something are refused with 403 when a browser sends them from another site.

[`agent-guide.md`](agent-guide.md) shows the agent calls in use, and [`DESIGN.md`](../DESIGN.md) has the rules behind them.

## Agents

| Call | What it does |
|---|---|
| `POST /agents/{id}/projects` | Creates a project, with an optional goal for the whole climb, or queues it while another is open |
| `GET /agents/{id}/project` | The project in brief: its goal, its state (`open`, `measuring`, `short` of its goal, or `ended`), its latest measurement, and each module's ID, state, steps, goal, and whether its verifiers are `missing`, `frozen`, or `failed` at the baseline |
| `PUT /agents/{id}/blurb` | Sets the agent's sentence |
| `POST /agents/{id}/modules` | Adds a module right after the current one, behind any added earlier that haven't started, or last in a project short of its goal |
| `GET /agents/{id}/modules/{m}` | Reads a module whole, with its verifiers' commands and file paths |
| `POST /agents/{id}/modules/{m}/verifiers` | Submits and freezes a module's verifiers |
| `POST /agents/{id}/modules/{m}/verifiers/changes` | Files a change request |
| `GET /agents/{id}/modules/{m}/verifiers/changes` | Lists the module's change requests |
| `GET /agents/{id}/modules/{m}/verifiers/changes/{change}` | Reads a change request and the admin's note |
| `POST /agents/{id}/modules/{m}/attempts` | Queues an attempt |
| `GET /agents/{id}/modules/{m}/attempts/{attemptId}` | Reads an attempt's job, its verdict with the numbers and why, the step's failed turns, the streak, and the module's state |
| `POST /agents/{id}/modules/{m}/steps/{n}/done` | Queues a step check |
| `GET /agents/{id}/modules/{m}/steps/{n}` | Reads a step and what its latest check found |
| `POST /agents/{id}/modules/{m}/abandon` | Abandons a module, with a follow-up if it has a win, and returns the commit the next module starts from |
| `GET /agents/{id}` | The agent's board line, as plain text |
| `GET /agents/{id}/results.tsv` | Every attempt across the agent's projects, oldest first, with its verdict, numbers, and note, and every abandoned module with its reason, as tab-separated text. Takes the agent or the admin token |
| `GET /board` | Every board line. Takes the agent or the admin token |

## The dashboard and the admin

| Call | What it does |
|---|---|
| `GET /` and any page | The dashboard, for any request that accepts `text/html`, so `/agents/1` is a page in a browser and the board line for `curl`. Without the admin's cookie, the sign-in page |
| `POST /signin` | Trades `{"token": "<admin token>"}` for the dashboard's cookie. Takes no token |
| `POST /signout` | Clears the cookie |
| `GET /api/board` | The dashboard's data: every agent, project, module, and attempt |
| `GET /api/agents/{id}/modules/{m}/attempts/{a}` | An attempt's runs and test results |
| `GET /admin/changes/{change}` | A change request with each changed file before and after |
| `POST /admin/changes/{change}` | Approves or rejects a change request: `{"approve": true, "note": "…"}` |
| `PUT /admin/agents/{id}/modules/{m}/verifiers` | Replaces a module's verifiers |
| `GET /admin/verifiers/{hash}` | A frozen verifier set's files |

## Runners

| Call | What it does |
|---|---|
| `POST /jobs/claim` | Claims the next job whose hardware label the runner has: `{"runner": "runner-1", "labels": ["cpu"]}`. 204 when there's none |
| `POST /jobs/{job}/lease` | Renews the lease on a job the runner holds |
| `POST /jobs/{job}/results` | Sends a job's runs, test results, and the verifier files its commit touched |
| `GET /healthz` | `ok`, with no token |
