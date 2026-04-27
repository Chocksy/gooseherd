import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ArtifactStore } from "./artifact-store.js";
import type { ControlPlaneStore } from "./control-plane-store.js";

const PREALLOCATED_RUN_ARTIFACTS = [
  {
    responseKey: "log",
    artifactKey: "run.log",
    artifactClass: "raw_run_log",
    relativePath: path.join("artifacts", "run.log"),
  },
  {
    responseKey: "agent-stdout.log",
    artifactKey: "agent-stdout.log",
    artifactClass: "debug_log",
    relativePath: "agent-stdout.log",
  },
  {
    responseKey: "agent-stderr.log",
    artifactKey: "agent-stderr.log",
    artifactClass: "debug_log",
    relativePath: "agent-stderr.log",
  },
  {
    responseKey: "auto-review-summary.json",
    artifactKey: "auto-review-summary.json",
    artifactClass: "internal_artifact",
    relativePath: "auto-review-summary.json",
  },
] as const;

export class FileArtifactStore implements ArtifactStore {
  constructor(
    private readonly workRoot: string,
    private readonly _publicBaseUrl: string,
    private readonly controlPlaneStore: ControlPlaneStore,
  ) {}

  async allocateTargets(runId: string): Promise<{
    targets: Record<string, { class: string; path: string; uploadUrl: string }>;
  }> {
    const runDir = path.join(this.workRoot, runId);
    await mkdir(path.join(runDir, "artifacts"), { recursive: true });

    const targets: Record<string, { class: string; path: string; uploadUrl: string }> = {};
    for (const artifact of PREALLOCATED_RUN_ARTIFACTS) {
      const artifactPath = path.join(runDir, artifact.relativePath);
      await this.controlPlaneStore.upsertArtifact(runId, artifact.artifactKey, artifact.artifactClass, {
        storage: "file",
        path: artifactPath,
      });
      targets[artifact.responseKey] = {
        class: artifact.artifactClass,
        path: artifactPath,
        uploadUrl: `/internal/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.artifactKey)}`,
      };
    }

    return { targets };
  }
}
