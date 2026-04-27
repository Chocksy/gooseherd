import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { loadPipeline } from "../src/pipeline/pipeline-loader.js";

test("ci-fix pipeline is defined as a standalone recovery pipeline", async () => {
  const pipeline = await loadPipeline(path.resolve("pipelines/ci-fix.yml"));

  assert.equal(pipeline.name, "ci-fix");
  assert.match(pipeline.description ?? "", /Standalone CI-fix pipeline/i);
  assert.equal(pipeline.context?.max_ci_fix_rounds, 1);
  assert.deepEqual(
    pipeline.nodes.map((node) => ({ id: node.id, type: node.type, action: node.action })),
    [
      { id: "clone", type: "deterministic", action: "clone" },
      { id: "setup_sandbox", type: "deterministic", action: "setup_sandbox" },
      { id: "classify_task", type: "deterministic", action: "classify_task" },
      { id: "hydrate", type: "deterministic", action: "hydrate_context" },
      { id: "fix_ci", type: "agentic", action: "fix_ci" },
      { id: "wait_ci", type: "async", action: "wait_ci" },
      { id: "notify", type: "deterministic", action: "notify" },
    ],
  );

  const waitCiNode = pipeline.nodes.find((node) => node.id === "wait_ci");
  assert.deepEqual(waitCiNode?.on_failure, {
    action: "loop",
    agent_node: "fix_ci",
    max_rounds: 1,
    on_exhausted: "fail_run",
  });
});
