import { runShell, runShellCapture, shellEscape } from "./shell.js";
import { buildGitAddPathspecs, filterInternalGeneratedFiles, listInternalGeneratedFiles } from "./internal-generated-files.js";

export interface CommitResult {
  commitSha: string;
  changedFiles: string[];
  internalArtifacts: string[];
}

/**
 * Stage all changes, commit, capture SHA + changed files, optionally push.
 *
 * Shared by commit, fix_ci, and fix_browser nodes.
 * Caller is responsible for checking whether changes exist before calling.
 */
export async function commitCaptureAndPush(
  repoDir: string,
  commitMsg: string,
  logFile: string,
  pushBranch?: string
): Promise<CommitResult> {
  await runShellCapture("git add -A", { cwd: repoDir, logFile });
  const allChangedFilesResult = await runShellCapture("git diff --cached --name-only HEAD", { cwd: repoDir, logFile });
  await runShellCapture("git reset HEAD --quiet", { cwd: repoDir, logFile });
  const allChangedFiles = allChangedFilesResult.stdout
    .split("\n")
    .map(f => f.trim())
    .filter(Boolean);
  const internalArtifacts = listInternalGeneratedFiles(allChangedFiles);

  const pathspecArgs = buildGitAddPathspecs().map(shellEscape).join(" ");
  await runShell(`git add -A -- ${pathspecArgs}`, { cwd: repoDir, logFile });

  const stagedFilesResult = await runShellCapture("git diff --cached --name-only", { cwd: repoDir, logFile });
  const stagedFiles = filterInternalGeneratedFiles(
    stagedFilesResult.stdout
      .split("\n")
      .map(f => f.trim())
      .filter(Boolean)
  );

  if (stagedFiles.length === 0) {
    throw new Error("No committable user changes remain after filtering internal-generated files.");
  }

  await runShell(`git commit -m ${shellEscape(commitMsg)}`, { cwd: repoDir, logFile });

  const shaResult = await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile });
  const commitSha = shaResult.stdout.trim().split("\n").pop()?.trim() ?? "";

  if (pushBranch) {
    await runShell(`git push origin ${shellEscape(pushBranch)}`, { cwd: repoDir, logFile });
  }

  const filesResult = await runShellCapture("git show --name-only --pretty='' HEAD", { cwd: repoDir, logFile });
  const changedFiles = filterInternalGeneratedFiles(
    filesResult.stdout
      .split("\n")
      .map(f => f.trim())
      .filter(f => f.length > 0 && !f.startsWith("---"))
  );

  return { commitSha, changedFiles, internalArtifacts };
}
