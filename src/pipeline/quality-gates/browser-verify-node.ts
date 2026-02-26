/**
 * Browser Verify node — smoke test + accessibility via subprocess.
 *
 * Opt-in (disabled by default). Uses curl for smoke test and pa11y CLI
 * for accessibility checks. No Playwright dependency.
 *
 * Runs after create_pr when a review app URL is available.
 * Skips gracefully if no URL, no pa11y, or node is disabled.
 */

import path from "node:path";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShellCapture, appendLog, shellEscape, mapToContainerPath } from "../shell.js";
import { appendGateReport } from "./gate-report.js";
import { logInfo } from "../../logger.js";
import {
  parsePa11yOutput,
  buildSmokeCheck,
  aggregateChecks,
  resolveReviewAppUrl
} from "./browser-verify.js";

export async function browserVerifyNode(
  nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const config = deps.config;
  const logFile = deps.logFile;

  // Check if enabled (deployment config, node config, or per-repo config)
  const repoEnabled = ctx.get<boolean>("repoBrowserVerifyEnabled");
  if (!config.browserVerifyEnabled && nodeConfig.enabled !== true && repoEnabled !== true) {
    await appendLog(logFile, "\n[gate:browser_verify] skipped (disabled)\n");
    return { outcome: "skipped" };
  }

  // Resolve review app URL
  let reviewAppUrl = ctx.get<string>("reviewAppUrl");

  if (!reviewAppUrl && config.reviewAppUrlPattern) {
    reviewAppUrl = resolveReviewAppUrl(config.reviewAppUrlPattern, {
      prNumber: ctx.get<string>("prNumber") ?? String(ctx.get<number>("prNumber") ?? ""),
      branchName: ctx.get<string>("branchName"),
      repoSlug: ctx.get<string>("repoSlug")
    });
  }

  // Also check node config for URL override
  const nc = nodeConfig.config as Record<string, unknown> | undefined;
  if (nc?.["review_app_url"]) {
    reviewAppUrl = nc["review_app_url"] as string;
  }

  if (!reviewAppUrl) {
    await appendLog(logFile, "\n[gate:browser_verify] skipped (no review app URL)\n");
    appendGateReport(ctx, "browser_verify", "skipped", ["No review app URL available"]);
    return { outcome: "skipped" };
  }

  // Validate URL scheme to prevent SSRF
  if (!reviewAppUrl.startsWith("https://") && !reviewAppUrl.startsWith("http://")) {
    await appendLog(logFile, "\n[gate:browser_verify] skipped (invalid URL scheme)\n");
    appendGateReport(ctx, "browser_verify", "skipped", ["Invalid URL scheme (must be http/https)"]);
    return { outcome: "skipped" };
  }

  await appendLog(logFile, `\n[gate:browser_verify] checking: ${reviewAppUrl}\n`);

  // 1. Smoke test via curl (shell-escape URL to prevent injection)
  const escapedUrl = shellEscape(reviewAppUrl);
  const curlResult = await runShellCapture(
    `curl -s -o /dev/null -w "%{http_code}" --max-time 30 ${escapedUrl}`,
    { cwd: deps.workRoot, logFile }
  );

  const statusCode = curlResult.code === 0 ? Number.parseInt(curlResult.stdout.trim(), 10) : 0;
  const smokeCheck = buildSmokeCheck(statusCode || 0, []);

  await appendLog(logFile, `[gate:browser_verify] smoke test: HTTP ${String(statusCode)}\n`);

  // 2. Accessibility test via pa11y (if available)
  const pa11yAvailable = await checkPa11yAvailable(deps.workRoot, logFile);
  let accessibilityChecked = false;

  const checks = [smokeCheck];

  if (pa11yAvailable && smokeCheck.passed) {
    const pa11yResult = await runShellCapture(
      `npx pa11y --reporter json --timeout 30000 ${escapedUrl}`,
      { cwd: deps.workRoot, logFile }
    );

    const accessCheck = parsePa11yOutput(pa11yResult.stdout);
    checks.push(accessCheck);
    accessibilityChecked = true;

    await appendLog(logFile, `[gate:browser_verify] accessibility: ${accessCheck.passed ? "pass" : "fail"} — ${accessCheck.details.split("\n")[0]}\n`);
  } else if (!pa11yAvailable) {
    await appendLog(logFile, "[gate:browser_verify] pa11y not available, skipping accessibility check\n");
  }

  // 3. Screenshot capture via Playwright (opt-in) — capture even on error pages
  let screenshotPath: string | undefined;
  if (config.screenshotEnabled && statusCode > 0) {
    screenshotPath = await captureScreenshot(
      reviewAppUrl,
      path.join(deps.workRoot, deps.run.id),
      logFile
    );
    if (screenshotPath) {
      await appendLog(logFile, `[gate:browser_verify] screenshot saved: ${screenshotPath}\n`);
      logInfo("browser_verify: screenshot captured", { path: screenshotPath });
    }
  }

  // Aggregate results
  const result = aggregateChecks(checks);

  const reasons = result.errors;
  appendGateReport(ctx, "browser_verify", result.overallPass ? "pass" : "soft_fail", reasons);

  if (!result.overallPass) {
    return {
      outcome: "soft_fail",
      error: `Browser verification failed:\n${reasons.join("\n")}`,
      outputs: { browserVerifyResult: result, accessibilityChecked, screenshotPath }
    };
  }

  return {
    outcome: "success",
    outputs: { browserVerifyResult: result, accessibilityChecked, screenshotPath }
  };
}

/**
 * Capture a screenshot of the review app URL using Playwright.
 * Returns the screenshot file path, or undefined if Playwright is not available.
 */
async function captureScreenshot(
  url: string,
  runDir: string,
  logFile: string
): Promise<string | undefined> {
  const screenshotFile = path.resolve(runDir, "screenshot.png");
  // Map to container path when running in sandbox (no-op otherwise)
  const scriptScreenshotPath = mapToContainerPath(screenshotFile);

  const script = [
    "const { chromium } = require('playwright');",
    "(async () => {",
    "  const opts = { args: ['--no-sandbox', '--disable-gpu'] };",
    "  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) opts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;",
    "  const browser = await chromium.launch(opts);",
    "  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });",
    `  await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle', timeout: 30000 });`,
    `  await page.screenshot({ path: ${JSON.stringify(scriptScreenshotPath)}, fullPage: false });`,
    "  await browser.close();",
    "})();"
  ].join("\n");

  const result = await runShellCapture(
    `node -e ${shellEscape(script)}`,
    { cwd: runDir, logFile, timeoutMs: 60_000 }
  );

  if (result.code === 0) {
    // Return host path so dashboard can serve the file
    return screenshotFile;
  }

  await appendLog(logFile, `[gate:browser_verify] screenshot failed: ${result.stderr.slice(0, 200)}\n`);
  return undefined;
}

async function checkPa11yAvailable(cwd: string, logFile: string): Promise<boolean> {
  // Use which to check if pa11y is installed, avoiding npx auto-download (supply chain risk)
  const result = await runShellCapture("which pa11y 2>/dev/null || npx --no-install pa11y --version 2>/dev/null", { cwd, logFile });
  return result.code === 0;
}
