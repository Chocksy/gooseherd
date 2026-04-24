import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { loadPipeline } from "../src/pipeline/pipeline-loader.js";

const expectedCommonNodes = [
  { id: "clone", type: "deterministic", action: "clone" },
  { id: "setup_sandbox", type: "deterministic", action: "setup_sandbox" },
  { id: "classify_task", type: "deterministic", action: "classify_task" },
  { id: "hydrate", type: "deterministic", action: "hydrate_context" },
  { id: "implement", type: "agentic", action: "implement" },
  { id: "lint_fix", type: "deterministic", action: "lint_fix" },
  { id: "validate", type: "deterministic", action: "validate" },
  { id: "local_test", type: "deterministic", action: "local_test" },
  { id: "lightweight_checks", type: "deterministic", action: "lightweight_checks" },
  { id: "diff_gate", type: "conditional", action: "diff_gate" },
  { id: "forbidden_files", type: "conditional", action: "forbidden_files" },
  { id: "security_scan", type: "deterministic", action: "security_scan" },
  { id: "commit", type: "deterministic", action: "commit" },
  { id: "push", type: "deterministic", action: "push" },
  { id: "create_pr", type: "deterministic", action: "create_pr" },
  { id: "wait_ci", type: "async", action: "wait_ci" },
  { id: "notify", type: "deterministic", action: "notify" },
];

test("feature-delivery self-review pipeline is explicit", async () => {
  const pipeline = await loadPipeline(path.resolve("pipelines/feature-delivery-self-review.yml"));

  assert.equal(pipeline.name, "feature-delivery-self-review");
  assert.deepEqual(
    pipeline.nodes.map((node) => ({ id: node.id, type: node.type, action: node.action })),
    expectedCommonNodes,
  );
  for (const node of pipeline.nodes) {
    assert.equal(Boolean(node.on_failure && "until" in node.on_failure), false);
  }
});

test("feature-delivery review-feedback pipeline is explicit", async () => {
  const pipeline = await loadPipeline(path.resolve("pipelines/feature-delivery-review-feedback.yml"));

  assert.equal(pipeline.name, "feature-delivery-review-feedback");
  assert.deepEqual(
    pipeline.nodes.map((node) => ({ id: node.id, type: node.type, action: node.action })),
    expectedCommonNodes,
  );
  for (const node of pipeline.nodes) {
    assert.equal(Boolean(node.on_failure && "until" in node.on_failure), false);
  }
});
