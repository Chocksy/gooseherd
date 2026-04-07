/**
 * Task type classifier — maps task description text to a profile type.
 * Used by the diff size gate to select appropriate thresholds.
 *
 * Pure logic, no side effects. Testable without pipeline infra.
 */

export type TaskType = "bugfix" | "feature" | "refactor" | "chore";

interface ClassifierRule {
  type: TaskType;
  patterns: RegExp[];
}

const CLASSIFIER_RULES: ClassifierRule[] = [
  {
    type: "bugfix",
    patterns: [
      /\bfix(e[ds])?\b/i,
      /\bbug\b/i,
      /\berror\b/i,
      /\bcrash(e[ds])?\b/i,
      /\bbroken\b/i,
      /\bregression\b/i,
      /\bhotfix\b/i,
      /\bpatch\b/i,
      /\bresolve[ds]?\b/i,
      /\brepair\b/i
    ]
  },
  {
    type: "refactor",
    patterns: [
      /\brefactor/i,
      /\brename\b/i,
      /\bclean\s?up\b/i,
      /\bextract\b/i,
      /\breorganize\b/i,
      /\brestructure\b/i,
      /\bsimplify\b/i,
      /\bdecompose\b/i,
      /\bmove\b.*\bto\b/i
    ]
  },
  {
    type: "chore",
    patterns: [
      /\bchore\b/i,
      /\bbump\b/i,
      /\bupdate\s+dep/i,
      /\bupgrade\b/i,
      /\bdeps?\b/i,
      /\bdependenc/i,
      /\bconfig(uration)?\s+change/i,
      /\bci\s*(\/\s*cd)?\s+/i,
      /\blint\s+config/i
    ]
  },
  {
    type: "feature",
    patterns: [
      /\badd\b/i,
      /\bcreate\b/i,
      /\bimplement/i,
      /\bbuild\b/i,
      /\bintroduce\b/i,
      /\bnew\b/i,
      /\bfeature\b/i,
      /\bsupport\s+for\b/i,
      /\benable\b/i
    ]
  }
];

/**
 * Classify a task description into a profile type.
 * Returns the first matching type (priority: bugfix > refactor > chore > feature).
 * Defaults to "feature" (most permissive thresholds) if no patterns match.
 */
export function classifyTask(taskText: string): TaskType {
  for (const rule of CLASSIFIER_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(taskText)) {
        return rule.type;
      }
    }
  }
  return "feature";
}

// ── Execution mode classification ──

/**
 * Execution mode determines agent autonomy and depth:
 * - simple: single-pass fix, minimal context (hotfix, typo, config change)
 * - standard: normal pipeline with validation loops (default)
 * - research: deep exploration with extended timeouts and richer context
 */
export type ExecutionMode = "simple" | "standard" | "research";

const SIMPLE_PATTERNS = [
  /\btypo\b/i, /\bwording\b/i, /\bcopy\s+change/i,
  /\bbump\s+version/i, /\bupdate\s+dep/i, /\bupgrade\b/i,
  /\bconfig\s+change/i, /\benv\s+var/i,
  /\brename\b/i, /\bremove\s+unused/i,
];

const RESEARCH_PATTERNS = [
  /\brefactor.*(?:system|architecture|module)/i,
  /\bmigrat(?:e|ion)\b/i, /\brewrite\b/i,
  /\binvestigat(?:e|ion)\b/i, /\banalyze?\b/i,
  /\bresearch\b/i, /\bexplore\b/i,
  /\bperformance\s+(?:issue|problem|bottleneck)/i,
  /\bsecurity\s+(?:audit|review|vulnerability)/i,
  /\bdesign\s+(?:system|pattern)/i,
  /\bmulti(?:ple)?\s+(?:file|module|component)/i,
];

/**
 * Classify execution mode from task text.
 * Can be overridden by exhaustion detection (escalate on repeated failures).
 */
export function classifyExecutionMode(taskText: string): ExecutionMode {
  // Check research first — research patterns are more specific (multi-word)
  // and should win over broad simple patterns like "rename"
  for (const pattern of RESEARCH_PATTERNS) {
    if (pattern.test(taskText)) return "research";
  }
  for (const pattern of SIMPLE_PATTERNS) {
    if (pattern.test(taskText)) return "simple";
  }
  return "standard";
}

/**
 * Escalate execution mode after consecutive failures.
 * simple→standard after 1 failure, standard→research after 2 failures.
 */
export function escalateMode(currentMode: ExecutionMode, consecutiveFailures: number): ExecutionMode {
  if (currentMode === "simple" && consecutiveFailures >= 1) return "standard";
  if (currentMode === "standard" && consecutiveFailures >= 2) return "research";
  return currentMode;
}
