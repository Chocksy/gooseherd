# Task Plan: Hubble MVP Build (Slack + Goose + GitHub PR)

## Goal
Create a runnable MVP in a new repository that can:
1) accept a Slack command in a personal workspace,
2) run a coding task via a pluggable agent command (Goose-compatible),
3) run lightweight validation,
4) push a branch and open a GitHub pull request,
5) report status back to Slack.

## Current Phase
Phase 5

## Phases

### Phase 1: MVP Scope Lock
- [x] Confirm no dedicated server requirement for v1
- [x] Choose MVP runtime architecture (single process + queue + Socket Mode)
- [x] Define local/VM deployment target and constraints
- **Status:** complete

### Phase 2: Repo Scaffolding
- [x] Create new repository folder (`hubble-mvp`)
- [x] Initialize Node/TypeScript project and base configs
- [x] Add env template, Dockerfile, and compose file
- **Status:** complete

### Phase 3: Core MVP Implementation
- [x] Implement Slack bot command intake (Socket Mode)
- [x] Implement run queue/state store
- [x] Implement agent execution adapter (configurable command template)
- [x] Implement GitHub branch push + PR creation
- **Status:** complete

### Phase 4: Ops Runbook + Pilot Defaults
- [x] Write setup guide for Slack app + GitHub token + optional Goose
- [x] Add VM bootstrap and local test workflow
- [x] Document fast-gate validation strategy for monolith repos
- **Status:** complete

### Phase 5: Verification
- [x] Run static checks/build locally for MVP repo
- [x] Smoke test command parsing and run lifecycle
- [x] Capture known gaps and next iteration plan
- **Status:** complete

## Key Questions
1. How do we make this testable without stable infra? (Answer: Slack Socket Mode + single VM/local.)
2. How do we avoid lock-in to one coding engine? (Answer: agent command template abstraction.)
3. How do we control validation cost for large Rails repos? (Answer: fast gate in MVP, full gate in CI.)

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Build MVP as a standalone new repo | Avoid coupling/risk with current monolith |
| Use TypeScript + Slack Bolt Socket Mode | Fastest path for personal Slack testing without public URL |
| Make Goose integration command-template based | Supports Goose/OpenRouter/Ollama/custom wrappers |
| Keep storage simple (file-based) for MVP | Reduces setup burden and allows quick validation |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Planning catchup reported unsynced prior context | 1 | Ran catchup + git status; no tracked diff conflicts found |
| TypeScript strict null errors in run manager and Slack event user field | 1 | Added stable run ID handling and explicit user guard |

## Notes
- Prior research docs remain valid and are intentionally preserved.
- This turn focuses on executable MVP code, not architecture-only docs.
