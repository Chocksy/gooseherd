import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("dashboard server delegates route groups to dedicated route modules", async () => {
  const serverPath = path.resolve(import.meta.dirname, "../src/dashboard-server.ts");
  const source = await readFile(serverPath, "utf8");

  assert.match(source, /from "\.\/dashboard\/routes\/setup-routes\.js"/);
  assert.match(source, /from "\.\/dashboard\/routes\/auth-routes\.js"/);
  assert.match(source, /from "\.\/dashboard\/routes\/settings-routes\.js"/);
  assert.match(source, /from "\.\/dashboard\/routes\/run-routes\.js"/);
  assert.match(source, /from "\.\/dashboard\/routes\/work-item-routes\.js"/);
  assert.match(source, /from "\.\/dashboard\/routes\/feature-routes\.js"/);

  assert.match(source, /handleSetupRoutes\(/);
  assert.match(source, /handleAuthRoutes\(/);
  assert.match(source, /handleSettingsRoutes\(/);
  assert.match(source, /handleRunRoutes\(/);
  assert.match(source, /handleWorkItemRoutes\(/);
  assert.match(source, /handleFeatureRoutes\(/);

  assert.doesNotMatch(source, /pathname === "\/api\/settings"/);
  assert.doesNotMatch(source, /pathname === "\/login"/);
  assert.doesNotMatch(source, /pathname === "\/api\/runs"/);
  assert.doesNotMatch(source, /pathname === "\/api\/work-items"/);
  assert.doesNotMatch(source, /pathname === "\/api\/observer\/state"/);
});
