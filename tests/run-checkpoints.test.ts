import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRunCheckpointEmittedAt } from "../src/runs/run-checkpoints.js";

test("normalizeRunCheckpointEmittedAt keeps valid timestamps", () => {
  assert.equal(
    normalizeRunCheckpointEmittedAt("2026-04-24T00:00:00.000Z"),
    "2026-04-24T00:00:00.000Z",
  );
});

test("normalizeRunCheckpointEmittedAt falls back when primary timestamp is invalid", () => {
  assert.equal(
    normalizeRunCheckpointEmittedAt("not-a-date", "2026-04-24T00:00:00.000Z"),
    "2026-04-24T00:00:00.000Z",
  );
});

test("normalizeRunCheckpointEmittedAt returns undefined when all timestamps are invalid", () => {
  assert.equal(normalizeRunCheckpointEmittedAt("not-a-date", "also-not-a-date"), undefined);
});
