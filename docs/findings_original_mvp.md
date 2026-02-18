# Findings & Decisions

## Current Objective
- Build a working MVP now, not just architecture docs.
- MVP must run with minimal infra: local machine or single VM.
- Slack integration should be testable in a personal Slack workspace.

## MVP Constraints and Implications
- No guaranteed long-lived server today:
  - Prefer Slack Socket Mode (no public webhook URL needed).
  - Keep runtime as one process with an internal queue.
- Validation in the Rails monolith is expensive:
  - MVP should support a fast validation gate command (targeted checks).
  - Full validation remains in existing CI matrix (already sharded).
- Open-source/LLM flexibility requirement:
  - Agent execution must be provider-agnostic via command template.
  - Goose can be one concrete adapter, not a hard dependency in code.

## Implementation Decisions (This Turn)
| Decision | Rationale |
|----------|-----------|
| New repo name: `hubble-mvp` | Fast isolation from monolith and simple pilot onboarding |
| Language/runtime: TypeScript + Node | Matches Slack Bolt ergonomics and rapid MVP iteration |
| Slack mode: Socket Mode | Works on local Mac/VM without ingress setup |
| State store: JSON file | Zero external services for first end-to-end test |
| Runner model: in-process queue | Simpler than Kubernetes/Temporal for MVP |
| Agent interface: command template with placeholders | Compatible with Goose/OpenRouter/Ollama/custom wrappers |
| GitHub integration: REST via Octokit | Straightforward PR automation for MVP |

## What “Done” Means for This MVP
1. Mention bot in Slack: request run against a repo.
2. Bot acknowledges with run ID and status updates.
3. Worker executes task command in isolated run directory.
4. Validation command runs (fast gate).
5. Branch is pushed and PR is opened automatically.
6. Bot posts PR link back to Slack.

## Implementation Findings (Built)
- New standalone repo created at `/Users/razvan/Development/hubble-mvp`.
- MVP stack implemented:
  - Slack Socket Mode app mentions (`src/slack-app.ts`)
  - Queue + file-backed run state (`src/run-manager.ts`, `src/store.ts`)
  - Pluggable execution command template (`src/executor.ts`)
  - GitHub PR creation with Octokit (`src/github.ts`)
  - Env-driven config with guardrails (`src/config.ts`)
- Ops artifacts added:
  - Setup/run guide (`README.md`)
  - Docker runtime (`Dockerfile`, `docker-compose.yml`)
  - VM bootstrap script (`scripts/bootstrap-vm.sh`)
  - Dummy agent + fast validation example scripts
- Verification completed:
  - `npm run check` passed
  - `npm run build` passed
  - command parser smoke test passed on built `dist` output

## Carry-Forward Resources
- `documentation/specs/integrations/minion_system_research_2026-02-17.md`
- `documentation/specs/integrations/hubble_system_blueprint_2026-02-17.md`

---
*Update this file as implementation discoveries are made*
