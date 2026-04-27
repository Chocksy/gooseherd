export function hasReusableBranch(run: { parentBranchName?: string }): boolean {
  return typeof run.parentBranchName === "string" && run.parentBranchName.trim() !== "";
}

export function isFollowUpRun(run: { parentRunId?: string; parentBranchName?: string }): boolean {
  return typeof run.parentRunId === "string" && run.parentRunId.trim() !== "" && hasReusableBranch(run);
}
