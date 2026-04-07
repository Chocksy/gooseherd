import { classifyError, type ClassifiedError } from "../run-manager.js";

export interface ClassifiedFailure extends ClassifiedError {
  retryable: boolean;
  retryStrategy: "full" | "none";
}

/** Maps error categories to retry decisions. */
const RETRY_MAP: Record<string, { retryable: boolean; retryStrategy: ClassifiedFailure["retryStrategy"] }> = {
  clone:       { retryable: true,  retryStrategy: "full" },
  timeout:     { retryable: false, retryStrategy: "none" },
  no_changes:  { retryable: false, retryStrategy: "none" },
  validation:  { retryable: false, retryStrategy: "none" },
  agent_crash: { retryable: true,  retryStrategy: "full" },
  push:        { retryable: true,  retryStrategy: "full" },
  pr:          { retryable: true,  retryStrategy: "full" },
  unknown:     { retryable: false, retryStrategy: "none" }
};

export function classifyFailureWithRetryability(message: string): ClassifiedFailure {
  const base = classifyError(message);
  const retry = RETRY_MAP[base.category] ?? { retryable: false, retryStrategy: "none" as const };
  return { ...base, ...retry };
}
