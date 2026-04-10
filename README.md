# [Gooseherd](https://goose-herd.com)

[![CI](https://github.com/chocksy/gooseherd/actions/workflows/ci.yml/badge.svg)](https://github.com/chocksy/gooseherd/actions/workflows/ci.yml)
[![Docker](https://img.shields.io/badge/ghcr.io-gooseherd-blue)](https://github.com/chocksy/gooseherd/pkgs/container/gooseherd)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Self-hosted AI coding agent orchestrator. Turn Slack messages into tested, reviewed PRs with pipeline automation, browser verification, and cost tracking.

## Quick Start (Docker)

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
# reserved for future Kubernetes support; rejected at startup today
SANDBOX_RUNTIME=kubernetes
SANDBOX_HOST_WORK_PATH=/absolute/path/to/.work
```

Or build everything at once with `make docker`.

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
