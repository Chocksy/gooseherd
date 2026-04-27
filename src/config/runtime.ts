import type { AppConfig, AppFeatures } from "../config.js";
import { resolveSandboxRuntime } from "../runtime/runtime-mode.js";
import type { ParsedEnv } from "./shared.js";
import { parseInteger } from "./shared.js";

type RuntimeConfigSlice = Pick<
  AppConfig,
  | "sandboxRuntime"
  | "sandboxRuntimeExplicit"
  | "sandboxEnabled"
  | "sandboxImage"
  | "sandboxHostWorkPath"
  | "sandboxCpus"
  | "sandboxMemoryMb"
  | "supervisorEnabled"
  | "supervisorRunTimeoutSeconds"
  | "supervisorNodeStaleSeconds"
  | "supervisorWatchdogIntervalSeconds"
  | "supervisorMaxAutoRetries"
  | "supervisorRetryCooldownSeconds"
  | "supervisorMaxRetriesPerDay"
>;

export function loadRuntimeConfig(parsed: ParsedEnv, features: AppFeatures): RuntimeConfigSlice {
  const sandboxRuntime = resolveSandboxRuntime(parsed);
  const sandboxRuntimeExplicit = parsed.SANDBOX_RUNTIME !== undefined;

  return {
    sandboxRuntime,
    sandboxRuntimeExplicit,
    sandboxEnabled: sandboxRuntime === "docker",
    sandboxImage: parsed.SANDBOX_IMAGE?.trim() || "gooseherd/sandbox:default",
    sandboxHostWorkPath: parsed.SANDBOX_HOST_WORK_PATH?.trim() || "",
    sandboxCpus: parseInteger(parsed.SANDBOX_CPUS, 2),
    sandboxMemoryMb: parseInteger(parsed.SANDBOX_MEMORY_MB, 4096),
    supervisorEnabled: features.supervisor,
    supervisorRunTimeoutSeconds: parseInteger(parsed.SUPERVISOR_RUN_TIMEOUT_SECONDS, 7200),
    supervisorNodeStaleSeconds: parseInteger(parsed.SUPERVISOR_NODE_STALE_SECONDS, 1800),
    supervisorWatchdogIntervalSeconds: parseInteger(parsed.SUPERVISOR_WATCHDOG_INTERVAL_SECONDS, 30),
    supervisorMaxAutoRetries: parseInteger(parsed.SUPERVISOR_MAX_AUTO_RETRIES, 1),
    supervisorRetryCooldownSeconds: parseInteger(parsed.SUPERVISOR_RETRY_COOLDOWN_SECONDS, 60),
    supervisorMaxRetriesPerDay: parseInteger(parsed.SUPERVISOR_MAX_RETRIES_PER_DAY, 20),
  };
}
