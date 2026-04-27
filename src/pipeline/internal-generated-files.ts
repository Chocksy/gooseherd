const INTERNAL_GENERATED_FILES = new Set(["AGENTS.md"]);

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
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
