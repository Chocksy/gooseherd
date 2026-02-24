/**
 * Forbidden file patterns — check changed files against deny/guarded lists.
 *
 * Deny: hard block (secrets, keys, env files)
 * Guarded: soft-fail (workflows, migrations) unless task explicitly mentions them
 * Lockfile-without-manifest: soft-fail when lockfile changes without manifest
 *
 * Pure logic, no side effects. Testable without pipeline infra.
 */

export interface ForbiddenFilesResult {
  verdict: "pass" | "soft_fail" | "hard_fail";
  deniedFiles: string[];
  guardedFiles: string[];
  lockfileViolations: string[];
  reasons: string[];
}

export interface ForbiddenFilesConfig {
  denyPatterns: string[];
  guardedPatterns: string[];
  lockfileManifestPairs: Array<{ lockfile: string; manifest: string }>;
}

export const DEFAULT_DENY_PATTERNS = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/secrets/**",
  "**/credentials/**"
];

export const DEFAULT_GUARDED_PATTERNS = [
  ".github/workflows/**",
  "**/migrations/**"
];

export const DEFAULT_LOCKFILE_PAIRS: Array<{ lockfile: string; manifest: string }> = [
  { lockfile: "package-lock.json", manifest: "package.json" },
  { lockfile: "yarn.lock", manifest: "package.json" },
  { lockfile: "pnpm-lock.yaml", manifest: "package.json" },
  { lockfile: "Gemfile.lock", manifest: "Gemfile" },
  { lockfile: "Pipfile.lock", manifest: "Pipfile" },
  { lockfile: "poetry.lock", manifest: "pyproject.toml" },
  { lockfile: "composer.lock", manifest: "composer.json" },
  { lockfile: "Cargo.lock", manifest: "Cargo.toml" }
];

/**
 * Convert a glob pattern to a regex. Supports **, *, ? operators.
 * Patterns are matched against the full file path.
 *
 * `** /x` matches `x` (root) AND `a/b/x` (nested).
 * `** /` at the start becomes `(?:.* /)?` to optionally match a prefix.
 */
export function globToRegex(pattern: string): RegExp {
  // Replace **/ with a placeholder that captures "any prefix including empty"
  // e.g. "**/.env*" → matches both ".env" and "config/.env.local"
  const regexStr = pattern
    .replace(/\*\*\//g, "\u2299/")    // **/ → placeholder/
    .replace(/\*\*/g, "\u2298")       // standalone ** → match anything
    .replace(/\*/g, "\u229A")         // * → placeholder
    .replace(/\?/g, "\u229B")         // ? → placeholder
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")  // escape regex metacharacters
    .replace(/\u229B/g, ".")          // ? → single char
    .replace(/\u2299\//g, "(?:.*\\/)?") // **/ → optional prefix with trailing /
    .replace(/\u2298/g, ".*")         // ** → any path
    .replace(/\u229A/g, "[^/]*");     // * → non-slash segment

  return new RegExp(`^${regexStr}$`);
}

/**
 * Check a list of changed files against forbidden file rules.
 */
export function checkForbiddenFiles(
  changedFiles: string[],
  taskText: string,
  config?: Partial<ForbiddenFilesConfig>
): ForbiddenFilesResult {
  const denyPatterns = config?.denyPatterns ?? DEFAULT_DENY_PATTERNS;
  const guardedPatterns = config?.guardedPatterns ?? DEFAULT_GUARDED_PATTERNS;
  const lockfilePairs = config?.lockfileManifestPairs ?? DEFAULT_LOCKFILE_PAIRS;

  const deniedFiles: string[] = [];
  const guardedFiles: string[] = [];
  const lockfileViolations: string[] = [];
  const reasons: string[] = [];

  const denyRegexes = denyPatterns.map(globToRegex);
  const guardedRegexes = guardedPatterns.map(globToRegex);

  // Check each file against deny patterns
  for (const file of changedFiles) {
    for (let i = 0; i < denyRegexes.length; i++) {
      if (denyRegexes[i]!.test(file)) {
        deniedFiles.push(file);
        reasons.push(`${file} matches deny pattern '${denyPatterns[i]}'`);
        break;
      }
    }
  }

  // Check each file against guarded patterns
  // Guarded files only soft-fail if the task text doesn't mention the relevant area
  for (const file of changedFiles) {
    if (deniedFiles.includes(file)) continue; // already denied
    for (let i = 0; i < guardedRegexes.length; i++) {
      if (guardedRegexes[i]!.test(file)) {
        // Check if task explicitly mentions this area
        const patternHint = guardedPatterns[i]!.replace(/\*\*/g, "").replace(/\*/g, "").replace(/\./g, " ").replace(/\//g, " ").trim();
        const taskMentions = patternHint.split(/\s+/).some(word =>
          word.length > 2 && taskText.toLowerCase().includes(word.toLowerCase())
        );
        if (!taskMentions) {
          guardedFiles.push(file);
          reasons.push(`${file} matches guarded pattern '${guardedPatterns[i]}' (task doesn't mention this area)`);
        }
        break;
      }
    }
  }

  // Lockfile-without-manifest check (directory-aware for monorepos)
  for (const pair of lockfilePairs) {
    const lockfileMatches = changedFiles.filter(f =>
      f === pair.lockfile || f.endsWith("/" + pair.lockfile)
    );
    for (const lockfilePath of lockfileMatches) {
      // Extract directory prefix to find the corresponding manifest
      const dir = lockfilePath.lastIndexOf("/") >= 0
        ? lockfilePath.slice(0, lockfilePath.lastIndexOf("/") + 1)
        : "";
      const expectedManifest = dir + pair.manifest;
      const hasManifest = changedFiles.some(f => f === expectedManifest);
      if (!hasManifest) {
        lockfileViolations.push(lockfilePath);
        reasons.push(`${lockfilePath} changed without ${expectedManifest}`);
      }
    }
  }

  let verdict: "pass" | "soft_fail" | "hard_fail" = "pass";
  if (deniedFiles.length > 0) {
    verdict = "hard_fail";
  } else if (guardedFiles.length > 0 || lockfileViolations.length > 0) {
    verdict = "soft_fail";
  }

  return { verdict, deniedFiles, guardedFiles, lockfileViolations, reasons };
}
