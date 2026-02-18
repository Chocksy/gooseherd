# Hubble Expansion Research: Memory, Feedback Loops & Deployment

Date: 2026-02-18
Scope: Four research threads for Hubble's next evolution

---

## 1. Stripe Minions Feedback Behavior (Deep Dive)

Source: https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents (Feb 9, 2026)

### 1.1 Not Actually "One-Shot"

Stripe markets Minions as "one-shot" but the reality is **one-shot from the engineer's perspective, iterative within a constrained envelope**.

Three automated feedback layers run within a single invocation:

| Layer | What | Speed | Behavior |
|-------|------|-------|----------|
| Local linting | Heuristic-selected lints pre-push | < 5 seconds | Agent fixes and retries before CI |
| CI autofixes | Test failures with known autofixes | Automatic | Applied without agent involvement |
| CI agent retry | Test failures without autofixes | Full CI round | Routed back to agent for remediation |

**Hard ceiling: maximum 2 CI rounds.** Rationale from the post: "there are diminishing marginal returns for an LLM to run many rounds of a full CI loop."

### 1.2 Human Interaction Model

| Phase | Human Role |
|-------|-----------|
| **Pre-run** | Engineer invokes via Slack, CLI, web UI, or internal apps. Slack thread + linked content ingested as context. |
| **During run** | Zero human interaction. Fully unattended. Engineers can passively monitor via web UI. |
| **Post-run** | Engineer reviews PR. If unsatisfied, **can give the minion further instructions and it pushes updated code to the same branch**. |

The post-run feedback is the key finding: **engineers can iteratively refine by giving further instructions after the initial run**. The minion pushes additional commits to the same branch. This creates a multi-turn pattern at the PR level.

### 1.3 Cross-Run Memory

**Not mentioned at all.** Each run starts fresh from invocation context (Slack message, ticket, etc.). No persistent learning between runs. Context comes from MCP tools ("Toolshed" with 400+ tools) that provide code search, build status, internal docs, feature flags — but this is always fetched fresh.

### 1.4 Failure Modes

| Failure | What Happens |
|---------|-------------|
| Lint failure | Caught locally, auto-retried |
| CI failure (within budget) | Agent attempts fix, repushes |
| CI failure (budget exhausted) | Run concludes — engineer takes over |
| Partially correct output | PR created with imperfect code; engineer refines or edits manually |

### 1.5 Part 2 Status

The post promises a sequel ("Part 2: how we implemented minions"). **As of Feb 18, 2026, no Part 2 has been published.** The Stripe Dev Blog shows the Minions post as the most recent entry.

### 1.6 Key Takeaways for Hubble

1. **Bounded retry is smart**: 2 CI rounds max prevents infinite retry spirals
2. **Post-run refinement is essential**: Not having it makes the system "try and fail"
3. **No cross-run memory is a gap**: Stripe doesn't do it — differentiator opportunity
4. **No mid-run chat**: The agent runs unattended, corrections come after

---

## 2. CEMS Integration: Auth, Scoping & Multi-Tenancy Deep Dive

Source: https://github.com/Chocksy/cems (code analysis)

### 2.1 What CEMS Is

CEMS (Continuous Evolving Memory System) is a persistent memory layer for AI coding assistants. It stores, retrieves, and evolves knowledge across sessions using:

- **PostgreSQL + pgvector** for vector storage and metadata
- **text-embedding-3-small** (1536-dim) via OpenRouter for embeddings
- **MCP protocol** (Express.js wrapper) for Claude Code integration
- **REST API** (Python/Starlette) for programmatic access

### 2.2 Architecture (3 Docker Services)

| Service | Port | Stack | Role |
|---------|------|-------|------|
| `postgres` (pgvector:pg16) | 5432 | PostgreSQL + pgvector | Vector storage, metadata |
| `cems-server` | 8765 | Python (Starlette + uvicorn) | REST API |
| `cems-mcp` | 8766 | Express.js (Streamable HTTP) | MCP protocol bridge |

### 2.3 Current Auth Model

**Two auth systems:**

| Layer | Mechanism | Who Uses It |
|-------|-----------|-------------|
| User Auth | `Authorization: Bearer <user_api_key>` validated against `users` table | All `/api/*` endpoints |
| Admin Auth | `Authorization: Bearer <CEMS_ADMIN_KEY>` simple string match | All `/admin/*` endpoints |

**Team selection:** An `x-team-id` header selects which team's shared scope to use. Currently **no validation** that the authenticated user is actually a member of that team.

**MCP wrapper:** Pure passthrough — receives auth headers from Claude Code hooks, forwards to Python REST API. No auth logic of its own.

### 2.4 Entity Hierarchy (Current)

```
company_id (free-form string on Team — no real entity)
  └── Team (name, company_id, settings)
       └── TeamMember (user_id, team_id, role: admin|member|viewer)
            └── User (username, email, api_key_hash, settings)
                 └── Memory Documents (user_id, team_id, scope, category)
```

Key facts:
- **Users** created only via admin API (no self-registration)
- **Teams** require `name` + `company_id` (free-form string, no FK)
- **A user CAN be in multiple teams** — `team_members` has composite PK `(user_id, team_id)`
- **Roles** (`admin`, `member`, `viewer`) exist in schema but are **never enforced** in memory access
- **No organization entity** above teams — `company_id` is just a string label
- DB scope enum allows `'personal', 'shared', 'team', 'company'` but code only uses `'personal'` and `'shared'`

### 2.5 Critical Finding: Shared Memory Visibility Bug

**Shared memories are NOT actually visible across users.**

In `document_store.py` (search functions), the `user_id` filter is **always** applied:

```python
if user_id:
    fb.add_param("d.user_id = ${}", UUID(user_id))
if team_id and scope in ("shared", "both"):
    fb.add_param("d.team_id = ${}", UUID(team_id))
```

Since `user_id` is always truthy (it's the authenticated user's UUID), every search includes `d.user_id = <current_user>`. This means:

- **Personal memories**: Only the owner can see them (correct)
- **Shared memories**: Only the user who WROTE them can see them (bug/limitation)
- **Cross-user visibility does NOT exist** — if User A writes a shared memory to Team X, User B on Team X cannot see it

This applies to ALL search paths: `search_chunks()`, `hybrid_search_chunks()`, `full_text_search_chunks()`, and the entire retrieval pipeline.

**Impact for Hubble:** Without fixing this, a `hubble-bot` user could write shared learnings, but no human user would ever see them. And human-written shared memories wouldn't be visible to the bot.

### 2.6 CEMS Scoping Options for Hubble

**The core question:** How should an autonomous agent system read/write organization-wide memories?

#### Option A: Dedicated `hubble-bot` User + Own Team

- Create `hubble-bot` user via admin API
- Create a `hubble` team
- Agents use hubble-bot's API key

**Problem:** Without the shared visibility fix, hubble-bot's memories are invisible to humans and vice versa. Even with the fix, engineers would need to join the `hubble` team, putting them in multiple teams.

#### Option B: Organization Team (Everyone Joins)

- Create one `org-wide` team (e.g., `hubstaff-org`)
- Add all engineers + `hubble-bot` to this team
- All shared memories go to this team

**Problem:** Same shared visibility bug applies. Also, engineers already have their own teams for personal Claude Code use. Being in multiple teams works (composite PK supports it) but adds complexity — the `x-team-id` header determines which team's shared scope is active, and clients would need to switch between teams.

#### Option C: New Organization Scope Layer

- Add `organizations` table above teams
- New scope value `"organization"` in the enum
- Org-scoped memories visible to all users in all teams under that org

**Problem:** Significant schema/code changes. The DB enum already has `'company'` as a scope value but it's unused — could repurpose it. Still requires the search filter fix plus new org-aware query logic.

#### Option D: Hybrid — Fix Shared Visibility + Org Team (Most Pragmatic)

1. **Fix the search filter** (~10 lines in `document_store.py`): change `WHERE user_id = $1 AND team_id = $2` to `WHERE (user_id = $1 OR team_id = $2)` for shared/both scopes
2. **Validate team membership** in middleware (currently unchecked)
3. **Create `hubble-bot` user** + **one `hubstaff-org` team** via admin API
4. **Add all engineers + hubble-bot** to `hubstaff-org`
5. Hubble writes with `scope="shared"` + `x-team-id: <hubstaff-org-id>`
6. After the fix, all team members see shared memories
7. Personal memories stay private per user

**Why this is best:**
- Smallest code change (~10 lines) to unlock cross-user visibility
- Works with existing CEMS architecture — no new tables or scopes needed
- Engineers keep their personal memories separate
- Hubble's learnings are visible to all engineers using CEMS
- Engineers' manually stored shared memories enrich Hubble's context
- `source_ref` handles per-repo scoping within the shared pool

### 2.7 Memory Types for Hubble

| Category | Examples | Who Writes | Who Reads |
|----------|---------|-----------|-----------|
| `patterns` | "This repo uses Slim templates, not ERB" | Repo indexer / engineers | Hubble agents |
| `learnings` (WORKING_SOLUTION) | "Billing spec passes when you run `bundle exec rspec spec/billing/`" | Hubble after successful run | Future Hubble agents |
| `learnings` (FAILED_APPROACH) | "Don't use `find_by` without nil check in controllers" | Hubble after failed run | Future Hubble agents |
| `learnings` (ERROR_FIX) | "Migration needs `safety_assured` block for column removes" | Hubble after CI fix | Future Hubble agents |
| `decisions` | "We use Sidekiq, not Resque" | Engineers | Hubble agents |
| `gate-rules` | "Never modify files in db/migrate/" | Engineers / admin | Hubble pre-run check |
| `context` | "PR #1234 reviewer said: always add index for new foreign keys" | Hubble after PR review | Future Hubble agents |

### 2.8 Integration Points

| When | What | CEMS API | Auth |
|------|------|----------|------|
| First time on a repo | Index repo conventions | `POST /api/index/path` | hubble-bot key |
| Before agent starts | Get repo-specific context | `GET /api/memory/profile?source_ref=project:org/repo` | hubble-bot key |
| Every agent prompt | Inject relevant memories | `POST /api/memory/search` with `project` param | hubble-bot key |
| After successful run | Store what worked | `POST /api/memory/add` (scope=shared, category=learnings) | hubble-bot key |
| After failed run | Store what failed | `POST /api/memory/add` (scope=shared, FAILED_APPROACH) | hubble-bot key |
| After PR review | Store reviewer feedback | `POST /api/memory/add` (scope=shared, context) | hubble-bot key |
| Per-repo rules | Set forbidden patterns | `POST /api/memory/add` (category=gate-rules) | admin or engineer |
| Periodic | Cleanup and consolidation | `POST /api/memory/maintenance` | hubble-bot key |

### 2.9 What This Enables (That Stripe Doesn't Have)

- **Cross-run learning**: "Last time on this repo, the agent broke the billing specs by not running `bundle exec rspec spec/billing/` — always validate billing after changes to payment models"
- **Failure pattern avoidance**: "FAILED_APPROACH: Don't use `find_by` without null checks in hubstaff-server controllers"
- **Convention enforcement**: "This repo uses Slim templates, not ERB — don't generate ERB"
- **Reviewer feedback loop**: PR reviewer catches an issue → stored as learning → future agents avoid same mistake
- **Shared org knowledge**: All engineers' CEMS memories enrich the agent's context

### 2.10 Limitations

- Requires the shared visibility fix in CEMS (~10 lines)
- PostgreSQL + pgvector dependency (but CEMS already brings this in Docker)
- Embeddings need OpenRouter API key (already used for Goose/agent)
- Hybrid search uses 3-4 LLM calls per query (vector-only mode is free but less precise)
- Observer daemon is client-side (watches local transcripts) — not applicable to containerized Hubble agents; direct REST API calls are the right approach

---

## 3. Feedback Loop: Current State & What's Needed

### 3.1 Current Hubble Follow-Up Mechanism

Hubble already has **basic thread follow-up handling** in `slack-app.ts`:

1. Engineer replies in a run's Slack thread
2. If the message isn't a recognized command (`run`, `status`, `tail`, `help`), it's treated as a follow-up
3. `parseFollowUpMessage()` extracts: task text, optional `base=<branch>` override, retry intent
4. A new run is created using the same `repoSlug` and `baseBranch` from the thread's latest run
5. The follow-up message becomes the new task

**What carries over:**
- `repoSlug` — always from latest run in thread
- `baseBranch` — from latest run unless overridden
- `task` — reused on retry, otherwise replaced by follow-up text
- `channelId` + `threadTs` — stays in same thread

**What does NOT carry over:**
- No reference to previous run's branch, commit, PR, or diff
- No conversation history — agent has zero knowledge of what happened before
- No link between runs (`RunRecord` has no `parentRunId`)
- Executor always does a **fresh `git clone`** from scratch
- Every run (including retries) creates a **new branch**

### 3.2 Dashboard Feedback Card

The dashboard has a "What did you think?" card with:
- Thumbs up / Thumbs down buttons
- Optional note textarea (max 1000 chars)
- Collapsible
- Single `RunFeedback` object per run (rating + note) — saving overwrites previous feedback
- Retry button (creates completely new run, same task, new branch)

**No way to type follow-up instructions from the dashboard.** It's read-only feedback, not a conversation.

### 3.3 Specific Gaps for Chat-Like Feedback

| Aspect | Current | Needed |
|--------|---------|--------|
| Run lineage | No `parentRunId` field | Chain of follow-ups must be traceable |
| Agent context | Static prompt template with task only | Prompt must include: original task + previous diff + feedback |
| Branch reuse | Fresh clone + new branch every time | Follow-ups should work on the existing branch |
| Feedback model | Single rating + note per run | Structured: what went wrong, what to fix, what was good |
| Dashboard input | Read-only thumbs + note | Text input for follow-up instructions + trigger re-run |
| Slack follow-up | Detects thread replies, but agent gets no previous context | Agent should receive summary of what changed + what failed |
| Retry semantics | Exact same task, from scratch | "Retry with adjustments" — same branch, accumulated context |

### 3.4 Feedback Options (From Simplest to Most Complex)

**Option A: Post-Run Refinement (Stripe Model)**
- Run completes → PR created → engineer reviews
- Engineer says in Slack thread: "fix the test you broke" or "also update the migration"
- Hubble re-runs with: original context + current branch diff + feedback message
- Works on the **same branch** (incremental commits, not fresh clone)
- This is essentially what Stripe does

**Option B: Feedback Thread with Memory (Enhanced)**
- Same as A, but each follow-up also:
  - Stores feedback as CEMS learning
  - Pulls relevant memories from previous runs on this repo
  - Agent prompt includes accumulated context from all runs in the thread
- The Slack thread becomes a natural conversation about the task

**Option C: Dashboard Chat (Most Refined UX)**
- Dashboard gets a chat-like input field alongside the activity stream
- Engineer types follow-up directly in the dashboard
- Dashboard triggers a follow-up run via API
- Run activity stream shows results inline, creating a chat-like flow
- Slack thread also updates for visibility

**Option D: Mid-Run Checkpoints (Advanced)**
- Agent pauses at key decisions ("about to modify billing controller")
- Engineer approves or redirects
- Much harder — Goose doesn't natively support this; would need custom tool

### 3.5 Minimum Viable Improvement

The smallest change that breaks the "try and fail" pattern:

1. Add `parentRunId` to `RunRecord` and `NewRunInput`
2. When creating a follow-up run, store the parent link
3. In the executor: if `parentRunId` exists, fetch the parent's branch + diff summary
4. Inject into the agent prompt: "Previous run produced these changes: [diff summary]. Engineer feedback: [follow-up message]. Build on this work."
5. Use the **same branch** (check if it exists, `git checkout` instead of `git checkout -b`)
6. After the run, store the outcome as a CEMS learning

This gives engineers the ability to say "good start, but also fix X" without starting from zero.

---

## 4. Docker/Coolify Deployment

### 4.1 Current State

The existing `Dockerfile` and `docker-compose.yml` are minimal starters with critical gaps.

**Dockerfile gaps:**
- Missing `git` (executor fails immediately)
- Missing `.dockerignore` (enormous image)
- No goose CLI
- No health check

**docker-compose gaps:**
- No port mapping for dashboard
- No health check
- No resource limits

### 4.2 Full Environment Variable Inventory

| Variable | Required | Default | Notes |
|----------|---------|---------|-------|
| `SLACK_BOT_TOKEN` | YES | — | `xoxb-...` |
| `SLACK_APP_TOKEN` | YES | — | `xapp-...` |
| `SLACK_SIGNING_SECRET` | YES | — | From Slack app settings |
| `SLACK_COMMAND_NAME` | no | `hubblebot` | Display name in help |
| `SLACK_ALLOWED_CHANNELS` | no | all | Comma-separated channel IDs |
| `GITHUB_TOKEN` | for real runs | — | PAT with repo+PR permissions |
| `GITHUB_DEFAULT_OWNER` | no | — | Default org for repos |
| `REPO_ALLOWLIST` | no | all | Comma-separated `owner/repo` |
| `RUNNER_CONCURRENCY` | no | `1` | Max parallel runs |
| `WORK_ROOT` | no | `.work` | Clone workspace |
| `DATA_DIR` | no | `data` | State file location |
| `DRY_RUN` | no | `true` | Must set `false` for real runs |
| `BRANCH_PREFIX` | no | `hubble` | Branch name prefix |
| `DEFAULT_BASE_BRANCH` | no | `main` | Default target branch |
| `GIT_AUTHOR_NAME` | no | `Hubble Bot` | Commit author |
| `GIT_AUTHOR_EMAIL` | no | `hubble-bot@local` | Commit email |
| `AGENT_COMMAND_TEMPLATE` | no | dummy agent | The actual agent command |
| `VALIDATION_COMMAND` | no | skip | Post-agent validation |
| `AGENT_TIMEOUT_SECONDS` | no | `1200` | 20 min hard timeout |
| `SLACK_PROGRESS_HEARTBEAT_SECONDS` | no | `20` | Status card update interval |
| `DASHBOARD_ENABLED` | no | `true` | Enable web UI |
| `DASHBOARD_HOST` | no | `127.0.0.1` | **Must be `0.0.0.0` in container** |
| `DASHBOARD_PORT` | no | `8787` | Dashboard HTTP port |
| `MAX_TASK_CHARS` | no | `4000` | Max task length |
| `OPENROUTER_API_KEY` | for goose | — | Passed through to agent |
| `GOOSE_PROVIDER` | for goose | — | Passed through to agent |
| `GOOSE_MODEL` | for goose | — | Passed through to agent |

### 4.3 System Dependencies

| Dependency | In bookworm-slim? | Needed For |
|-----------|-------------------|-----------|
| `git` | NO | All executor git operations |
| `bash` | YES | Command execution (`spawn("bash", ["-lc", ...])`) |
| `curl` | NO | Health check (or use Node-based check) |
| `goose` | NO | Agent execution (if using goose template) |
| `python3` | NO | Goose runtime dependency |

### 4.4 Volumes

| Volume | Container Path | Purpose | Size Concern |
|--------|---------------|---------|-------------|
| `.work` | `/app/.work` | Repo clones + run logs | Large — each run clones a full repo. Needs periodic cleanup. |
| `data` | `/app/data` | `runs.json` state file | Small — critical persistence, should be backed up. |

### 4.5 Network

- **Outbound only** for Slack (Socket Mode = WebSocket, no inbound webhook)
- **Outbound** to GitHub (HTTPS) and OpenRouter (HTTPS)
- **Inbound** port 8787 for dashboard (Coolify reverse proxy → HTTPS)
- **No authentication** on dashboard — Traefik basic auth or app-level auth needed

### 4.6 Docker Compose Vision (Hubble + CEMS)

```
services:
  hubble:         # Main process (Slack + dashboard + executor)
  cems-server:    # CEMS REST API (Python)
  cems-mcp:       # CEMS MCP bridge (Express.js) — optional, for Claude Code clients
  postgres:       # Shared PostgreSQL + pgvector
```

Hubble talks to CEMS via REST API (not MCP) since it's server-to-server. The MCP wrapper is only needed if human engineers also use CEMS with their Claude Code clients.

### 4.7 Priority Fixes for Deployment

| Priority | What | Category |
|----------|------|----------|
| P0 | Install `git` in Dockerfile | Dockerfile |
| P0 | Create `.dockerignore` | Dockerfile |
| P0 | Set `DASHBOARD_HOST=0.0.0.0` default for container | Config |
| P0 | Expose port 8787 in docker-compose | Networking |
| P1 | Install goose CLI in Dockerfile | Dockerfile |
| P1 | Add Docker health check (`/healthz` exists) | Reliability |
| P1 | Add named volume declarations | Persistence |
| P2 | Dashboard authentication | Security |
| P2 | Workspace cleanup for old `.work/` directories | Disk |
| P2 | Multi-stage Docker build | Image size |

---

## 5. Comparison: Hubble + CEMS vs Stripe Minions

| Capability | Stripe Minions | Hubble (Current) | Hubble + CEMS (Target) |
|-----------|---------------|-----------------|----------------------|
| Invocation | Slack, CLI, web UI, internal apps | Slack, CLI (`local:trigger`), dashboard retry | Same + dashboard follow-up |
| Execution | Isolated devboxes (~10s startup) | Host process (local/VM) | Docker container |
| Agent runtime | Goose fork | Goose (configurable template) | Same |
| CI feedback | Local lint + 2 CI rounds | Configurable validation command | Same + bounded retry |
| Post-run refinement | Engineer gives further instructions → new commits on same branch | Thread follow-up creates fresh run | Follow-up reuses branch + carries context |
| Cross-run memory | None | None | CEMS: learnings, failures, conventions |
| Per-repo knowledge | MCP "Toolshed" (400+ tools, fresh fetch) | None | CEMS: indexed repo conventions + project-scoped boost |
| Reviewer feedback | Manual | Manual (thumbs + note) | Automated: stored as CEMS learning → fed to future runs |
| Dashboard | Web UI for monitoring | Activity stream + feedback + retry | Same + chat-like follow-up input |
| Scale | 1,000+ merged PRs/week | Single-process, 1 concurrent run | Docker, configurable concurrency |

---

## 6. Open Questions

### CEMS Integration
1. **Shared visibility fix**: ~10-line change in `document_store.py` — should we PR this to CEMS first?
2. **Team membership validation**: Currently `x-team-id` is unchecked — security concern?
3. **Hubble-bot API key management**: Store in Hubble's env, or use a secret broker?
4. **Memory injection timing**: Before agent start (one-time profile) or on every prompt (via custom hook)?

### Feedback Loop
5. **Branch reuse mechanics**: How to handle conflicts when follow-up runs work on an existing branch that's diverged from base?
6. **Context window**: How much previous-run context can we inject without blowing the agent's context window?
7. **Dashboard chat UX**: Simple text input + send button, or something richer?

### Deployment
8. **Goose in Docker**: `pipx install goose-ai`? Or use a pre-built binary / custom distribution?
9. **CEMS in same compose**: Share the PostgreSQL instance, or keep CEMS fully separate?
10. **Coolify config**: Build from Dockerfile on push, or pre-built image in registry?
11. **Dashboard auth**: Traefik basic auth (simple), or implement proper auth in Hubble (more work but better UX)?
