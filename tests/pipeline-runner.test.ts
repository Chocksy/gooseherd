import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveRunRecordFromPayload, runPipelineRunner } from "../src/runner/pipeline-runner.js";
import type { RunEnvelope, RunnerCompletionPayload, RunnerEventPayload } from "../src/runtime/control-plane-types.js";

const samplePayload: RunEnvelope = {
  runId: "run-pipeline-runner-1",
  payloadRef: "payload/run-pipeline-runner-1",
  payloadJson: {
    run: {
      id: "run-pipeline-runner-1",
      runtime: "kubernetes",
      repoSlug: "org/repo",
      task: "pipeline runner test",
      baseBranch: "main",
      branchName: "goose/test",
      requestedBy: "runner",
      channelId: "runner",
      threadTs: "runner",
      createdAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
      prefetchContext: {
        meta: {
          fetchedAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
          sources: ["jira"],
        },
        workItem: {
          id: "work-item-1",
          title: "Work item",
          workflow: "feature_delivery",
        },
        jira: {
          issue: {
            key: "HUB-1",
            description: "issue description",
          },
          comments: [],
        },
      },
      autoReviewSourceSubstate: "pr_adopted",
    },
  },
  runtime: "kubernetes",
  createdAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
  updatedAt: new Date("2026-04-10T00:00:00.000Z").toISOString(),
};

test("pipeline runner ignores transient cancellation polling failures during a successful run", async () => {
  const originalPollMs = process.env.RUNNER_CANCELLATION_POLL_MS;
  process.env.RUNNER_CANCELLATION_POLL_MS = "5";
  const events: RunnerEventPayload[] = [];
  const completions: RunnerCompletionPayload[] = [];
  let cancellationChecks = 0;

  try {
    await runPipelineRunner(
      {
        getPayload: async () => samplePayload,
        appendEvent: async (event: RunnerEventPayload) => {
          events.push(event);
        },
        complete: async (payload: RunnerCompletionPayload) => {
          completions.push(payload);
        },
        getCancellation: async () => {
          cancellationChecks += 1;
          if (cancellationChecks === 1) {
            throw new Error("temporary upstream failure");
          }
          return { cancelRequested: false };
        },
      } as never,
      async () => ({
        branchName: "goose/test",
        logsPath: "/tmp/run.log",
        commitSha: "abc123",
        changedFiles: ["src/index.ts"],
        prNumber: 42,
      }),
    );
  } finally {
    if (originalPollMs === undefined) {
      delete process.env.RUNNER_CANCELLATION_POLL_MS;
    } else {
      process.env.RUNNER_CANCELLATION_POLL_MS = originalPollMs;
    }
  }

  assert.equal(cancellationChecks >= 1, true);
  assert.equal(events.some((event) => event.eventType === "run.started"), true);
  assert.equal(events.some((event) => event.eventType === "run.warning"), false);
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.status, "success");
  assert.equal(completions[0]?.artifactState, "complete");
  assert.equal((completions[0] as { prNumber?: number } | undefined)?.prNumber, 42);
});

test("deriveRunRecordFromPayload preserves prefetched context and auto-review substate", () => {
  const run = deriveRunRecordFromPayload(samplePayload);

  assert.equal(run.prefetchContext?.workItem.id, "work-item-1");
  assert.equal(run.prefetchContext?.jira?.issue.key, "HUB-1");
  assert.equal(run.autoReviewSourceSubstate, "pr_adopted");
});

test("deriveRunRecordFromPayload reads top-level prefetched context from control-plane payload", () => {
  const run = deriveRunRecordFromPayload({
    ...samplePayload,
    payloadJson: {
      run: {
        ...samplePayload.payloadJson.run,
        prefetchContext: undefined,
        autoReviewSourceSubstate: undefined,
      },
      prefetch: {
        meta: {
          fetchedAt: new Date("2026-04-11T00:00:00.000Z").toISOString(),
          sources: ["github_pr"],
        },
        workItem: {
          id: "work-item-2",
          title: "Another work item",
          workflow: "feature_delivery",
        },
        github: {
          pr: {
            number: 99,
            url: "https://github.com/org/repo/pull/99",
            title: "Prefetched PR",
            body: "body",
            state: "open",
          },
          discussionComments: [],
          reviews: [],
          reviewComments: [],
          ci: {
            headSha: "deadbeef",
            conclusion: "success",
          },
        },
      },
      autoReviewSourceSubstate: "applying_review_feedback",
    },
  });

  assert.equal(run.prefetchContext?.workItem.id, "work-item-2");
  assert.equal(run.prefetchContext?.github?.pr.number, 99);
  assert.equal(run.autoReviewSourceSubstate, "applying_review_feedback");
});

test("pipeline runner uploads run.log artifact when a target is provided", async (t) => {
  const originalPollMs = process.env.RUNNER_CANCELLATION_POLL_MS;
  process.env.RUNNER_CANCELLATION_POLL_MS = "5";
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pipeline-runner-artifact-"));
  const logsPath = path.join(tmpDir, "run.log");
  await writeFile(logsPath, "runner log body\n", "utf8");
  t.after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    if (originalPollMs === undefined) {
      delete process.env.RUNNER_CANCELLATION_POLL_MS;
    } else {
      process.env.RUNNER_CANCELLATION_POLL_MS = originalPollMs;
    }
  });

  const uploaded: Array<{ uploadUrl: string; body: string; contentType: string }> = [];

  await runPipelineRunner(
    {
      getPayload: async () => samplePayload,
      appendEvent: async () => undefined,
      complete: async () => undefined,
      getCancellation: async () => ({ cancelRequested: false }),
      getArtifacts: async () => ({
        targets: {
          log: {
            class: "raw_run_log",
            path: "/tmp/server/run.log",
            uploadUrl: "https://control-plane.example/internal/runs/run-pipeline-runner-1/artifacts/run.log",
          },
        },
      }),
      uploadArtifact: async (uploadUrl: string, body: Buffer, contentType: string) => {
        uploaded.push({ uploadUrl, body: body.toString("utf8"), contentType });
      },
    } as never,
    async () => ({
      branchName: "goose/test",
      logsPath,
      commitSha: "abc123",
      changedFiles: ["src/index.ts"],
    }),
  );

  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0]?.uploadUrl, "https://control-plane.example/internal/runs/run-pipeline-runner-1/artifacts/run.log");
  assert.equal(uploaded[0]?.body, "runner log body\n");
  assert.equal(uploaded[0]?.contentType, "text/plain");
});

test("pipeline runner uploads debug artifacts and includes them in failed completion payload", async (t) => {
  const originalPollMs = process.env.RUNNER_CANCELLATION_POLL_MS;
  const originalWorkRoot = process.env.WORK_ROOT;
  process.env.RUNNER_CANCELLATION_POLL_MS = "5";
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pipeline-runner-failed-artifacts-"));
  const runDir = path.join(tmpDir, samplePayload.runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "run.log"), "runner log body\n", "utf8");
  await writeFile(path.join(runDir, "agent-stdout.log"), "stdout marker\n", "utf8");
  await writeFile(path.join(runDir, "agent-stderr.log"), "stderr marker\n", "utf8");
  await writeFile(path.join(runDir, "auto-review-summary.json"), "{\"selectedFindings\":[]}\n", "utf8");
  process.env.WORK_ROOT = tmpDir;

  const uploaded: Array<{ uploadUrl: string; body: string; contentType: string }> = [];
  const completions: RunnerCompletionPayload[] = [];

  t.after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    if (originalPollMs === undefined) {
      delete process.env.RUNNER_CANCELLATION_POLL_MS;
    } else {
      process.env.RUNNER_CANCELLATION_POLL_MS = originalPollMs;
    }
    if (originalWorkRoot === undefined) {
      delete process.env.WORK_ROOT;
    } else {
      process.env.WORK_ROOT = originalWorkRoot;
    }
  });

  await assert.rejects(
    () => runPipelineRunner(
      {
        getPayload: async () => samplePayload,
        appendEvent: async () => undefined,
        complete: async (payload: RunnerCompletionPayload) => {
          completions.push(payload);
        },
        getCancellation: async () => ({ cancelRequested: false }),
        getArtifacts: async () => ({
          targets: {
            log: {
              class: "raw_run_log",
              path: "/tmp/server/run.log",
              uploadUrl: "https://control-plane.example/internal/runs/run-pipeline-runner-1/artifacts/run.log",
            },
            "agent-stdout.log": {
              class: "debug_log",
              path: "/tmp/server/agent-stdout.log",
              uploadUrl: "https://control-plane.example/internal/runs/run-pipeline-runner-1/artifacts/agent-stdout.log",
            },
            "agent-stderr.log": {
              class: "debug_log",
              path: "/tmp/server/agent-stderr.log",
              uploadUrl: "https://control-plane.example/internal/runs/run-pipeline-runner-1/artifacts/agent-stderr.log",
            },
            "auto-review-summary.json": {
              class: "internal_artifact",
              path: "/tmp/server/auto-review-summary.json",
              uploadUrl: "https://control-plane.example/internal/runs/run-pipeline-runner-1/artifacts/auto-review-summary.json",
            },
          },
        }),
        uploadArtifact: async (uploadUrl: string, body: Buffer, contentType: string) => {
          uploaded.push({ uploadUrl, body: body.toString("utf8"), contentType });
        },
      } as never,
      async () => {
        throw new Error("pipeline failed");
      },
    ),
    /pipeline failed/,
  );

  assert.equal(uploaded.length, 4);
  assert.deepEqual(
    uploaded.map((entry) => entry.uploadUrl).sort(),
    [
      "https://control-plane.example/internal/runs/run-pipeline-runner-1/artifacts/agent-stderr.log",
      "https://control-plane.example/internal/runs/run-pipeline-runner-1/artifacts/agent-stdout.log",
      "https://control-plane.example/internal/runs/run-pipeline-runner-1/artifacts/auto-review-summary.json",
      "https://control-plane.example/internal/runs/run-pipeline-runner-1/artifacts/run.log",
    ],
  );
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.status, "failed");
  assert.deepEqual(completions[0]?.internalArtifacts, [
    "agent-stdout.log",
    "agent-stderr.log",
    "auto-review-summary.json",
  ]);
});
