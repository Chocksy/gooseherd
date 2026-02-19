# [Gooseherd](https://goose-herd.com)

Self-hosted AI coding agent orchestrator — herds [Goose](https://github.com/block/goose) agents via Slack and opens PRs.

In this first version it:

1. Accepts commands from Slack (Socket Mode, no public webhook needed).
2. Enqueues a run with task + repo target.
3. Clones repo, runs a configurable agent command (Goose-compatible template), and optional validation.
4. Commits/pushes a branch and opens a GitHub PR (unless `DRY_RUN=true`).
5. Reports live status back in Slack via an updatable run card (phase + elapsed + heartbeat).
6. Exposes an optional local dashboard to inspect runs, logs, changed files, and operator feedback.
7. Auto-recovers interrupted runs on restart by re-queuing them.

## Why this project

This is intentionally a low-infra build you can run locally or on one VM before Kubernetes/Temporal.

## Command syntax

Mention the bot in Slack:

- `@gooseherd help`
- `@gooseherd run owner/repo[@base-branch] | Fix flaky billing spec`
- `@gooseherd status` or `@gooseherd status <run-id-or-prefix>`
- `@gooseherd tail` or `@gooseherd tail <run-id-or-prefix>`
- In an existing run thread: `@gooseherd <follow-up instruction>` (reuses repo from latest run in that thread)

Note: command hint text is configurable via `SLACK_COMMAND_NAME` in `.env`.

Examples:

- `@gooseherd run hubstaff/hubstaff-server | Fix failing transferwise banner spec`
- `@gooseherd run hubstaff/hubstaff-server@staging | Add guard for nil organization on billing page`
- `@gooseherd run epiccoders/pxls@master | MVP dry run: tweak footer width`
- Thread follow-up: `@gooseherd branch is master retry`
- Thread follow-up: `@gooseherd base=master retry`

## Quick start

1. Copy env file and fill secrets:

```bash
cp .env.example .env
```

2. Install deps and run:

```bash
npm install
npm run dev
```

3. In Slack, mention your bot with a `run` command.

4. (Optional) Open dashboard:

```bash
open http://127.0.0.1:8787
```

### Local trigger (no Slack)

Use terminal trigger for deterministic testing:

```bash
npm run local:trigger -- epiccoders/pxls@master "make footer full width"
```

This writes state to `data/runs.json` and logs to `.work/<run-id>/run.log`.

## Slack app setup (Socket Mode)

1. Create app at https://api.slack.com/apps
2. Enable **Socket Mode**.
3. OAuth scopes (bot token):
- `app_mentions:read`
- `channels:history`
- `chat:write`
4. Install app to your Slack workspace.
5. Copy tokens into `.env`:
- `SLACK_BOT_TOKEN` (`xoxb-...`)
- `SLACK_APP_TOKEN` (`xapp-...`)
- `SLACK_SIGNING_SECRET`

## GitHub setup

For `DRY_RUN=false`, provide `GITHUB_TOKEN` with repo write + PR permissions.

Optional controls:

- `REPO_ALLOWLIST=hubstaff/hubstaff-server`
- `GITHUB_DEFAULT_OWNER=hubstaff`

## Goose integration

`AGENT_COMMAND_TEMPLATE` is fully configurable. Placeholders are shell-escaped for safety:

- `{{repo_dir}}`
- `{{prompt_file}}` (same as task file)
- `{{task_file}}`
- `{{run_id}}`
- `{{repo_slug}}`

Default command uses `scripts/dummy-agent.sh` for safe testing.

To switch to Goose, replace with your command wrapper, for example:

```bash
AGENT_COMMAND_TEMPLATE='cd {{repo_dir}} && goose run --no-session -i {{prompt_file}}'
```

For non-interactive OpenRouter setup, set these env vars too:

```bash
OPENROUTER_API_KEY=...
GOOSE_PROVIDER=openrouter
GOOSE_MODEL=<openrouter-model-id>
AGENT_TIMEOUT_SECONDS=1200
AGENT_COMMAND_TEMPLATE='cd {{repo_dir}} && goose run --no-session --no-profile --with-builtin developer,todo --debug --max-turns 60 --max-tool-repetitions 6 --provider openrouter --model $GOOSE_MODEL -i {{prompt_file}}'
```

If your Goose CLI syntax differs, keep a wrapper script and point the template to it.

Use `@gooseherd tail` (or `@gooseherd tail <run-id>`) to view recent in-progress logs directly in Slack.

Runs now include a live status card in-thread. If a run is actively progressing, the card updates every heartbeat interval.

## Dashboard

The built-in dashboard is useful when you want a Stripe-like run inspector without leaving local dev.

- URL: `http://<DASHBOARD_HOST>:<DASHBOARD_PORT>`
Features:
- Runs list with live status/phase
- Tail logs view
- Changed files view
- Run feedback capture (`👍/👎 + note`)
- One-click retry for failed/completed runs

Relevant env vars:

- `SLACK_COMMAND_NAME=gooseherd`
- `DASHBOARD_ENABLED=true|false`
- `DASHBOARD_HOST=127.0.0.1`
- `DASHBOARD_PORT=8787`
- `SLACK_PROGRESS_HEARTBEAT_SECONDS=20`

## Branding

Branding is fully configurable via the `APP_NAME` environment variable. Set `APP_NAME=Hubble` to run as "Hubble", or leave the default for "Gooseherd". Everything derives from this single variable: dashboard title, commit prefix, branch prefix, bot name, git author.

## Workflow Files

Multi-agent/validator workflow definitions are versioned under `workflows/`:

- `workflows/gooseherd-team.workflow.yml`
- `workflows/validators.workflow.yml`

These files define stage ownership and validation gates (`check`, `build`, `test`) for repeatable delivery.

## Testing

Run the verification suite:

```bash
npm run check
npm run build
npm test
```

## Validation strategy for large Rails repos

Set `VALIDATION_COMMAND` to a fast gate instead of full suite. Example:

```bash
VALIDATION_COMMAND='bash scripts/validate-fast-example.sh {{repo_dir}}'
```

Use full matrix/coverage in CI after PR creation.

## Single VM deployment

1. Provision Ubuntu VM.
2. Run bootstrap:

```bash
bash scripts/bootstrap-vm.sh
```

3. Deploy service:

```bash
cp .env.example .env
# fill .env
npm install
npm run build
npm start
```

Or Docker:

```bash
docker compose up --build -d
```

## Known limitations

- Single-process queue only (no distributed orchestration).
- File-based state store.
- No sandbox isolation yet (runs on host runtime).
- No policy engine yet (repo/task restrictions are basic allowlists).

## Next iteration

1. Move run execution into ephemeral containers/VM workers.
2. Add PostgreSQL for durable run state.
3. Add policy checks for high-risk paths.
4. Add staged validation profiles by risk level.
