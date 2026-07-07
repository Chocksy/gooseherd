import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const INTERNAL_GENERATED_FILES = new Set(["AGENTS.md"]);

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

export type InternalFilesSnapshot = ReadonlyMap<string, string>;

/**
 * Read (and remove from disk) any harness-written files in `repoDir`.
 *
 * We need them off the working tree during `git add -A` so the positive
 * `'.'` pathspec doesn't trip git's "you asked to add an ignored file"
 * warning when the host repo's .gitignore lists e.g. AGENTS.md (exit 1
 * with no useful error). Pair with `restoreInternalGeneratedFiles` so
 * downstream agent nodes (fix_browser, fix_ci re-run, decide_recovery)
 * still find their pi-agent context after the commit lands.
 */
export async function snapshotInternalGeneratedFiles(repoDir: string): Promise<InternalFilesSnapshot> {
  const snapshot = new Map<string, string>();
  for (const file of INTERNAL_GENERATED_FILES) {
    const filePath = path.join(repoDir, file);
    try {
      snapshot.set(file, await readFile(filePath, "utf8"));
      await rm(filePath, { force: true });
    } catch {
      // not present — nothing to save or remove
    }
  }
  return snapshot;
}

/** Re-materialize whatever `snapshotInternalGeneratedFiles` lifted off disk. */
export async function restoreInternalGeneratedFiles(
  repoDir: string,
  snapshot: InternalFilesSnapshot
): Promise<void> {
  for (const [file, content] of snapshot) {
    await writeFile(path.join(repoDir, file), content, "utf8");
  }
}

export function isInternalGeneratedFile(filePath: string): boolean {
  return INTERNAL_GENERATED_FILES.has(normalizeRelativePath(filePath));
}

export function filterInternalGeneratedFiles(files: string[]): string[] {
  return files.filter((file) => !isInternalGeneratedFile(file));
}

export function listInternalGeneratedFiles(files: string[]): string[] {
  return files.filter((file) => isInternalGeneratedFile(file));
}

export function buildGitAddPathspecs(): string[] {
  return [".", ...[...INTERNAL_GENERATED_FILES].map((file) => `:(exclude)${file}`)];
}

export function mergeInternalArtifacts(...artifactLists: Array<string[] | undefined>): string[] | undefined {
  const merged = new Set<string>();

  for (const artifacts of artifactLists) {
    if (!artifacts) continue;
    for (const artifact of artifacts) {
      const normalized = normalizeRelativePath(artifact);
      if (normalized) {
        merged.add(normalized);
      }
    }
  }

  return merged.size > 0 ? [...merged] : undefined;
}
