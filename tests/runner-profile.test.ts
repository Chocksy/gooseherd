import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDbConnectionUrl,
  resolveRunnerImage,
  resolveRunnerNodeHeapMb,
  resolveRunnerProfile,
  resolveRunnerResources,
} from "../src/runtime/runner-profile.js";

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

test("resolveRunnerProfile: hubstaff-server is db-slot enabled with envTemplate", () => {
  const profile = resolveRunnerProfile("NetsoftHoldings/hubstaff-server");
  assert.equal(profile.needsDbSlot, true);
  assert.equal(profile.imageEnv, "KUBERNETES_RUNNER_IMAGE_SERVER");
  assert.equal(profile.cpuEnv, "KUBERNETES_RUNNER_CPU_SERVER");
  assert.equal(profile.memoryEnv, "KUBERNETES_RUNNER_MEMORY_SERVER");
  assert.equal(profile.nodeHeapMbEnv, "KUBERNETES_RUNNER_NODE_HEAP_MB_SERVER");
  assert.ok(profile.envTemplate);
});

test("resolveRunnerNodeHeapMb reads heap cap from profile-specific env var", () => {
  const originalEnv = process.env;
  try {
    process.env = { ...originalEnv, KUBERNETES_RUNNER_NODE_HEAP_MB_SERVER: "1536" };
    assert.equal(resolveRunnerNodeHeapMb("NetsoftHoldings/hubstaff-server"), "1536");
  } finally {
    process.env = originalEnv;
  }
});

test("resolveRunnerNodeHeapMb trims whitespace and treats blanks as unset", () => {
  const originalEnv = process.env;
  try {
    process.env = { ...originalEnv, KUBERNETES_RUNNER_NODE_HEAP_MB_SERVER: "   " };
    assert.equal(resolveRunnerNodeHeapMb("NetsoftHoldings/hubstaff-server"), undefined);
  } finally {
    process.env = originalEnv;
  }
});

test("resolveRunnerNodeHeapMb returns undefined when env is unset", () => {
  const originalEnv = process.env;
  try {
    const next = { ...originalEnv };
    delete next.KUBERNETES_RUNNER_NODE_HEAP_MB_SERVER;
    process.env = next;
    assert.equal(resolveRunnerNodeHeapMb("NetsoftHoldings/hubstaff-server"), undefined);
  } finally {
    process.env = originalEnv;
  }
});

test("resolveRunnerNodeHeapMb returns undefined for repos without a profile", () => {
  const originalEnv = process.env;
  try {
    process.env = { ...originalEnv, KUBERNETES_RUNNER_NODE_HEAP_MB_SERVER: "1536" };
    assert.equal(resolveRunnerNodeHeapMb("Some/other-repo"), undefined);
  } finally {
    process.env = originalEnv;
  }
});

test("resolveRunnerResources reads cpu/memory from profile-specific env vars", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      KUBERNETES_RUNNER_CPU_SERVER: "2",
      KUBERNETES_RUNNER_MEMORY_SERVER: "3Gi",
    };
    assert.deepEqual(
      resolveRunnerResources("NetsoftHoldings/hubstaff-server"),
      { cpu: "2", memory: "3Gi" },
    );
  } finally {
    process.env = originalEnv;
  }
});

test("resolveRunnerResources trims whitespace and treats blanks as unset", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      KUBERNETES_RUNNER_CPU_SERVER: "  2  ",
      KUBERNETES_RUNNER_MEMORY_SERVER: "   ",
    };
    assert.deepEqual(
      resolveRunnerResources("NetsoftHoldings/hubstaff-server"),
      { cpu: "2", memory: undefined },
    );
  } finally {
    process.env = originalEnv;
  }
});

test("resolveRunnerResources returns no overrides when env vars are unset", () => {
  const originalEnv = process.env;
  try {
    const next = { ...originalEnv };
    delete next.KUBERNETES_RUNNER_CPU_SERVER;
    delete next.KUBERNETES_RUNNER_MEMORY_SERVER;
    process.env = next;
    assert.deepEqual(
      resolveRunnerResources("NetsoftHoldings/hubstaff-server"),
      { cpu: undefined, memory: undefined },
    );
  } finally {
    process.env = originalEnv;
  }
});

test("resolveRunnerResources returns no overrides for repos without a profile", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      ...originalEnv,
      KUBERNETES_RUNNER_CPU_SERVER: "2",
      KUBERNETES_RUNNER_MEMORY_SERVER: "3Gi",
    };
    assert.deepEqual(
      resolveRunnerResources("Some/other-repo"),
      { cpu: undefined, memory: undefined },
    );
  } finally {
    process.env = originalEnv;
  }
});

test("resolveRunnerProfile: unknown repo returns default profile (no slot)", () => {
  const profile = resolveRunnerProfile("Some/other-repo");
  assert.equal(profile.needsDbSlot, false);
  assert.equal(profile.envTemplate, undefined);
});

test("envTemplate: builds expected env vars for hubstaff-server", () => {
  const profile = resolveRunnerProfile("NetsoftHoldings/hubstaff-server");
  assert.ok(profile.envTemplate);
  const env = profile.envTemplate!(7, {
    pg: { protocol: "postgres:", host: "hs-pg", port: 5432, user: "hubuser", password: "p@ss" },
    clickhouse: { protocol: "http:", host: "hs-ch", port: 8123, user: "default", password: undefined },
    redis: { protocol: "redis:", host: "hs-redis", port: 6379, user: undefined, password: undefined },
  });

  assert.equal(env.DATABASE_URL, "postgres://hubuser:p%40ss@hs-pg:5432/goose_7");
  assert.equal(env.READER_DATABASE_URL, env.DATABASE_URL);
  assert.equal(env.INTERNAL_READER_DATABASE_URL, env.DATABASE_URL);
  assert.equal(env.REPORTS_READER_DATABASE_URL, env.DATABASE_URL);
  assert.equal(env.DATABASE_CLEANER_ALLOW_REMOTE_DATABASE_URL, "true");
  assert.equal(env.ENABLE_CLICKHOUSE, "1");
  assert.equal(env.CLICKHOUSE_URL, "http://default@hs-ch:8123");
  assert.equal(env.CLICKHOUSE_DATABASE, "goose_7");
  assert.equal(env.REDIS_DEFAULT_URL, "redis://hs-redis:6379/7");
  assert.equal(env.REDIS_INTERNAL_URL, "redis://hs-redis:6379/7");
});

test("parseDbConnectionUrl: parses postgres URL with creds", () => {
  const info = parseDbConnectionUrl("postgres://admin:secret@db.internal:5433/postgres", 5432);
  assert.deepEqual(info, {
    protocol: "postgres:",
    host: "db.internal",
    port: 5433,
    user: "admin",
    password: "secret",
  });
});

test("parseDbConnectionUrl: applies default port when missing", () => {
  const info = parseDbConnectionUrl("redis://redis.internal", 6379);
  assert.deepEqual(info, {
    protocol: "redis:",
    host: "redis.internal",
    port: 6379,
    user: undefined,
    password: undefined,
  });
});

test("parseDbConnectionUrl: returns null for missing or invalid URL", () => {
  assert.equal(parseDbConnectionUrl(undefined, 5432), null);
  assert.equal(parseDbConnectionUrl("", 5432), null);
  assert.equal(parseDbConnectionUrl("not a url", 5432), null);
});
