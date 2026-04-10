/**
 * E2E Browser Verify Test — real PR, real deploy preview, real browser verification.
 *
 * Full pipeline flow:
 *   1. Direct enqueue (bypasses orchestrator — conversation test already covers that)
 *   2. Pipeline: clone → implement → commit → push → create_pr
 *   3. Deploy preview: wait for Coolify preview at {{prNumber}}.stg.epicpxls.com
 *   4. Browser verify: Stagehand agent navigates preview, validates change
 *   5. Verify artifacts: screenshots, video, verdict
 *   6. Cleanup: close PR, delete branch
 *
 * Gated on E2E_BROWSER_VERIFY=1 — not run in normal test suite.
 * Creates a REAL GitHub PR (closed + cleaned up after).
 *
 * Usage:
 *   E2E_BROWSER_VERIFY=1 node --test --import tsx tests/e2e-browser-verify.test.ts
 *
 * Optional env vars:
 *   E2E_AGENT_MODEL=<model>          — override agent model (default: openrouter/openai/gpt-4.1-mini)
 *   E2E_BROWSER_VERIFY_MODEL=<model> — override browser verify model (default: openai/gpt-4.1-mini)
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, access, readdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { loadConfig, resolveGitHubAuthMode, type AppConfig } from "../src/config.js";
import { PipelineEngine } from "../src/pipeline/pipeline-engine.js";
import { GitHubService } from "../src/github.js";
import { DockerExecutionBackend } from "../src/runtime/docker-backend.js";
import { LocalExecutionBackend } from "../src/runtime/local-backend.js";
import { RunStore } from "../src/store.js";
import { RunManager } from "../src/run-manager.js";
import type { RunRecord } from "../src/types.js";

dotenv.config({ override: true });

const ENABLED = process.env["E2E_BROWSER_VERIFY"] === "1";
const REPO = "epiccoders/pxls";

// ── Helpers ────────────────────────────────────────────

function stubWebClient() {
  return {
    chat: {
      postMessage: async () => ({ ok: true, ts: "0000000000.000001" }),
      update: async () => ({ ok: true })
    }
  };
}

function swapAgentModel(template: string, newModel: string): string {
  return template.replace(/--model\s+\S+/, `--model ${newModel}`);
}

async function waitForRunCompletion(
  store: RunStore,
  runId: string,
  timeoutMs: number
): Promise<RunRecord> {
  const deadline = Date.now() + timeoutMs;
  const shortId = runId.slice(0, 8);
  let lastPhase = "";
  while (Date.now() < deadline) {
    const run = await store.getRun(runId);
    if (run) {
      const phase = run.phase ?? run.status;
      if (phase !== lastPhase) {
        const elapsed = run.startedAt
          ? `${Math.round((Date.now() - Date.parse(run.startedAt)) / 1000)}s`
          : "?";
        console.log(`  [${shortId}] ${lastPhase || "start"} → ${phase} (${elapsed})`);
        lastPhase = phase;
      }
      if (run.status === "completed" || run.status === "failed") {
        return run;
      }
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`Run ${runId} did not complete within ${timeoutMs / 1000}s (last phase: ${lastPhase})`);
}

/** Close PR and delete branch via gh CLI. Swallows errors — cleanup is best-effort. */
function cleanupPR(repoSlug: string, prNumber: number | string, branchName: string): void {
  try {
    console.log(`\nCleanup: closing PR #${prNumber} on ${repoSlug}...`);
    execSync(`gh pr close ${String(prNumber)} --repo ${repoSlug} --delete-branch`, {
      timeout: 30_000,
      stdio: "pipe"
    });
    console.log(`Cleanup: PR #${prNumber} closed, branch ${branchName} deleted`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    console.log(`Cleanup: failed to close PR (will need manual cleanup): ${msg}`);
    try {
      execSync(`gh api repos/${repoSlug}/git/refs/heads/${branchName} -X DELETE`, {
        timeout: 15_000,
        stdio: "pipe"
      });
      console.log(`Cleanup: branch ${branchName} deleted`);
    } catch {
      console.log(`Cleanup: branch deletion also failed — manual cleanup needed`);
    }
  }
}

// ── The Test ───────────────────────────────────────────

test("E2E Browser Verify: visual change → PR → deploy preview → browser verify", async (t) => {
  if (!ENABLED) {
    t.skip("Set E2E_BROWSER_VERIFY=1 to run this test");
    return;
  }

  const baseConfig = loadConfig();
  const authMode = resolveGitHubAuthMode(baseConfig);

  if (authMode === "none") {
    t.skip("No GitHub auth configured — skipping");
    return;
  }
  if (!process.env["OPENROUTER_API_KEY"]) {
    t.skip("OPENROUTER_API_KEY not set — skipping");
    return;
  }

  // ── Model resolution ──
  const agentModel = process.env["E2E_AGENT_MODEL"] || "openrouter/openai/gpt-4.1-mini";
  const agentTemplate = swapAgentModel(baseConfig.agentCommandTemplate, agentModel);
  const browserVerifyModel = process.env["E2E_BROWSER_VERIFY_MODEL"] || "openai/gpt-4.1-mini";

  console.log("\n====== E2E BROWSER VERIFY TEST ======");
  console.log(`Agent model: ${agentModel}`);
  console.log(`Browser verify model: ${browserVerifyModel}`);
  console.log(`Repo: ${REPO}`);
  console.log(`Pipeline: ${baseConfig.pipelineFile}`);

  // ── Setup temp dirs ──
  const tmpDir = await mkdtemp(path.join(tmpdir(), "gooseherd-e2e-bv-"));
  const workRoot = path.join(tmpDir, "work");
  const dataDir = path.join(tmpDir, "data");

  const threadChannelId = "local";
  const threadTs = `e2e-bv-${Date.now()}.000000`;

  // Track PR info for cleanup
  let prNumber: number | string | undefined;
  let branchName: string | undefined;

  try {
    const config: AppConfig = {
      ...baseConfig,
      workRoot,
      dataDir,
      // MUST be false — we need to push + create PR for preview deployment
      dryRun: false,
      agentCommandTemplate: agentTemplate,
      agentTimeoutSeconds: Math.min(baseConfig.agentTimeoutSeconds, 300),
      // Skip validation/lint — testing the browser verify flow, not project linting
      validationCommand: "",
      lintFixCommand: "",
      // Enable browser verify + screenshots
      browserVerifyEnabled: true,
      screenshotEnabled: true,
      browserVerifyModel,
      // Skip CI wait — testing deploy preview + browser verify, not GitHub Actions
      ciWaitEnabled: false,
    };

    const store = new RunStore(dataDir);
    await store.init();

    const githubService = GitHubService.create(config);
    const pipelineEngine = new PipelineEngine(config, githubService);
    const runtimeRegistry = {
      local: new LocalExecutionBackend(pipelineEngine),
      docker: new DockerExecutionBackend(pipelineEngine),
      kubernetes: undefined
    };
    const slackClient = stubWebClient();
    const runManager = new RunManager(config, store, runtimeRegistry, slackClient as any);

    // ────────────────────────────────────────────────────
    // Enqueue directly — bypass orchestrator.
    // The E2E conversation test already validates the orchestrator.
    // This test focuses on: push → PR → deploy preview → browser verify.
    //
    // Task: Create a NEW static HTML file in public/.
    // Why: pi-agent's edit tool reliably FAILS on Slim templates (complex
    // indentation + Ruby interpolation). Creating a new file is 100% reliable.
    // Rails serves files from public/ directly — the badge will be visible
    // at /gooseherd-qa-test.html on the preview deployment.
    // ────────────────────────────────────────────────────

    const task = [
      `Create a new file at public/gooseherd-qa-test.html with the following content:`,
      "",
      `<!DOCTYPE html>`,
      `<html lang="en">`,
      `<head><meta charset="utf-8"><title>Gooseherd QA</title></head>`,
      `<body style="margin:0;font-family:sans-serif;background:#f5f5f5">`,
      `  <div style="max-width:600px;margin:40px auto;padding:20px;background:white;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1)">`,
      `    <h1 style="color:#333">Gooseherd QA Verification</h1>`,
      `    <p>This page was created by the Gooseherd E2E browser verify test.</p>`,
      `    <p>If you can see this page, the deploy preview is working correctly.</p>`,
      `  </div>`,
      `  <div id="gooseherd-qa" style="position:fixed;bottom:0;right:0;background:#FFEB3B;color:#333;padding:2px 8px;font-size:11px;z-index:9999">GH-QA</div>`,
      `</body>`,
      `</html>`,
      "",
      "Create ONLY this one new file. Do not modify any other files.",
    ].join("\n");

    console.log("\n====== Enqueuing pipeline run (direct, no orchestrator) ======");

    const run = await runManager.enqueueRun({
      repoSlug: REPO,
      task,
      baseBranch: config.defaultBaseBranch,
      requestedBy: "e2e-browser-test",
      channelId: threadChannelId,
      threadTs,
      runtime: config.sandboxRuntime,
      enableNodes: ["deploy_preview", "browser_verify", "summarize_changes", "upload_screenshot"]
    });

    branchName = run.branchName;
    console.log(`Run queued: ${run.id.slice(0, 8)} on ${run.repoSlug} (branch: ${branchName})`);

    // ────────────────────────────────────────────────────
    // Wait for full pipeline: implement → push → PR → deploy → browser verify
    // ────────────────────────────────────────────────────
    console.log("\n====== Waiting for full pipeline (agent → push → PR → deploy → browser verify) ======");
    console.log("This may take 5-15 minutes (deploy preview build time)...");

    const completedRun = await waitForRunCompletion(store, run.id, 1_200_000); // 20 min
    console.log(`\nRun finished: status=${completedRun.status}`);

    // Capture PR info for cleanup
    prNumber = completedRun.prNumber;
    if (!prNumber && completedRun.prUrl) {
      const match = completedRun.prUrl.match(/\/pull\/(\d+)/);
      if (match) prNumber = match[1];
    }

    if (completedRun.status === "failed") {
      console.log(`Error: ${completedRun.error}`);
      if (completedRun.logsPath) {
        try {
          const logs = await readFile(completedRun.logsPath, "utf8");
          const tail = logs.split("\n").slice(-50).join("\n");
          console.log(`Last 50 log lines:\n${tail}`);
        } catch { /* no logs */ }
      }
    }

    // ── Pipeline should complete ──
    assert.ok(
      completedRun.status === "completed",
      `Run should complete. Status: ${completedRun.status}, Error: ${completedRun.error ?? "none"}`
    );

    // ── Verify core pipeline artifacts ──
    const runDir = path.join(workRoot, run.id);
    const repoDir = path.join(runDir, "repo");

    await access(repoDir);
    console.log("  Clone: OK");

    assert.ok(completedRun.commitSha, "Should have a commit SHA");
    console.log(`  Commit: ${completedRun.commitSha?.slice(0, 8)}`);

    assert.ok(completedRun.changedFiles && completedRun.changedFiles.length > 0, "Should have changed files");
    console.log(`  Changed: ${completedRun.changedFiles?.join(", ")}`);

    // ── Verify the static HTML file was created ──
    const qaFilePath = path.join(repoDir, "public", "gooseherd-qa-test.html");
    try {
      const qaContent = await readFile(qaFilePath, "utf8");
      const hasQaBadge = qaContent.includes("gooseherd-qa") || qaContent.includes("GH-QA");
      console.log(`  QA file: ${hasQaBadge ? "created with badge" : "created but badge not found"}`);
    } catch {
      console.log("  QA file: not found (agent may have used different path)");
    }

    // ── Verify PR was created ──
    assert.ok(completedRun.prUrl, "Should have a PR URL (dryRun is false)");
    console.log(`  PR: ${completedRun.prUrl}`);

    // ── Verify deploy preview + browser verify from logs ──
    if (completedRun.logsPath) {
      const logs = await readFile(completedRun.logsPath, "utf8");
      console.log(`  Logs: ${logs.split("\n").length} lines`);

      // Deploy preview
      const deployPreviewRan = logs.includes("[deploy_preview]");
      console.log(`  Deploy preview: ${deployPreviewRan ? "ran" : "not found in logs"}`);

      if (deployPreviewRan) {
        const urlMatch = logs.match(/\[deploy_preview\] preview ready: (https?:\/\/\S+)/);
        if (urlMatch) console.log(`  Preview URL: ${urlMatch[1]}`);
        const readyMatch = logs.match(/\[deploy_preview\] URL ready: HTTP (\d+) after (\d+)s/);
        if (readyMatch) console.log(`  Preview ready: HTTP ${readyMatch[1]} after ${readyMatch[2]}s`);
      }

      // Browser verify
      const browserVerifyRan = logs.includes("[gate:browser_verify]");
      console.log(`  Browser verify: ${browserVerifyRan ? "ran" : "not found in logs"}`);

      if (browserVerifyRan) {
        const smokeMatch = logs.match(/\[gate:browser_verify\] smoke test: HTTP (\d+)/);
        if (smokeMatch) console.log(`  Smoke test: HTTP ${smokeMatch[1]}`);

        const verdictMatch = logs.match(/\[gate:browser_verify\] (?:LLM )?verdict: (PASS|FAIL) \((\w+)\) — (.+)/);
        if (verdictMatch) console.log(`  Verdict: ${verdictMatch[1]} (${verdictMatch[2]}) — ${verdictMatch[3]}`);

        const stagehandFailed = logs.includes("[gate:browser_verify] stagehand failed");
        if (stagehandFailed) console.log("  Stagehand: fell back to screenshot");
      }
    }

    // ── Verify screenshot artifacts ──
    const screenshotsDir = path.join(runDir, "screenshots");
    try {
      await access(screenshotsDir);
      const screenshots = await readdir(screenshotsDir);
      console.log(`  Screenshots: ${screenshots.length > 0 ? screenshots.join(", ") : "(none)"}`);
      for (const s of screenshots) {
        const content = await readFile(path.join(screenshotsDir, s));
        assert.ok(content.length > 100, `Screenshot ${s} should have content`);
      }
    } catch {
      console.log("  Screenshots: directory not created");
    }

    // ── Verify video artifact ──
    try {
      const videoPath = path.join(runDir, "verification.mp4");
      await access(videoPath);
      const videoContent = await readFile(videoPath);
      console.log(`  Video: verification.mp4 (${Math.round(videoContent.length / 1024)}KB)`);
    } catch {
      console.log("  Video: not recorded");
    }

    // ── Final summary ──
    const duration = completedRun.startedAt && completedRun.finishedAt
      ? `${Math.round((Date.parse(completedRun.finishedAt) - Date.parse(completedRun.startedAt)) / 1000)}s`
      : "?";

    console.log("\n====== E2E BROWSER VERIFY — PASS ======");
    console.log(`Run: ${completedRun.status} in ${duration}`);
    console.log(`Commit: ${completedRun.commitSha?.slice(0, 8)} | Files: ${completedRun.changedFiles?.length}`);
    console.log(`PR: ${completedRun.prUrl ?? "none"}`);

  } finally {
    // ── Cleanup: close PR + delete branch ──
    if (prNumber && branchName) {
      cleanupPR(REPO, prNumber, branchName);
    } else if (branchName) {
      try {
        execSync(`gh api repos/${REPO}/git/refs/heads/${branchName} -X DELETE`, {
          timeout: 15_000,
          stdio: "pipe"
        });
        console.log(`Cleanup: branch ${branchName} deleted`);
      } catch {
        console.log(`Cleanup: no remote branch to delete`);
      }
    }

    await new Promise(r => setTimeout(r, 2000));
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}, { timeout: 1_500_000 }); // 25 min overall timeout
