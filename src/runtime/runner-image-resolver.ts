import { logInfo } from "../logger.js";

const REPO_TO_IMAGE_ENV: Record<string, string> = {
  "NetsoftHoldings/hubstaff-server": "KUBERNETES_RUNNER_IMAGE_SERVER",
};

export function resolveRunnerImage(repoSlug: string, defaultImage: string): string {
  const envKey = REPO_TO_IMAGE_ENV[repoSlug];
  if (!envKey) {
    return defaultImage;
  }

  const override = process.env[envKey]?.trim();
  if (!override) {
    return defaultImage;
  }

  logInfo("runner-image: using repo-specific image", { repoSlug, envKey, image: override });
  return override;
}
