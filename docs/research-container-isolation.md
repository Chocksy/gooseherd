# Container Isolation Research — Task 30

## Problem Statement

Agent runs execute directly on the host. No sandboxing, no resource limits, no isolation between concurrent runs. External tool dependencies (goose, git, pa11y, playwright, gitleaks) must be installed on the host — tests and runs break when moving between machines.

## Industry Approaches

### Cursor Cloud Agents (Feb 2026)
- Each agent gets an **isolated AWS VM** — full development environment
- Agent has internet access, auto-runs terminal commands, iterates on tests
- GUI interaction via computer-use (browser clicking, navigating)
- Produces merge-ready PRs with **video recordings, screenshots, logs**
- Remote desktop access to agent's VM for live inspection
- Available from web, mobile, desktop, Slack, GitHub
- Subagents run asynchronously in trees for parallel work
- 30%+ of Cursor's own PRs created by cloud agents

### Devin (Cognition)
- Docker-based sandbox with shell, editor, and browser
- Agent loop: decompose → read docs → edit code → run tests → analyze → iterate
- Screenshots via browser accessibility tree snapshots (semantic, not pixel-based)
- Video recording is multi-phase (raw recording + post-production) because 90% of agent time is "thinking" = still frames
- Uses Mux's agentic screen recording approach

### E2B Sandbox
- Firecracker microVMs (same tech as AWS Lambda), start in <200ms
- SDKs for JS/Python, ~$0.05/hr per sandbox
- Docker + E2B partnership for MCP tool access
- Overkill for our use case but good reference architecture

### agent-infra/sandbox
- All-in-one Docker container: browser + shell + file + MCP + VSCode
- Apache-2.0 licensed, open source
- Built-in VNC, Jupyter, file manager, terminal
- Shared filesystem across all components

## Decision: Docker-out-of-Docker (DooD)

**Chosen approach:** Self-hosted Docker via socket mount. The gooseherd orchestrator container talks to the host Docker daemon to create sibling sandbox containers per run.

**Why not the others:**
- Full VMs (Cursor approach): overkill — we don't need GUI/computer-use
- E2B: vendor dependency + ongoing cost for something we can build in ~200 lines
- agent-infra/sandbox: good reference but heavier than needed

## Architecture

```
┌─ Docker Host (Hetzner via Coolify) ─────────────┐
│                                                  │
│  Docker Daemon                                   │
│    │                                             │
│    ├── gooseherd (orchestrator container)         │
│    │     - pipeline engine                       │
│    │     - run manager + slack                   │
│    │     - dashboard server                      │
│    │     - /var/run/docker.sock mounted           │
│    │     - SLIM image (no goose/agent tools)     │
│    │                                             │
│    ├── sandbox-run-abc123 (per-run container)    │
│    │     - git, goose, node, curl, gitleaks      │
│    │     - /work mounted from host volume        │
│    │     - resource limits (CPU, RAM, timeout)   │
│    │                                             │
│    └── sandbox-run-def456 (per-run container)    │
│          - different image if repo specifies     │
│          - /work mounted from host volume        │
│                                                  │
└──────────────────────────────────────────────────┘
```

## Execution Boundaries

### Stays on Host (Orchestrator)
- `pipeline-engine.ts` — orchestrator loop, node sequencing
- `run-manager.ts` — Slack communication, heartbeat
- `store.ts` — runs.json persistence
- `github.ts` — Octokit API calls (create_pr, wait_ci, check_annotations)
- `llm/caller.ts` — OpenRouter API calls (plan_task, scope_judge, smart_triage)
- `dashboard-server.ts` — HTTP API + HTML dashboard
- `workspace-cleaner.ts` — cleanup old runs

### Runs Inside Sandbox Container
- Agent execution (implement, fix-validation, fix-ci)
- All git operations on cloned repos (clone, checkout, commit, push)
- Validation/lint/test commands
- Browser verify (curl, pa11y, playwright)
- Security scan (gitleaks)
- Hydrate context (filesystem inspection of cloned repo)

## Shell Execution — Single Choke Point

All process execution goes through `src/pipeline/shell.ts`:
- `runShell()` — fire-and-forget, throws on non-zero
- `runShellCapture()` — captures stdout/stderr, returns exit code
- `runShellWithProgress()` — like runShell with onStderr callback

All use `spawn("bash", ["-lc", command])`. Replacing this with `docker exec` containerizes everything.

### Complete Call Site Inventory

| Node | File | Shell Functions | What It Runs |
|------|------|----------------|-------------|
| clone | nodes/clone.ts | runShellWithProgress, runShellCapture, runShell | git clone/fetch/checkout/config |
| hydrate_context | nodes/hydrate-context.ts | runShellCapture | find, ls, git rev-list, git diff |
| implement | nodes/implement.ts | runShellCapture | AGENT_COMMAND_TEMPLATE |
| lint_fix | nodes/lint-fix.ts | runShellCapture | LINT_FIX_COMMAND |
| validate | nodes/validate.ts | runShellCapture | VALIDATION_COMMAND |
| local_test | nodes/local-test.ts | runShellCapture | LOCAL_TEST_COMMAND |
| fix_validation | nodes/fix-validation.ts | runShell | AGENT_COMMAND_TEMPLATE |
| commit | nodes/commit.ts | runShell, runShellCapture | git diff/add/commit/rev-parse/show |
| push | nodes/push.ts | runShell | git remote set-url, git push |
| fix_ci | ci/fix-ci-node.ts | runShell, runShellCapture | agent cmd, git status/add/commit/push |
| diff_gate | quality-gates/diff-gate-node.ts | runShellCapture | git diff --numstat |
| forbidden_files | quality-gates/forbidden-files-node.ts | runShellCapture | git diff --name-only |
| security_scan | quality-gates/security-scan-node.ts | runShellCapture | git diff, gitleaks, which |
| scope_judge | quality-gates/scope-judge-node.ts | runShellCapture | git diff, git diff --name-only |
| browser_verify | quality-gates/browser-verify-node.ts | runShellCapture | curl, npx pa11y, node (playwright) |
| repo_config | pipeline/repo-config.ts | runShellCapture | git show |

## Path Mapping (The One Gotcha)

Docker-out-of-Docker requires known host paths for volume mounts.

**Current (named volume):**
```yaml
volumes:
  - gooseherd-work:/app/.work    # host path is opaque
```

**Required (bind mount):**
```yaml
volumes:
  - /data/gooseherd/work:/app/.work    # known host path
  - /var/run/docker.sock:/var/run/docker.sock
```

Config var `SANDBOX_HOST_WORK_PATH=/data/gooseherd/work` tells the ContainerManager what host path maps to workRoot.

## File System Layout Per Run

```
/data/gooseherd/work/{runId}/     ← host path (bind mount)
  ├── repo/                       ← cloned git repo (container writes)
  ├── run.log                     ← append-only log (both read/write)
  ├── events.jsonl                ← pipeline events (both read/write)
  ├── checkpoints/                ← context bag checkpoints
  │   └── checkpoint.json
  ├── task.md                     ← prompt file (host writes, container reads)
  ├── fix-round-{N}.md           ← fix prompts
  ├── ci-fix-round-{N}.md        ← CI fix prompts
  └── screenshot.png              ← browser verify output
```

## Token Security

**Current:** Tokens embedded in git URL (`x-access-token:TOKEN@github.com`), persisted in `.git/config`.

**Improved:** Pass `GIT_TOKEN` as env var to sandbox. Use git credential helper:
```bash
git config --global credential.helper '!f() { echo "password=$GIT_TOKEN"; }; f'
```

Tokens never persist on disk. Sanitized from logs by existing `sanitizeForLogs()`.

## Network Access Per Node

| Node | Network Needed | Destination |
|------|---------------|-------------|
| clone | YES | github.com |
| push | YES | github.com |
| implement | YES | LLM API + package registries |
| fix_validation | YES | LLM API |
| fix_ci | YES | LLM API + github.com |
| browser_verify | YES | Review app URL |
| plan_task | N/A (host-side) | OpenRouter API |
| scope_judge | N/A (host-side) | OpenRouter API |
| All quality gates | NO | Local git only |

## External Tool Dependencies for Sandbox Image

| Tool | Required? | Used By |
|------|-----------|---------|
| bash | YES | All shell execution |
| git | YES | clone, hydrate, commit, push, quality gates |
| goose CLI | YES | implement, fix-validation, fix-ci |
| node | YES | Playwright screenshot |
| curl | YES | Browser verify smoke test |
| find, ls, head, sed | YES | hydrate-context, clone |
| which | YES | Tool detection |
| pa11y | OPTIONAL | Accessibility testing |
| playwright | OPTIONAL | Screenshot capture |
| gitleaks | OPTIONAL | Security scan (falls back to regex) |

## Per-Repo Image Configuration

Via `.gooseherd.yml` in target repo:
```yaml
sandbox:
  image: "gooseherd/sandbox:ruby32"
  # OR extend default:
  packages:
    - python3
    - ruby
```

## Resource Limits

```typescript
interface SandboxConfig {
  image: string;         // default: "gooseherd/sandbox:default"
  cpus: number;          // default: 2
  memoryMb: number;      // default: 4096
  timeoutSeconds: number; // default: from AGENT_TIMEOUT_SECONDS
  networkMode: "bridge" | "none";
}
```

## Local Development

`SANDBOX_ENABLED=false` (default) keeps the current direct-spawn behavior. No Docker needed for development. The sandbox path is opt-in for production/Coolify deployment.

## Implementation Plan

See `plan/tasks.md` and `progress.md` for phased implementation tracked via planning-with-files.
