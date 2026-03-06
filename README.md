# [Gooseherd](https://goose-herd.com)

[![CI](https://github.com/chocksy/gooseherd/actions/workflows/ci.yml/badge.svg)](https://github.com/chocksy/gooseherd/actions/workflows/ci.yml)
[![Docker](https://img.shields.io/badge/ghcr.io-gooseherd-blue)](https://github.com/chocksy/gooseherd/pkgs/container/gooseherd)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Self-hosted AI coding agent orchestrator. Turn Slack messages into tested, reviewed PRs with pipeline automation, browser verification, and cost tracking.

## Quick Start (Docker)

```bash
docker pull ghcr.io/chocksy/gooseherd:latest
cp .env.example .env   # edit with your tokens
docker compose up -d
open http://localhost:8787
```

## Quick Start (npm)

```bash
git clone https://github.com/chocksy/gooseherd.git
cd gooseherd
npm install
cp .env.example .env   # edit with your tokens
npm run dev
open http://localhost:8787
```

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

Default uses `scripts/dummy-agent.sh` for safe testing. Switch to your agent:

```bash
# Goose
AGENT_COMMAND_TEMPLATE='cd {{repo_dir}} && goose run --no-session -i {{prompt_file}}'

# pi-agent
AGENT_COMMAND_TEMPLATE='cd {{repo_dir}} && pi -p @{{prompt_file}} --no-session --mode json'
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
