# Hubstaff "Minions-like" Slack Coding System Research

Date: 2026-02-17  
Author: Codex research + council-style parallel analysis

## 1. Objective

Design a Slack-native system for Hubstaff where engineers can ask an agent to investigate bugs, fix issues, or implement features, and receive a branch + PR for review/merge.

## 2. Executive Recommendation

Build on **Block Goose** as the core open-source agent runtime, and implement a Hubstaff-owned orchestration layer around it (Slack ingress, runner lifecycle, policy checks, GitHub PR flow, auditability).

Why:
- Stripe explicitly states Minions runs on a fork of Goose.
- Goose is Apache-2.0 and purpose-built for extensible autonomous coding with MCP support.
- It avoids licensing constraints tied to source-available enterprise-only features.

Secondary option:
- Use OpenHands SDK for parts of runtime/orchestration ideas, but treat its Slack/Jira/Linear integrations as potentially license-constrained for long-term self-host production.

## 3. What Stripe Minions Actually Does (from 2026-02-09 post)

Confirmed facts from Stripe's post:
- Minions produce more than 1,000 merged PRs per week.
- Typical run starts in Slack and ends in a PR ready for human review.
- Runs execute in isolated pre-warmed devboxes (about 10 seconds startup), isolated from production and internet.
- Core loop runs on a fork of Block Goose.
- Agent loop is interleaved with deterministic steps (git operations, lint, tests).
- MCP is central; Stripe uses a large internal MCP server ("Toolshed") with 400+ tools.
- One-shot goal with layered feedback:
  - Fast local checks first.
  - Selective CI.
  - Maximum of two CI rounds.

Inference:
- The system is not "just an agent"; it is a full control-plane + execution-plane architecture with strict policy and feedback gates.

Note:
- Stripe mentions a part 2 implementation deep dive, but as of 2026-02-17 no separate published part-2 slug was found in the current Stripe blog index payload.

## 4. Current Hubstaff Baseline (repo evidence)

Hubstaff already has useful primitives:
- Existing Slack OAuth + API utility layer: `lib/slack_utils.rb`
- Slack integration controller flows: `app/controllers/slack_controller.rb`
- Sidekiq-based Slack delivery jobs with retry/rate-limit/circuit-breaker patterns:
  - `app/jobs/slack/deliver_notifications_job_base.rb`
  - `app/jobs/slack/deliver_notifications_job.rb`
  - `app/jobs/slack/deliver_smart_notification_job.rb`
- Slack queue model: `app/models/slack_notification.rb`
- Slack routes today: `config/routes.rb:410`
- Architecture docs explicitly describe Slack as outbound only:
  - `documentation/specs/integrations/current_state_architecture.md:619`
  - `documentation/specs/integrations/current_state_architecture.md:714`
- Stack already includes `slack-ruby-client`, `sidekiq`, and `ruby-openai`:
  - `Gemfile:158`
  - `Gemfile:278`
  - `Gemfile:290`

Gap to close:
- No inbound Slack command/event ingestion route for "start investigation/fix/feature" workflows.
- No agent run lifecycle model (run state, artifacts, policy decisions, traceability).
- No ephemeral coding-runner orchestration layer that can safely modify repos and open PRs.

## 5. Open-Source Candidate Evaluation

| Candidate | License | Strengths | Gaps vs your goal | Fit |
|---|---|---|---|---|
| Block Goose | Apache-2.0 | Extensible local agent, MCP-native, CLI/Desktop, Stripe-proven base | No out-of-box Slack-to-PR control plane | **Best base** |
| OpenHands | MIT core + source-available enterprise dirs | Strong SDK/CLI/GUI ecosystem; cloud mentions Slack/Jira/Linear integrations | Slack integration tied to cloud/enterprise context; license boundary to manage | Good reference/partial base |
| SWE-agent | MIT | Strong autonomous repo issue-solving engine, research-grade | Less production workflow productization, weaker Slack-native flow | Good for experimentation |
| Aider | Apache-2.0 | Excellent git-centric coding assistant, lint/test workflows | Primarily interactive pair-coding; not end-to-end unattended orchestration | Useful component, not full base |

## 6. Proposed Hubstaff Architecture (Minions-like)

### 6.1 Control Plane (inside Hubstaff platform)

- Slack ingress service:
  - App mentions, slash command, and thread context ingestion.
  - Signature verification (`X-Slack-Signature`, timestamp).
  - Immediate ack within Slack timing constraints.
- Run Orchestrator:
  - Creates `AgentRun` with request metadata, policy context, repo target.
  - Queues execution job to runner manager.
- Policy Engine:
  - Allowlist repos/paths/actions.
  - Enforce "no secrets/prod access", max runtime, max file changes, CI budget.
- PR Coordinator:
  - Branch naming, push, PR creation, CI status polling, Slack status updates.
- Audit + Observability:
  - Full trace of prompts, tool calls, file diffs, test outcomes, approvals.

### 6.2 Execution Plane (isolated runners)

- Ephemeral containers/VMs with pre-baked repo toolchains.
- Network and credentials sandboxing.
- Agent runtime (Goose fork/config) + deterministic wrappers:
  - `git checkout -b ...`
  - repo formatting/lint
  - scoped tests
  - commit + push + PR draft/open
- Optional second CI-fix attempt, then stop.

### 6.3 Tool Layer (MCP-first)

- Start with small curated MCP set:
  - GitHub (PRs, checks, comments)
  - Issue tracker (Jira/Linear/GitHub issues)
  - Docs/search
  - CI status
- Expand to "Toolshed-like" internal catalog after MVP proves reliability.

## 7. MVP Scope (what to build first)

Week 1-2:
- Slack inbound workflow (`/minion` + mention in thread).
- `AgentRun` persistence model + status updates in Slack.
- Secure GitHub App auth path for repo write + PR create.

Week 3-5:
- Ephemeral runner manager.
- Goose-based run with deterministic wrappers for lint/tests.
- Create branch + PR + summary comment.

Week 6-8:
- CI feedback loop (max 2 attempts).
- Guardrails: policy checks, timeout/cancel, cost limits.
- Basic web UI for run logs and artifacts.

Inference:
- A functional internal MVP is realistic in about 8 weeks with 2-3 senior engineers, if infra primitives (k8s/runner fleet/secrets) already exist.

## 8. Build vs Adapt Decision

### Adapt-heavy path (recommended)

Use open-source runtime + custom control plane:
- Fork/configure Goose.
- Keep orchestration, policy, and Slack/GitHub integration in your own services.
- Benefit: maximum legal clarity + architectural control.

### Full build from scratch (not recommended first)

- Rebuilding runtime loop, tool protocol adapters, and reliable repo-edit behavior is expensive and slow.
- High risk of spending months before reaching stable PR-quality output.

## 9. Security/Compliance Requirements (non-negotiable)

- Least-privilege GitHub App permissions only.
- Ephemeral credentials per run; no long-lived tokens in prompts/logs.
- Runner isolation from production data systems.
- Prompt/tool call redaction and retention policies.
- Human review required before merge.
- Kill switch and per-org/per-repo disable controls.

## 10. Success Metrics

- PR acceptance rate (merged without heavy rewrite).
- Median end-to-end run time.
- Re-run rate (how often command must be repeated).
- Cost per successful PR.
- On-call issue closure acceleration.
- Policy violation incidents (target: zero).

## 11. Key Decisions You Need to Make Next

1. Runtime base: Goose-only or Goose + OpenHands SDK experimentation?
2. Runner substrate: Kubernetes jobs, VM pool, or existing CI workers?
3. Repo scope for pilot: one repo/team first (recommended) vs broad rollout.
4. Merge policy: draft PR only vs auto-open ready PR with strict gates.
5. LLM policy: single provider or multi-model routing by task type/cost.

## 12. Sources

- Stripe Minions post (2026-02-09):  
  https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents
- Goose repository:  
  https://github.com/block/goose
- Goose quickstart/docs:  
  https://block.github.io/goose/docs/quickstart
- OpenHands repository/readme and license boundary:  
  https://github.com/OpenHands/OpenHands
- OpenHands enterprise license file:  
  https://github.com/OpenHands/OpenHands/blob/main/enterprise/LICENSE
- SWE-agent repository:  
  https://github.com/SWE-agent/SWE-agent
- Aider repository:  
  https://github.com/Aider-AI/aider
- Slack Events API docs:  
  https://docs.slack.dev/apis/events-api/
- Slack request signing docs:  
  https://docs.slack.dev/authentication/verifying-requests-from-slack/
- GitHub pull request REST docs:  
  https://docs.github.com/en/rest/pulls/pulls
- GitHub App permissions guidance:  
  https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- MCP architecture docs:  
  https://modelcontextprotocol.io/docs/concepts/architecture

