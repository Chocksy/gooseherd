import assert from "node:assert/strict";
import test from "node:test";
import { provisionRunnerDb, teardownRunnerDb } from "../src/runtime/runner-db-resources.js";
import { resolveRunnerProfile } from "../src/runtime/runner-profile.js";

test("provisionRunnerDb: no-op when profile does not need a slot", async () => {
  const profile = resolveRunnerProfile("Some/other-repo");
  await provisionRunnerDb(7, profile, {});
});

test("teardownRunnerDb: no-op when profile does not need a slot", async () => {
  const profile = resolveRunnerProfile("Some/other-repo");
  await teardownRunnerDb(7, profile, {});
});

test("provisionRunnerDb: tolerates missing admin URLs (logs warning, no throw)", async () => {
  const profile = resolveRunnerProfile("NetsoftHoldings/hubstaff-server");
  await provisionRunnerDb(7, profile, {});
});

test("teardownRunnerDb: tolerates missing admin URLs (logs warning, no throw)", async () => {
  const profile = resolveRunnerProfile("NetsoftHoldings/hubstaff-server");
  await teardownRunnerDb(7, profile, {});
});

test("provisionRunnerDb: rejects Redis URL with unsupported scheme", async () => {
  const profile = resolveRunnerProfile("NetsoftHoldings/hubstaff-server");
  await assert.rejects(
    () => provisionRunnerDb(7, profile, { redis: "http://example.com:6379" }),
    /unsupported scheme "http:"/,
  );
});
