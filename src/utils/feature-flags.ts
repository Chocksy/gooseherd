import type { AppConfig, AppFeatures } from "../config.js";

type LegacyFeatureCarrier = Partial<Pick<AppConfig,
  | "features"
  | "observerEnabled"
  | "browserVerifyEnabled"
  | "ciWaitEnabled"
  | "supervisorEnabled"
  | "autonomousSchedulerEnabled"
>>;

const DEFAULT_FEATURES: AppFeatures = {
  observer: false,
  workItems: false,
  browserVerify: false,
  ciWait: false,
  supervisor: true,
  sessions: false,
  eval: false,
  autonomousScheduler: false,
};

export type FeatureKey = keyof AppFeatures;

export function getFeatures(config: LegacyFeatureCarrier): AppFeatures {
  if (config.features) {
    return config.features;
  }

  return {
    observer: config.observerEnabled ?? DEFAULT_FEATURES.observer,
    workItems: DEFAULT_FEATURES.workItems,
    browserVerify: config.browserVerifyEnabled ?? DEFAULT_FEATURES.browserVerify,
    ciWait: config.ciWaitEnabled ?? DEFAULT_FEATURES.ciWait,
    supervisor: config.supervisorEnabled ?? DEFAULT_FEATURES.supervisor,
    sessions: DEFAULT_FEATURES.sessions,
    eval: DEFAULT_FEATURES.eval,
    autonomousScheduler: config.autonomousSchedulerEnabled ?? DEFAULT_FEATURES.autonomousScheduler,
  };
}

export function isFeatureEnabled(config: LegacyFeatureCarrier, key: FeatureKey): boolean {
  return getFeatures(config)[key];
}
