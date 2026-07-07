/**
 * Wraps the orchestrator's search_code tool callback so that GitHub
 * /search/code 403 rate-limit errors are converted into a structured
 * tool-result string the LLM can act on.
 *
 * Why: with the raw error string, the LLM otherwise wastes turns
 * retrying search_code with different queries (observed in prod logs
 * 2026-04-28 — 21 search/code calls, 7 returning 403, exhausted at
 * turn 25). The nudge string explicitly redirects the model to call
 * execute_task with mode="investigate" so the request becomes a
 * clone-based investigation run visible in the dashboard.
 */
const RATE_LIMIT_RE = /\brate\s*limit|abuse\s+detection|secondary\s+rate/i;

export function wrapSearchCodeWithRateLimitNudge(
  inner: (query: string, repoSlug: string) => Promise<string>
): (query: string, repoSlug: string) => Promise<string> {
  return async (query, repoSlug) => {
    try {
      return await inner(query, repoSlug);
    } catch (err) {
      const status = (err as { status?: unknown } | null)?.status;
      const msg = err instanceof Error ? err.message : String(err);
      if (status === 403 && RATE_LIMIT_RE.test(msg)) {
        return [
          `Error: GitHub /search/code is rate-limited (status 403): ${msg}`,
          ``,
          `Do NOT keep calling search_code with new queries — the rate limit applies`,
          `to the whole endpoint, not the query. Instead, call execute_task with`,
          `mode="investigate" and the same question. That will clone the repo and`,
          `let an agent investigate it; the run will appear in the dashboard and`,
          `the answer will be posted back to this Slack thread.`
        ].join("\n");
      }
      throw err;
    }
  };
}
