import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb } from "./test-db.js";

test("createTestDb cleanup silences postgres schema drop notices", async (t) => {
  const logMock = t.mock.method(console, "log", () => undefined);
  const { cleanup } = await createTestDb();

  await cleanup();

  assert.equal(logMock.mock.calls.length, 0);
});
