/**
 * Security scanning — detect leaked secrets in diff output.
 *
 * Primary: gitleaks (external binary) in pipe mode
 * Fallback: regex patterns for common token formats
 *
 * Pure logic for regex fallback. Testable without pipeline infra.
 */

export interface SecretFinding {
  file: string;
  line: number;
  rule: string;
  match: string;
}

export interface SecurityScanResult {
  verdict: "pass" | "hard_fail";
  findings: SecretFinding[];
  method: "gitleaks" | "regex";
}

interface RegexRule {
  name: string;
  pattern: RegExp;
}

const SECRET_PATTERNS: RegexRule[] = [
  { name: "github_token", pattern: /ghp_[A-Za-z0-9_]{36}/g },
  { name: "github_oauth", pattern: /gho_[A-Za-z0-9_]{36}/g },
  { name: "github_app", pattern: /(?:ghu|ghs)_[A-Za-z0-9_]{36}/g },
  { name: "github_refresh", pattern: /ghr_[A-Za-z0-9_]{36}/g },
  { name: "openai_key", pattern: /sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/g },
  { name: "openai_project_key", pattern: /sk-proj-[A-Za-z0-9_-]{20,}/g },
  { name: "openai_svcacct_key", pattern: /sk-svcacct-[A-Za-z0-9_-]{20,}/g },
  { name: "aws_access_key", pattern: /AKIA[A-Z0-9]{16}/g },
  { name: "slack_token", pattern: /xox[bporas]-[A-Za-z0-9-]{10,}/g },
  { name: "stripe_key", pattern: /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{24,}/g },
  { name: "generic_secret", pattern: /(?:api[_-]?key|secret|token|password|credentials?)\s*[:=]\s*['"`][^'"`]{8,}['"`]/gi },
  { name: "private_key_header", pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g },
  { name: "anthropic_key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g }
];

/**
 * Parse a unified diff to extract file/line context for each hunk.
 * Returns an array of { file, lineNumber, content } for added lines.
 */
function parseDiffLines(diffOutput: string): Array<{ file: string; line: number; content: string }> {
  const result: Array<{ file: string; line: number; content: string }> = [];
  let currentFile = "";
  let lineNumber = 0;

  for (const rawLine of diffOutput.split("\n")) {
    // Detect file header: +++ b/path/to/file
    if (rawLine.startsWith("+++ b/")) {
      currentFile = rawLine.slice(6);
      continue;
    }

    // Detect hunk header: @@ -old,count +new,count @@
    const hunkMatch = rawLine.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)/);
    if (hunkMatch) {
      lineNumber = Number(hunkMatch[1]) - 1;
      continue;
    }

    // Added lines start with +
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      lineNumber++;
      result.push({ file: currentFile, line: lineNumber, content: rawLine.slice(1) });
      continue;
    }

    // Context lines (space prefix) increment line counter
    if (rawLine.startsWith(" ")) {
      lineNumber++;
    }
    // Removed lines (- prefix) don't increment new-file line counter
  }

  return result;
}

/**
 * Scan diff output for secrets using regex patterns.
 * Only scans ADDED lines (+ prefix in diff) to avoid false positives on removed secrets.
 */
export function scanDiffForSecrets(diffOutput: string): SecurityScanResult {
  const findings: SecretFinding[] = [];
  const addedLines = parseDiffLines(diffOutput);

  for (const { file, line, content } of addedLines) {
    for (const rule of SECRET_PATTERNS) {
      // Reset lastIndex for global regex
      rule.pattern.lastIndex = 0;
      const match = rule.pattern.exec(content);
      if (match) {
        // Redact the actual secret value — show first 4 + last 4 chars
        const raw = match[0];
        const redacted = raw.length > 12
          ? `${raw.slice(0, 4)}...${raw.slice(-4)}`
          : `${raw.slice(0, 4)}...`;

        findings.push({ file, line, rule: rule.name, match: redacted });
      }
    }
  }

  return {
    verdict: findings.length > 0 ? "hard_fail" : "pass",
    findings,
    method: "regex"
  };
}

/**
 * Parse gitleaks JSON report output.
 */
export function parseGitleaksReport(jsonOutput: string): SecurityScanResult {
  try {
    const entries = JSON.parse(jsonOutput) as Array<{
      File: string;
      StartLine: number;
      RuleID: string;
      Match: string;
    }>;

    if (!Array.isArray(entries) || entries.length === 0) {
      return { verdict: "pass", findings: [], method: "gitleaks" };
    }

    const findings: SecretFinding[] = entries.map(e => ({
      file: e.File,
      line: e.StartLine,
      rule: e.RuleID,
      match: e.Match.length > 12
        ? `${e.Match.slice(0, 4)}...${e.Match.slice(-4)}`
        : `${e.Match.slice(0, 4)}...`
    }));

    return {
      verdict: "hard_fail",
      findings,
      method: "gitleaks"
    };
  } catch {
    // Invalid JSON — fail-secure. If gitleaks wrote a report we can't parse,
    // assume something was found rather than silently passing.
    return {
      verdict: "hard_fail",
      findings: [{ file: "unknown", line: 0, rule: "parse_error", match: "gitleaks report not parseable" }],
      method: "gitleaks"
    };
  }
}
