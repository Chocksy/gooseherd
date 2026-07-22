import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardCapabilities } from "../src/dashboard/capabilities.js";
import type { AppConfig } from "../src/config.js";

type CapabilitiesConfig = Parameters<typeof buildDashboardCapabilities>[0];

function makeConfig(overrides: Partial<CapabilitiesConfig> = {}): CapabilitiesConfig {
  return {
    observerEnabled: false,
    browserVerifyEnabled: false,
    scopeJudgeEnabled: false,
    ciWaitEnabled: false,
    dryRun: false,
    sandboxRuntime: "local" as AppConfig["sandboxRuntime"],
    features: undefined,
    ...overrides,
  };
}

test("dryRun capability reports the effective value for kubernetes runs (ambient DRY_RUN ignored)", () => {
  const capabilities = buildDashboardCapabilities(makeConfig({ dryRun: true, sandboxRuntime: "kubernetes" }));
  assert.equal(capabilities.dryRun, false);
});

test("dryRun capability honors config.dryRun for non-kubernetes runtimes", () => {
  const capabilities = buildDashboardCapabilities(makeConfig({ dryRun: true, sandboxRuntime: "local" }));
  assert.equal(capabilities.dryRun, true);
});
