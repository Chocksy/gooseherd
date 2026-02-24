# Gooseherd Installation & Configuration Tiers: Research Document

**Date:** 2026-02-21
**Status:** Research / Proposal
**Author:** Engineering research session

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State Analysis](#2-current-state-analysis)
3. [Tier 0 -- Barebones "Just Works"](#3-tier-0----barebones-just-works)
4. [Tier 1 -- Standard "Production Ready"](#4-tier-1----standard-production-ready)
5. [Tier 2 -- Enterprise "Full System"](#5-tier-2----enterprise-full-system)
6. [Installation Flow Design](#6-installation-flow-design)
7. [Configuration Management Strategy](#7-configuration-management-strategy)
8. [Multi-Tenant Architecture](#8-multi-tenant-architecture)
9. [Comparison with Similar Tools](#9-comparison-with-similar-tools)
10. [Upgrade Path: Tier 0 to Tier 2](#10-upgrade-path-tier-0-to-tier-2)
11. [Recommendations](#11-recommendations)

---

## 1. Executive Summary

Gooseherd currently requires ~30 environment variables, manual Goose installation, and a clone-and-configure workflow. This is too much friction for first-time adopters.

This document proposes a three-tier onboarding system modeled after Terraform's progressive disclosure pattern and Renovate's self-hosted flexibility:

- **Tier 0** (3 env vars): `docker compose up` and go. Slack trigger, agent codes, PR created.
- **Tier 1** (8-10 env vars): Adds CI integration, validation, CEMS memory.
- **Tier 2** (full config file): Observer system, browser automation, multi-repo pipelines, LLM-as-judge.

The key insight: **sensible defaults eliminate 80% of configuration**. The current `.env.example` has 30+ variables, but only 3-4 are truly required for a working system. Everything else either has a safe default or is an optional feature.

---

## 2. Current State Analysis

### 2.1 Current Required Configuration

Analyzing `src/config.ts`, only **3 variables** are validated as `z.string().min(1)` (truly required):

| Variable | Required? | Why |
|----------|-----------|-----|
| `SLACK_BOT_TOKEN` | Yes | Socket mode connection |
| `SLACK_APP_TOKEN` | Yes | Socket mode connection |
| `SLACK_SIGNING_SECRET` | Yes | Request verification |

Everything else is `z.string().optional()` with sensible defaults in `loadConfig()`.

### 2.2 Effectively Required (for useful output)

| Variable | Default | Why needed |
|----------|---------|------------|
| `GITHUB_TOKEN` | none | Without it, `DRY_RUN=true` (no PRs created) |
| `AGENT_COMMAND_TEMPLATE` | `bash scripts/dummy-agent.sh ...` | The dummy agent does nothing useful |
| `OPENROUTER_API_KEY` | none | Agent needs an LLM provider |
| `DRY_RUN` | `true` | Must be set to `false` for real PRs |

### 2.3 Current Pain Points

1. **30+ env vars in `.env.example`** -- overwhelms new users even though most are optional
2. **No Goose auto-installation** outside Docker -- bare-metal users must install separately
3. **Agent command template** is the hardest thing to get right -- requires understanding Goose CLI flags
4. **Slack App creation** is a multi-step GitHub-external process with no guidance
5. **No config validation feedback** -- if you misconfigure, you get cryptic runtime errors
6. **No wizard or interactive setup** -- just "read the .env.example and figure it out"

---

## 3. Tier 0 -- Barebones "Just Works"

### 3.1 Philosophy

A new company should go from "zero" to "Slack bot that creates PRs" in under 15 minutes. This means:

- Single `docker compose up` command
- Goose is pre-installed in the Docker image (already true)
- All agent configuration is baked in with opinionated defaults
- No CI integration, no validation, no observer system
- Just: **Slack trigger -> clone -> agent codes -> commit -> push -> PR**

### 3.2 Minimum Env Vars: 4

```env
# The only things you must provide:
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
GITHUB_TOKEN=ghp_...
```

That is it. Everything else gets defaults:

| Currently Required Config | Tier 0 Default |
|--------------------------|----------------|
| `OPENROUTER_API_KEY` | **Required as 5th var** if using OpenRouter, OR auto-detected from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` |
| `AGENT_COMMAND_TEMPLATE` | Built-in default: `cd {{repo_dir}} && goose run -n gooseherd-{{run_id}} --no-profile --with-builtin developer --max-turns 40 --provider openrouter --model anthropic/claude-sonnet-4 -i {{prompt_file}}` |
| `DRY_RUN` | `false` (the whole point is to create PRs) |
| `GOOSE_PROVIDER` | `openrouter` |
| `GOOSE_MODEL` | `anthropic/claude-sonnet-4` |
| `RUNNER_CONCURRENCY` | `1` |
| `VALIDATION_COMMAND` | empty (skip validation) |
| `REPO_ALLOWLIST` | empty (allow all repos the token can access) |
| `DASHBOARD_ENABLED` | `true` |

### 3.3 The Tier 0 Pipeline (hardcoded)

```
Slack mention
  -> parse repo + task
  -> git clone
  -> goose agent runs on task
  -> git add -A && git commit
  -> git push
  -> gh pr create
  -> Slack reply with PR link
```

No validation. No lint fix. No retry loops. No memory. Just the core loop.

### 3.4 Tier 0 Docker Compose

```yaml
# gooseherd-quickstart/docker-compose.yml
services:
  gooseherd:
    image: ghcr.io/chocksy/gooseherd:latest
    env_file: .env
    volumes:
      - gooseherd-data:/app/data
    ports:
      - "8787:8787"
    restart: unless-stopped

volumes:
  gooseherd-data:
```

With a `.env` file containing only:

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
GITHUB_TOKEN=ghp_...
OPENROUTER_API_KEY=sk-or-...
```

**Total: 5 env vars** (4 integrations + 1 LLM key).

### 3.5 Key Design Decision: Built-in Agent Template

The biggest simplification is making the agent command template a **built-in default** rather than requiring users to construct the Goose CLI invocation themselves. The `loadConfig()` function currently defaults to the dummy agent. For Tier 0, it should default to a real Goose invocation.

Proposed new default for `AGENT_COMMAND_TEMPLATE`:

```
cd {{repo_dir}} && goose run -n gooseherd-{{run_id}} --no-profile --with-builtin developer --max-turns 40 -i {{prompt_file}}
```

The `--provider` and `--model` flags should be injected by Gooseherd based on auto-detected env vars (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`).

### 3.6 What Gets Stripped Away

| Feature | Tier 0 Status |
|---------|--------------|
| Validation/linting | Removed |
| CEMS memory | Removed |
| Observer system | Removed |
| Browser automation | Removed |
| Follow-up template | Removed (single template) |
| Workspace cleanup | On (automatic, no config) |
| Dashboard | On (no auth) |
| Multi-repo | Works (no allowlist = all repos) |
| Concurrency | 1 runner |

---

## 4. Tier 1 -- Standard "Production Ready"

### 4.1 What It Adds

Tier 1 is for teams that have validated Tier 0 works and now want production guardrails:

1. **CI integration** -- wait for GitHub Actions to pass before merging
2. **Validation command** -- run tests/linting before pushing
3. **Structured error re-prompting** -- if validation fails, re-run agent with error context (already built)
4. **CEMS memory** -- agents learn from past runs
5. **Follow-up template** -- enable `--fork` for session continuity
6. **Repo allowlist** -- lock down which repos can be used
7. **Channel allowlist** -- restrict which Slack channels can trigger runs

### 4.2 Additional Env Vars (4-6 more, total 8-11)

```env
# --- Everything from Tier 0, plus: ---

# Validation (run tests before pushing)
VALIDATION_COMMAND=cd {{repo_dir}} && npm test
# or: cd {{repo_dir}} && bundle exec rspec
# or: cd {{repo_dir}} && pytest

# Optional lint auto-fix
LINT_FIX_COMMAND=cd {{repo_dir}} && npm run lint:fix

# Memory (agent learns from past runs)
CEMS_ENABLED=true
CEMS_API_URL=http://cems:8100
CEMS_API_KEY=your-cems-key

# Access control
REPO_ALLOWLIST=myorg/repo-a,myorg/repo-b
SLACK_ALLOWED_CHANNELS=C0123456789
```

### 4.3 Tier 1 Docker Compose

```yaml
services:
  gooseherd:
    image: ghcr.io/chocksy/gooseherd:latest
    env_file: .env
    volumes:
      - gooseherd-data:/app/data
      - gooseherd-work:/app/.work
      - goose-sessions:/root/.local/share/goose
    ports:
      - "8787:8787"
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 4G
          cpus: "2.0"

  # CEMS memory service (optional but recommended)
  cems:
    image: ghcr.io/chocksy/cems:latest
    environment:
      - DATABASE_URL=sqlite:///data/cems.db
    volumes:
      - cems-data:/data
    restart: unless-stopped

volumes:
  gooseherd-data:
  gooseherd-work:
  goose-sessions:
  cems-data:
```

### 4.4 The Tier 1 Pipeline

```
Slack mention
  -> parse repo + task
  -> search CEMS for relevant memories
  -> git clone
  -> goose agent runs on task (with memory context)
  -> lint auto-fix (if configured)
  -> validation command (tests, linting)
  -> if validation fails: re-run agent with error context (up to MAX_VALIDATION_ROUNDS)
  -> git add -A && git commit
  -> git push
  -> gh pr create
  -> store run completion in CEMS
  -> Slack reply with PR link
```

---

## 5. Tier 2 -- Enterprise "Full System"

### 5.1 What It Adds

Tier 2 is the full Gooseherd with every feature enabled:

1. **Observer system** -- Sentry error monitoring, GitHub webhook triggers, scheduled runs
2. **Browser automation** -- test against review app URLs
3. **Multi-MCP extension support** -- custom tool servers for agents
4. **LLM-as-judge quality gates** -- secondary LLM reviews agent output before PR
5. **Custom pipelines per repo** -- different validation/agent configs per repository
6. **Multiple agent concurrency** -- parallel runs
7. **Dashboard with auth** -- Traefik basic auth or OAuth
8. **GitHub App auth** -- instead of PAT, use proper GitHub App installation tokens

### 5.2 Configuration Model Shift

At Tier 2, env vars alone are insufficient. This tier needs a **configuration file** (`gooseherd.yml` or `gooseherd.config.ts`) for:

- Per-repo pipeline definitions
- Observer rules
- MCP extension declarations
- Quality gate configurations

### 5.3 Proposed `gooseherd.yml` (Tier 2)

```yaml
# gooseherd.yml -- central configuration
version: 2

defaults:
  agent:
    provider: openrouter
    model: anthropic/claude-sonnet-4
    maxTurns: 60
    timeout: 1200
  validation:
    maxRetries: 2
  git:
    authorName: "Gooseherd Bot"
    authorEmail: "gooseherd@company.com"
    branchPrefix: "gooseherd"
    defaultBase: "main"

repos:
  "myorg/backend":
    validation: "cd {{repo_dir}} && bundle exec rspec"
    lintFix: "cd {{repo_dir}} && bundle exec rubocop -A"
    agent:
      model: anthropic/claude-sonnet-4
      maxTurns: 80
      extensions:
        - name: cems-memory
          command: "cems-mcp"
        - name: sentry
          command: "sentry-mcp --org myorg"

  "myorg/frontend":
    validation: "cd {{repo_dir}} && npm test && npm run lint"
    lintFix: "cd {{repo_dir}} && npm run lint:fix"
    agent:
      model: anthropic/claude-sonnet-4
      maxTurns: 40

observers:
  sentry:
    enabled: true
    dsn: "${SENTRY_DSN}"
    triggerOn:
      - newIssue
      - regressionDetected
    autoFix: true
    targetRepos:
      - "myorg/backend"

  github:
    enabled: true
    webhookSecret: "${GITHUB_WEBHOOK_SECRET}"
    triggerOn:
      - issueLabeled: "gooseherd"
      - issueAssigned: "gooseherd-bot"

  schedule:
    enabled: true
    jobs:
      - cron: "0 9 * * 1"  # Every Monday 9am
        repo: "myorg/backend"
        task: "Update all deprecated API calls"

qualityGates:
  llmJudge:
    enabled: true
    model: anthropic/claude-sonnet-4
    criteria:
      - "Changes are minimal and focused on the task"
      - "No unrelated refactoring"
      - "Tests cover the new functionality"
    passThreshold: 0.8

concurrency:
  maxRunners: 4
  queueStrategy: "fifo"  # or "priority"

dashboard:
  auth:
    type: "basic"  # or "oauth", "none"
    users:
      - "${DASHBOARD_USER}:${DASHBOARD_PASS}"
```

### 5.4 Why a Config File at Tier 2

Environment variables work for flat key-value pairs but break down for:
- **Nested structures** (per-repo pipeline configs)
- **Lists** (MCP extensions, observer rules, quality gate criteria)
- **Conditional logic** (different models per repo)
- **Readability** (a 50-line YAML is more maintainable than 50 env vars)

The config file should be **additive** to env vars, not a replacement. Env vars override config file values (following Railway and Vercel's pattern), so deployment platforms can inject secrets.

---

## 6. Installation Flow Design

### 6.1 `npx create-gooseherd` Wizard

Modeled after `create-t3-app` and `create-next-app`, the wizard asks only what it needs and provides progressive disclosure.

```
$ npx create-gooseherd

  Welcome to Gooseherd! Let's set up your AI agent orchestrator.

  ? Where do you want to create the project? (./gooseherd)
  ? Which tier do you want to start with?
    > Tier 0 - Quick Start (Slack + agent + PRs)
      Tier 1 - Production (+ validation + memory)
      Tier 2 - Enterprise (+ observers + multi-repo pipelines)

  --- Slack Setup ---
  ? Do you have a Slack App already?
    > No, help me create one
      Yes, I have my tokens

  [If "No":]
  Great! Follow these steps:
  1. Go to https://api.slack.com/apps
  2. Click "Create New App" > "From a manifest"
  3. Paste this manifest:

  [outputs pre-built Slack App manifest YAML]

  4. Install the app to your workspace
  5. Copy the tokens from the "OAuth & Permissions" page

  ? Paste your SLACK_BOT_TOKEN: xoxb-...
  ? Paste your SLACK_APP_TOKEN: xapp-...
  ? Paste your SLACK_SIGNING_SECRET: ...

  --- GitHub Setup ---
  ? How do you want to authenticate with GitHub?
    > Personal Access Token (quick start)
      GitHub App (recommended for production)

  [If PAT:]
  ? Paste your GITHUB_TOKEN: ghp_...

  --- AI Provider ---
  ? Which LLM provider do you want to use?
    > OpenRouter (recommended - access to all models)
      Anthropic (direct API)
      OpenAI (direct API)

  ? Paste your OPENROUTER_API_KEY: sk-or-...

  --- Deployment ---
  ? How do you want to run Gooseherd?
    > Docker Compose (recommended)
      Bare metal (Node.js)
      Coolify
      Railway

  Creating your project...
  - Generated .env with 5 variables
  - Generated docker-compose.yml
  - Generated gooseherd.yml (minimal)

  Done! Start Gooseherd:
    cd gooseherd && docker compose up -d

  Dashboard: http://localhost:8787
  Slack: @gooseherd run owner/repo | your task
```

### 6.2 What the Wizard Auto-Detects

If run inside an existing repo (for per-repo config):

| Signal | Detection | Action |
|--------|-----------|--------|
| `package.json` + `jest` in devDeps | Node.js + Jest | Set `VALIDATION_COMMAND=cd {{repo_dir}} && npm test` |
| `Gemfile` + `rspec` | Ruby + RSpec | Set `VALIDATION_COMMAND=cd {{repo_dir}} && bundle exec rspec` |
| `pyproject.toml` + `pytest` | Python + pytest | Set `VALIDATION_COMMAND=cd {{repo_dir}} && pytest` |
| `.github/workflows/` present | GitHub Actions CI | Suggest CI integration |
| `.eslintrc*` present | ESLint | Set `LINT_FIX_COMMAND` |
| `.rubocop.yml` present | RuboCop | Set `LINT_FIX_COMMAND` |

### 6.3 Slack App Manifest (Pre-Built)

One of the biggest friction points is creating the Slack App. Gooseherd should provide a **Slack App Manifest** that users can paste directly:

```yaml
display_information:
  name: Gooseherd
  description: AI coding agent orchestrator
  background_color: "#1a1a2e"

features:
  bot_user:
    display_name: gooseherd
    always_online: true

oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - channels:history
      - groups:history
      - im:history
      - mpim:history

settings:
  event_subscriptions:
    bot_events:
      - app_mention
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

This eliminates the guesswork of which Slack permissions and features to enable.

### 6.4 Deployment Options

#### Docker Compose (default, all tiers)

Already covered above. The pre-built Docker image at `ghcr.io/chocksy/gooseherd:latest` includes Goose, Node.js, and git.

#### Bare Metal

```bash
# Requirements: Node.js 22+, git, goose CLI
npx create-gooseherd --bare-metal
cd gooseherd
npm install
npm start
```

#### Coolify

Gooseherd already has Coolify support via the existing `docker-compose.yml`. The wizard would generate the compose file with `${VAR:?}` syntax for required vars and `${VAR:-default}` for optional ones, matching Coolify's env injection pattern.

#### Railway

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE"
  },
  "deploy": {
    "healthcheckPath": "/healthz",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 5
  }
}
```

---

## 7. Configuration Management Strategy

### 7.1 Comparison of Patterns

| Tool | Config Pattern | Env Vars | Config File | Hot-Reload |
|------|---------------|----------|-------------|------------|
| GitHub Actions | `.github/workflows/*.yml` | Secrets in UI | Yes (YAML) | On push |
| Vercel | Dashboard UI (primary) | UI + `vercel.json` (legacy) | Optional | On deploy |
| Railway | `railway.json` or `railway.toml` | Dashboard UI | Yes | On deploy |
| Coolify | Dashboard UI | UI injects into compose | Compose file | On deploy |
| Terraform | `.tf` files (HCL) | `TF_VAR_*` override | Yes | On apply |
| Renovate | `config.js` or `renovate.json` | `RENOVATE_*` override | Yes | Per run |
| Dependabot | `.github/dependabot.yml` | None | Yes (YAML) | On push |
| Danger.js | `dangerfile.js` | `DANGER_GITHUB_API_TOKEN` | Yes (JS) | Per CI run |

### 7.2 Recommended Pattern for Gooseherd

**Dual-layer configuration**: env vars for secrets/credentials, config file for behavior.

```
Priority (highest to lowest):
  1. Environment variables     (secrets, deployment-specific)
  2. gooseherd.yml             (behavior, pipelines, repos)
  3. Built-in defaults         (sensible out-of-the-box)
```

This mirrors Renovate's pattern where:
- `RENOVATE_TOKEN` is always an env var (secret)
- `config.js` defines repository lists, rules, and behavior
- Built-in presets provide sensible defaults

### 7.3 Config File Format

**YAML** (`gooseherd.yml`) is recommended over JSON or JS because:
- Human-readable without tooling
- Supports comments (unlike JSON)
- No execution risk (unlike JS/TS config files)
- Familiar to DevOps engineers (Kubernetes, GitHub Actions, Docker Compose)
- Can reference env vars with `${VAR}` syntax

### 7.4 Config Validation and Error Messages

The current Zod-based validation in `config.ts` is good but needs better error messages. Proposed improvements:

```
ERROR: Missing required variable SLACK_BOT_TOKEN

  Gooseherd requires a Slack Bot Token to connect to your workspace.

  To get one:
  1. Go to https://api.slack.com/apps
  2. Select your Gooseherd app
  3. Navigate to "OAuth & Permissions"
  4. Copy the "Bot User OAuth Token" (starts with xoxb-)

  Then set it:
    export SLACK_BOT_TOKEN=xoxb-your-token
    # or add to your .env file
```

Every validation error should include:
1. What is missing
2. Why it is needed
3. How to get/fix it
4. Where to set it

### 7.5 Config Hot-Reloading

For Tier 2, hot-reloading `gooseherd.yml` without restart is valuable. Implementation approach:

- Watch `gooseherd.yml` with `fs.watch()`
- On change, re-parse and validate
- Swap the in-memory config atomically
- Log the change: `"Config reloaded: added repo myorg/new-repo"`
- Do NOT hot-reload env vars (those require restart for security)

### 7.6 Per-Repo Config (`.gooseherd.yml`)

In addition to the central `gooseherd.yml`, individual repos can have a `.gooseherd.yml` at their root:

```yaml
# .gooseherd.yml in myorg/backend
validation: "bundle exec rspec"
lintFix: "bundle exec rubocop -A"
agent:
  maxTurns: 80
  extensions:
    - name: custom-db-tool
      command: "my-db-mcp-server"
```

This follows Dependabot's pattern (`.github/dependabot.yml` per repo) and Renovate's pattern (`renovate.json` per repo).

**Merge order:**
1. Built-in defaults
2. Central `gooseherd.yml` repo section
3. Per-repo `.gooseherd.yml` (overrides central)
4. Environment variables (override everything)

---

## 8. Multi-Tenant Architecture

### 8.1 Scoping Configs Per Repo

The `gooseherd.yml` `repos:` section handles this naturally:

```yaml
repos:
  "teamA/service-a":
    agent:
      model: anthropic/claude-sonnet-4
    validation: "npm test"

  "teamB/data-pipeline":
    agent:
      model: google/gemini-2.5-pro
    validation: "pytest"
```

Repos not listed in `repos:` use the `defaults:` section.

### 8.2 Different Agent Providers Per Team

Gooseherd already passes `--provider` and `--model` via the command template. With per-repo config:

```yaml
repos:
  "teamA/*":  # Glob patterns for team-wide config
    agent:
      provider: anthropic
      model: claude-sonnet-4
      apiKeyEnv: ANTHROPIC_API_KEY  # Which env var to use

  "teamB/*":
    agent:
      provider: openai
      model: gpt-4o
      apiKeyEnv: OPENAI_API_KEY
```

The `apiKeyEnv` field tells Gooseherd which environment variable to pass as the API key for that team's provider.

### 8.3 Billing/Usage Tracking

Each `RunRecord` already tracks `repoSlug`, `requestedBy`, `createdAt`, and `finishedAt`. Adding:

```typescript
interface RunRecord {
  // ... existing fields ...
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    model: string;
    estimatedCostUsd: number;
  };
  teamId?: string;  // Derived from repo slug or Slack channel
}
```

The dashboard can then show usage breakdowns per team/repo. For actual billing integration, Gooseherd would expose a `/api/usage` endpoint that billing systems can poll.

### 8.4 Permission Model

Permissions layer on top of existing mechanisms:

| Mechanism | Current | Tier 2 Proposal |
|-----------|---------|-----------------|
| `REPO_ALLOWLIST` | Comma-separated list | Per-team repo scoping in config |
| `SLACK_ALLOWED_CHANNELS` | Comma-separated list | Per-team channel mapping |
| GitHub token scope | Single PAT | GitHub App with per-repo installation |
| Dashboard access | No auth | Basic auth / OAuth |

```yaml
teams:
  platform:
    channels: ["C_PLATFORM"]
    repos: ["myorg/infra", "myorg/platform-*"]
    members: ["U_ALICE", "U_BOB"]

  product:
    channels: ["C_PRODUCT", "C_ENGINEERING"]
    repos: ["myorg/web-app", "myorg/mobile-*"]
    members: ["U_CAROL", "U_DAVE"]
```

---

## 9. Comparison with Similar Tools

### 9.1 Renovate

**Renovate's model is the closest analog to Gooseherd's needs.**

| Aspect | Renovate | Gooseherd (Proposed) |
|--------|----------|---------------------|
| Cloud option | Mend.io hosted | goose-herd.com (future) |
| Self-hosted | Docker / npm / GitHub Action | Docker / npm |
| Min config | `RENOVATE_TOKEN` + `repositories: [...]` | `SLACK_BOT_TOKEN` + `GITHUB_TOKEN` |
| Config file | `config.js` (global) + `renovate.json` (per-repo) | `gooseherd.yml` (global) + `.gooseherd.yml` (per-repo) |
| Autodiscovery | Scans all accessible repos | Could scan via GitHub token |
| Scheduling | Cron-based runs | Event-driven (Slack) + cron (Tier 2) |

**Key lesson from Renovate:** They separate the "global/admin config" (how the bot itself runs) from the "repo config" (what the bot does in each repo). Gooseherd should do the same.

### 9.2 Dependabot

| Aspect | Dependabot | Gooseherd (Proposed) |
|--------|-----------|---------------------|
| Setup | Enable in GitHub UI (zero config for hosted) | `npx create-gooseherd` wizard |
| Config | `.github/dependabot.yml` per repo | `.gooseherd.yml` per repo |
| Self-hosted | Not available (GitHub-native) | Self-hosted first |
| Customization | Limited (schedules, ignore rules) | Full pipeline customization |

**Key lesson from Dependabot:** The `.github/dependabot.yml` per-repo pattern is simple and works well. A `.gooseherd.yml` per-repo config would follow this pattern.

### 9.3 Danger.js

| Aspect | Danger.js | Gooseherd (Proposed) |
|--------|----------|---------------------|
| Install | `npm install danger --save-dev` | `npx create-gooseherd` |
| Config | `dangerfile.js` (code-as-config) | `gooseherd.yml` (declarative) |
| Auth | 1 env var (`DANGER_GITHUB_API_TOKEN`) | 5 env vars (Slack + GitHub + LLM) |
| Runs in | CI pipeline | Standalone service |

**Key lesson from Danger.js:** One env var for auth is the gold standard. Gooseherd cannot match this (Slack requires 3 tokens), but can get close with the wizard auto-generating the Slack App.

### 9.4 GitHub Apps vs PAT

For Tier 0-1, a **Personal Access Token** is the right choice:
- Zero setup beyond creating the token
- Works immediately
- Fine for single-org use

For Tier 2, a **GitHub App** is recommended:
- Not tied to a user account (survives employee departure)
- Higher rate limits (15k/hr vs 5k/hr)
- Granular permissions per repo
- Short-lived tokens (1hr, auto-rotated)
- Built-in webhook support

The upgrade path: Tier 0 starts with PAT, Tier 2 adds GitHub App support as an alternative. Both should always work.

### 9.5 Open Agent / sandboxed.sh

| Aspect | Open Agent | Gooseherd |
|--------|-----------|-----------|
| Agent | Claude Code / OpenCode | Goose (configurable) |
| Trigger | Web UI / iOS / CLI | Slack / Dashboard / Webhooks |
| Isolation | Container per task | Directory per task |
| Config | Git repo of skills/rules | gooseherd.yml + .gooseherd.yml |

**Key lesson from Open Agent:** Their "git repo of skills" pattern is interesting for Tier 2. Gooseherd could allow a `skills/` directory with custom instructions per task type.

---

## 10. Upgrade Path: Tier 0 to Tier 2

### 10.1 Tier 0 -> Tier 1

**Changes required:**
1. Add 4-6 env vars to `.env`
2. Optionally add CEMS service to `docker-compose.yml`
3. No code changes, no config file changes

```diff
# .env additions for Tier 1
+ VALIDATION_COMMAND=cd {{repo_dir}} && npm test
+ LINT_FIX_COMMAND=cd {{repo_dir}} && npm run lint:fix
+ CEMS_ENABLED=true
+ CEMS_API_URL=http://cems:8100
+ CEMS_API_KEY=your-key
+ REPO_ALLOWLIST=myorg/repo-a,myorg/repo-b
```

**Zero breaking changes.** All existing Tier 0 env vars continue to work. New vars just enable additional features.

### 10.2 Tier 1 -> Tier 2

**Changes required:**
1. Create `gooseherd.yml` config file
2. Migrate per-repo settings from env vars to config file
3. Optionally switch from PAT to GitHub App
4. Add observer/webhook infrastructure

```bash
# Guided migration
npx gooseherd migrate --from-env-to-config
```

This command would:
1. Read the current `.env` file
2. Generate a `gooseherd.yml` with equivalent settings
3. Show which env vars can be removed (behavioral ones)
4. Keep secrets in `.env` (tokens, API keys)

**The key principle: env vars from Tier 0/1 continue to work at Tier 2.** The config file is additive. A company can stay on "env vars only" forever if they want. The config file just unlocks per-repo customization and advanced features.

### 10.3 Incremental Feature Adoption

Each Tier 2 feature can be enabled independently:

| Feature | How to Enable | Dependencies |
|---------|--------------|--------------|
| CI integration | Add `ci:` section to `gooseherd.yml` | GitHub Actions (already set up in repos) |
| Observer: Sentry | Add `observers.sentry:` section | Sentry account + DSN |
| Observer: GitHub webhooks | Add `observers.github:` section | Webhook secret |
| Observer: Scheduled | Add `observers.schedule:` section | None |
| Browser automation | Add `browserTest:` to repo config | Review app URL template |
| LLM-as-judge | Add `qualityGates:` section | Second LLM API key |
| Multi-concurrency | Set `RUNNER_CONCURRENCY=4` or `concurrency.maxRunners: 4` | More CPU/RAM |
| Dashboard auth | Add `dashboard.auth:` section | Credentials |
| GitHub App | Add app credentials to env | GitHub App registration |

---

## 11. Recommendations

### 11.1 Immediate Actions (This Sprint)

1. **Change `DRY_RUN` default to `false`** -- The current default of `true` is defensive but makes every new install produce no useful output until the user discovers this flag.

2. **Add a real default `AGENT_COMMAND_TEMPLATE`** -- Replace the dummy agent default with a working Goose invocation. Auto-detect provider from available API key env vars.

3. **Create a Slack App Manifest** -- Embed it in the README and in the wizard output. This eliminates 50% of setup friction.

4. **Improve config validation errors** -- Add contextual help messages to every Zod validation failure.

5. **Publish Docker image to GHCR** -- Enable `docker compose up` with `image: ghcr.io/chocksy/gooseherd:latest` instead of requiring `build: .`.

### 11.2 Near-Term (Next Month)

6. **Build `npx create-gooseherd`** -- Interactive wizard using `@inquirer/prompts` (the same library `create-t3-app` uses). Generates `.env`, `docker-compose.yml`, and optional `gooseherd.yml`.

7. **Implement provider auto-detection** -- If `ANTHROPIC_API_KEY` is set, default to Anthropic direct. If `OPENROUTER_API_KEY` is set, default to OpenRouter. If `OPENAI_API_KEY` is set, default to OpenAI.

8. **Add `gooseherd.yml` config file support** -- Parse on startup, merge with env vars, validate with Zod.

9. **Add per-repo `.gooseherd.yml` support** -- Read from cloned repo during execution, merge with central config.

### 11.3 Medium-Term (Next Quarter)

10. **GitHub App support** -- Alternative to PAT for Tier 2 users. Auto-rotate installation tokens.

11. **Config hot-reloading** -- Watch `gooseherd.yml` for changes without restart.

12. **`npx gooseherd migrate`** -- Tool to move from env-vars-only to config-file setup.

13. **Dashboard auth** -- Basic auth via Traefik labels (already scaffolded in docker-compose.yml comments).

### 11.4 Architecture Principle

The guiding principle across all tiers is **progressive disclosure**:

- Tier 0 hides everything behind sensible defaults
- Tier 1 exposes validation and memory as env var additions
- Tier 2 exposes the full config surface via a structured file

A user should never see complexity before they need it. The `.env.example` file should be split into:

- `.env.example` (Tier 0: 5 vars)
- `.env.example.production` (Tier 1: adds 6 more vars)
- `gooseherd.example.yml` (Tier 2: full config reference)

This ensures the first-time user sees only what they need, while the power user can find the full reference.

---

## Appendix A: Env Var Inventory by Tier

| Variable | Tier 0 | Tier 1 | Tier 2 | Default |
|----------|--------|--------|--------|---------|
| `SLACK_BOT_TOKEN` | Required | Required | Required | -- |
| `SLACK_APP_TOKEN` | Required | Required | Required | -- |
| `SLACK_SIGNING_SECRET` | Required | Required | Required | -- |
| `GITHUB_TOKEN` | Required | Required | Required (or GitHub App) | -- |
| `OPENROUTER_API_KEY` | Required* | Required* | Required* | -- |
| `APP_NAME` | -- | Optional | Optional | `Gooseherd` |
| `DRY_RUN` | -- | -- | -- | `false` (proposed) |
| `VALIDATION_COMMAND` | -- | Optional | Config file | empty |
| `LINT_FIX_COMMAND` | -- | Optional | Config file | empty |
| `MAX_VALIDATION_ROUNDS` | -- | Optional | Config file | `2` |
| `CEMS_ENABLED` | -- | Optional | Config file | `false` |
| `CEMS_API_URL` | -- | Conditional | Config file | -- |
| `CEMS_API_KEY` | -- | Conditional | Config file | -- |
| `REPO_ALLOWLIST` | -- | Optional | Config file | empty (all repos) |
| `SLACK_ALLOWED_CHANNELS` | -- | Optional | Config file | empty (all channels) |
| `RUNNER_CONCURRENCY` | -- | -- | Optional | `1` |
| `AGENT_COMMAND_TEMPLATE` | -- | -- | Optional | Built-in Goose default |
| `AGENT_FOLLOW_UP_TEMPLATE` | -- | -- | Optional | Auto-generated |
| `AGENT_TIMEOUT_SECONDS` | -- | -- | Optional | `1200` |
| `GITHUB_DEFAULT_OWNER` | -- | -- | Optional | -- |
| `BRANCH_PREFIX` | -- | -- | Optional | `gooseherd` |
| `DEFAULT_BASE_BRANCH` | -- | -- | Optional | `main` |
| `GIT_AUTHOR_NAME` | -- | -- | Optional | `Gooseherd Bot` |
| `GIT_AUTHOR_EMAIL` | -- | -- | Optional | `gooseherd-bot@local` |
| `DASHBOARD_ENABLED` | -- | -- | Optional | `true` |
| `DASHBOARD_HOST` | -- | -- | Optional | `0.0.0.0` (Docker) |
| `DASHBOARD_PORT` | -- | -- | Optional | `8787` |

*Required = one of `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`

## Appendix B: Slack App Manifest

```yaml
display_information:
  name: Gooseherd
  description: AI coding agent orchestrator
  background_color: "#1a1a2e"
  long_description: >
    Gooseherd herds AI coding agents via Slack.
    Mention the bot with a repo and task, and it will
    clone the repo, run an AI agent to implement the task,
    and create a pull request with the changes.

features:
  bot_user:
    display_name: gooseherd
    always_online: true

oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - channels:history
      - groups:history
      - im:history
      - mpim:history

settings:
  event_subscriptions:
    bot_events:
      - app_mention
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

## Appendix C: Quick-Start Script (Tier 0)

```bash
#!/bin/bash
# quick-start.sh -- Get Gooseherd running in 5 minutes
set -euo pipefail

echo "=== Gooseherd Quick Start ==="
echo ""

# Check prerequisites
command -v docker >/dev/null 2>&1 || { echo "Error: Docker is required. Install from https://docker.com"; exit 1; }
command -v docker compose version >/dev/null 2>&1 || { echo "Error: Docker Compose V2 is required."; exit 1; }

# Create project directory
mkdir -p gooseherd && cd gooseherd

# Prompt for required tokens
echo "You'll need these tokens (see README for how to get them):"
echo ""
read -rp "SLACK_BOT_TOKEN (xoxb-...): " SLACK_BOT_TOKEN
read -rp "SLACK_APP_TOKEN (xapp-...): " SLACK_APP_TOKEN
read -rp "SLACK_SIGNING_SECRET: " SLACK_SIGNING_SECRET
read -rp "GITHUB_TOKEN (ghp_...): " GITHUB_TOKEN
read -rp "OPENROUTER_API_KEY (sk-or-...): " OPENROUTER_API_KEY

# Generate .env
cat > .env <<EOF
SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}
SLACK_APP_TOKEN=${SLACK_APP_TOKEN}
SLACK_SIGNING_SECRET=${SLACK_SIGNING_SECRET}
GITHUB_TOKEN=${GITHUB_TOKEN}
OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
EOF

# Generate docker-compose.yml
cat > docker-compose.yml <<'COMPOSE'
services:
  gooseherd:
    image: ghcr.io/chocksy/gooseherd:latest
    env_file: .env
    volumes:
      - gooseherd-data:/app/data
    ports:
      - "8787:8787"
    restart: unless-stopped

volumes:
  gooseherd-data:
COMPOSE

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Start Gooseherd:"
echo "  docker compose up -d"
echo ""
echo "Dashboard: http://localhost:8787"
echo "Slack: @gooseherd run owner/repo | your task"
```
