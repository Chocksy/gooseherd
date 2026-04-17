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
