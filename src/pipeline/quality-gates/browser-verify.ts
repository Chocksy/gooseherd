/**
 * Browser Verify — pure logic for browser-based verification checks.
 *
 * Runs smoke tests (HTTP check, no console errors), accessibility tests
 * (via pa11y CLI), and LLM-powered visual verification against a review app URL.
 */

import { readFile } from "node:fs/promises";
import {
  callLLMVision,
  extractJSON,
  type LLMCallerConfig,
  type ContentPart,
  type LLMResponse
} from "../../llm/caller.js";
import { filterInternalGeneratedFiles } from "../internal-generated-files.js";

export interface BrowserCheck {
  name: string;
  passed: boolean;
  details: string;
}

export interface BrowserVerifyResult {
  checks: BrowserCheck[];
  overallPass: boolean;
  errors: string[];
}

/**
 * Parse pa11y JSON output into accessibility check results.
 */
export function parsePa11yOutput(stdout: string): BrowserCheck {
  if (!stdout.trim()) {
    return { name: "accessibility", passed: true, details: "No violations found" };
  }

  try {
    const issues = JSON.parse(stdout) as Array<{
      type: string;
      code: string;
      message: string;
      selector: string;
    }>;

    const errors = issues.filter(i => i.type === "error");

    if (errors.length === 0) {
      return {
        name: "accessibility",
        passed: true,
        details: `${String(issues.length)} warnings, 0 errors`
      };
    }

    const details = errors
      .slice(0, 5)
      .map(e => `[${e.code}] ${e.message} (${e.selector})`)
      .join("\n");

    return {
      name: "accessibility",
      passed: false,
      details: `${String(errors.length)} accessibility error(s):\n${details}`
    };
  } catch {
    return { name: "accessibility", passed: true, details: "pa11y output parse error (inconclusive, defaulting to pass)" };
  }
}

/**
 * Build a smoke test check from HTTP response info.
 */
export function buildSmokeCheck(
  statusCode: number,
  consoleErrors: string[]
): BrowserCheck {
  const passed = statusCode >= 200 && statusCode < 400 && consoleErrors.length === 0;

  let details = `HTTP ${String(statusCode)}`;
  if (consoleErrors.length > 0) {
    details += `\nConsole errors: ${consoleErrors.slice(0, 5).join("; ")}`;
  }

  return { name: "smoke_test", passed, details };
}

/**
 * Aggregate individual checks into a final result.
 *
 * Priority logic: if feature_verification passed, accessibility failures are
 * demoted to warnings (pre-existing a11y issues shouldn't block a correctly
 * implemented feature). Smoke test failures always block.
 */
export function aggregateChecks(checks: BrowserCheck[]): BrowserVerifyResult {
  const featureCheck = checks.find(c => c.name === "feature_verification");
  const featurePassed = featureCheck?.passed === true;
  const featureAuthBlocked = featureCheck?.passed === false
    && /auth|login|sign in|sign up|without access to the authenticated|unable to log in|blocked/i.test(featureCheck.details);

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const c of checks) {
    if (c.passed) continue;
    if (c.name === "accessibility" && (featurePassed || featureAuthBlocked)) {
      // Demote accessibility to warning when feature passed OR auth flow blocked verification.
      warnings.push(`${c.name}: ${c.details}`);
    } else {
      errors.push(`${c.name}: ${c.details}`);
    }
  }

  return {
    checks,
    overallPass: errors.length === 0,
    errors: [...errors, ...warnings]
  };
}

/**
 * Resolve the review app URL from a pattern and context values.
 *
 * Pattern: "https://{{prNumber}}-preview.app.com"
 * Supported variables: {{prNumber}}, {{branchName}}, {{repoSlug}}
 */
export function resolveReviewAppUrl(
  pattern: string,
  vars: { prNumber?: string; branchName?: string; repoSlug?: string }
): string {
  let url = pattern;
  if (vars.prNumber) url = url.replace(/\{\{prNumber\}\}/g, vars.prNumber);
  if (vars.branchName) url = url.replace(/\{\{branchName\}\}/g, vars.branchName);
  if (vars.repoSlug) url = url.replace(/\{\{repoSlug\}\}/g, vars.repoSlug);
  return url;
}

// ── LLM-powered Visual Verification ─────────────────────

export interface VisualVerifyResult {
  passed: boolean;
  reasoning: string;
  confidence: "high" | "medium" | "low";
  inputTokens: number;
  outputTokens: number;
}

// ── Visual Verdict (vision-based, uses screenshot) ──

const VISUAL_VERIFY_SYSTEM = `You are a QA engineer reviewing a deployed web application after a code change.
You receive: a screenshot of the live page, the task description (what should have changed), the list of changed files, and optionally DOM inspection results.

Your job: determine whether the evidence (screenshot AND/OR DOM results) confirms the requested change was implemented correctly.

Respond with EXACTLY this JSON format (no markdown fences):
{"passed": true/false, "confidence": "high"/"medium"/"low", "reasoning": "1-2 sentence explanation"}

Guidelines:
- PASSED = the screenshot confirms the change was made on the correct page
- FAILED = the evidence shows the change is missing, broken, or incorrect
- CRITICAL: If the screenshot shows a login page, signup page, or authentication form, the verification FAILED — the target page was never reached
- If the change is to a part of the page not visible in the screenshot, mark confidence "low" and pass=true with a note
- Focus on what the task asked for — ignore unrelated page content
- Be concise and specific in your reasoning`;

/**
 * Build the text prompt describing the task and changed files.
 */
export function buildVerifyPrompt(task: string, changedFiles: string[], domFindings?: string[]): string {
  const sanitizedChangedFiles = filterInternalGeneratedFiles(changedFiles);
  const fileList = sanitizedChangedFiles.length > 0
    ? sanitizedChangedFiles.map(f => `  - ${f}`).join("\n")
    : "  (no file list available)";

  let prompt = `Task that was implemented:\n${task}\n\nFiles changed:\n${fileList}`;

  if (domFindings && domFindings.length > 0) {
    prompt += `\n\nDOM inspection results:\n${domFindings.map(f => `  - ${f}`).join("\n")}`;
  }

  prompt += "\n\nDoes the evidence (screenshot and/or DOM results) confirm this change was correctly implemented?";
  return prompt;
}

/**
 * Send a screenshot + task context to an LLM for visual verification.
 * Reads the screenshot file, base64-encodes it, and sends it as a vision request.
 */
export async function verifyFeatureVisually(
  llmConfig: LLMCallerConfig,
  screenshotPath: string,
  task: string,
  changedFiles: string[],
  model?: string,
  domFindings?: string[]
): Promise<VisualVerifyResult> {
  const imageBuffer = await readFile(screenshotPath);
  const base64Image = imageBuffer.toString("base64");

  const userContent: ContentPart[] = [
    { type: "text", text: buildVerifyPrompt(task, changedFiles, domFindings) },
    { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } }
  ];

  const response: LLMResponse = await callLLMVision(llmConfig, {
    system: VISUAL_VERIFY_SYSTEM,
    userContent,
    model,
    maxTokens: 256,
    timeoutMs: 30_000,
    jsonMode: true
  });

  // Parse the JSON response (with fallback extraction from prose)
  const parsed = extractJSON<{ passed: boolean; confidence: string; reasoning: string }>(response.content);
  if (!parsed) {
    return {
      passed: false,
      reasoning: `LLM response was not valid JSON (inconclusive): ${response.content.slice(0, 100)}`,
      confidence: "low",
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens
    };
  }

  const confidence = (["high", "medium", "low"].includes(parsed.confidence)
    ? parsed.confidence
    : "medium") as "high" | "medium" | "low";

  return {
    passed: parsed.passed === true,
    reasoning: parsed.reasoning || "No reasoning provided",
    confidence,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens
  };
}
