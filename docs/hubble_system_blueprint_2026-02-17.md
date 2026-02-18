# Hubble / Hubblers: Detailed Blueprint for a Slack-Native Coding Agent System

Date: 2026-02-17  
Audience: Hubstaff Engineering, Platform, Security, Dev Productivity

## 1. Scope and Intent

This design is for a **new standalone system** (not coupled to existing outbound Slack notifications in Hubstaff Rails app) that can:

- Receive coding requests from Slack threads.
- Investigate bugs or implement scoped features autonomously.
- Push a branch, open/update a PR, and report status back to Slack.
- Keep a strict human-review gate before merge.

Name options:
- Product/system: `Hubble`
- Agents/workers: `Hubblers`

## 2. Recommendation Summary

### Recommended architecture (single best path)

- **Agent runtime base:** Block Goose (fork or pinned internal distribution)
- **Control-plane language:** TypeScript (Node.js 22 LTS)
- **Slack framework:** Bolt for JavaScript
- **API layer:** Fastify (or NestJS if team prefers stronger DI patterns)
- **Workflow orchestration:** Temporal (self-hosted)
- **Queue/cache/coordination:** Redis
- **Primary state store:** PostgreSQL
- **Execution substrate:** Kubernetes Jobs with gVisor (`runsc`) runtime class
- **Policy engine:** OPA (Rego policies)
- **Object/log artifact storage:** S3-compatible blob store (e.g., S3/MinIO)

Why this path:
- Stripe publicly states Minions uses Goose as the core loop.
- Goose has an explicit custom distribution path (provider/tool/branding customization), including a REST-server architecture (`goosed`).
- Slack-first ergonomics are strongest with Bolt JS.
- Temporal gives durable long-running workflow state, retries, and observability for multi-step unattended runs.
- Kubernetes Jobs + TTL are a natural fit for per-run isolated execution with automatic cleanup.

## 3. Build-vs-Adapt Decision (Detailed)

### 3.1 Adapt (recommended)

Use OSS components for the hard parts and build Hubstaff-specific control logic:

- Reuse Goose for agentic edit loop.
- Build your own Slack ingress + policy + run orchestrator + PR coordinator.
- Keep organization-specific MCP tools private.

Benefits:
- Faster path to production reliability.
- Lower risk than inventing a full coding runtime.
- Keeps strategic control in-house.

### 3.2 Build from scratch (not recommended)

Inference:
- Reimplementing robust unattended coding behavior, tool calling, retries, and deterministic guardrails usually costs multiple quarters before dependable PR quality.

## 4. Open Source Components and Licensing

| Component | Role | License | Notes |
|---|---|---|---|
| Block Goose | Core coding-agent runtime | Apache-2.0 | Custom distros documented; aligns with Stripe pattern |
| Temporal Server | Durable workflow orchestration | MIT | Good for long-running run state machines |
| OPA | Policy-as-code enforcement | Apache-2.0 | Rego policies for action gating |
| PostgreSQL | Source of truth | PostgreSQL License | ACID + mature ecosystem |
| Redis | Fast queue/cache/rate-limit primitives | BSD-like (Redis OSS) | Use OSS version for self-hosting |
| Kubernetes | Ephemeral execution plane | Apache-2.0 | Job controller + TTL cleanup |
| gVisor | Stronger container sandboxing | Apache-2.0 | Runtime isolation layer in k8s |

OpenHands note:
- OpenHands core is MIT, but enterprise folder/license is source-available with additional terms. Treat as optional reference, not primary foundation for your self-hosted production path.

## 5. System Architecture (Production)

## 5.1 High-level components

1. `hubble-slack-gateway` (TypeScript/Bolt)
- Handles slash commands, app mentions, shortcuts, and thread context extraction.
- Verifies Slack signatures and timestamps.
- Responds quickly to Slack, then hands off async work.

2. `hubble-api` (TypeScript/Fastify)
- Core API for run creation, status querying, cancellation, approvals.
- Normalizes tasks into internal `RunIntent` objects.

3. `hubble-orchestrator` (TypeScript Temporal worker)
- Implements deterministic run workflows.
- Drives states: `queued -> running -> validating -> pr_opened -> done/failed`.

4. `hubble-runner-manager` (TypeScript service + k8s client)
- Creates isolated k8s Job per run.
- Injects short-lived credentials and policy envelope.
- Applies runtimeClass and pod security settings.

5. `hubble-runner` (container image)
- Minimal Linux base + git + language toolchains + Goose runtime.
- Executes deterministic wrapper script around Goose.
- Emits structured logs/artifacts.

6. `hubble-pr-coordinator` (TypeScript worker)
- Uses GitHub App tokens to create branch/commits/PR.
- Adds CI links, patch summary, risk hints.
- Updates Slack thread with progress and PR URL.

7. `hubble-policy-service` (OPA sidecar or service)
- Evaluates action plans and changed-file policies.
- Hard blocks disallowed actions.

8. `hubble-ui` (optional in pilot, required for scale)
- Run timeline, tool traces, artifact browser, approval actions.

## 5.2 Core data stores

- PostgreSQL:
  - Runs, tasks, state transitions, policy decisions, approvals, artifacts index.
- Redis:
  - Idempotency keys, short-lived locks, rate limiting, transient queueing.
- S3/MinIO:
  - Run transcripts, diffs, logs, test outputs, prompt snapshots.

## 5.3 External integrations

- Slack Events API / Interactivity API.
- GitHub App APIs (contents, pull requests, checks, issues metadata as needed).
- Internal MCP servers for docs/search/tickets.

## 6. Detailed Workflow

## 6.1 Slack to run creation

1. Engineer invokes `@Hubble` in a thread or `/hubble` command.
2. Slack gateway verifies request signature and timestamp.
3. Gateway captures:
- user/team/channel/thread
- full thread text and links
- repository target (explicit or inferred)
- task type (`investigate`, `fix`, `feature`, `test-fix`)
4. Gateway writes `run_request` and acks Slack immediately.

## 6.2 Orchestration and policy preflight

1. Orchestrator assembles `RunContext`.
2. Runs preflight checks:
- repo allowlist
- user permissions
- change budget limits
- task-type policy
3. Hydrates context from MCP tools deterministically (ticket/docs/last failing CI).
4. Creates execution plan and requests runner provisioning.

## 6.3 Runner execution (deterministic + agentic loop)

Inside runner:

1. Clone repo at target base branch.
2. Create work branch: `hubble/<run-id>-<slug>`.
3. Run agent loop (Goose) with constrained tools.
4. Enforce deterministic steps after each major change:
- format/lint
- scoped tests
- policy checks (paths/files/forbidden APIs)
5. On success, commit and push branch.
6. Return artifacts + change summary.

## 6.4 PR and feedback loop

1. PR coordinator creates draft PR by default.
2. Adds:
- summary of requested task
- files changed
- test/lint results
- known risks
3. Waits for CI status; optionally permits one auto-fix cycle.
4. Posts final status in Slack thread.

## 6.5 Termination

- Success: PR ready for human review.
- Partial: PR opened with caveats and known blockers.
- Failure: no PR, full logs + repro notes posted.

## 7. Data Model (Initial schema)

## 7.1 `agent_runs`
- `id` (uuid, pk)
- `run_key` (unique text)
- `status` (enum)
- `task_type` (enum)
- `requested_by_user_id` (text)
- `slack_team_id`, `slack_channel_id`, `slack_thread_ts`
- `repo_owner`, `repo_name`, `base_branch`, `head_branch`
- `model_profile` (text)
- `cost_tokens_input`, `cost_tokens_output`, `cost_usd_estimated`
- `created_at`, `updated_at`, `started_at`, `finished_at`

## 7.2 `run_events`
- `id` (uuid)
- `run_id` (fk)
- `event_type` (enum)
- `payload_json` (jsonb)
- `created_at`

## 7.3 `policy_decisions`
- `id` (uuid)
- `run_id` (fk)
- `policy_name`
- `decision` (`allow|deny|warn`)
- `reason`
- `input_hash`
- `created_at`

## 7.4 `run_artifacts`
- `id` (uuid)
- `run_id` (fk)
- `artifact_type` (`log|diff|patch|test_report|prompt_snapshot`)
- `storage_uri`
- `sha256`
- `created_at`

## 7.5 `run_approvals`
- `id` (uuid)
- `run_id` (fk)
- `approval_type` (`high_risk_change`, `rerun`, `merge_override`)
- `approved_by`
- `approved_at`

## 8. Security Architecture

## 8.1 Identity and secrets

- Slack signing secret verification at ingress.
- GitHub App installation tokens minted per run, short-lived.
- No static PATs in runners.
- Use workload identity / secret broker to inject ephemeral credentials.

## 8.2 Runner isolation

- One k8s Job per run.
- Non-root container user.
- Read-only root filesystem where possible.
- NetworkPolicy deny-all + explicit egress allowlist (GitHub, model endpoint, internal MCP only).
- Runtime isolation via gVisor runtime class.

## 8.3 Policy guardrails (OPA)

Examples:
- Deny changes to `infra/prod/**` in pilot.
- Deny secrets file writes (`*.pem`, `.env`, key patterns).
- Deny dependency upgrades unless task explicitly permits.
- Limit max files changed and max LOC delta.

## 8.4 Auditability

- Every tool call and decision event logged.
- Hash and retain prompts/artifacts.
- Correlate Slack thread -> run -> commit -> PR -> reviewer.

## 9. Reliability and SLOs

Suggested SLOs (pilot):
- 95% run-start latency < 90s from Slack command.
- 90% successful PR generation for supported task categories.
- 99% Slack command ack under 2.5s.
- 0 unauthorized high-risk file modifications.

Failure handling:
- Temporal retries for transient integration failures.
- Runner heartbeat and timeout kill.
- Idempotency key per Slack event to avoid duplicate runs.

## 10. Recommended Task Taxonomy

Pilot-safe categories:
- `test_fix` (fix failing tests)
- `small_bugfix` (single service/module)
- `code_cleanup` (lint/refactor constrained)
- `docs_update` (developer docs)

Deferred categories:
- DB migrations in core billing paths
- auth/security-sensitive flows
- cross-repo architectural refactors

## 11. Pilot Scope (Detailed)

## 11.1 Pilot boundaries

- Team: 5-10 engineers (one on-call pod + one product pod).
- Repositories: 1-2 medium-size repos.
- Duration: 6 weeks active pilot.
- Run budget: max 20 autonomous runs/day.

## 11.2 Pilot phases

Phase A (Week 1-2): Dry-run / shadow mode
- Slack ingestion + run planning + no write access.
- Produce "proposed diff" artifacts only.

Phase B (Week 3-4): Write + PR draft mode
- Branch/PR creation enabled.
- Strict file/path policies.
- No auto-merge, always human review.

Phase C (Week 5-6): Controlled CI loop
- Single automated CI-fix retry permitted.
- Measure PR acceptability and reviewer effort.

## 11.3 Success criteria

- >= 60% pilot runs produce reviewable PRs.
- >= 40% pilot PRs merged with minimal manual rewrite.
- Median review time not worse than human-authored baseline.
- No critical policy/security incidents.

## 11.4 Abort criteria

- Any high-severity secret leak incident.
- >5% runs violate hard policy denies due to design issues.
- Sustained CI resource abuse or runaway token spend.

## 12. Delivery Plan (12-week build)

Week 1-2:
- Slack app + signature verification + command schema.
- PostgreSQL schema + run event model.
- Temporal skeleton workflow.

Week 3-4:
- Kubernetes runner manager.
- Goose runner wrapper.
- Artifact storage and log streaming.

Week 5-6:
- GitHub App integration (branch/commit/PR/check status).
- Slack progress updates and cancel/retry controls.

Week 7-8:
- OPA policy integration.
- Security controls (network policy, runtime class, redaction).

Week 9-10:
- Pilot-safe task taxonomy + policy packs.
- Dashboards (run outcomes, latency, cost).

Week 11-12:
- Pilot execution and tuning.
- Go/no-go review for broader rollout.

## 13. Team and Ownership

Minimum team:
- 1 Staff engineer (architecture/orchestration)
- 1 Senior backend engineer (Slack/GitHub integrations)
- 1 Senior platform engineer (k8s/isolation/security)
- 0.5 SRE + 0.5 security engineer part-time

Service ownership:
- Dev Productivity owns product behavior and policies.
- Platform owns runner substrate and reliability.
- Security owns guardrails and audit requirements.

## 14. Cost Controls

- Per-run token budget caps (hard stop).
- Max runtime per run (e.g., 25 minutes default).
- Max retries at each stage.
- CI round cap (1 in pilot, maybe 2 post-pilot).
- Automatic stop for low-confidence or policy-conflicting plans.

## 15. Naming/Branding Guidance

- External app name in Slack: `Hubble`.
- Internal worker noun: `Hubblers`.
- Run IDs: `HB-<date>-<shortid>`.
- Branch prefix: `hubble/`.
- Public principle: "Hubblers write; humans approve."

## 16. Key Inferences vs Confirmed Facts

Confirmed from sources:
- Stripe Minions are Slack-triggered, Goose-based, unattended to PR, with deterministic validation stages.
- Goose supports custom distributions, branding, extensions, and server/REST architecture.
- Slack recommends Bolt and requires prompt event acknowledgements.
- Kubernetes Jobs/TTL semantics support ephemeral run workers and cleanup.

Inference for Hubstaff design:
- TypeScript + Bolt + Temporal + k8s Jobs + gVisor is the highest-leverage stack for fast, safe implementation by a product-platform team.
- A 12-week implementation with a 6-week controlled pilot is realistic with the staffing described.

## 17. Source References

- Stripe Minions blog: https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents
- Goose README: https://github.com/block/goose
- Goose custom distros: https://raw.githubusercontent.com/block/goose/main/CUSTOM_DISTROS.md
- OpenHands README: https://github.com/OpenHands/OpenHands
- OpenHands enterprise license: https://github.com/OpenHands/OpenHands/blob/main/enterprise/LICENSE
- SWE-agent README: https://github.com/SWE-agent/SWE-agent
- Aider README: https://github.com/Aider-AI/aider
- Slack Bolt/platform: https://api.slack.com/automation/bolt
- Slack Events API: https://docs.slack.dev/apis/events-api/
- Slack request verification: https://docs.slack.dev/authentication/verifying-requests-from-slack/
- GitHub pull requests REST: https://docs.github.com/en/rest/pulls/pulls
- GitHub app permissions guide: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- GitHub checks REST (source): https://raw.githubusercontent.com/github/docs/main/content/rest/checks/runs.md
- Temporal docs: https://docs.temporal.io/
- Temporal OSS README: https://raw.githubusercontent.com/temporalio/temporal/master/README.md
- Temporal license: https://raw.githubusercontent.com/temporalio/temporal/master/LICENSE
- Kubernetes Jobs (source): https://raw.githubusercontent.com/kubernetes/website/main/content/en/docs/concepts/workloads/controllers/job.md
- Kubernetes TTL-after-finished (source): https://raw.githubusercontent.com/kubernetes/website/main/content/en/docs/concepts/workloads/controllers/ttlafterfinished.md
- OPA docs: https://openpolicyagent.org/docs/
- OPA license: https://raw.githubusercontent.com/open-policy-agent/opa/main/LICENSE
- gVisor docs: https://gvisor.dev/docs/
- PostgreSQL about: https://www.postgresql.org/about/
