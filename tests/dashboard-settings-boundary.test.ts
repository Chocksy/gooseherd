import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("dashboard settings payload is built through dedicated boundary helpers", async () => {
  const serverPath = path.resolve(import.meta.dirname, "../src/dashboard-server.ts");
  const settingsRoutesPath = path.resolve(import.meta.dirname, "../src/dashboard/routes/settings-routes.ts");
  const serverSource = await readFile(serverPath, "utf8");
  const settingsRoutesSource = await readFile(settingsRoutesPath, "utf8");

  assert.match(serverSource, /from "\.\/dashboard\/routes\/settings-routes\.js"/);
  assert.match(settingsRoutesSource, /from "\.\.\/capabilities\.js"/);
  assert.match(settingsRoutesSource, /from "\.\.\/settings-payload\.js"/);
  assert.match(settingsRoutesSource, /buildDashboardSettingsPayload\(/);
  assert.doesNotMatch(settingsRoutesSource, /features:\s*\{\s*observer:\s*config\.observerEnabled/s);
});
