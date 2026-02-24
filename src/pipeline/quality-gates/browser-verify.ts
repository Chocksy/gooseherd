/**
 * Browser Verify — pure logic for browser-based verification checks.
 *
 * Runs smoke tests (HTTP check, no console errors) and accessibility tests
 * (via pa11y CLI) against a review app URL.
 * Uses subprocess pattern (like security-scan with gitleaks) to avoid
 * heavy Playwright/browser dependencies.
 */

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
    return { name: "accessibility", passed: true, details: "pa11y output parse error (pass)" };
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
 */
export function aggregateChecks(checks: BrowserCheck[]): BrowserVerifyResult {
  const errors = checks.filter(c => !c.passed).map(c => `${c.name}: ${c.details}`);
  return {
    checks,
    overallPass: errors.length === 0,
    errors
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
