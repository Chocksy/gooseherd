/**
 * Scope Judge — pure logic for LLM-as-judge scope validation.
 *
 * Compares the git diff against the original task to detect off-scope changes.
 * Calibrated to prefer PASS (only fail for clearly unrelated changes).
 */

export interface ScopeJudgeViolation {
  file: string;
  message: string;
  fixHint?: string;
}

export interface ScopeJudgeResult {
  decision: "pass" | "soft_fail" | "hard_fail";
  score: number;
  confidence: number;
  violations: ScopeJudgeViolation[];
  reason: string;
}

/**
 * Build the scope judge system prompt.
 * Calibrated to prefer PASS — mirrors Spotify's approach (~25% veto rate).
 */
export function buildScopeJudgeSystemPrompt(): string {
  return [
    "You are ScopeJudge. Determine if the code diff matches the original task.",
    "",
    "CALIBRATION: Prefer PASS unless clear evidence of off-scope changes.",
    "Test updates, import adjustments, and necessary wiring are IN-SCOPE.",
    "Incidental formatting changes (linting, whitespace) are IN-SCOPE.",
    "",
    "Only FAIL for:",
    "- Unrelated refactoring not connected to the task",
    "- Files clearly not connected to the task objective",
    "- Deleting or weakening existing tests without justification",
    "- Security risks (hardcoded secrets, disabling auth, removing validation)",
    "- Config changes without justification from the task",
    "",
    "Respond ONLY with a JSON object (no markdown, no explanation outside the JSON):",
    "{",
    '  "decision": "pass" | "soft_fail" | "hard_fail",',
    '  "score": 0-100,',
    '  "confidence": 0.0-1.0,',
    '  "violations": [{ "file": "path", "message": "why off-scope", "fixHint": "suggestion" }],',
    '  "reason": "one-line summary"',
    "}"
  ].join("\n");
}

/**
 * Build the user message containing the task and diff.
 */
export function buildScopeJudgeUserMessage(
  task: string,
  diff: string,
  changedFiles: string[]
): string {
  // Truncate diff to avoid token blowup (keep first 8000 chars)
  const maxDiffChars = 8000;
  const truncatedDiff = diff.length > maxDiffChars
    ? `${diff.slice(0, maxDiffChars)}\n\n... (diff truncated, ${String(diff.length - maxDiffChars)} chars omitted)`
    : diff;

  return [
    "## Original Task",
    task,
    "",
    "## Changed Files",
    changedFiles.join("\n"),
    "",
    "## Diff",
    "```diff",
    truncatedDiff,
    "```"
  ].join("\n");
}

/**
 * Parse and validate the LLM's scope judge response.
 * Returns a safe default on parse failure (fail-open: pass).
 */
export function parseScopeJudgeResponse(raw: unknown): ScopeJudgeResult {
  if (!raw || typeof raw !== "object") {
    return failOpenDefault("Response is not an object");
  }

  const obj = raw as Record<string, unknown>;

  const decision = obj["decision"];
  if (decision !== "pass" && decision !== "soft_fail" && decision !== "hard_fail") {
    return failOpenDefault(`Invalid decision: ${String(decision)}`);
  }

  const rawScore = typeof obj["score"] === "number" ? obj["score"] : 100;
  const score = Math.max(0, Math.min(100, rawScore));
  const rawConfidence = typeof obj["confidence"] === "number" ? obj["confidence"] : 0.5;
  const confidence = Math.max(0, Math.min(1, rawConfidence));

  let violations: ScopeJudgeViolation[] = [];
  if (Array.isArray(obj["violations"])) {
    violations = (obj["violations"] as Array<Record<string, unknown>>)
      .filter(v => typeof v["file"] === "string" && typeof v["message"] === "string")
      .map(v => ({
        file: v["file"] as string,
        message: v["message"] as string,
        fixHint: typeof v["fixHint"] === "string" ? v["fixHint"] : undefined
      }));
  }

  const reason = typeof obj["reason"] === "string" ? obj["reason"] : "";

  return { decision, score, confidence, violations, reason };
}

function failOpenDefault(reason: string): ScopeJudgeResult {
  return {
    decision: "pass",
    score: 100,
    confidence: 0,
    violations: [],
    reason: `Scope judge parse error (fail-open): ${reason}`
  };
}
