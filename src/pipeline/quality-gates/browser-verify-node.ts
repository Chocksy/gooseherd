/**
 * Browser Verify node — interactive verification via Stagehand agent.
 *
 * Flow:
 * 1. Curl smoke test (fast, always runs)
 * 2. Pa11y accessibility (if available)
 * 3. Stagehand agent verification:
 *    a. Launch headless browser, navigate to preview URL
 *    b. Agent autonomously navigates, interacts, handles auth
 *    c. Structured verdict via Zod schema: {passed, confidence, reasoning}
 *    d. Screenshots captured before/after verification
 * 4. Aggregate results and return artifacts
 *
 * Graceful degradation: if Stagehand fails to init (missing chromium, etc.),
 * falls back to Playwright screenshot + LLM vision check (no interactivity).
 */

import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { runShellCapture, appendLog, shellEscape, mapToContainerPath, isInSandbox } from "../shell.js";
import { appendGateReport } from "./gate-report.js";
import { logInfo } from "../../logger.js";
import {
  parsePa11yOutput,
  buildSmokeCheck,
  aggregateChecks,
  resolveReviewAppUrl,
  verifyFeatureVisually,
  type VisualVerifyResult,
  type BrowserCheck
} from "./browser-verify.js";
import type { AppConfig } from "../../config.js";
import type { LLMCallerConfig } from "../../llm/caller.js";
import {
  classifyBrowserVerifyFailure,
  deriveAuthSignals,
  detectAuthErrorType,
  resolveStagehandProvider,
  type AgentActionEntry,
  type AuthErrorType,
  type BrowserAuthSignals,
  type BrowserVerifyFailureCode,
  type NetworkEntry,
  type StagehandProviderResolution
} from "./browser-verify-routing.js";
import { AuthCredentialStore } from "./auth-credential-store.js";
import { getDb } from "../../db/index.js";

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

  // Check for test credentials in node config
  if (nc?.["test_email"] && nc?.["test_password"]) {
    const configCreds = { email: nc["test_email"] as string, password: nc["test_password"] as string };
    if (!ctx.get("browserVerifyCredentials")) {
      ctx.set("browserVerifyCredentials", configCreds);
    }
  }
  const allowSignup = nc?.["allow_signup"] !== false;
  const preferSignupWithoutCredentials = nc?.["prefer_signup_without_credentials"] !== false;
  ctx.set("browserVerifyAuthConfig", { allowSignup, preferSignupWithoutCredentials });

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

  // 1. Smoke test via curl
  const escapedUrl = shellEscape(reviewAppUrl);
  const curlResult = await runShellCapture(
    `curl -s -o /dev/null -w "%{http_code}" --max-time 30 ${escapedUrl}`,
    { cwd: deps.workRoot, logFile }
  );

  const statusCode = curlResult.code === 0 ? Number.parseInt(curlResult.stdout.trim(), 10) : 0;
  const smokeCheck = buildSmokeCheck(statusCode || 0, []);
  const runDir = path.resolve(deps.workRoot, deps.run.id);
  await mkdir(runDir, { recursive: true });

  await appendLog(logFile, `[gate:browser_verify] smoke test: HTTP ${String(statusCode)}\n`);

  // 2. Accessibility test via pa11y (if available)
  const pa11yAvailable = await checkPa11yAvailable(deps.workRoot, logFile);
  let accessibilityChecked = false;
  const checks: BrowserCheck[] = [smokeCheck];

  if (pa11yAvailable && smokeCheck.passed) {
    const pa11yOutputPath = path.resolve(runDir, "pa11y-report.json");
    const pa11yCommandOutputPath = isInSandbox() ? mapToContainerPath(pa11yOutputPath) : pa11yOutputPath;
    const pa11yResult = await runShellCapture(
      `npx pa11y${isInSandbox() ? " --config /etc/pa11y.json" : ""} --reporter json --timeout 30000 ${escapedUrl} > ${shellEscape(pa11yCommandOutputPath)}`,
      { cwd: deps.workRoot, logFile }
    );
    const pa11yRaw = await readTextFileSafe(pa11yOutputPath);
    const pa11yPayload = (pa11yRaw ?? "").trim() || pa11yResult.stdout;
    const accessCheck = (pa11yResult.code !== 0 && !pa11yPayload.trim())
      ? {
          name: "accessibility",
          passed: false,
          details: `pa11y execution failed (exit ${String(pa11yResult.code)})`
        }
      : parsePa11yOutput(pa11yPayload);
    checks.push(accessCheck);
    accessibilityChecked = true;

    await appendLog(logFile, `[gate:browser_verify] accessibility: ${accessCheck.passed ? "pass" : "fail"} — ${accessCheck.details.split("\n")[0]}\n`);
  } else if (!pa11yAvailable) {
    await appendLog(logFile, "[gate:browser_verify] pa11y not available, skipping accessibility check\n");
  }

  // 3. Interactive verification via Stagehand agent
  let screenshotPath: string | undefined;
  let verifyResult: VisualVerifyResult | undefined;
  let verifyCheck: BrowserCheck | undefined;
  let planTokenUsage: { input: number; output: number } | undefined;
  let domFindings: string[] | undefined;
  let authSignals: BrowserAuthSignals | undefined;
  let stagehandErrorMessage: string | undefined;
  let providerResolution: StagehandProviderResolution | undefined;
  let safeResolution: StagehandProviderResolution | undefined;
  let preflightFailureCode: "provider_mismatch" | "missing_api_key" | undefined;

  if (smokeCheck.passed) {
    providerResolution = resolveStagehandProvider(
      config.browserVerifyModel,
      config.browserVerifyExecutionModel,
      config
    );

    await appendLog(
      logFile,
      `[gate:browser_verify] provider: ${providerResolution.ok ? "ok" : "error"} route=${providerResolution.route ?? "none"} primary=${providerResolution.primaryProvider} execution=${providerResolution.executionProvider} reason="${providerResolution.reason}"\n`
    );
    safeResolution = providerResolution.ok
      ? (({ apiKey: _key, ...rest }) => rest)(providerResolution) as StagehandProviderResolution
      : providerResolution;
    ctx.set("browserVerifyProviderResolution", safeResolution);
    if (providerResolution.route) {
      ctx.set("browserVerifyProviderRoute", providerResolution.route);
    }

    if (!providerResolution.ok) {
      preflightFailureCode = providerResolution.failureCode ?? "provider_mismatch";
      const preflightMessage = `Provider preflight failed: ${providerResolution.reason}`;
      await appendLog(logFile, `[gate:browser_verify] ${preflightMessage}\n`);
      verifyCheck = {
        name: "feature_verification",
        passed: false,
        details: preflightMessage
      };
      checks.push(verifyCheck);
      if (config.screenshotEnabled) {
        screenshotPath = await captureScreenshotFallback(reviewAppUrl, runDir, logFile);
      }
    }
  }

  // Track whether auth retry loop exhausted all attempts
  let authExhausted = false;

  if (smokeCheck.passed && providerResolution?.ok && providerResolution.apiKey) {
    // Load credential store for auth retry
    const credStore = new AuthCredentialStore(getDb(), config.encryptionKey);
    await credStore.load();

    const domain = new URL(reviewAppUrl).hostname;
    const storedCreds = await credStore.getForDomain(domain);

    // Get credentials from context (persisted across fix_browser retries)
    const savedCreds = ctx.get<{ email: string; password: string }>("browserVerifyCredentials");

    // Auth retry loop: attempts stored creds, then rotates signup profiles
    const maxAuthAttempts = 3;

    for (let authAttempt = 0; authAttempt < maxAuthAttempts; authAttempt++) {
      // Determine credentials for this attempt
      let attemptCreds = savedCreds ?? undefined;

      // Attempt 0: try stored credentials from credential store (if no context creds)
      if (!attemptCreds && storedCreds?.loginSuccessful && authAttempt === 0) {
        attemptCreds = { email: storedCreds.email, password: storedCreds.password };
        await credStore.touch(domain);
        await appendLog(logFile, `[gate:browser_verify] auth attempt ${authAttempt}: using stored credentials for ${domain}\n`);
      }

      // Build signup profile for this attempt (rotating email domains)
      let signupProfile: SignupProfile | undefined;
      if (!attemptCreds && allowSignup) {
        signupProfile = buildSignupProfileForAttempt(
          reviewAppUrl, deps.run.repoSlug, deps.run.id, authAttempt, config
        );
        ctx.set("browserVerifySignupProfile", signupProfile);
        await appendLog(
          logFile,
          `[gate:browser_verify] auth attempt ${authAttempt}: signup profile preferred=${signupProfile.preferredEmail} backups=${signupProfile.backupEmails.join(",")}\n`
        );
      }

      if (authAttempt > 0) {
        await appendLog(logFile, `[gate:browser_verify] auth retry attempt ${authAttempt}/${maxAuthAttempts - 1}\n`);
      }

      try {
        const { runStagehandVerification } = await import("./stagehand-verify.js");
        const result = await runStagehandVerification(
          reviewAppUrl,
          deps.run.task,
          ctx.get<string[]>("changedFiles") ?? [],
          runDir,
          providerResolution.apiKey,
          config.browserVerifyModel,
          logFile,
          attemptCreds,
          ctx.get<string>("changeSummary"),
          providerResolution.baseURL,
          config.browserVerifyExecutionModel,
          config.browserVerifyMaxSteps,
          config.browserVerifyExecTimeoutMs,
          {
            allowSignup,
            preferSignupWithoutCredentials: !attemptCreds && preferSignupWithoutCredentials
          },
          signupProfile
        );
        screenshotPath = result.screenshotPath;
        verifyResult = result.verifyResult;
        planTokenUsage = result.planTokens;
        domFindings = result.domFindings;

        if (result.videoPath) {
          ctx.set("videoPath", result.videoPath);
          logInfo("browser_verify: video recorded", { path: result.videoPath });
        }
        if (result.consolePath) {
          ctx.set("consolePath", result.consolePath);
        }
        if (result.networkPath) {
          ctx.set("networkPath", result.networkPath);
        }
        if (result.actionsPath) {
          ctx.set("actionsPath", result.actionsPath);
        }
        authSignals = await collectAuthSignals(result.actionsPath, result.networkPath, verifyResult?.reasoning);
        ctx.set("browserVerifyAuthSignals", authSignals);

        // Check if verification passed — no need to retry
        if (verifyResult?.passed) {
          // Save successful credentials to store
          if (signupProfile) {
            await credStore.save(domain, {
              email: signupProfile.preferredEmail,
              password: signupProfile.password,
              createdAt: new Date().toISOString(),
              lastUsedAt: new Date().toISOString(),
              loginSuccessful: true
            });
            // Persist in context for fix_browser retries
            ctx.set("browserVerifyCredentials", {
              email: signupProfile.preferredEmail,
              password: signupProfile.password
            });
          } else if (attemptCreds && !savedCreds) {
            // Stored creds worked — update lastUsedAt (touch already called above)
          }
          break; // success — exit retry loop
        }

        // Verification failed — check if it's an auth-related failure worth retrying
        const isAuthRelated = authSignals?.authGateLikely
          || authSignals?.signupPageSeen
          || authSignals?.loginPageSeen;

        if (!isAuthRelated) {
          // Not an auth problem — don't retry, it's a genuine feature failure
          break;
        }

        // Detect the specific auth error type
        const actions = await readJsonArray<AgentActionEntry>(result.actionsPath);
        const authErrorType: AuthErrorType = detectAuthErrorType(
          domFindings ?? [],
          actions,
          verifyResult?.reasoning ?? ""
        );
        await appendLog(logFile, `[gate:browser_verify] auth error type: ${authErrorType}\n`);

        if (authErrorType === "captcha_required") {
          authExhausted = true;
          await appendLog(logFile, "[gate:browser_verify] captcha detected — auth exhausted\n");
          break;
        }

        // Last attempt — don't retry further
        if (authAttempt >= maxAuthAttempts - 1) {
          authExhausted = true;
          await appendLog(logFile, "[gate:browser_verify] auth retry attempts exhausted\n");
          break;
        }

        // Otherwise continue to next attempt (email_rejected → rotate domain,
        // password_too_weak → next profile has stronger password, form_error/unknown → retry)
      } catch (error) {
        // Stagehand failed — fall back to screenshot + vision (no retry)
        const msg = error instanceof Error ? error.message : "Unknown error";
        stagehandErrorMessage = msg;
        await appendLog(logFile, `[gate:browser_verify] stagehand failed, falling back to screenshot: ${msg}\n`);

        screenshotPath = await captureScreenshotFallback(reviewAppUrl, runDir, logFile);
        if (screenshotPath && providerResolution.apiKey) {
          const llmConfig: LLMCallerConfig = {
            apiKey: config.openrouterApiKey ?? providerResolution.apiKey,
            defaultModel: config.browserVerifyModel,
            defaultTimeoutMs: 30_000,
            providerPreferences: config.openrouterProviderPreferences
          };
          try {
            verifyResult = await verifyFeatureVisually(
              llmConfig,
              screenshotPath,
              deps.run.task,
              ctx.get<string[]>("changedFiles") ?? [],
              config.browserVerifyModel
            );
          } catch (visionError) {
            const visionMsg = visionError instanceof Error ? visionError.message : "Unknown error";
            await appendLog(logFile, `[gate:browser_verify] vision fallback also failed: ${visionMsg}\n`);
          }
        }
        break; // Don't retry on stagehand init failures
      }
    }

    if (verifyResult) {
      verifyCheck = {
        name: "feature_verification",
        passed: verifyResult.passed,
        details: `[${verifyResult.confidence}] ${verifyResult.reasoning}`
      };
      checks.push(verifyCheck);
      await appendLog(logFile, `[gate:browser_verify] LLM verdict: ${verifyResult.passed ? "PASS" : "FAIL"} (${verifyResult.confidence}) — ${verifyResult.reasoning}\n`);
    } else if (screenshotPath) {
      // Verification was attempted but failed — don't silently pass
      verifyCheck = {
        name: "feature_verification",
        passed: false,
        details: "Feature verification inconclusive — verification failed or no verdict available"
      };
      checks.push(verifyCheck);
      await appendLog(logFile, "[gate:browser_verify] feature verification inconclusive (no verdict)\n");
    }
  } else if (smokeCheck.passed && !providerResolution?.apiKey) {
    await appendLog(logFile, "[gate:browser_verify] no API key (set ANTHROPIC_API_KEY or OPENROUTER_API_KEY), skipping LLM verification\n");
    if (smokeCheck.passed && config.screenshotEnabled) {
      screenshotPath = await captureScreenshotFallback(reviewAppUrl, runDir, logFile);
    }
  }

  // Store screenshot path in context for upload_screenshot node
  if (screenshotPath) {
    ctx.set("screenshotPath", screenshotPath);
    logInfo("browser_verify: screenshot captured", { path: screenshotPath });
  }

  // Aggregate results
  const result = aggregateChecks(checks);
  const reasons = result.errors;

  // Token usage from LLM verification
  const browserModel = config.browserVerifyModel;
  const tokenUsage: Record<string, { input: number; output: number; model?: string }> = {};
  if (planTokenUsage) {
    tokenUsage._tokenUsage_browserVerifyPlan = { ...planTokenUsage, model: browserModel };
  }
  if (verifyResult) {
    tokenUsage._tokenUsage_browserVerifyVision = {
      input: verifyResult.inputTokens,
      output: verifyResult.outputTokens,
      model: browserModel
    };
  }

  if (!result.overallPass) {
    const verdictReason = verifyResult
      ? `[${verifyResult.confidence}] ${verifyResult.reasoning}`
      : reasons.join("; ");
    const classifiedCode = classifyBrowserVerifyFailure({
      checks,
      verifyReason: verdictReason,
      authSignals,
      preflightFailureCode
    });
    // Override to auth_exhausted when the retry loop gave up on all auth attempts
    const failureCode: BrowserVerifyFailureCode = authExhausted ? "auth_exhausted" : classifiedCode;
    await appendLog(logFile, `[gate:browser_verify] failure_class: ${failureCode}${authExhausted ? " (auth retry exhausted)" : ""}\n`);

    appendGateReport(ctx, "browser_verify", "failure", reasons);
    return {
      outcome: "failure",
      error: `Browser verification failed:\n${reasons.join("\n")}`,
      outputs: {
        browserVerifyResult: result,
        browserVerifyFailureCode: failureCode,
        browserVerifyVerdictReason: verdictReason,
        browserVerifyDomFindings: domFindings ?? [],
        ...(authSignals ? { browserVerifyAuthSignals: authSignals } : {}),
        ...(stagehandErrorMessage ? { browserVerifyStagehandError: stagehandErrorMessage } : {}),
        ...(safeResolution ? { browserVerifyProviderResolution: safeResolution } : {}),
        accessibilityChecked,
        screenshotPath,
        ...tokenUsage
      }
    };
  }

  appendGateReport(ctx, "browser_verify", "pass", reasons);
  return {
    outcome: "success",
    outputs: {
      browserVerifyResult: result,
      browserVerifyFailureCode: "",
      browserVerifyVerdictReason: "",
      ...(safeResolution ? { browserVerifyProviderResolution: safeResolution } : {}),
      ...(authSignals ? { browserVerifyAuthSignals: authSignals } : {}),
      accessibilityChecked,
      screenshotPath,
      ...tokenUsage
    }
  };
}

// ── Fallback: Playwright screenshot (no Stagehand) ──

async function captureScreenshotFallback(
  url: string,
  runDir: string,
  logFile: string
): Promise<string | undefined> {
  const screenshotsDir = path.join(runDir, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });
  const screenshotFile = path.join(screenshotsDir, "final.png");
  const scriptScreenshotPath = mapToContainerPath(screenshotFile);

  const script = [
    "const { chromium } = require('playwright');",
    "(async () => {",
    "  const opts = { args: ['--no-sandbox', '--disable-gpu'] };",
    "  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) opts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;",
    "  const browser = await chromium.launch(opts);",
    "  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });",
    `  await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle', timeout: 30000 });`,
    `  await page.screenshot({ path: ${JSON.stringify(scriptScreenshotPath)}, fullPage: true });`,
    "  await browser.close();",
    "})();"
  ].join("\n");

  const result = await runShellCapture(
    `node -e ${shellEscape(script)}`,
    { cwd: runDir, logFile, timeoutMs: 60_000 }
  );

  if (result.code === 0) {
    return screenshotFile;
  }

  await appendLog(logFile, `[gate:browser_verify] screenshot fallback failed: ${result.stderr.slice(0, 200)}\n`);
  return undefined;
}

// ── Availability checks ──

async function checkPa11yAvailable(cwd: string, logFile: string): Promise<boolean> {
  const result = await runShellCapture("which pa11y 2>/dev/null || npx --no-install pa11y --version 2>/dev/null", { cwd, logFile });
  return result.code === 0;
}

async function collectAuthSignals(
  actionsPath?: string,
  networkPath?: string,
  reasonText?: string
): Promise<BrowserAuthSignals | undefined> {
  const actions = await readJsonArray<AgentActionEntry>(actionsPath);
  const network = await readJsonArray<NetworkEntry>(networkPath);
  if (actions.length === 0 && network.length === 0 && !reasonText) return undefined;
  return deriveAuthSignals(actions, network, reasonText);
}

async function readJsonArray<T>(filePath?: string): Promise<T[]> {
  if (!filePath) return [];
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

async function readTextFileSafe(filePath?: string): Promise<string | undefined> {
  if (!filePath) return undefined;
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

interface SignupProfile {
  fullName: string;
  preferredEmail: string;
  backupEmails: string[];
  password: string;
}

/** @internal Exported for testing */
export function buildSignupProfile(
  reviewAppUrl: string,
  repoSlug: string,
  runId: string,
  configEmailDomains?: string[]
): SignupProfile {
  const slug = normalizeSlug(repoSlug.split("/")[1] ?? repoSlug);
  const token = `${Date.now().toString(36)}${runId.replace(/-/g, "").slice(0, 6)}`;
  const preferredDomain = deriveProjectDomain(reviewAppUrl);

  // Use config-provided domains if available, otherwise fall back to defaults
  const fallbackDomains = configEmailDomains && configEmailDomains.length > 0
    ? configEmailDomains
    : ["gmail.com", "outlook.com"];

  const domains = Array.from(
    new Set([
      preferredDomain,
      ...fallbackDomains
    ].filter((value): value is string => Boolean(value)))
  );

  const makeEmail = (domain: string, suffix: string): string =>
    `qa+${slug}-${token}-${suffix}@${domain}`;

  const preferredEmail = makeEmail(domains[0] ?? "gmail.com", "a");
  const backupEmails = [
    makeEmail(domains[1] ?? domains[0] ?? "gmail.com", "b"),
    makeEmail(domains[2] ?? domains[0] ?? "gmail.com", "c")
  ];

  return {
    fullName: "QA Browser Verify",
    preferredEmail,
    backupEmails,
    password: `Qa!${token}#2026`
  };
}

/**
 * Build a signup profile for a specific auth retry attempt.
 * Each attempt rotates through different email domain combinations
 * to handle cases where a domain is rejected or already registered.
 */
export function buildSignupProfileForAttempt(
  reviewAppUrl: string,
  repoSlug: string,
  runId: string,
  attempt: number,
  config: Pick<AppConfig, "browserVerifyTestEmail" | "browserVerifyTestPassword" | "browserVerifyEmailDomains">
): SignupProfile {
  // If config provides explicit test email/password, use those (attempt 0 only)
  if (attempt === 0 && config.browserVerifyTestEmail && config.browserVerifyTestPassword) {
    return {
      fullName: "QA Browser Verify",
      preferredEmail: config.browserVerifyTestEmail,
      backupEmails: [],
      password: config.browserVerifyTestPassword
    };
  }

  // Build profile with domain rotation based on attempt number
  const base = buildSignupProfile(reviewAppUrl, repoSlug, runId, config.browserVerifyEmailDomains);

  if (attempt === 0) {
    return base;
  }

  // Rotate: attempt 1 uses backup_1 as preferred, attempt 2 uses backup_2
  const allEmails = [base.preferredEmail, ...base.backupEmails];
  const rotatedIndex = Math.min(attempt, allEmails.length - 1);
  const rotatedPreferred = allEmails[rotatedIndex] ?? base.preferredEmail;
  const rotatedBackups = allEmails.filter((_, i) => i !== rotatedIndex);

  // Strengthen password on retry (add more complexity)
  const strengthenedPassword = `${base.password}!X${String(attempt)}`;

  return {
    fullName: base.fullName,
    preferredEmail: rotatedPreferred,
    backupEmails: rotatedBackups,
    password: strengthenedPassword
  };
}

function normalizeSlug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned || "project";
}

function deriveProjectDomain(reviewAppUrl: string): string | undefined {
  try {
    const host = new URL(reviewAppUrl).hostname.toLowerCase();
    if (host === "localhost" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return undefined;
    const parts = host.split(".").filter(Boolean);
    if (parts.length < 2) return undefined;
    const tld = parts[parts.length - 1];
    const sld = parts[parts.length - 2];
    if (!tld || !sld) return undefined;
    if (sld === "stg" && parts.length >= 3) {
      return `${parts[parts.length - 3]}.${sld}.${tld}`; // preserve env-like domains when needed
    }
    return `${sld}.${tld}`;
  } catch {
    return undefined;
  }
}
