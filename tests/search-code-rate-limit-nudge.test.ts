import assert from "node:assert/strict";
import test from "node:test";
import { wrapSearchCodeWithRateLimitNudge } from "../src/orchestrator/search-code-rate-limit.js";

test("wrapSearchCodeWithRateLimitNudge: returns nudge string on 403 with 'rate limit' message", async () => {
  const inner = async () => {
    const err = new Error("You have exceeded a secondary rate limit. Please wait a few minutes before you try again.") as Error & { status?: number };
    err.status = 403;
    throw err;
  };
  const wrapped = wrapSearchCodeWithRateLimitNudge(inner);

  const result = await wrapped("daily work summary", "owner/repo");

  assert.match(result, /rate-limited/);
  assert.match(result, /execute_task/);
  assert.match(result, /investigate/);
});

test("wrapSearchCodeWithRateLimitNudge: returns nudge string on 403 with 'abuse detection' message", async () => {
  const inner = async () => {
    const err = new Error("You have triggered an abuse detection mechanism.") as Error & { status?: number };
    err.status = 403;
    throw err;
  };
  const wrapped = wrapSearchCodeWithRateLimitNudge(inner);

  const result = await wrapped("q", "owner/repo");

  assert.match(result, /rate-limited/);
});

test("wrapSearchCodeWithRateLimitNudge: re-throws non-rate-limit 401 errors unchanged", async () => {
  const inner = async () => {
    const err = new Error("Bad credentials") as Error & { status?: number };
    err.status = 401;
    throw err;
  };
  const wrapped = wrapSearchCodeWithRateLimitNudge(inner);

  await assert.rejects(() => wrapped("q", "owner/repo"), /Bad credentials/);
});

test("wrapSearchCodeWithRateLimitNudge: re-throws non-rate-limit 403 errors unchanged", async () => {
  const inner = async () => {
    const err = new Error("Forbidden: insufficient scope") as Error & { status?: number };
    err.status = 403;
    throw err;
  };
  const wrapped = wrapSearchCodeWithRateLimitNudge(inner);

  await assert.rejects(() => wrapped("q", "owner/repo"), /insufficient scope/);
});

test("wrapSearchCodeWithRateLimitNudge: returns inner success unchanged", async () => {
  const inner = async () => "path/to/file.rb\n  match line";
  const wrapped = wrapSearchCodeWithRateLimitNudge(inner);

  assert.equal(await wrapped("q", "owner/repo"), "path/to/file.rb\n  match line");
});
