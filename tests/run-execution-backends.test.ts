import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalExecutionBackend } from "../src/runtime/local-backend.js";
import { DockerExecutionBackend } from "../src/runtime/docker-backend.js";
import type { PipelineEngine, PipelinePhase } from "../src/pipeline/pipeline-engine.js";
import type { ExecutionResult, RunRecord } from "../src/types.js";

type PipelineCall = {
  run: RunRecord;
  onPhase: (phase: PipelinePhase) => Promise<void>;
  pipelineFile?: string;
  onDetail?: (detail: string) => Promise<void>;
  skipNodes?: string[];
  enableNodes?: string[];
  abortSignal?: AbortSignal;
};

const mockPipelineCalls: PipelineCall[] = [];

const mockPipelineEngine: Pick<PipelineEngine, "execute"> = {
  execute: async (
    run: RunRecord,
    onPhase: (phase: PipelinePhase) => Promise<void>,
    pipelineFile?: string,
    onDetail?: (detail: string) => Promise<void>,
    skipNodes?: string[],
    enableNodes?: string[],
    abortSignal?: AbortSignal
  ): Promise<ExecutionResult> => {
    mockPipelineCalls.push({ run, onPhase, pipelineFile, onDetail, skipNodes, enableNodes, abortSignal });
    return {
      branchName: run.branchName,
      logsPath: "/tmp/run.log",
      commitSha: "abc123",
      changedFiles: []
    };
  }
};

function makeRun(runtime: RunRecord["runtime"]): RunRecord {
  return {
    id: "run-1",
    runtime,
    status: "running",
    phase: "agent",
    repoSlug: "org/repo",
    task: "test",
    baseBranch: "main",
    branchName: "test/branch",
    requestedBy: "U_TEST",
    channelId: "C_TEST",
    threadTs: "123.456",
    createdAt: new Date().toISOString(),
    skipNodes: ["lint_fix"],
    enableNodes: ["browser_verify"]
  };
}

const mockContext = {
  onPhase: async (_phase: PipelinePhase) => {},
  onDetail: async (_detail: string) => {},
  abortSignal: new AbortController().signal,
  pipelineFile: "pipelines/runtime-test.yml"
};

test("local backend executes pipeline without sandbox creation", async () => {
  mockPipelineCalls.length = 0;
  const backend = new LocalExecutionBackend(mockPipelineEngine as PipelineEngine);
  const run = makeRun("local");
  await backend.execute(run, mockContext);
  assert.equal(mockPipelineCalls[0]?.run, run);
  assert.equal(mockPipelineCalls[0]?.run.runtime, "local");
  assert.equal(mockPipelineCalls[0]?.onPhase, mockContext.onPhase);
  assert.equal(mockPipelineCalls[0]?.onDetail, mockContext.onDetail);
  assert.equal(mockPipelineCalls[0]?.pipelineFile, mockContext.pipelineFile);
  assert.deepEqual(mockPipelineCalls[0]?.skipNodes, run.skipNodes);
  assert.deepEqual(mockPipelineCalls[0]?.enableNodes, run.enableNodes);
  assert.equal(mockPipelineCalls[0]?.abortSignal, mockContext.abortSignal);
});

test("docker backend requires sandbox-capable pipeline wiring", async () => {
  mockPipelineCalls.length = 0;
  const backend = new DockerExecutionBackend(mockPipelineEngine as PipelineEngine);
  const run = makeRun("docker");
  await backend.execute(run, mockContext);
  assert.equal(mockPipelineCalls[0]?.run, run);
  assert.equal(mockPipelineCalls[0]?.run.runtime, "docker");
  assert.equal(mockPipelineCalls[0]?.onPhase, mockContext.onPhase);
  assert.equal(mockPipelineCalls[0]?.onDetail, mockContext.onDetail);
  assert.equal(mockPipelineCalls[0]?.pipelineFile, mockContext.pipelineFile);
  assert.deepEqual(mockPipelineCalls[0]?.skipNodes, run.skipNodes);
  assert.deepEqual(mockPipelineCalls[0]?.enableNodes, run.enableNodes);
  assert.equal(mockPipelineCalls[0]?.abortSignal, mockContext.abortSignal);
});
