import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("createServices passes sandboxRuntime into WorkItemOrchestrator config", async () => {
  const indexPath = path.resolve(import.meta.dirname, "../src/index.ts");
  const source = await readFile(indexPath, "utf8");

  assert.match(
    source,
    /workItemOrchestrator\s*=\s*new WorkItemOrchestrator\(db,\s*\{\s*config:\s*\{\s*defaultBaseBranch:\s*config\.defaultBaseBranch,\s*sandboxRuntime:\s*config\.sandboxRuntime,\s*\},\s*runManager,\s*\}\);/s,
  );
});
