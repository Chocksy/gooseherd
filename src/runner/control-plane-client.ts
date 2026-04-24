import type {
  RunEnvelope,
  RunnerCompletionPayload,
  RunnerEventPayload,
  RunnerTokenUsagePayload,
} from "../runtime/control-plane-types.js";
import { sleep } from "../utils/sleep.js";
import { isRecord } from "../utils/type-guards.js";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const BASE_RETRY_DELAY_MS = 250;
const TERMINAL_STATUSES = new Set([401, 403, 404, 409, 422]);

interface RunnerControlPlaneClientConfig {
  baseUrl: string;
  runId: string;
  token: string;
  requestTimeoutMs?: number;
}

interface RetryOptions {
  maxAttempts?: number;
}

interface ArtifactTarget {
  class: string;
  path: string;
  uploadUrl: string;
}

interface ArtifactTargetsResponse {
  targets: Record<string, ArtifactTarget>;
}

function toArtifactUploadBody(body: Buffer | Uint8Array | string, contentType: string): string | Blob {
  if (typeof body === "string") {
    return body;
  }
  const binaryBody = Uint8Array.from(body);
  return new Blob([binaryBody], { type: contentType });
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status >= 500;
}

function isTerminalStatus(status: number): boolean {
  return TERMINAL_STATUSES.has(status);
}

function isRunEnvelope(value: unknown): value is RunEnvelope {
  if (!isRecord(value)) return false;
  if (typeof value.runId !== "string" || value.runId.trim() === "") return false;
  if (typeof value.payloadRef !== "string" || value.payloadRef.trim() === "") return false;
  if (!isRecord(value.payloadJson)) return false;
  if (value.runtime !== "local" && value.runtime !== "docker" && value.runtime !== "kubernetes") return false;
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return false;
  if (typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) return false;
  return true;
}

function isCancellationResponse(value: unknown): value is { cancelRequested: boolean } {
  return isRecord(value) && typeof value.cancelRequested === "boolean";
}

function isArtifactTargetsResponse(value: unknown): value is ArtifactTargetsResponse {
  if (!isRecord(value) || !isRecord(value.targets)) return false;

  for (const target of Object.values(value.targets)) {
    if (!isRecord(target)) return false;
    if (typeof target.class !== "string" || target.class.trim() === "") return false;
    if (typeof target.path !== "string" || target.path.trim() === "") return false;
    if (typeof target.uploadUrl !== "string" || target.uploadUrl.trim() === "") return false;
  }

  return true;
}

async function parseValidatedSuccessBody<T>(
  res: Response,
  suffix: RequestSuffix,
  validator: (value: unknown) => value is T,
): Promise<T> {
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error(`invalid success body for ${suffix}`);
  }

  if (!validator(parsed)) {
    throw new Error(`invalid success body for ${suffix}`);
  }

  return parsed;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort|timed out|timeout/i.test(error.message));
}

type RequestSuffix = "payload" | "artifacts" | "events" | "complete" | "cancellation" | "token-usage";

function nextRetryDelayMs(attempt: number): number {
  const baseDelay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
  const jitter = Math.random() * baseDelay * 0.5;
  return Math.round(baseDelay + jitter);
}

export class RunnerControlPlaneClient {
  constructor(private readonly cfg: RunnerControlPlaneClientConfig) {}

  async getPayload(opts?: RetryOptions): Promise<RunEnvelope> {
    return this.request<RunEnvelope>("GET", "payload", undefined, opts?.maxAttempts, (res, suffix) =>
      parseValidatedSuccessBody(res, suffix, isRunEnvelope),
    );
  }

  async appendEvent(payload: RunnerEventPayload, opts?: RetryOptions): Promise<void> {
    await this.request("POST", "events", payload, opts?.maxAttempts);
  }

  async complete(payload: RunnerCompletionPayload, opts?: RetryOptions): Promise<void> {
    await this.request("POST", "complete", payload, opts?.maxAttempts);
  }

  async addTokenUsage(payload: RunnerTokenUsagePayload, opts?: RetryOptions): Promise<void> {
    await this.request("POST", "token-usage", payload, opts?.maxAttempts);
  }

  async getCancellation(opts?: RetryOptions): Promise<{ cancelRequested: boolean }> {
    return this.request<{ cancelRequested: boolean }>("GET", "cancellation", undefined, opts?.maxAttempts, (res, suffix) =>
      parseValidatedSuccessBody(res, suffix, isCancellationResponse),
    );
  }

  async getArtifacts(opts?: RetryOptions): Promise<ArtifactTargetsResponse> {
    return this.request<ArtifactTargetsResponse>("GET", "artifacts", undefined, opts?.maxAttempts, (res, suffix) =>
      parseValidatedSuccessBody(res, suffix, isArtifactTargetsResponse),
    );
  }

  async uploadArtifact(
    uploadUrl: string,
    body: Buffer | Uint8Array | string,
    contentType = "application/octet-stream",
    opts?: RetryOptions,
  ): Promise<void> {
    const maxAttempts = Math.max(1, opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const resolvedUrl = new URL(uploadUrl, this.cfg.baseUrl).toString();
    const timeoutMs = Math.max(1, this.cfg.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    const requestBody = toArtifactUploadBody(body, contentType);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);

      try {
        response = await fetch(resolvedUrl, {
          method: "POST",
          signal: abortController.signal,
          headers: {
            authorization: `Bearer ${this.cfg.token}`,
            "content-type": contentType,
          },
          body: requestBody,
        });
      } catch (error) {
        clearTimeout(timeoutHandle);
        if (attempt === maxAttempts) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`retry budget exhausted for artifact upload: ${message}`);
        }
        await sleep(nextRetryDelayMs(attempt));
        continue;
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (response.ok) {
        return;
      }

      if (isTerminalStatus(response.status)) {
        throw new Error(`terminal status ${response.status} for artifact upload`);
      }

      if (!isRetryableStatus(response.status) || attempt === maxAttempts) {
        throw new Error(`retry budget exhausted for artifact upload: status ${response.status}`);
      }

      await sleep(nextRetryDelayMs(attempt));
    }

    throw new Error("retry budget exhausted for artifact upload");
  }

  private async request<T>(
    method: "GET" | "POST",
    suffix: RequestSuffix,
    body?: unknown,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    onSuccess?: (res: Response, suffix: RequestSuffix) => Promise<T>,
  ): Promise<T> {
    const url = `${this.cfg.baseUrl}/internal/runs/${this.cfg.runId}/${suffix}`;
    const attempts = Math.max(1, maxAttempts);
    const timeoutMs = Math.max(1, this.cfg.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);

      try {
        response = await fetch(url, {
          method,
          signal: abortController.signal,
          headers: {
            authorization: `Bearer ${this.cfg.token}`,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (error) {
        clearTimeout(timeoutHandle);
        if (attempt === attempts) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`retry budget exhausted for ${suffix}: ${message}`);
        }
        await sleep(nextRetryDelayMs(attempt));
        continue;
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (response.ok) {
        if (onSuccess) {
          return onSuccess(response, suffix);
        }
        return undefined as T;
      }

      if (isTerminalStatus(response.status)) {
        throw new Error(`terminal status ${response.status} for ${suffix}`);
      }

      if (!isRetryableStatus(response.status) || attempt === attempts) {
        throw new Error(`retry budget exhausted for ${suffix}: status ${response.status}`);
      }

      await sleep(nextRetryDelayMs(attempt));
    }

    throw new Error(`retry budget exhausted for ${suffix}`);
  }
}
