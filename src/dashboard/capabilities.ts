import type { AppConfig } from "../config.js";
import { getFeatures } from "../utils/feature-flags.js";
import { isDashboardAdminPrincipal, type DashboardActorPrincipal } from "./actor-principal.js";

export interface DashboardCapabilities {
  observer: boolean;
  workItems: boolean;
  browserVerify: boolean;
  scopeJudge: boolean;
  ciWait: boolean;
  sessions: boolean;
  eval: boolean;
  dryRun: boolean;
  manageUsers: boolean;
}

export function buildDashboardCapabilities(
  config: Pick<
    AppConfig,
    | "observerEnabled"
    | "browserVerifyEnabled"
    | "scopeJudgeEnabled"
    | "ciWaitEnabled"
    | "dryRun"
    | "features"
  >,
  actorPrincipal?: DashboardActorPrincipal,
): DashboardCapabilities {
  const features = getFeatures(config);
  return {
    observer: config.observerEnabled,
    workItems: features.workItems,
    browserVerify: config.browserVerifyEnabled,
    scopeJudge: config.scopeJudgeEnabled,
    ciWait: config.ciWaitEnabled,
    sessions: features.sessions,
    eval: features.eval,
    dryRun: config.dryRun,
    manageUsers: isDashboardAdminPrincipal(actorPrincipal),
  };
}
