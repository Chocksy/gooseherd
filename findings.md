# Findings — Phase 14: Container Isolation (Task 30)

## Research Summary

See `docs/research-container-isolation.md` for full industry research (Cursor, Devin, E2B, agent-infra/sandbox).

## Key Technical Findings

### 1. Single Choke Point Confirmed
All shell execution goes through 3 functions in `src/pipeline/shell.ts`:
- `runShell()` (line 34) — `spawn("bash", ["-lc", command])`
- `runShellCapture()` (line 155) — same with capture
- `runShellWithProgress()` (line 114) — same with stderr callback

Adding an `sandboxId` option to route through `docker exec` is a minimal change.

### 2. CWD Pattern — Two Modes
- **repoDir** (`{workRoot}/{runId}/repo`): Used by git ops, quality gates
- **gooseherd root** (`path.resolve(".")`): Used by implement.ts (line 52) for agent CLI
- In container: both map to `/work/repo` and `/work` respectively

### 3. Login Shell Dependency
`implement.ts` line 55 uses `login: true` (bash -lc) so goose is on PATH.
In Docker: PATH is set in the image — this becomes cleaner, not harder.

### 4. Docker Available Locally
Docker 28.5.2 running with 4 containers. Good for local testing.

### 5. Volume Strategy
Named volumes don't expose host paths. Must use bind mounts:
- `SANDBOX_HOST_WORK_PATH` (e.g., `/data/gooseherd/work` on host, `.work` locally)
- For local dev: `SANDBOX_HOST_WORK_PATH=$(pwd)/.work`
- For Coolify: `SANDBOX_HOST_WORK_PATH=/data/gooseherd/work`

### 6. dockerode npm Package
- 5M weekly downloads, pure JS, well-maintained
- API: `docker.createContainer()`, `container.start()`, `container.exec()`, `container.remove()`
- Types: `@types/dockerode`
- Zero native deps — clean install

### 7. Dashboard Artifact Serving
Dashboard currently has NO route to serve files from run directories.
Need: `GET /api/runs/:id/artifacts/:filename` with path traversal protection.
Screenshot path already stored in context bag as `screenshotPath`.

### 8. Existing Tests
- 466 tests across 35 suites
- `tests/pipeline-nodes.test.ts` — mocks `runShellCapture`, easy to extend
- `tests/e2e-pipeline.test.ts` — full pipeline with real git, good pattern for Docker integration test

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Docker socket exposure | Read-only mount, non-root user in sandbox |
| Path mapping confusion | SANDBOX_HOST_WORK_PATH explicit config |
| Container cleanup on crash | Automatic label-based cleanup on startup |
| Test flakiness with Docker | SANDBOX_ENABLED=false keeps existing tests working |
| Image pull time | Pre-pull image on startup; use local build for dev |
