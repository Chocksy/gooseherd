import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("dashboard server lazy-loads eval scenario loader", async () => {
  const dashboardServerSource = await readFile(path.join(repoRoot, "src/dashboard-server.ts"), "utf8");
  const featureRoutesSource = await readFile(path.join(repoRoot, "src/dashboard/routes/feature-routes.ts"), "utf8");

  assert.ok(
    !dashboardServerSource.includes("scenario-loader"),
    "Expected dashboard-server to stay decoupled from the eval scenario loader implementation",
  );
  assert.ok(
    !featureRoutesSource.includes('import { loadScenariosFromDir } from "../../eval/scenario-loader.js";'),
    "Expected feature-routes to avoid top-level runtime import of eval scenario loader",
  );
  assert.ok(
    featureRoutesSource.includes('await import("../../eval/scenario-loader.js")'),
    "Expected feature-routes to lazy-load eval scenario loader inside the eval route",
  );
});
