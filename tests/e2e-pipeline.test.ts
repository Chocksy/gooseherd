import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { loadConfig, type AppConfig } from "../src/config.js";
import { PipelineEngine } from "../src/pipeline/pipeline-engine.js";
import { GitHubService } from "../src/github.js";
import { resolveGitHubAuthMode } from "../src/config.js";
import type { RunRecord, ExecutionResult, PipelinePhase } from "../src/types.js";

// Load .env for real tokens
dotenv.config({ override: true });

// ── Helpers ─────────────────────────────────────────

function makeTestRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const id = `e2e-test-${Date.now()}`;
  return {
    id,
    status: "queued",
    phase: "queued",
    repoSlug: "epiccoders/pxls",
    task: "Add a comment to the README.md file explaining that this repo is managed by Gooseherd.",
    baseBranch: "main",
    branchName: `gooseherd/e2e-test-${id.slice(0, 8)}`,
    requestedBy: "U_E2E_TEST",
    channelId: "C_E2E_TEST",
    threadTs: "0000000000.000000",
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function makeTestConfig(workRoot: string, dataDir: string): AppConfig {
  const config = loadConfig();
  return {
    ...config,
    workRoot,
    dataDir,
    // Force dry run — no push, no PR
    dryRun: true,
    // Use dummy agent — fast, no LLM costs
    agentCommandTemplate: `bash ${path.resolve("scripts/dummy-agent.sh")} {{repo_dir}} {{prompt_file}} {{run_id}}`,
    // Disable validation/lint (no project-specific commands for pxls)
    validationCommand: "",
    lintFixCommand: "",
    // Disable CI wait
    agentTimeoutSeconds: 120,
  };
}

// ── E2E: Full Default Pipeline ──────────────────────

test("E2E: full default pipeline with epiccoders/pxls (dummy agent, dry-run)", async (t) => {
  // Skip if no GitHub auth configured (PAT or App)
  const authMode = resolveGitHubAuthMode(loadConfig());
  if (authMode === "none") {
    t.skip("No GitHub auth configured (set GITHUB_TOKEN or GitHub App credentials) — skipping E2E test");
    return;
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), "gooseherd-e2e-"));
  const workRoot = path.join(tmpDir, "work");
  const dataDir = path.join(tmpDir, "data");

  try {
    const config = makeTestConfig(workRoot, dataDir);
    const githubService = GitHubService.create(config);
    const engine = new PipelineEngine(config, githubService);
    const run = makeTestRun();

    // Track phases
    const phases: string[] = [];
    const onPhase = async (phase: PipelinePhase): Promise<void> => {
      phases.push(phase);
    };

    const result: ExecutionResult = await engine.execute(run, onPhase);

    // ── Assert pipeline completed ──
    assert.ok(result, "Pipeline should return a result");
    assert.ok(result.branchName, "Result should have a branch name");
    assert.ok(result.logsPath, "Result should have a logs path");

    // ── Assert phases progressed ──
    assert.ok(phases.includes("cloning"), `Should have cloned. Phases: ${phases.join(", ")}`);
    assert.ok(phases.includes("agent"), `Should have run agent. Phases: ${phases.join(", ")}`);

    // ── Assert clone produced a real repo ──
    const repoDir = path.join(workRoot, run.id, "repo");
    await access(repoDir); // throws if doesn't exist
    const readme = await readFile(path.join(repoDir, "README.md"), "utf8");
    assert.ok(readme.length > 0, "README.md should exist and have content");

    // ── Assert dummy agent produced changes ──
    assert.ok(result.commitSha, "Should have a commit SHA (agent made changes)");
    assert.ok(result.changedFiles && result.changedFiles.length > 0, "Should have changed files");
    assert.ok(
      result.changedFiles?.some(f => f.includes("README.md")),
      `Changed files should include README.md. Got: ${result.changedFiles?.join(", ")}`
    );

    // ── Assert prompt file was created ──
    const promptFile = path.join(workRoot, run.id, "task.md");
    const promptContent = await readFile(promptFile, "utf8");
    assert.ok(promptContent.includes("epiccoders/pxls"), "Prompt should reference the repo");
    assert.ok(promptContent.includes("Repository Context"), "Prompt should have repo context section");
    assert.ok(promptContent.includes("Task:"), "Prompt should have task section");

    // ── Assert .goosehints was written ──
    const goosehints = await readFile(path.join(repoDir, ".goosehints"), "utf8");
    assert.ok(goosehints.includes("Gooseherd Run Context"), ".goosehints should have run context");
    assert.ok(goosehints.includes(run.id), ".goosehints should include run ID");

    // ── Assert dry-run skipped push (no prUrl) ──
    assert.equal(result.prUrl, undefined, "Dry-run should not produce a PR URL");

    // ── Assert logs were written ──
    const logs = await readFile(result.logsPath!, "utf8");
    assert.ok(logs.length > 0, "Run logs should have content");
    assert.ok(logs.includes("[pipeline]"), "Logs should contain pipeline node entries");

    console.log(`E2E PASS: ${phases.length} phases, ${result.changedFiles?.length} files changed, commit ${result.commitSha?.slice(0, 8)}`);
  } finally {
    // Cleanup
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}, { timeout: 120_000 }); // 2 minute timeout for clone + agent

// ── E2E: Prompt contains task-type-specific instructions ──

test("E2E: hydrate-context injects task-type-aware instructions", async (t) => {
  // Skip if no GitHub auth configured (PAT or App)
  const authMode2 = resolveGitHubAuthMode(loadConfig());
  if (authMode2 === "none") {
    t.skip("No GitHub auth configured (set GITHUB_TOKEN or GitHub App credentials) — skipping E2E test");
    return;
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), "gooseherd-e2e-type-"));
  const workRoot = path.join(tmpDir, "work");
  const dataDir = path.join(tmpDir, "data");

  try {
    const config = makeTestConfig(workRoot, dataDir);
    const githubService = GitHubService.create(config);
    const engine = new PipelineEngine(config, githubService);

    // Use a bugfix-style task to test classifier
    const run = makeTestRun({
      task: "Fix the broken CSS styling on the landing page — the hero section has overflow issues"
    });

    const result = await engine.execute(run, async () => {});

    assert.ok(result.commitSha, "Pipeline should complete with a commit");

    // Read the prompt file and verify task-type-specific instructions
    const promptFile = path.join(workRoot, run.id, "task.md");
    const promptContent = await readFile(promptFile, "utf8");

    // The classifier should detect "fix" → bugfix type
    assert.ok(promptContent.includes("Task type:"), "Prompt should show task type");
    assert.ok(promptContent.includes("Expected output:"), "Prompt should have expected output section");

    // Verify repo summary was injected
    assert.ok(promptContent.includes("Directory structure"), "Prompt should have directory structure");

    console.log(`E2E type-aware PASS: prompt has task type + repo context`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}, { timeout: 120_000 });
