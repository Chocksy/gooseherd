import type { RuntimeRegistry, RunExecutionBackend } from "./backend.js";

type AssertExtends<T extends U, U> = true;

type InvalidRuntimeRegistry = {
  local: RunExecutionBackend<"local"> | undefined;
  docker: RunExecutionBackend<"local"> | undefined;
  kubernetes: undefined;
};

// @ts-expect-error docker slot must reject a local backend
type RuntimeRegistryRejectsMismatchedBackend = AssertExtends<InvalidRuntimeRegistry, RuntimeRegistry>;

export type RuntimeRegistryTypecheck = RuntimeRegistryRejectsMismatchedBackend;
