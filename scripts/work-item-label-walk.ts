/*
 * work-item-label-walk.ts — end-to-end "label walk" driver for the Hubble
 * feature-delivery flow, exercised against a REAL GitHub PR on epiccoders/pxls.
 *
 * ─── How the state machine ACTUALLY advances (verified against the reducer) ───
 * Labels alone do NOT move a work item between states. They only set flags:
 *   - "code review passed"  → engineering_review_done flag
 *   - "qa passed"           → qa_review_done flag
 * State advances on a CI-GREEN event (github.ci_completed=success). The app
 * re-resolves the CI conclusion from the LIVE GitHub check snapshot of the PR
 * head SHA (GitHubService.getPullRequestCiSnapshot), so a synthetic
 * check_suite=success only "sticks" if the PR genuinely has a green check.
 * A single ci_green event, once the relevant review flag is already set,
 * cascades auto_review → engineering_review → qa_preparation → qa_review →
 * ready_for_merge (see feature-delivery-reducer.ts / feature-delivery-policy.ts).
 *
 * Consequences this driver is built around:
 *   1. We seed a default team (adoption's resolveDeliveryContext needs one).
 *   2. On the scratch BASE branch we remove pxls's heavy `.github/workflows/main.yml`
 *      and add a trivial always-green workflow + a `.gooseherd.yml` ignore_checks,
 *      so the live snapshot goes green fast and deterministically. Scratch branch
 *      ONLY — master is never touched.
 *   3. We interleave each label with a synthetic check_suite=success so the
 *      cascade fires STEPWISE. The two labels are never pre-applied together, or
 *      the cascade would jump straight to ready_for_merge and the QA-comment
 *      handler (which early-returns unless state==qa_preparation) would no-op.
 *
 * ─── App launch command this driver expects (run separately, background) ───
 *   WORK_ITEMS_ENABLED=true \
 *   OBSERVER_ENABLED=true \
 *   OBSERVER_GITHUB_WEBHOOK_SECRET=<secret> \
 *   SANDBOX_RUNTIME=local \
 *   DRY_RUN=false \
 *   DASHBOARD_ENABLED=true \
 *   DATABASE_URL=postgres://gooseherd:gooseherd@localhost:55432/gooseherd \
 *   FEATURE_DELIVERY_SELF_REVIEW_ENABLED=false \
 *   FEATURE_DELIVERY_SKIP_PRODUCT_REVIEW=true \
 *   npm run dev
 *
 *   The same OBSERVER_GITHUB_WEBHOOK_SECRET and DATABASE_URL must be visible to
 *   this driver (via env). Webhook target defaults to http://127.0.0.1:8787/webhooks/github.
 *
 * ─── --mode is NOT a mock/offline switch ───
 *   --mode real (default): also applies the GitHub labels for real via `gh` (the
 *     webhook events below still drive the state machine).
 *   --mode synthetic: webhook-only labels — it skips the real `gh` label writes and
 *     drives the flow purely through synthesized webhook payloads. It is NOT a dry
 *     run: it STILL requires a real GitHub PR + green CI on epiccoders/pxls, the `gh`
 *     CLI (for PR/CI reads and the scratch-branch push), Postgres, and a running
 *     gooseherd instance receiving webhooks. Neither mode mocks GitHub or the app.
 *
 * Usage:
 *   npm run label-walk -- --repo epiccoders/pxls [--pr <n>] [--mode synthetic|real]
 *                          [--cleanup] [--no-cleanup-on-failure]
 *     --mode synthetic  webhook-only labels; still needs real GitHub CI, gh CLI,
 *                       Postgres, and a running gooseherd instance (see above).
 *     --cleanup         after the walk, close the scratch PR and delete its
 *                       hubble-e2e-base-*/hubble-e2e-head-* refs (only when this run
 *                       CREATED the scratch PR — never touches an operator's --pr).
 *     --no-cleanup-on-failure  keep the scratch PR/branches on failure for debugging
 *                       (by default a failed run best-effort deletes what it created).
 *
 * ─── Manual cleanup ───
 *   Scratch resources are named hubble-e2e-base-<ts> / hubble-e2e-head-<ts> and the
 *   PR titled "Hubble E2E label walk <ts>". By default a scratch PR is left OPEN on
 *   success (pass --cleanup to tear it down); a FAILED run cleans up unless
 *   --no-cleanup-on-failure is given. To remove leftovers by hand:
 *     gh pr close <n> --repo <repo>
 *     gh api -X DELETE repos/<repo>/git/refs/heads/hubble-e2e-head-<ts>
 *     gh api -X DELETE repos/<repo>/git/refs/heads/hubble-e2e-base-<ts>
 */

import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import postgres from "postgres";

// ───────────────────────────── config / args ─────────────────────────────

interface Args {
  repo: string;
  pr?: number;
  mode: "synthetic" | "real";
  cleanup: boolean;
  cleanupOnFailure: boolean;
}

function parseArgs(argv: string[]): Args {
  let repo = "";
  let pr: number | undefined;
  let mode: "synthetic" | "real" = "real";
  let cleanup = false;
  let cleanupOnFailure = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") { repo = argv[++i] ?? ""; }
    else if (arg === "--pr") { pr = Number.parseInt(argv[++i] ?? "", 10); }
    else if (arg === "--cleanup") { cleanup = true; }
    else if (arg === "--no-cleanup-on-failure") { cleanupOnFailure = false; }
    else if (arg === "--mode") {
      const value = argv[++i];
      if (value !== "synthetic" && value !== "real") throw new Error(`--mode must be synthetic|real, got ${String(value)}`);
      mode = value;
    }
  }
  if (!repo) throw new Error("--repo <owner/name> is required");
  if (pr !== undefined && !Number.isInteger(pr)) throw new Error("--pr must be an integer");
  return { repo, pr, mode, cleanup, cleanupOnFailure };
}

const WEBHOOK_URL = process.env.GOOSEHERD_WEBHOOK_URL ?? "http://127.0.0.1:8787/webhooks/github";
const WEBHOOK_SECRET = process.env.OBSERVER_GITHUB_WEBHOOK_SECRET ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://gooseherd:gooseherd@localhost:55432/gooseherd";

const ADOPTION_LABEL = "ai:assist";
const ENGINEERING_REVIEW_LABEL = "code review passed";
const QA_PASSED_LABEL = "qa passed";
const AUTOMERGE_LABEL = "automerge";
// Matches the app's QA_UAT_HEADER_RE (qa-preparation-actions.ts).
const QA_UAT_HEADER_RE = /^#{2,6}\s+QA\s*(?:\/|-)?\s*UAT\b/im;

// ───────────────────────────── small utilities ─────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg: string): void {
  console.log(`[label-walk] ${msg}`);
}

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function ghJson<T>(args: string[]): T {
  return JSON.parse(gh(args)) as T;
}

/** gh api that tolerates a non-zero exit, returning stdout+stderr text. */
function ghTry(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: gh(args) };
  } catch (error) {
    const err = error as { stdout?: Buffer | string; stderr?: Buffer | string };
    const out = `${String(err.stdout ?? "")}${String(err.stderr ?? "")}`;
    return { ok: false, out };
  }
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

async function poll<T>(
  label: string,
  timeoutMs: number,
  intervalMs: number,
  fn: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const result = await fn();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${String(Math.round(timeoutMs / 1000))}s waiting for: ${label}`);
    }
    if (attempt % 5 === 0) log(`  …still waiting for ${label} (${String(Math.round((deadline - Date.now()) / 1000))}s left)`);
    await sleep(intervalMs);
  }
}

// ───────────────────────────── webhook transport ─────────────────────────────

async function postWebhook(eventType: string, payload: Record<string, unknown>): Promise<void> {
  if (!WEBHOOK_SECRET) throw new Error("OBSERVER_GITHUB_WEBHOOK_SECRET is not set for the driver");
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
  const response = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": eventType,
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": signature,
    },
    body,
  });
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`Webhook POST (${eventType}) returned ${String(response.status)}: ${text}`);
  }
  log(`  → webhook ${eventType} accepted (${text.trim()})`);
}

interface GhPull {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: string;
  commits: number;
  base: { ref: string };
  head: { ref: string; sha: string };
  user: { login: string };
  labels: Array<{ name: string }>;
}

function fetchPull(repo: string, prNumber: number): GhPull {
  return ghJson<GhPull>(["api", `repos/${repo}/pulls/${String(prNumber)}`]);
}

function labeledPayload(repo: string, pull: GhPull, labelName: string): Record<string, unknown> {
  const labelNames = new Set(pull.labels.map((l) => l.name));
  labelNames.add(labelName);
  return {
    action: "labeled",
    number: pull.number,
    label: { name: labelName },
    repository: { full_name: repo },
    pull_request: {
      number: pull.number,
      title: pull.title,
      body: pull.body ?? "",
      html_url: pull.html_url,
      state: pull.state,
      user: { login: pull.user.login },
      base: { ref: pull.base.ref },
      head: { ref: pull.head.ref, sha: pull.head.sha },
      labels: [...labelNames].map((name) => ({ name })),
    },
  };
}

function checkSuiteSuccessPayload(repo: string, pull: GhPull): Record<string, unknown> {
  return {
    action: "completed",
    repository: { full_name: repo },
    check_suite: {
      conclusion: "success",
      status: "completed",
      head_sha: pull.head.sha,
      pull_requests: [{ number: pull.number }],
    },
  };
}

// ───────────────────────────── postgres helpers ─────────────────────────────

interface WorkItemRow {
  id: string;
  state: string;
  substate: string | null;
  flags: string[];
}

async function ensureDefaultTeam(sql: postgres.Sql): Promise<string> {
  const existing = await sql<Array<{ id: string }>>`select id from teams where is_default = true limit 1`;
  if (existing.length > 0) {
    log(`default team already present (${existing[0]!.id})`);
    return existing[0]!.id;
  }
  const id = randomUUID();
  await sql`
    insert into teams (id, name, slack_channel_id, is_default)
    values (${id}, ${"hubble-e2e-default"}, ${"C_HUBBLE_E2E"}, true)
  `;
  log(`seeded default team 'hubble-e2e-default' (${id})`);
  return id;
}

async function queryWorkItem(sql: postgres.Sql, repo: string, prNumber: number): Promise<WorkItemRow | undefined> {
  const rows = await sql<WorkItemRow[]>`
    select id, state, substate, flags
    from work_items
    where repo = ${repo} and github_pr_number = ${prNumber}
    limit 1
  `;
  return rows[0];
}

async function workItemStateHistory(sql: postgres.Sql, workItemId: string): Promise<string> {
  const rows = await sql<Array<{ event_type: string; payload: unknown; created_at: Date }>>`
    select event_type, payload, created_at
    from work_item_events
    where work_item_id = ${workItemId}
    order by id asc
  `;
  return rows
    .map((r) => `    ${r.created_at.toISOString()}  ${r.event_type}  ${JSON.stringify(r.payload)}`)
    .join("\n");
}

// ───────────────────────────── github scaffolding ─────────────────────────────

const ECHO_WORKFLOW = `name: hubble-e2e-green
on:
  pull_request:
  push:
jobs:
  hubble-e2e:
    runs-on: ubuntu-latest
    steps:
      - run: echo "hubble e2e green check"
`;

const GOOSEHERD_YML = `# Scratch-branch scaffolding for the Hubble E2E label walk. Never on master.
qualityGates:
  ci:
    ignore_checks:
      - "EpicPxls"
      - "Autosquash"
      - "message-check"
      - "rspec"
      - "coverage"
      - "brakeman"
      - "eslint"
      - "cypress"
`;

interface ScratchPr {
  prNumber: number;
  htmlUrl: string;
  baseBranch: string;
  headBranch: string;
}

function putFile(repo: string, branch: string, path: string, content: string, message: string, sha?: string): string {
  const args = [
    "api", "-X", "PUT", `repos/${repo}/contents/${path}`,
    "-f", `message=${message}`,
    "-f", `content=${b64(content)}`,
    "-f", `branch=${branch}`,
  ];
  if (sha) { args.push("-f", `sha=${sha}`); }
  const resp = ghJson<{ content: { sha: string } }>(args);
  return resp.content.sha;
}

function createScratchPr(repo: string): ScratchPr {
  const ts = Date.now();
  const baseBranch = `hubble-e2e-base-${ts}`;
  const headBranch = `hubble-e2e-head-${ts}`;
  const defaultBranch = ghJson<{ default_branch: string }>(["api", `repos/${repo}`]).default_branch;
  log(`default branch is '${defaultBranch}'`);

  const masterSha = ghJson<{ object: { sha: string } }>(["api", `repos/${repo}/git/ref/heads/${defaultBranch}`]).object.sha;

  log(`creating scratch base branch ${baseBranch}`);
  gh(["api", "-X", "POST", `repos/${repo}/git/refs`,
    "-f", `ref=refs/heads/${baseBranch}`,
    "-f", `sha=${masterSha}`]);

  // Remove pxls's heavy CI workflow on the scratch base so only the trivial green
  // check exists (scratch branch only — master is untouched).
  const mainWf = ghTry(["api", `repos/${repo}/contents/.github/workflows/main.yml?ref=${baseBranch}`]);
  if (mainWf.ok) {
    const sha = (JSON.parse(mainWf.out) as { sha: string }).sha;
    log("deleting heavy .github/workflows/main.yml on scratch base");
    gh(["api", "-X", "DELETE", `repos/${repo}/contents/.github/workflows/main.yml`,
      "-f", "message=chore(hubble-e2e): drop heavy CI on scratch base",
      "-f", `sha=${sha}`,
      "-f", `branch=${baseBranch}`]);
  } else {
    log("no .github/workflows/main.yml found on base (skipping delete)");
  }

  log("adding always-green workflow + .gooseherd.yml on scratch base");
  putFile(repo, baseBranch, ".github/workflows/hubble-e2e.yml", ECHO_WORKFLOW, "ci(hubble-e2e): always-green check");
  putFile(repo, baseBranch, ".gooseherd.yml", GOOSEHERD_YML, "chore(hubble-e2e): ignore_checks scaffolding");

  // Head branch off the (now scaffolded) base tip.
  const baseTip = ghJson<{ object: { sha: string } }>(["api", `repos/${repo}/git/ref/heads/${baseBranch}`]).object.sha;
  log(`creating head branch ${headBranch}`);
  gh(["api", "-X", "POST", `repos/${repo}/git/refs`,
    "-f", `ref=refs/heads/${headBranch}`,
    "-f", `sha=${baseTip}`]);

  // Two trivial commits so the squash path (2 → 1) is exercised.
  const docPath = `docs/hubble-e2e-${ts}.md`;
  log("creating two trivial commits on head branch");
  const firstSha = putFile(repo, headBranch, docPath, `# Hubble E2E ${ts}\n\nFirst change.\n`, "docs(hubble-e2e): first change");
  putFile(repo, headBranch, docPath, `# Hubble E2E ${ts}\n\nFirst change.\nSecond change.\n`, "docs(hubble-e2e): second change", firstSha);

  const body = [
    "Automated Hubble E2E label-walk PR. Safe to close.",
    "",
    "This PR exercises ai:assist → code review passed → qa passed against the local gooseherd instance.",
  ].join("\n");
  log("opening pull request");
  const pr = ghJson<{ number: number; html_url: string }>([
    "api", "-X", "POST", `repos/${repo}/pulls`,
    "-f", `title=Hubble E2E label walk ${ts}`,
    "-f", `head=${headBranch}`,
    "-f", `base=${baseBranch}`,
    "-f", `body=${body}`,
  ]);
  log(`opened PR #${String(pr.number)} — ${pr.html_url}`);
  return { prNumber: pr.number, htmlUrl: pr.html_url, baseBranch, headBranch };
}

function ensureLabel(repo: string, name: string): void {
  // Create if missing; ignore the 422 "already exists".
  ghTry(["api", "-X", "POST", `repos/${repo}/labels`, "-f", `name=${name}`, "-f", "color=ededed"]);
}

function addLabelReal(repo: string, prNumber: number, name: string): void {
  ensureLabel(repo, name);
  gh(["api", "-X", "POST", `repos/${repo}/issues/${String(prNumber)}/labels`, "-f", `labels[]=${name}`]);
  log(`  applied label '${name}' on GitHub`);
}

interface CheckRun { name: string; status: string; conclusion: string | null; }

function checkRunsFor(repo: string, sha: string): CheckRun[] {
  const resp = ghJson<{ check_runs: CheckRun[] }>(["api", `repos/${repo}/commits/${sha}/check-runs`]);
  return resp.check_runs;
}

async function waitForGreenSnapshot(repo: string, sha: string): Promise<void> {
  await poll(`green CI check on ${sha.slice(0, 8)}`, 8 * 60_000, 5_000, async () => {
    const runs = checkRunsFor(repo, sha);
    const relevant = runs.filter((r) => !/EpicPxls|Autosquash|message-check|rspec|coverage|brakeman|eslint|cypress/i.test(r.name));
    if (relevant.length === 0) return undefined;
    if (relevant.some((r) => r.status !== "completed")) return undefined;
    if (relevant.some((r) => r.conclusion !== null && !["success", "neutral", "skipped"].includes(r.conclusion))) {
      throw new Error(`CI check failed: ${JSON.stringify(relevant)}`);
    }
    if (!relevant.some((r) => r.conclusion === "success")) return undefined;
    return true;
  });
}

interface QaUatComment { htmlUrl: string; createdAt: string; updatedAt: string; }

/**
 * Find a QA/UAT comment that this walk is responsible for — i.e. one whose
 * created_at (fresh comment) OR updated_at (a sticky comment Gooseherd re-edited in
 * place) is at/after the walk's start. This prevents step 2 from passing on a
 * pre-existing QA/UAT comment left over from an earlier run or authored by a human.
 * Returns the newest such comment, or undefined when none qualifies yet.
 */
function findFreshQaUatComment(repo: string, prNumber: number, sinceMs: number): QaUatComment | undefined {
  const comments = ghJson<Array<{ body: string; html_url: string; created_at: string; updated_at: string }>>([
    "api", `repos/${repo}/issues/${String(prNumber)}/comments`, "--paginate",
  ]);
  return comments
    .filter((c) => QA_UAT_HEADER_RE.test(c.body ?? ""))
    .map((c) => ({ htmlUrl: c.html_url, createdAt: c.created_at, updatedAt: c.updated_at }))
    .filter((c) => Date.parse(c.updatedAt) >= sinceMs || Date.parse(c.createdAt) >= sinceMs)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}

/**
 * Best-effort teardown of a scratch PR this run created: close the PR and delete
 * its head/base refs. Only ever called with a ScratchPr we opened ourselves, so it
 * can never touch an operator-supplied --pr. Tolerates already-closed/deleted state.
 */
function cleanupScratch(repo: string, scratch: ScratchPr): void {
  log(`cleanup: closing scratch PR #${String(scratch.prNumber)} and deleting its refs`);
  ghTry(["api", "-X", "PATCH", `repos/${repo}/pulls/${String(scratch.prNumber)}`, "-f", "state=closed"]);
  for (const branch of [scratch.headBranch, scratch.baseBranch]) {
    const res = ghTry(["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${branch}`]);
    log(`  ${res.ok ? "deleted" : "could not delete"} ref ${branch}${res.ok ? "" : ` (${res.out.trim().slice(0, 120)})`}`);
  }
}

// ───────────────────────────── the walk ─────────────────────────────

interface StepResult { step: string; pass: boolean; evidence: string; }

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Captured up front: step 2 only accepts a QA/UAT comment created/updated at or
  // after this instant, so a comment from an earlier run can't satisfy the check.
  const walkStartMs = Date.now();
  log(`repo=${args.repo} mode=${args.mode} pr=${args.pr ?? "(create)"} cleanup=${String(args.cleanup)}`);
  log(`webhook=${WEBHOOK_URL}  db=${DATABASE_URL.replace(/:[^:@/]+@/, ":***@")}`);

  const sql = postgres(DATABASE_URL, { max: 2 });
  const results: StepResult[] = [];
  let prNumber = args.pr ?? -1;
  let htmlUrl = "";
  let workItemId = "";
  let commitsBefore = 0;
  let commitsAfter = 0;
  let scratch: ScratchPr | undefined;
  let walkSucceeded = false;

  try {
    await ensureDefaultTeam(sql);

    // ── Setup ──
    if (args.pr === undefined) {
      scratch = createScratchPr(args.repo);
      prNumber = scratch.prNumber;
      htmlUrl = scratch.htmlUrl;
    } else {
      const pull = fetchPull(args.repo, prNumber);
      htmlUrl = pull.html_url;
    }
    commitsBefore = fetchPull(args.repo, prNumber).commits;
    log(`PR #${String(prNumber)} has ${String(commitsBefore)} commits before the walk`);

    // ── Step 1: ai:assist → adoption ──
    log(`STEP 1: apply '${ADOPTION_LABEL}' (adopt as feature-delivery work item)`);
    if (args.mode === "real") addLabelReal(args.repo, prNumber, ADOPTION_LABEL);
    await postWebhook("pull_request", labeledPayload(args.repo, fetchPull(args.repo, prNumber), ADOPTION_LABEL));
    const adopted = await poll("work item adoption", 60_000, 2_000, async () => queryWorkItem(sql, args.repo, prNumber));
    workItemId = adopted.id;
    // Step 1 must land EXACTLY in auto_review. Accepting a further-cascaded state
    // (engineering_review … ready_for_merge) would mask a violated stepwise
    // precondition — e.g. a reused work item that had already progressed — and let
    // a broken adoption transition slip through as a PASS. If the driver is re-run
    // against an already-progressed item, fail loudly and tell the operator to use
    // a fresh work item rather than silently passing.
    const alreadyProgressed = ["engineering_review", "qa_preparation", "qa_review", "ready_for_merge"].includes(adopted.state);
    results.push({
      step: "1. ai:assist → adopted",
      pass: adopted.state === "auto_review",
      evidence: alreadyProgressed
        ? `work item ${adopted.id} is already at state=${adopted.state} (expected auto_review) — this item has progressed past adoption; re-run against a FRESH work item / PR`
        : `work item ${adopted.id} state=${adopted.state} substate=${String(adopted.substate)} flags=[${adopted.flags.join(",")}]`,
    });
    log(`  adopted: ${results[0]!.evidence}`);

    // ── Step 2: code review passed → CI green → qa_preparation → QA/UAT comment ──
    log(`STEP 2: apply '${ENGINEERING_REVIEW_LABEL}', drive CI green, expect QA/UAT comment`);
    if (args.mode === "real") addLabelReal(args.repo, prNumber, ENGINEERING_REVIEW_LABEL);
    await postWebhook("pull_request", labeledPayload(args.repo, fetchPull(args.repo, prNumber), ENGINEERING_REVIEW_LABEL));

    const pullForCi = fetchPull(args.repo, prNumber);
    log(`  waiting for a green check on head ${pullForCi.head.sha.slice(0, 8)} …`);
    await waitForGreenSnapshot(args.repo, pullForCi.head.sha);
    log("  CI is green; injecting synthetic check_suite=success");
    await postWebhook("check_suite", checkSuiteSuccessPayload(args.repo, pullForCi));

    // Wait for a QA/UAT comment this walk is responsible for (fresh created_at, or a
    // sticky updated_at at/after walkStart) — a pre-existing comment must NOT pass.
    const qaComment = await poll("fresh QA/UAT comment on PR", 12 * 60_000, 6_000, async () =>
      findFreshQaUatComment(args.repo, prNumber, walkStartMs),
    );
    const qaCommentUrl = qaComment.htmlUrl;
    const afterQa = await queryWorkItem(sql, args.repo, prNumber);
    // The QA/UAT comment is posted once the cascade reaches qa_preparation, so the
    // work item must have landed in qa_preparation (or cascaded on to qa_review) —
    // a comment alongside any other state means a violated stepwise precondition.
    const qaStateOk = afterQa?.state === "qa_preparation" || afterQa?.state === "qa_review";
    results.push({
      step: "2. code review passed → qa_preparation + QA/UAT comment",
      pass: qaStateOk,
      evidence: `comment=${qaCommentUrl} (created=${qaComment.createdAt}, updated=${qaComment.updatedAt}, walkStart=${new Date(walkStartMs).toISOString()}) ; work item state=${afterQa?.state ?? "?"} (expected qa_preparation|qa_review) substate=${String(afterQa?.substate)} flags=[${afterQa?.flags.join(",") ?? ""}]`,
    });
    log(`  QA/UAT comment: ${qaCommentUrl}`);

    // ── Step 3: qa passed → CI green → ready_for_merge → squash → automerge ──
    log(`STEP 3: apply '${QA_PASSED_LABEL}', drive CI green, expect squash + '${AUTOMERGE_LABEL}'`);
    if (args.mode === "real") addLabelReal(args.repo, prNumber, QA_PASSED_LABEL);
    await postWebhook("pull_request", labeledPayload(args.repo, fetchPull(args.repo, prNumber), QA_PASSED_LABEL));

    const pullForCi2 = fetchPull(args.repo, prNumber);
    await waitForGreenSnapshot(args.repo, pullForCi2.head.sha);
    log("  CI is green; injecting synthetic check_suite=success to enter ready_for_merge");
    await postWebhook("check_suite", checkSuiteSuccessPayload(args.repo, pullForCi2));

    // Squash + force-with-lease push reduces the commit count to 1.
    await poll("PR squashed to a single commit", 12 * 60_000, 6_000, async () => {
      const count = fetchPull(args.repo, prNumber).commits;
      return count === 1 ? true : undefined;
    });
    commitsAfter = fetchPull(args.repo, prNumber).commits;
    log(`  commit count is now ${String(commitsAfter)}; re-triggering ready-for-merge to add automerge`);

    // After the squash push, re-post a benign pull_request event so
    // ReadyForMergeActions.handleEntry runs again — now seeing a single commit,
    // it adds the automerge label (see ready-for-merge-actions.ts).
    await postWebhook("pull_request", labeledPayload(args.repo, fetchPull(args.repo, prNumber), QA_PASSED_LABEL));
    const automergePresent = await poll(`'${AUTOMERGE_LABEL}' label on PR`, 5 * 60_000, 5_000, async () => {
      const labels = fetchPull(args.repo, prNumber).labels.map((l) => l.name);
      return labels.includes(AUTOMERGE_LABEL) ? labels : undefined;
    });
    const afterMerge = await queryWorkItem(sql, args.repo, prNumber);
    results.push({
      step: "3. qa passed → squash (2→1) + automerge",
      pass: commitsAfter === 1 && automergePresent.includes(AUTOMERGE_LABEL),
      evidence: `commits ${commitsBefore}→${commitsAfter}; labels=[${automergePresent.join(",")}]; work item state=${afterMerge?.state ?? "?"}`,
    });
    log(`  ready_for_merge: ${results[2]!.evidence}`);

    // ── Report ──
    printReport(args, prNumber, htmlUrl, qaCommentUrl, results);
    if (workItemId) {
      console.log("\nWork item event history:");
      console.log(await workItemStateHistory(sql, workItemId));
    }

    const allPass = results.every((r) => r.pass);
    walkSucceeded = true;
    if (!allPass) process.exitCode = 1;
  } catch (error) {
    console.error(`\n[label-walk] FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    printReport(args, prNumber, htmlUrl, undefined, results);
    if (workItemId) {
      console.log("\nWork item event history:");
      console.log(await workItemStateHistory(sql, workItemId).catch(() => "  (unavailable)"));
    }
    process.exitCode = 1;
  } finally {
    // Tear down scratch resources we created when asked (--cleanup) or, on a failed
    // run, by default (unless --no-cleanup-on-failure). Never touches an operator's
    // --pr, since `scratch` is only set when this run opened the PR itself.
    if (scratch) {
      const cleanupNow = args.cleanup || (!walkSucceeded && args.cleanupOnFailure);
      if (cleanupNow) {
        try {
          cleanupScratch(args.repo, scratch);
        } catch (cleanupError) {
          console.error(`[label-walk] cleanup error (ignored): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        }
      } else {
        console.log(`\nScratch PR left open for inspection: ${scratch.htmlUrl}`);
      }
    } else if (htmlUrl) {
      console.log(`\nPR left open for inspection: ${htmlUrl}`);
    }
    await sql.end({ timeout: 5 });
  }
}

function printReport(
  args: Args,
  prNumber: number,
  htmlUrl: string,
  qaCommentUrl: string | undefined,
  results: StepResult[],
): void {
  console.log("\n══════════════════════════ LABEL WALK REPORT ══════════════════════════");
  console.log(`repo=${args.repo}  mode=${args.mode}  PR #${String(prNumber)}  ${htmlUrl}`);
  if (qaCommentUrl) console.log(`QA/UAT comment: ${qaCommentUrl}`);
  console.log("────────────────────────────────────────────────────────────────────────");
  for (const r of results) {
    console.log(`  [${r.pass ? "PASS" : "FAIL"}] ${r.step}`);
    console.log(`         ${r.evidence}`);
  }
  const missing = 3 - results.length;
  if (missing > 0) console.log(`  [FAIL] ${String(missing)} step(s) did not run (aborted early)`);
  console.log("════════════════════════════════════════════════════════════════════════");
}

void main();
