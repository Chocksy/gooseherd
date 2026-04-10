# [Gooseherd](https://goose-herd.com)

[![CI](https://github.com/chocksy/gooseherd/actions/workflows/ci.yml/badge.svg)](https://github.com/chocksy/gooseherd/actions/workflows/ci.yml)
[![Docker](https://img.shields.io/badge/ghcr.io-gooseherd-blue)](https://github.com/chocksy/gooseherd/pkgs/container/gooseherd)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Self-hosted AI coding agent orchestrator. Turn Slack messages into tested, reviewed PRs with pipeline automation, browser verification, and cost tracking.

## Quick Start (Docker: `local` or `docker` runtime)

```bash
git clone https://github.com/chocksy/gooseherd.git
cd gooseherd
cp .env.example .env   # edit with your tokens
docker compose up -d
open http://localhost:8787
```

Or use `make docker` to build from source (includes sandbox image):

```bash
make docker
```

## Quick Start (npm)

Requires Node.js 22+ and PostgreSQL 15+.

```bash
git clone https://github.com/chocksy/gooseherd.git
cd gooseherd
npm install
cp .env.example .env   # edit with your tokens

# Start PostgreSQL (if not already running):
docker run -d --name gooseherd-pg -e POSTGRES_USER=gooseherd \
  -e POSTGRES_PASSWORD=gooseherd -e POSTGRES_DB=gooseherd \
  -p 5432:5432 postgres:17-alpine

npm run dev
open http://localhost:8787
```

Add `DATABASE_URL=postgres://gooseherd:gooseherd@localhost:5432/gooseherd` to your `.env` when running outside Docker Compose.

## How It Works

1. **Command via Slack** — mention the bot with a task and target repo.
2. **Pipeline runs** — clones repo, runs your AI agent, validates, commits, pushes.
3. **PR opens** — with changed files, cost tracking, and optional browser verification.

### Command Syntax

```
@gooseherd run owner/repo | Fix the flaky billing spec
@gooseherd run owner/repo@staging | Add nil guard on billing page
@gooseherd status
@gooseherd tail
```

Thread follow-ups reuse the repo from the latest run in that thread:
```
@gooseherd retry
@gooseherd base=main retry
```

## Slack App Setup

1. Create app at https://api.slack.com/apps
2. Enable **Socket Mode** (no public webhook needed).
3. Add bot token scopes: `app_mentions:read`, `channels:history`, `chat:write`
4. Install to your workspace.
5. Copy tokens into `.env`:
   - `SLACK_BOT_TOKEN` (`xoxb-...`)
   - `SLACK_APP_TOKEN` (`xapp-...`)
   - `SLACK_SIGNING_SECRET`

## GitHub Setup

Provide `GITHUB_TOKEN` with repo write + PR permissions (for `DRY_RUN=false`).

Optional controls:
- `REPO_ALLOWLIST=yourorg/yourrepo` — restrict which repos the bot can target
- `GITHUB_DEFAULT_OWNER=yourorg` — default owner when only repo name is given

## Agent Configuration

`AGENT_COMMAND_TEMPLATE` is fully configurable. Placeholders are shell-escaped:

| Placeholder | Description |
|-------------|-------------|
| `{{repo_dir}}` | Cloned repo directory |
| `{{prompt_file}}` | Task file path |
| `{{task_file}}` | Same as prompt_file |
| `{{run_id}}` | Unique run identifier |
| `{{repo_slug}}` | `owner/repo` |

Default uses `scripts/dummy-agent.sh` — a safe no-op test stub that creates a file and a screenshot without touching real code. Switch to your agent for real runs (the sandbox image ships with all of these pre-installed):

```bash
# pi-agent (OPENROUTER_API_KEY)
AGENT_COMMAND_TEMPLATE='cd {{repo_dir}} && pi -p @{{prompt_file}} --no-session --mode json'

# Goose (OPENROUTER_API_KEY)
AGENT_COMMAND_TEMPLATE='cd {{repo_dir}} && goose run --no-session -i {{prompt_file}}'

# OpenAI Codex CLI (CODEX_API_KEY)
AGENT_COMMAND_TEMPLATE='cd {{repo_dir}} && codex exec --full-auto "$(cat {{prompt_file}})"'

# Claude Code CLI (ANTHROPIC_API_KEY)
AGENT_COMMAND_TEMPLATE='cd {{repo_dir}} && claude -p "$(cat {{prompt_file}})" --allowedTools "Read,Edit,Write,Bash,Grep,Glob"'

# Cursor Agent CLI (CURSOR_API_KEY)
AGENT_COMMAND_TEMPLATE='cd {{repo_dir}} && cursor-agent "$(cat {{prompt_file}})" --no-interactive'
```

## Dashboard

Built-in run inspector at `http://localhost:8787`:
- Live run status and phase tracking
- Tail logs, changed files view
- Run feedback (`+1/-1` + notes)
- One-click retry for failed runs
- Cost tracking per run

## Local Trigger (No Slack)

```bash
npm run local:trigger -- yourorg/yourrepo@main "make footer full width"
```

## Deployment

See **[docs/deployment.md](docs/deployment.md)** for the full deployment guide — all environment variables, feature toggles, production tips, and docker-compose configuration.

For DevOps teams preparing a Kubernetes deployment contract, see **[docs/installation-kubernetes.md](docs/installation-kubernetes.md)**.

## Architecture

See **[docs/architecture.md](docs/architecture.md)** for the full system diagram — pipeline engine, 19 node handlers, YAML pipeline composition, and the observer auto-trigger system.

## Sandbox (optional)

Run each agent in an isolated Docker container:

```bash
# Build the sandbox image
make docker-sandbox

# Runtime mode in .env
SANDBOX_RUNTIME=local
# or
SANDBOX_RUNTIME=docker
SANDBOX_HOST_WORK_PATH=/absolute/path/to/.work
```

Or build everything at once with `make docker`.

Use this path when Gooseherd itself is running outside Kubernetes and you want local app execution or Docker sandbox execution.

## Local Kubernetes (`minikube`)

Use this path when you want Gooseherd itself to run against Kubernetes and launch per-run runner `Job`s through `SANDBOX_RUNTIME=kubernetes`.

Important distinction:

- `docker compose` is the simplest local path for `SANDBOX_RUNTIME=local` and `SANDBOX_RUNTIME=docker`
- `minikube` is the correct local path for `SANDBOX_RUNTIME=kubernetes`
- the current `docker-compose.yml` does not make the Gooseherd container Kubernetes-aware by default

### Full Local Kubernetes Deployment

The repo now includes a minimal local deployment bundle in [kubernetes/local/README.md](/home/vsevolod/work/hubstaff/gooseherd/.worktrees/kubernetes-runtime/kubernetes/local/README.md) plus helper scripts:

```bash
minikube start --driver=docker
npm run k8s:local-up
kubectl -n gooseherd port-forward svc/gooseherd 8787:8787 9090:9090
```

Useful helpers:

```bash
npm run k8s:local-status
npm run k8s:local-down
```

What `k8s:local-up` does:

- builds and loads the Gooseherd app image into `minikube`
- builds and loads the runner image into `minikube`
- deploys PostgreSQL in the `gooseherd` namespace
- generates the Gooseherd secret from your local `.env`
- deploys Gooseherd with `SANDBOX_RUNTIME=kubernetes`
- configures runner callbacks to use cluster DNS instead of `host.minikube.internal`
- bootstraps the setup wizard through a temporary local port-forward so the dashboard is ready immediately

The local app image is built from `kubernetes/app.Dockerfile`, not the heavier top-level `Dockerfile`.
The top-level image remains the right one for `docker compose` and `local|docker` runtime flows.

This is the right local path when you want a normal dashboard-triggered run to execute fully inside Kubernetes.

By default, `k8s:local-up` completes the setup wizard with the local dashboard password `gooseherd-local`.
Override it with `GOOSEHERD_LOCAL_DASHBOARD_PASSWORD=...` if you want a different local login password.

### Kubernetes Smoke Check

`SANDBOX_RUNTIME=kubernetes` is supported for normal runs when the Gooseherd process can reach the Kubernetes API and the runner pod can reach `GOOSEHERD_INTERNAL_BASE_URL`.
For the quickest local verification path, use the smoke run in `minikube`.

Prerequisites:

```bash
minikube start --driver=docker
docker compose up -d postgres gooseherd
```

Then run:

```bash
MINIKUBE_BUILD_IN_NODE=1 npm run k8s:smoke
```

What this does:

- builds `gooseherd/k8s-runner:dev`
- loads it into the `minikube` node Docker daemon
- creates a `kubernetes` run plus one-time `RUN_TOKEN`
- launches a Kubernetes `Secret` and `Job`
- waits for the runner pod to finish
- reconciles the run back into Gooseherd and cleans up Kubernetes resources

Expected success signal:

```text
[smoke] run <run-id> finalized as completed
[smoke] success
```

Notes:

- the smoke pipeline is `pipelines/kubernetes-smoke.yml`
- the runner pod reaches Gooseherd through `http://host.minikube.internal:8787`
- the flow is image-heavy; keep several GB of free disk space available before running it

### Full Local Kubernetes Path

The target local architecture is:

- PostgreSQL in `minikube`
- Gooseherd app in `minikube`
- Gooseherd service reachable from runner jobs through cluster DNS
- local browser access through `kubectl port-forward` or `minikube service`

The implementation plan for this local deployment path lives in [docs/plans/2026-04-10-local-minikube-deployment-plan.md](/home/vsevolod/work/hubstaff/gooseherd/.worktrees/kubernetes-runtime/docs/plans/2026-04-10-local-minikube-deployment-plan.md).

For the deployment contract and operational caveats, see [docs/installation-kubernetes.md](docs/installation-kubernetes.md).

## Testing

```bash
npm run check    # TypeScript type check
npm run build    # Compile
npm test         # Run test suite
```

Or use the Makefile:
```bash
make test
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
