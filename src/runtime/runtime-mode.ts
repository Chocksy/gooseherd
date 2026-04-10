export type SandboxRuntime = "local" | "docker" | "kubernetes";

export interface SandboxRuntimePreflightConfig {
  sandboxRuntime: SandboxRuntime;
  sandboxRuntimeExplicit: boolean;
  sandboxEnabled: boolean;
  sandboxHostWorkPath: string;
}

export interface SandboxRuntimeHotReloadConfig extends SandboxRuntimePreflightConfig {
  sandboxImage: string;
  sandboxCpus: number;
  sandboxMemoryMb: number;
}

export type SandboxRuntimeFallbackReason = "missing_host_work_path" | "docker_unreachable";

export interface SandboxRuntimePreflightResult {
  sandboxEnabled: boolean;
  fallbackReason?: SandboxRuntimeFallbackReason;
}

export function assertImplementedSandboxRuntime(runtime: SandboxRuntime): void {
  if (runtime === "kubernetes") {
    throw new Error("SANDBOX_RUNTIME=kubernetes is not supported yet");
  }
}

export async function preflightSandboxRuntime(
  config: SandboxRuntimePreflightConfig,
  deps: { pingDocker: () => Promise<boolean> }
): Promise<SandboxRuntimePreflightResult> {
  assertImplementedSandboxRuntime(config.sandboxRuntime);

  if (!config.sandboxEnabled) {
    return { sandboxEnabled: false };
  }

  if (config.sandboxHostWorkPath.trim() === "") {
    if (config.sandboxRuntimeExplicit) {
      throw new Error("SANDBOX_HOST_WORK_PATH is required when SANDBOX_RUNTIME=docker");
    }
    return { sandboxEnabled: false, fallbackReason: "missing_host_work_path" };
  }

  const dockerOk = await deps.pingDocker();
  if (!dockerOk) {
    if (config.sandboxRuntimeExplicit) {
      throw new Error("Docker daemon not reachable for SANDBOX_RUNTIME=docker");
    }
    return { sandboxEnabled: false, fallbackReason: "docker_unreachable" };
  }

  return { sandboxEnabled: true };
}

export function hasSandboxRuntimeHotReloadChange(
  current: SandboxRuntimeHotReloadConfig,
  next: SandboxRuntimeHotReloadConfig
): boolean {
  return current.sandboxRuntime !== next.sandboxRuntime
    || current.sandboxRuntimeExplicit !== next.sandboxRuntimeExplicit
    || current.sandboxHostWorkPath !== next.sandboxHostWorkPath
    || current.sandboxImage !== next.sandboxImage
    || current.sandboxCpus !== next.sandboxCpus
    || current.sandboxMemoryMb !== next.sandboxMemoryMb;
}

export function resolveSandboxRuntime(env: {
  SANDBOX_RUNTIME?: string;
  SANDBOX_ENABLED?: string;
}): SandboxRuntime {
  if (env.SANDBOX_RUNTIME !== undefined) {
    const rawExplicit = env.SANDBOX_RUNTIME.trim();
    if (rawExplicit === "") {
      throw new Error("Invalid SANDBOX_RUNTIME value: ");
    }
    const explicit = rawExplicit.toLowerCase();
    if (explicit === "local" || explicit === "docker" || explicit === "kubernetes") {
      return explicit;
    }
    throw new Error(`Invalid SANDBOX_RUNTIME value: ${rawExplicit}`);
  }

  const legacy = env.SANDBOX_ENABLED?.trim().toLowerCase();
  if (legacy === "1" || legacy === "true" || legacy === "yes") {
    return "docker";
  }

  return "local";
}
