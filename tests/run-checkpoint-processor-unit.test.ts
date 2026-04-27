import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { RunCheckpointProcessor } from "../src/runs/run-checkpoint-processor.js";
import type { RunCheckpointRecord } from "../src/runs/run-checkpoints.js";

function checkpoint(key: string): RunCheckpointRecord {
  return {
    runId: "run-1",
    checkpointKey: key,
    checkpointType: "run.waiting_external_ci",
    payload: {},
    emittedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test("processUnprocessed is best-effort and reports failed checkpoints without throwing", async () => {
  const checkpoints = [checkpoint("ok"), checkpoint("fail")];
  const processedKeys: string[] = [];
  const processor = Object.create(RunCheckpointProcessor.prototype) as RunCheckpointProcessor & {
    checkpoints: { listUnprocessed: () => Promise<RunCheckpointRecord[]> };
    process: (checkpoint: RunCheckpointRecord) => Promise<void>;
  };
  processor.checkpoints = {
    listUnprocessed: async () => checkpoints,
  };
  processor.process = async (item) => {
    if (item.checkpointKey === "fail") {
      throw new Error("temporary");
    }
    processedKeys.push(item.checkpointKey);
  };

  const errorSpy = mock.method(console, "error", () => {});
  const result = await processor.processUnprocessed({ limit: 2 });

  assert.deepEqual(result, { processed: 1, failed: 1 });
  assert.deepEqual(processedKeys, ["ok"]);
  assert.equal(errorSpy.mock.callCount(), 1);
  assert.deepEqual(errorSpy.mock.calls[0]?.arguments[1], {
    runId: "run-1",
    checkpointKey: "fail",
    checkpointType: "run.waiting_external_ci",
    error: "temporary",
  });
  errorSpy.mock.restore();
});
