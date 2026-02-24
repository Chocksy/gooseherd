/**
 * Structured error parser: replaces raw stderr dump with categorized,
 * deduplicated, prioritized errors.
 *
 * Falls back to raw text if parsing produces nothing useful.
 */

interface ParsedError {
  file?: string;
  line?: number;
  column?: number;
  code?: string;
  message: string;
  category: ErrorCategory;
}

type ErrorCategory = "security" | "type" | "build" | "test" | "lint" | "style" | "runtime" | "unknown";

const CATEGORY_PRIORITY: Record<ErrorCategory, number> = {
  security: 0,
  type: 1,
  build: 2,
  test: 3,
  runtime: 4,
  lint: 5,
  style: 6,
  unknown: 7
};

const CATEGORY_LABELS: Record<ErrorCategory, string> = {
  security: "SECURITY ERRORS",
  type: "TYPE ERRORS",
  build: "BUILD ERRORS",
  test: "TEST FAILURES",
  runtime: "RUNTIME ERRORS",
  lint: "LINT ISSUES",
  style: "STYLE ISSUES",
  unknown: "OTHER ERRORS"
};

// ── Pattern matchers ──

// Standard file:line:col: message format (gcc, eslint, tsc, rubocop, etc.)
const FILE_LINE_PATTERN = /^(.+?):(\d+)(?::(\d+))?:\s*(?:(error|warning|info|note|fatal|Error|Warning))?\s*(?:\[([^\]]+)\])?\s*:?\s*(.+)/;

// TypeScript error: file(line,col): error TSxxxx: message
const TS_ERROR_PATTERN = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)/;

// RSpec failure: file:line (or "Failure/Error: ...")
const RSPEC_PATTERN = /^(?:rspec\s+)?(.+?):(\d+)(?::in\s+`[^`]+`)?/;

// Jest/Vitest: "● Test Suite Name > test name" followed by lines with file:line
const JEST_FAIL_PATTERN = /^\s*●\s+(.+)/;

// Python: File "file", line N
const PYTHON_PATTERN = /^\s*File "(.+?)", line (\d+)/;

function categorizeError(message: string, code?: string): ErrorCategory {
  const lower = message.toLowerCase();

  // Security patterns
  if (/secret|token|password|credential|api.?key|private.?key/i.test(lower)) return "security";
  if (code?.startsWith("SEC") || code?.startsWith("CWE")) return "security";

  // Type errors
  if (/type\s+error|not\s+assignable|cannot\s+find\s+name|property.*does\s+not\s+exist/i.test(lower)) return "type";
  if (code?.startsWith("TS") || code?.startsWith("E0")) return "type";

  // Build errors
  if (/syntax\s+error|unexpected\s+token|cannot\s+resolve|module\s+not\s+found|import.*not\s+found/i.test(lower)) return "build";

  // Test failures
  if (/expected|assertion|test.*fail|spec.*fail|rspec|jest|pytest|to\s+eq|to\s+equal/i.test(lower)) return "test";
  if (/nomethod|undefined\s+method|nameerror|attributeerror/i.test(lower)) return "runtime";

  // Lint
  if (/no-unused|prefer-|eslint|rubocop|ruff|flake8|pylint/i.test(lower)) return "lint";
  if (code && /^[A-Z]\d{3,4}$/.test(code)) return "lint"; // E501, W291, etc.

  // Style
  if (/trailing\s+(whitespace|space)|indentation|formatting/i.test(lower)) return "style";

  return "unknown";
}

function parseLine(line: string): ParsedError | undefined {
  // TypeScript-style errors
  let match = TS_ERROR_PATTERN.exec(line);
  if (match) {
    const message = match[5] ?? line;
    return {
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      code: match[4],
      message,
      category: categorizeError(message, match[4])
    };
  }

  // Standard file:line:col pattern
  match = FILE_LINE_PATTERN.exec(line);
  if (match) {
    const message = match[6] ?? line;
    const code = match[5];
    return {
      file: match[1],
      line: Number(match[2]),
      column: match[3] ? Number(match[3]) : undefined,
      code,
      message,
      category: categorizeError(message, code)
    };
  }

  // Python traceback
  match = PYTHON_PATTERN.exec(line);
  if (match) {
    return {
      file: match[1],
      line: Number(match[2]),
      message: line.trim(),
      category: "runtime"
    };
  }

  return undefined;
}

function deduplicateErrors(errors: ParsedError[]): ParsedError[] {
  const seen = new Map<string, { error: ParsedError; count: number }>();

  for (const error of errors) {
    // Group by file + category + code/message-prefix
    const key = [
      error.file ?? "unknown",
      error.category,
      error.code ?? error.message.slice(0, 40)
    ].join(":");

    const existing = seen.get(key);
    if (existing) {
      existing.count++;
    } else {
      seen.set(key, { error, count: 1 });
    }
  }

  return Array.from(seen.values()).map((entry) => {
    if (entry.count > 1) {
      return {
        ...entry.error,
        message: `${entry.error.message} (${String(entry.count - 1)} similar ${entry.count === 2 ? "failure" : "failures"} omitted — same root cause)`
      };
    }
    return entry.error;
  });
}

function formatError(error: ParsedError, index: number): string {
  const location = error.file
    ? `${error.file}${error.line ? `:${String(error.line)}` : ""}${error.column ? `:${String(error.column)}` : ""}`
    : "";
  const codeTag = error.code ? ` [${error.code}]` : "";
  return `${String(index + 1)}. ${location}${codeTag}: ${error.message}`;
}

/**
 * Parse raw error output into structured, categorized, deduplicated error report.
 * Falls back to raw text if no structured errors can be extracted.
 *
 * @param rawOutput - Raw stderr/stdout from a failed command
 * @param maxErrors - Maximum number of root cause issues to include (default: 12)
 * @param maxChars - Maximum characters for the output (default: 6000)
 */
export function parseErrors(rawOutput: string, maxErrors = 12, maxChars = 6000): string {
  if (!rawOutput.trim()) {
    return "```\n(no output)\n```";
  }

  const lines = rawOutput.split("\n");
  const errors: ParsedError[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseLine(line);
    if (parsed) {
      errors.push(parsed);
    }
  }

  // If we couldn't parse anything structured, fall back to raw text
  if (errors.length === 0) {
    const trimmed = rawOutput.slice(-maxChars);
    return `\`\`\`\n${trimmed}\n\`\`\``;
  }

  // Deduplicate
  const deduped = deduplicateErrors(errors);

  // Sort by priority
  deduped.sort((a, b) => {
    const priorityDiff = CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category];
    if (priorityDiff !== 0) return priorityDiff;
    return (a.file ?? "").localeCompare(b.file ?? "");
  });

  // Limit to maxErrors
  const limited = deduped.slice(0, maxErrors);
  const omitted = deduped.length - limited.length;

  // Group by category
  const groups = new Map<ErrorCategory, ParsedError[]>();
  for (const error of limited) {
    const existing = groups.get(error.category);
    if (existing) {
      existing.push(error);
    } else {
      groups.set(error.category, [error]);
    }
  }

  // Build output
  const sections: string[] = [];
  const totalCount = limited.length;
  const categoryCount = groups.size;

  sections.push(`Found ${String(totalCount)} errors across ${String(categoryCount)} ${categoryCount === 1 ? "category" : "categories"}. Fix in priority order:`);
  sections.push("");

  let globalIndex = 0;
  for (const [category, categoryErrors] of groups) {
    sections.push(`## ${CATEGORY_LABELS[category]} (${String(categoryErrors.length)})${category === "type" ? " — fix first, may resolve test failures" : ""}`);
    for (const error of categoryErrors) {
      sections.push(formatError(error, globalIndex));
      globalIndex++;
    }
    sections.push("");
  }

  if (omitted > 0) {
    sections.push(`(${String(omitted)} additional errors omitted)`);
    sections.push("");
  }

  // Add strategy hint if type errors exist alongside test failures
  if (groups.has("type") && groups.has("test")) {
    sections.push("## Strategy");
    sections.push("Fix type errors first — they likely cascade into test failures.");
  }

  let result = sections.join("\n");
  if (result.length > maxChars) {
    result = result.slice(0, maxChars - 20) + "\n\n(truncated)";
  }

  return result;
}
