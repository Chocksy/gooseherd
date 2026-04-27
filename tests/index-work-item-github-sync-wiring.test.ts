import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("createWorkItemServices passes githubService into GitHubWorkItemSync", async () => {
  const indexPath = path.resolve(import.meta.dirname, "../src/index.ts");
  const indexSource = await readFile(indexPath, "utf8");

  assert.match(
    indexSource,
    /new workItemGitHubSyncMod\.GitHubWorkItemSync\(db,\s*\{[\s\S]*githubService,\s*[\s\S]*resolveDeliveryContext:/,
  );
});
