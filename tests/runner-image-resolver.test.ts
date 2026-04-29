import assert from "node:assert/strict";
import test from "node:test";
import { resolveRunnerImage } from "../src/runtime/runner-image-resolver.js";

const DEFAULT_IMAGE = "gooseherd/k8s-runner:dev";

test("resolveRunnerImage returns default for unmapped repo", () => {
  const originalEnv = process.env;
  try {
    process.env = { ...originalEnv, KUBERNETES_RUNNER_IMAGE_SERVER: "registry.example.com/runner-server:abc123" };
    assert.equal(resolveRunnerImage("Some/other-repo", DEFAULT_IMAGE), DEFAULT_IMAGE);
  } finally {
    process.env = originalEnv;
  }
});

test("resolveRunnerImage returns repo-specific image when env override is set", () => {
  const originalEnv = process.env;
  try {
    process.env = { ...originalEnv, KUBERNETES_RUNNER_IMAGE_SERVER: " registry.example.com/runner-server:abc123 " };
    assert.equal(
      resolveRunnerImage("NetsoftHoldings/hubstaff-server", DEFAULT_IMAGE),
      "registry.example.com/runner-server:abc123",
    );
  } finally {
    process.env = originalEnv;
  }
});

test("resolveRunnerImage falls back to default when override env is empty", () => {
  const originalEnv = process.env;
  try {
    process.env = { ...originalEnv, KUBERNETES_RUNNER_IMAGE_SERVER: "   " };
    assert.equal(resolveRunnerImage("NetsoftHoldings/hubstaff-server", DEFAULT_IMAGE), DEFAULT_IMAGE);
  } finally {
    process.env = originalEnv;
  }
});

test("resolveRunnerImage falls back to default when override env is unset", () => {
  const originalEnv = process.env;
  try {
    const next = { ...originalEnv };
    delete next.KUBERNETES_RUNNER_IMAGE_SERVER;
    process.env = next;
    assert.equal(resolveRunnerImage("NetsoftHoldings/hubstaff-server", DEFAULT_IMAGE), DEFAULT_IMAGE);
  } finally {
    process.env = originalEnv;
  }
});
