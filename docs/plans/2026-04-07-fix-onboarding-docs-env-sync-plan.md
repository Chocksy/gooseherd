---
title: "fix: Sync onboarding docs, .env.example, and docker-compose with config.ts"
type: fix
date: 2026-04-07
---

# fix: Sync onboarding docs, .env.example, and docker-compose with config.ts

## Overview

The onboarding experience is broken for new developers. The Docker Quick Start omits `git clone`, the npm path doesn't mention PostgreSQL, `.env.example` is missing ~20 env vars from `config.ts`, `docker-compose.yml` has stale variable names that silently break observer/Sentry, and enabling sandbox requires an undocumented separate build step. A colleague following the README end-to-end will hit multiple failures before running their first task.

## Problem Statement

Six files have drifted out of sync with `src/config.ts` (the source of truth):

1. **`.env.example`** — Missing vars (sandbox sizing, orchestrator, screenshot, git identity, CI tuning), wrong default model (`claude-haiku-4-5` vs code's `claude-sonnet-4-6`), references 4 deleted pipeline presets
2. **`README.md`** — Docker path has no `git clone`, npm path has no PostgreSQL, doesn't explain dummy-agent is a test stub, no sandbox build step
3. **`docker-compose.yml`** — 5 stale var names (`SENTRY_ORG` → `SENTRY_ORG_SLUG`, `OBSERVER_DAILY_LIMIT` → `OBSERVER_MAX_RUNS_PER_DAY`, etc.), missing GitHub App vars, timeout defaults diverge from config.ts
4. **`docs/deployment.md`** — Says "bcrypt" (actually scrypt), deleted pipeline presets listed, `ENCRYPTION_KEY_FILE` undocumented, stale model defaults
5. **Sandbox** — `docker compose up` doesn't build the sandbox image; `make pull` pulls GHCR tag but config.ts defaults to a local tag
6. **`Makefile`** — `make pull` fetches wrong sandbox tag vs what config expects

## Proposed Solution

Treat `src/config.ts` as the canonical source. Update all 6 files to match it. Add sandbox as a compose build target so `docker compose up --build` builds everything in one command.

## Technical Considerations

- **`.env.example` section structure**: Uses `═══` dividers and `── Name ──` subsection headers. New vars must follow this pattern.
- **`docker-compose.yml` dual purpose**: Used for both Coolify deployment (no ports, Traefik routing) and local dev (with `docker-compose.override.yml` for ports). Changes must work for both.
- **`ENCRYPTION_KEY_FILE`**: Used in `src/db/setup-store.ts:343` via `process.env.ENCRYPTION_KEY_FILE` but NOT in `config.ts` envSchema. It's consumed directly by SetupStore, not loadConfig(). Document it in deployment.md but don't add to `.env.example` (advanced use only).
- **Setup wizard exists**: Confirmed in `src/db/setup-store.ts` + `src/dashboard/wizard-html.ts`. First-run redirects to `/setup`. Docs are correct about wizard flow.
- **Sandbox image**: Adding as a compose `profiles: [sandbox]` service is cleanest — doesn't build by default, but `docker compose --profile sandbox up --build` gets everything.

## Acceptance Criteria

### `.env.example`
- [x] All env vars from `config.ts` envSchema appear (commented if optional, uncommented if commonly needed)
- [x] `DEFAULT_LLM_MODEL` default matches config.ts (`anthropic/claude-sonnet-4-6`)
- [x] Deleted pipeline presets removed from comments
- [x] Git identity vars added (`BRANCH_PREFIX`, `DEFAULT_BASE_BRANCH`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`)
- [x] Sandbox vars added (`SANDBOX_IMAGE`, `SANDBOX_HOST_WORK_PATH`, `SANDBOX_CPUS`, `SANDBOX_MEMORY_MB`)
- [x] Orchestrator vars added (`ORCHESTRATOR_ENABLED`, `ORCHESTRATOR_MODEL`)
- [x] `SCREENSHOT_ENABLED` added under Browser Verify section
- [x] CI tuning vars added (`CI_POLL_INTERVAL_SECONDS`, `CI_MAX_WAIT_SECONDS`, `CI_MAX_FIX_ROUNDS`)
- [x] Observer sub-feature vars added (GitHub watched repos, Slack watched channels, webhook secrets)
- [x] `CEMS_MCP_COMMAND` — skipped, legacy var replaced by `MCP_EXTENSIONS`
- [x] `DRY_RUN=true` as default (safer for new users)

### `README.md`
- [x] Docker Quick Start: add `git clone` + `cd gooseherd` as step 1
- [x] npm Quick Start: add PostgreSQL requirement + startup command
- [x] Add note that default agent is `dummy-agent.sh` (safe test stub)
- [x] Add `make docker` as the recommended one-command setup
- [x] Mention sandbox build for users who need container isolation

### `docker-compose.yml`
- [x] Fix stale var names:
  - `SENTRY_ORG` → `SENTRY_ORG_SLUG`
  - `OBSERVER_DAILY_LIMIT` → `OBSERVER_MAX_RUNS_PER_DAY`
  - `OBSERVER_DAILY_PER_REPO_LIMIT` → `OBSERVER_MAX_RUNS_PER_REPO_PER_DAY`
- [x] Remove vars with no config.ts counterpart:
  - `OBSERVER_RATE_LIMIT_WINDOW_MINUTES`
  - `OBSERVER_RATE_LIMIT_MAX_PER_WINDOW`
- [x] Add GitHub App vars (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`)
- [x] Fix timeout defaults to match config.ts (remove hardcoded compose defaults, let config.ts win):
  - `ORCHESTRATOR_TIMEOUT_MS` remove `:-60000` (config.ts: 180000)
  - `ORCHESTRATOR_WALL_CLOCK_TIMEOUT_MS` remove `:-180000` (config.ts: 480000)
- [x] Add `ORCHESTRATOR_ENABLED` var (already existed)
- [x] Add `SCREENSHOT_ENABLED` var (already existed)
- [x] Add `CI_WAIT_ENABLED` var
- [x] Add sandbox as a compose build target (profile-gated):
  ```yaml
  sandbox:
    build: sandbox/
    image: gooseherd/sandbox:default
    profiles: [sandbox]
  ```

### `docs/deployment.md`
- [x] Section 4: change "bcrypt hash" to "scrypt hash"
- [x] Pipeline section: remove references to deleted presets (`complex.yml`, `hotfix.yml`, `docs-only.yml`, `ui-change.yml`)
- [x] Database section: document `ENCRYPTION_KEY_FILE` (used by SetupStore for file-based key path)
- [x] LLM Models table: fix `DEFAULT_LLM_MODEL` default to `anthropic/claude-sonnet-4-6`
- [x] LLM Models table: fix `ORCHESTRATOR_MODEL` default description
- [x] LLM Models table: fix `BROWSER_VERIFY_MODEL` default description (falls back to DEFAULT_LLM_MODEL, not hardcoded)
- [x] Sandbox section: add build instructions with 3 options (make, compose profile, manual)
- [x] Add note about `make docker` as one-command setup

### `Makefile`
- [x] `make pull`: re-tags GHCR image to `gooseherd/sandbox:default` after pull
- [x] Verify `make docker` still works after compose sandbox profile addition

## Implementation Steps

### Step 1: `.env.example` — sync with config.ts

**File:** `.env.example`

Diff `config.ts` envSchema against `.env.example` vars. Add missing vars in their correct sections following the `═══` / `── Name ──` convention. Fix the `DEFAULT_LLM_MODEL` default. Remove deleted pipeline preset references.

Key additions by section:
- **Git identity**: `BRANCH_PREFIX`, `DEFAULT_BASE_BRANCH`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`
- **Sandbox**: `SANDBOX_IMAGE`, `SANDBOX_HOST_WORK_PATH`, `SANDBOX_CPUS`, `SANDBOX_MEMORY_MB`
- **Orchestrator**: `ORCHESTRATOR_ENABLED`, `ORCHESTRATOR_MODEL`, `ORCHESTRATOR_TIMEOUT_MS`, `ORCHESTRATOR_WALL_CLOCK_TIMEOUT_MS`
- **Browser Verify**: `SCREENSHOT_ENABLED`
- **CI**: `CI_POLL_INTERVAL_SECONDS`, `CI_PATIENCE_TIMEOUT_SECONDS`, `CI_MAX_WAIT_SECONDS`, `CI_CHECK_FILTER`, `CI_MAX_FIX_ROUNDS`
- **Observer**: `OBSERVER_ALERT_CHANNEL_ID`, `OBSERVER_GITHUB_WATCHED_REPOS`, `OBSERVER_SLACK_WATCHED_CHANNELS`, `OBSERVER_WEBHOOK_SECRETS`, `OBSERVER_GITHUB_WEBHOOK_SECRET`, `OBSERVER_SENTRY_WEBHOOK_SECRET`
- **Supervisor**: already in advanced section, verify completeness
- **LLM default**: `anthropic/claude-sonnet-4-6`
- **DRY_RUN**: change default to `true`

### Step 2: `docker-compose.yml` — fix stale vars + add sandbox

**File:** `docker-compose.yml`

1. Rename the 3 stale observer/sentry vars
2. Remove the 2 vars with no config.ts counterpart
3. Add GitHub App vars
4. Remove hardcoded timeout defaults that diverge from config.ts
5. Add `ORCHESTRATOR_ENABLED`, `SCREENSHOT_ENABLED`, `CI_WAIT_ENABLED`
6. Add sandbox build service with `profiles: [sandbox]`

### Step 3: `README.md` — fix Quick Starts

**File:** `README.md`

1. Docker Quick Start: prepend `git clone` + `cd`
2. npm Quick Start: add PostgreSQL prerequisite + startup command
3. Add note about dummy-agent being a test stub
4. Add `make docker` mention
5. Brief sandbox note

### Step 4: `docs/deployment.md` — fix inaccuracies

**File:** `docs/deployment.md`

1. "bcrypt" → "scrypt"
2. Remove deleted pipeline presets
3. Document `ENCRYPTION_KEY_FILE`
4. Fix model default values in tables
5. Add sandbox build instructions
6. Add `make docker` reference

### Step 5: `Makefile` — fix sandbox tag mismatch

**File:** `Makefile`

Update `make pull` to re-tag the GHCR sandbox image:
```makefile
pull:
	docker pull ghcr.io/chocksy/gooseherd:latest
	docker pull ghcr.io/chocksy/gooseherd-sandbox:latest
	docker tag ghcr.io/chocksy/gooseherd-sandbox:latest gooseherd/sandbox:default
```

### Step 6: Verify

- Run `docker compose config` to validate compose syntax
- Run `make docker` to confirm full build works
- Spot-check that `npm run check` still passes (no code changes, but sanity check)

## Dependencies & Risks

- **No code changes** — all changes are documentation/configuration only. Zero risk to runtime behavior.
- **Compose profile addition** — Docker Compose profiles require Compose v2. All modern Docker Desktop includes this.
- **Stale var rename** — If anyone has a `.env` with `SENTRY_ORG` (not `SENTRY_ORG_SLUG`), their observer config silently breaks. But it was already broken (config.ts never read `SENTRY_ORG`). The fix makes the docs match reality.

## References

- `src/config.ts` — canonical env var schema and defaults (all 140 vars)
- `src/db/setup-store.ts:343` — `ENCRYPTION_KEY_FILE` usage
- `src/dashboard/auth.ts` — dual auth (DASHBOARD_TOKEN + wizard password)
- `src/sandbox/image-resolver.ts` — sandbox image resolution logic
- `sandbox/Dockerfile` — sandbox image build instructions
- Codex review findings (this session)
- SpecFlow analysis (this session)
