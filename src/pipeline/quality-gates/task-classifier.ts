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
