/**
 * Stagehand-based browser verification adapter.
 *
 * Replaces the old agent-browser CLI + callLLMWithTools agentic loop with
 * Stagehand's built-in agent API. The agent navigates, interacts, handles
 * auth, and returns a structured verdict via Zod schema.
 */

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { extractJSON, type LLMCallerConfig } from "../../llm/caller.js";
import { verifyFeatureVisually, type VisualVerifyResult } from "./browser-verify.js";
import { appendLog } from "../shell.js";
import { filterInternalGeneratedFiles } from "../internal-generated-files.js";
import { CdpScreencast } from "./cdp-screencast.js";
import { CdpConsoleCapture } from "./cdp-console-capture.js";
import { CdpNetworkCapture } from "./cdp-network-capture.js";

const STAGEHAND_PACKAGE = "@browserbasehq/stagehand";

type AISdkClientInstance = { model: unknown; getLanguageModel?: () => unknown };
type AISdkClientConstructor = new (options: { model: unknown }) => AISdkClientInstance;
type StagehandModule = {
  AISdkClient: AISdkClientConstructor;
  Stagehand: new (options: Record<string, unknown>) => any;
};

async function loadStagehandModule(): Promise<StagehandModule> {
  try {
    return await import(STAGEHAND_PACKAGE) as StagehandModule;
  } catch (error) {
    throw new Error(
      "Browser verify requires optional dependency @browserbasehq/stagehand. Rebuild with INSTALL_BROWSER_VERIFY=true.",
      { cause: error }
    );
  }
}

// ── Verdict Schema ──

const VerdictSchema = z.object({
  passed: z.boolean().describe("Whether the feature/change was implemented correctly"),
  confidence: z.enum(["high", "medium", "low"]).describe("Confidence in the verdict"),
  reasoning: z.string().describe("1-2 sentence explanation of the evidence found")
});

// ── System Prompt ──

const STAGEHAND_SYSTEM_PROMPT = `You are a QA engineer verifying a deployed web application after a code change.

## Goal
Determine whether the requested feature/change was implemented correctly on the live preview.

## How to work
1. Study the page to understand what's visible.
2. Navigate to the feature, interact with elements, and gather evidence.
3. Use JavaScript evaluation for precise DOM queries: element text, counts, visibility, computed styles.
4. Take screenshots to capture visual evidence.

## Pre-Done Verification Checklist (MANDATORY before calling done with passed=true)
Before reporting PASSED, you MUST verify ALL of the following:
1. **URL check**: Confirm you are on the correct page — check the current URL matches the target page, NOT a login/signup/error page.
2. **DOM evidence**: Use JavaScript evaluation to confirm the expected DOM element or text actually exists on the page.
3. **Form verification**: If you submitted any forms (login, signup, etc.), verify they succeeded — check for error messages, check the URL changed from the form page.
4. **Requirement coverage**: Verify each specific requirement from the task description has evidence.
If ANY requirement is unmet or uncertain, you MUST report FAILED honestly. Do NOT fabricate success.

## Authentication
If the page shows a login/signup form instead of the expected feature:
1. Look for "Sign in" or "Log in" links.
2. If test credentials are provided, use them to sign in.
3. If no credentials are provided and signup is available, create a temporary account via signup.
4. Never use placeholder emails like @example.com unless explicitly instructed.
5. If signup returns validation errors, inspect the exact error text and retry with corrected inputs.
6. After authentication, navigate to the target page.
7. If blocked by CAPTCHA/email verification or disabled inputs, report the specific blocker.

## Error Recovery
- After form submission, check page for error messages (red text, .error, .alert, .flash elements).
- If signup fails: read the exact error text, switch to backup email, retry up to 3 times.
- If login fails: verify credentials were actually submitted (not just filled), check for POST requests.
- If stuck on auth wall after multiple attempts: report auth_required — do NOT fabricate success.

## Loop Detection
- If the same action fails 2-3 times, try a different approach.
- Track what you have tried — do not repeat failed approaches.
- If you are stuck on the same page after 3+ actions, reassess your strategy.

## Navigation Mandate
If Navigation Hints are provided in the instruction, you MUST navigate to those pages to verify the change. If you cannot reach them after authentication attempts, report FAILED with the specific blocker.

## Evidence
- Trust DOM evaluation results over visual impressions for text/element assertions.
- Be specific about what evidence you found.
- PASSED = evidence confirms the change was made correctly.
- FAILED = evidence shows the change is missing, broken, or incorrect.`;

// ── OpenRouter Client Factory ──

/**
 * Creates an AISdkClient compatible with OpenRouter (or any OpenAI-compatible endpoint).
 *
 * Stagehand's built-in provider routing doesn't work with OpenRouter because:
 * - `anthropic/*` → @ai-sdk/anthropic → sends Anthropic-format, but OpenRouter returns OpenAI-format
 * - `openai/*` → @ai-sdk/openai → uses /responses endpoint, but OpenRouter only supports /chat/completions
 *
 * This factory uses @ai-sdk/openai-compatible which sends standard /chat/completions requests.
 * The returned client also has the getLanguageModel() method patched in, since Stagehand's
 * public AISdkClient (external_clients/aisdk.js) lacks it but the agent handler requires it.
 */
function createOpenRouterClient(
  AISdkClient: AISdkClientConstructor,
  modelName: string,
  apiKey: string,
  baseURL: string
): AISdkClientInstance {
  const provider = createOpenAICompatible({
    name: "openrouter",
    baseURL,
    apiKey,
    supportsStructuredOutputs: true
  });
  const client = new AISdkClient({ model: provider(modelName) });
  // Patch: public AISdkClient lacks getLanguageModel() which the agent handler needs
  if (!("getLanguageModel" in client)) {
    (client as any).getLanguageModel = function () { return this.model; };
  }
  return client;
}

// ── URL Hint Extraction ──

/** Rails view/controller path → route mapping rules. */
const RAILS_ROUTE_PATTERNS: Array<{ pattern: RegExp; route: (m: RegExpMatchArray) => string }> = [
  // Specific patterns first (before generic catch-all)
  { pattern: /app\/views\/devise\/sessions\/new/, route: () => "/users/sign_in" },
  { pattern: /app\/views\/devise\/registrations\/new/, route: () => "/users/sign_up" },
  { pattern: /app\/views\/devise\/passwords\/new/, route: () => "/users/password/new" },
  { pattern: /app\/views\/devise\/registrations\/edit/, route: () => "/user/edit" },
  { pattern: /app\/views\/(home|landing|pages)\/(index|home|landing)/, route: () => "/" },
  // Generic patterns
  { pattern: /app\/views\/([^/]+)\/index/, route: (m) => `/${m[1]}` },
  { pattern: /app\/views\/([^/]+)\/show/, route: (m) => `/${m[1]}/:id` },
  { pattern: /app\/views\/([^/]+)\/new/, route: (m) => `/${m[1]}/new` },
  { pattern: /app\/views\/([^/]+)\/edit/, route: (m) => `/${m[1]}/:id/edit` },
  { pattern: /app\/controllers\/([^/]+)_controller/, route: (m) => `/${m[1]}` },
];

/**
 * Extract URL path hints from task text and changed files.
 * Helps the Stagehand agent navigate to the right page.
 */
export function extractUrlHints(task: string, changedFiles: string[]): string[] {
  const sanitizedChangedFiles = filterInternalGeneratedFiles(changedFiles);
  const hints = new Set<string>();

  // 1. Parse changed files for Rails routes
  for (const file of sanitizedChangedFiles) {
    for (const { pattern, route } of RAILS_ROUTE_PATTERNS) {
      const match = file.match(pattern);
      if (match) {
        hints.add(route(match));
        break; // first match per file
      }
    }
  }

  // 2. Extract URL-like paths from task text
  // Match patterns like "/user/edit", "/admin/dashboard", "on the /about page"
  const urlPathRegex = /(?:^|\s|")(\/[a-z][a-z0-9_/-]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlPathRegex.exec(task)) !== null) {
    const p = match[1];
    // Skip common non-route paths like /tmp, /var, /usr, /etc
    if (!/^\/(tmp|var|usr|etc|bin|dev|proc|sys)\b/.test(p)) {
      hints.add(p);
    }
  }

  // 3. Extract "on the X page" patterns
  const pagePatternRegex = /on\s+the\s+([a-z][a-z0-9_ -]*?)\s+page/gi;
  while ((match = pagePatternRegex.exec(task)) !== null) {
    const pageName = match[1].trim().toLowerCase().replace(/\s+/g, "-");
    hints.add(`/${pageName}`);
  }

  return [...hints];
}

// ── Instruction Builder ──

export function buildInstruction(
  task: string,
  changedFiles: string[],
  credentials?: { email: string; password: string },
  changeSummary?: string,
  authStrategy?: {
    allowSignup?: boolean;
    preferSignupWithoutCredentials?: boolean;
  },
  signupProfile?: {
    fullName: string;
    preferredEmail: string;
    backupEmails: string[];
    password: string;
  }
): string {
  const sanitizedChangedFiles = filterInternalGeneratedFiles(changedFiles);
  const fileList = sanitizedChangedFiles.length > 0
    ? sanitizedChangedFiles.map(f => `  - ${f}`).join("\n")
    : "  (none available)";

  let instruction = `Verify that this task was implemented correctly on the live page.\n\nTask: ${task}\n\nFiles changed:\n${fileList}`;

  if (changeSummary) {
    instruction += `\n\nChange summary (what the developer actually did):\n${changeSummary}`;
  }

  // Add navigation hints from file analysis and task text
  const urlHints = extractUrlHints(task, sanitizedChangedFiles);
  if (urlHints.length > 0) {
    instruction += `\n\n## Navigation hints\nBased on the changed files and task, these pages are likely relevant:\n${urlHints.map(h => `  - ${h}`).join("\n")}\nNavigate to these paths on the review app URL to verify the changes.`;
  }

  if (credentials) {
    instruction += `\n\n## Authentication credentials\nUse these to log in: email="%email%", password="%password%".\nIMPORTANT: When filling login forms, use the variable syntax %email% and %password% as the values in fillForm — do NOT type literal email addresses.`;
  } else if (authStrategy?.allowSignup) {
    instruction += "\n\nNo test credentials were provided. If the target page requires authentication, use signup to create a temporary account and continue verification.";
    if (authStrategy.preferSignupWithoutCredentials) {
      instruction += "\nPrefer signup over guessing default credentials.";
    }
    if (signupProfile) {
      instruction += `\n\n## Signup credentials (MUST USE — do NOT use @example.com)\nWhen filling signup forms, use these variable values:\n- Email field: use %signup_email% as the value\n- Password fields: use %signup_password% as the value\n- Name field (if present): use %signup_name% as the value\nIf the first email is rejected, use %backup_email_1%, then %backup_email_2%.`;
      instruction += `\nThe actual values: email="${signupProfile.preferredEmail}", password="${signupProfile.password}"`;
      instruction += "\nIMPORTANT: When calling fillForm, put %signup_email% in the value field, NOT a literal email. The system will substitute the actual email.";
      instruction += "\nIf signup returns validation errors, read the exact inline error text and retry up to 3 times.";
      instruction += "\nRetry policy: 1) if email invalid/taken, switch to %backup_email_1% then %backup_email_2%; 2) if password is too weak, strengthen password; 3) if form remains blocked, report blocker explicitly.";
    }
  }

  instruction += `\n\nNavigate to the relevant page, interact with elements to test the feature, and determine whether the task was implemented correctly. Provide your verdict.`;

  return instruction;
}

// ── Main Verification Function ──

export interface StagehandVerifyResult {
  screenshotPath?: string;
  videoPath?: string;
  consolePath?: string;
  networkPath?: string;
  actionsPath?: string;
  verifyResult?: VisualVerifyResult;
  planTokens?: { input: number; output: number };
  domFindings?: string[];
}

export async function runStagehandVerification(
  url: string,
  task: string,
  changedFiles: string[],
  runDir: string,
  apiKey: string,
  model: string,
  logFile: string,
  credentials?: { email: string; password: string },
  changeSummary?: string,
  baseURL?: string,
  executionModel?: string,
  maxSteps?: number,
  executionTimeoutMs?: number,
  authStrategy?: {
    allowSignup?: boolean;
    preferSignupWithoutCredentials?: boolean;
  },
  signupProfile?: {
    fullName: string;
    preferredEmail: string;
    backupEmails: string[];
    password: string;
  }
): Promise<StagehandVerifyResult> {
  const screenshotsDir = path.join(runDir, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });
  const { AISdkClient, Stagehand } = await loadStagehandModule();

  // Resolve chromium path from env (sandbox or local)
  const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    || process.env.PUPPETEER_EXECUTABLE_PATH
    || undefined;

  const execModelLabel = executionModel ?? "(same)";
  const providerLabel = baseURL ?? "native";
  await appendLog(logFile, `[gate:browser_verify] stagehand: initializing (model=${model}, executionModel=${execModelLabel}, chromium=${chromiumPath ?? "bundled"}, baseURL=${providerLabel})\n`);

  // When using OpenRouter (baseURL set), create a custom LLM client via @ai-sdk/openai-compatible.
  const llmClient = baseURL ? createOpenRouterClient(AISdkClient, model, apiKey, baseURL) : undefined;

  const modelConfig: { modelName: string; apiKey: string; baseURL?: string } = {
    modelName: model,
    apiKey,
    ...(baseURL ? { baseURL } : {})
  };

  const stagehand = new Stagehand({
    env: "LOCAL",
    experimental: true,
    model: modelConfig,
    ...(llmClient ? { llmClient } : {}),
    localBrowserLaunchOptions: {
      headless: true,
      ...(chromiumPath ? { executablePath: chromiumPath } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"]
    },
    logger: (logLine: { category?: string; message: string }) => {
      appendLog(logFile, `[stagehand:${logLine.category ?? "info"}] ${logLine.message}\n`).catch(() => {});
    },
    verbose: 1
  });

  let screencast: CdpScreencast | undefined;
  let consoleCapture: CdpConsoleCapture | undefined;
  let networkCapture: CdpNetworkCapture | undefined;

  try {
    await stagehand.init();
    await appendLog(logFile, "[gate:browser_verify] stagehand: initialized\n");

    // When using OpenRouter, Stagehand's built-in resolveLlmClient() creates standard AI SDK
    // provider clients (e.g. @ai-sdk/anthropic) which don't work with OpenRouter. Override it
    // to route ALL model resolution through our @ai-sdk/openai-compatible factory.
    if (baseURL) {
      const originalResolve = (stagehand as any).resolveLlmClient.bind(stagehand);
      (stagehand as any).resolveLlmClient = (modelOverride?: string | { modelName: string }) => {
        if (!modelOverride) return (stagehand as any).llmClient;
        const overrideModelName = typeof modelOverride === "string"
          ? modelOverride
          : modelOverride.modelName;
        // If same model as primary, return the existing client
        if (overrideModelName === model) return (stagehand as any).llmClient;
        // Create a new OpenRouter-compatible client for the override model
        return createOpenRouterClient(AISdkClient, overrideModelName, apiKey, baseURL);
      };
    }

    // Get the page — Stagehand creates one on init
    const pages = stagehand.context.pages();
    if (pages.length === 0) {
      throw new Error("Stagehand initialized but no pages available");
    }
    const page = pages[0];

    // Start CDP captures BEFORE navigation to capture initial page load.
    // Each capture starts independently — partial failure doesn't null already-started ones.
    // Try public Playwright API first (newCDPSession), then fall back to internal getSessionForFrame.
    const cdpSession = await (async () => {
      // Method 1: Public Playwright API — BrowserContext.newCDPSession(page)
      try {
        const ctx = (page as any).context?.();
        if (ctx?.newCDPSession) {
          const s = await ctx.newCDPSession(page);
          if (s?.send && s?.on) {
            await appendLog(logFile, "[gate:browser_verify] cdp: session via newCDPSession\n");
            return s;
          }
        }
      } catch { /* fall through */ }

      // Method 2: Internal Playwright API — page.getSessionForFrame
      try {
        const s = (page as any).getSessionForFrame?.((page as any).mainFrameId?.());
        if (s?.send && s?.on) {
          await appendLog(logFile, "[gate:browser_verify] cdp: session via getSessionForFrame\n");
          return s;
        }
      } catch { /* fall through */ }

      await appendLog(logFile, "[gate:browser_verify] cdp: no session available — video/console/network capture disabled\n");
      return undefined;
    })();

    if (cdpSession) {
      try { screencast = new CdpScreencast(cdpSession, runDir); await screencast.start(); } catch { screencast = undefined; }
      try { consoleCapture = new CdpConsoleCapture(cdpSession, runDir); await consoleCapture.start(); } catch { consoleCapture = undefined; }
      try { networkCapture = new CdpNetworkCapture(cdpSession, runDir); await networkCapture.start(); } catch { networkCapture = undefined; }
      const started = [screencast && "screencast", consoleCapture && "console", networkCapture && "network"].filter(Boolean).join(" + ");
      await appendLog(logFile, `[gate:browser_verify] cdp: ${started || "none"} started\n`);
    }

    // Navigate to the URL
    await page.goto(url, { waitUntil: "networkidle", timeoutMs: 30_000 });
    await appendLog(logFile, `[gate:browser_verify] stagehand: navigated to ${url}\n`);

    // Take initial screenshot (Stagehand runs Chromium locally — use host paths, NOT container paths)
    const initialScreenshot = path.join(screenshotsDir, "step-0-initial.png");
    await page.screenshot({ path: initialScreenshot, fullPage: true });

    // Build instruction and create agent
    const instruction = buildInstruction(task, changedFiles, credentials, changeSummary, authStrategy, signupProfile);

    // Build agent options:
    // - When using OpenRouter: don't pass model (use injected llmClient), but DO pass executionModel
    //   as a string — our patched resolveLlmClient will handle it via createOpenRouterClient
    // - When using native API: pass modelConfig directly, executionModel as string
    const agentOpts: Record<string, unknown> = {
      systemPrompt: STAGEHAND_SYSTEM_PROMPT
    };
    if (!llmClient) {
      agentOpts.model = modelConfig;
    }
    if (executionModel) {
      agentOpts.executionModel = llmClient ? executionModel : {
        modelName: executionModel,
        apiKey,
        ...(baseURL ? { baseURL } : {})
      };
    }
    const agent = stagehand.agent(agentOpts);

    const effectiveMaxSteps = maxSteps ?? 15;
    const effectiveExecutionTimeoutMs = executionTimeoutMs ?? 300_000;
    await appendLog(
      logFile,
      `[gate:browser_verify] stagehand: executing agent (maxSteps=${String(effectiveMaxSteps)}, timeoutMs=${String(effectiveExecutionTimeoutMs)}, allowSignup=${String(authStrategy?.allowSignup ?? false)})\n`
    );

    // Build variables for form filling — these are injected into fillForm's value field
    // so the model can use %email%, %password% etc. instead of guessing/hallucinating
    const agentVariables: Record<string, { value: string; description: string }> = {};
    if (credentials) {
      agentVariables.email = { value: credentials.email, description: "Login email address" };
      agentVariables.password = { value: credentials.password, description: "Login password" };
    } else if (signupProfile) {
      agentVariables.signup_email = { value: signupProfile.preferredEmail, description: "Email for signup form" };
      agentVariables.signup_password = { value: signupProfile.password, description: "Password for signup form" };
      agentVariables.signup_name = { value: signupProfile.fullName, description: "Full name for signup form" };
      if (signupProfile.backupEmails.length > 0) {
        agentVariables.backup_email_1 = { value: signupProfile.backupEmails[0]!, description: "Backup email if first is rejected" };
      }
      if (signupProfile.backupEmails.length > 1) {
        agentVariables.backup_email_2 = { value: signupProfile.backupEmails[1]!, description: "Second backup email" };
      }
    }

    // Execute with timeout via AbortSignal (configurable, defaults to 300s)
    const result = await agent.execute({
      instruction,
      maxSteps: effectiveMaxSteps,
      output: VerdictSchema,
      signal: AbortSignal.timeout(effectiveExecutionTimeoutMs),
      ...(Object.keys(agentVariables).length > 0 ? { variables: agentVariables } : {})
    });

    // Capture final URL BEFORE anything else — this is ground truth
    const finalUrl = page.url();
    await appendLog(logFile, `[gate:browser_verify] stagehand: agent done — success=${String(result.success)}, completed=${String(result.completed)}, actions=${String(result.actions.length)}, finalUrl=${finalUrl}\n`);

    // Hard check: is the browser stuck on an auth page?
    const authPagePattern = /\/(login|signin|sign_in|signup|sign_up|users\/sign_in|users\/sign_up|register|auth)\b/i;
    const stuckOnAuth = authPagePattern.test(new URL(finalUrl).pathname);
    if (stuckOnAuth) {
      await appendLog(logFile, `[gate:browser_verify] HARD FAIL: agent ended on auth page ${finalUrl} — overriding any verdict\n`);
    }

    // Take final screenshot
    const finalScreenshot = path.join(screenshotsDir, "final.png");
    await page.screenshot({ path: finalScreenshot });

    // Collect DOM findings from actions
    const domFindings: string[] = [];
    for (const action of result.actions as Array<{ reasoning?: string }>) {
      if (action.reasoning) {
        domFindings.push(action.reasoning);
      }
    }

    // Token usage
    const planTokens = result.usage
      ? { input: result.usage.input_tokens, output: result.usage.output_tokens }
      : undefined;

    // Step A: Extract agent's verdict — structured output first, then message parsing
    let verifyResult: VisualVerifyResult | undefined;

    if (result.output) {
      // Validate with Zod rather than blind cast
      const parsed = VerdictSchema.safeParse(result.output);
      if (parsed.success) {
        verifyResult = {
          passed: parsed.data.passed,
          confidence: parsed.data.confidence,
          reasoning: parsed.data.reasoning,
          inputTokens: planTokens?.input ?? 0,
          outputTokens: planTokens?.output ?? 0
        };
        await appendLog(logFile, `[gate:browser_verify] verdict: ${verifyResult.passed ? "PASS" : "FAIL"} (${verifyResult.confidence}) — ${verifyResult.reasoning}\n`);
      } else {
        await appendLog(logFile, `[gate:browser_verify] structured output failed validation: ${parsed.error.message.slice(0, 200)}\n`);
      }
    }

    if (!verifyResult && result.message) {
      const extracted = extractJSON<{ passed: boolean; confidence: string; reasoning: string }>(result.message);
      if (extracted && typeof extracted.passed === "boolean") {
        const confidence = (["high", "medium", "low"].includes(extracted.confidence)
          ? extracted.confidence
          : "medium") as "high" | "medium" | "low";
        verifyResult = {
          passed: extracted.passed,
          reasoning: extracted.reasoning || "No reasoning provided",
          confidence,
          inputTokens: planTokens?.input ?? 0,
          outputTokens: planTokens?.output ?? 0
        };
        await appendLog(logFile, `[gate:browser_verify] verdict (from message text): ${verifyResult.passed ? "PASS" : "FAIL"} (${verifyResult.confidence})\n`);
      } else {
        await appendLog(logFile, `[gate:browser_verify] no structured output, agent message: ${result.message.slice(0, 300)}\n`);
      }
    }

    // Step B: Always run vision as independent cross-check
    // CRITICAL: Do NOT pass domFindings here — they come from the agent's own reasoning
    // and would poison the independent check. Vision must judge from screenshot alone.
    const visionConfig: LLMCallerConfig = { apiKey, defaultModel: model, defaultTimeoutMs: 30_000 };
    let visionVerdict: VisualVerifyResult | undefined;
    try {
      visionVerdict = await verifyFeatureVisually(
        visionConfig,
        finalScreenshot,
        task,
        changedFiles,
        model
      );
      await appendLog(logFile, `[gate:browser_verify] vision cross-check: ${visionVerdict.passed ? "PASS" : "FAIL"} (${visionVerdict.confidence}) — ${visionVerdict.reasoning}\n`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      await appendLog(logFile, `[gate:browser_verify] vision cross-check failed: ${msg}\n`);
    }

    // Step C: Reconcile verdicts — hard checks first, then cross-check
    if (stuckOnAuth) {
      // Hard override: browser is on an auth page — verification definitively failed
      verifyResult = {
        passed: false,
        confidence: "high",
        reasoning: `Agent ended on auth page (${finalUrl}) — never reached the target page to verify the change`,
        inputTokens: verifyResult?.inputTokens ?? 0,
        outputTokens: verifyResult?.outputTokens ?? 0
      };
    } else if (verifyResult) {
      // Agent produced a verdict — cross-check with vision
      if (verifyResult.passed && visionVerdict && !visionVerdict.passed && visionVerdict.confidence !== "low") {
        await appendLog(logFile, `[gate:browser_verify] OVERRIDE: agent claimed PASS but vision disagrees (${visionVerdict.confidence})\n`);
        verifyResult = {
          ...verifyResult,
          passed: false,
          confidence: visionVerdict.confidence,
          reasoning: `Evidence contradiction: agent claimed PASS but vision says: ${visionVerdict.reasoning}`
        };
      }
    } else if (visionVerdict) {
      // Agent failed to produce verdict — use vision as the verdict
      verifyResult = visionVerdict;
      await appendLog(logFile, "[gate:browser_verify] using vision verdict (agent produced no verdict)\n");
    }

    // Stop CDP captures and save BEFORE closing Stagehand (close kills CDP connection)
    let videoPath: string | undefined;
    let consolePath: string | undefined;
    let networkPath: string | undefined;

    if (screencast) {
      try {
        await screencast.stop();
        const mp4Path = path.join(runDir, "verification.mp4");
        videoPath = await screencast.encode(mp4Path);
        await appendLog(logFile, `[gate:browser_verify] screencast: ${videoPath ? `encoded ${screencast.frames} frames → ${videoPath}` : "encode failed or no frames"}\n`);
      } catch {
        await appendLog(logFile, "[gate:browser_verify] screencast: encode failed (non-fatal)\n");
      }
    }

    if (consoleCapture) {
      try {
        await consoleCapture.stop();
        consolePath = await consoleCapture.save();
        await appendLog(logFile, `[gate:browser_verify] console: ${consolePath ? `saved ${consoleCapture.count} entries` : "no logs"}\n`);
      } catch {
        await appendLog(logFile, "[gate:browser_verify] console: save failed (non-fatal)\n");
      }
    }

    if (networkCapture) {
      try {
        await networkCapture.stop();
        networkPath = await networkCapture.save();
        await appendLog(logFile, `[gate:browser_verify] network: ${networkPath ? `saved ${networkCapture.count} requests` : "no requests"}\n`);
      } catch {
        await appendLog(logFile, "[gate:browser_verify] network: save failed (non-fatal)\n");
      }
    }

    // Save agent actions to JSON (best-effort)
    let actionsPath: string | undefined;
    if (result.actions.length > 0) {
      try {
        const actionEntries = (result.actions as Array<{
          type?: string;
          reasoning?: string;
          pageUrl?: string;
          timestamp?: number;
          action?: string;
          url?: string;
          taskCompleted?: boolean;
        }>).map((a) => ({
          type: a.type as string,
          reasoning: a.reasoning as string | undefined,
          pageUrl: a.pageUrl as string | undefined,
          timestamp: a.timestamp as number | undefined,
          action: a.action as string | undefined,
          url: a.url as string | undefined,
          taskCompleted: a.taskCompleted as boolean | undefined
        }));
        actionsPath = path.join(runDir, "agent-actions.json");
        await writeFile(actionsPath, JSON.stringify(actionEntries, null, 2));
        await appendLog(logFile, `[gate:browser_verify] actions: saved ${actionEntries.length} steps\n`);
      } catch {
        actionsPath = undefined;
        await appendLog(logFile, "[gate:browser_verify] actions: save failed (non-fatal)\n");
      }
    }

    return {
      screenshotPath: finalScreenshot,
      videoPath,
      consolePath,
      networkPath,
      actionsPath,
      verifyResult,
      planTokens,
      domFindings: domFindings.length > 0 ? domFindings : undefined
    };
  } finally {
    // Safety net stops (all idempotent via stopped flags)
    await screencast?.stop().catch(() => {});
    await consoleCapture?.stop().catch(() => {});
    await networkCapture?.stop().catch(() => {});
    await stagehand.close().catch(() => {});
    await appendLog(logFile, "[gate:browser_verify] stagehand: closed\n");
    // Clean up temporary frame files
    await screencast?.cleanup().catch(() => {});
  }
}
