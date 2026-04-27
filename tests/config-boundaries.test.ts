import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("config facade delegates parsing to slice modules", async () => {
  const configPath = path.resolve(import.meta.dirname, "../src/config.ts");
  const facadeSource = await readFile(configPath, "utf8");

  assert.match(facadeSource, /from "\.\/config\/shared\.js"/);
  assert.match(facadeSource, /from "\.\/config\/core\.js"/);
  assert.match(facadeSource, /from "\.\/config\/integrations\.js"/);
  assert.match(facadeSource, /from "\.\/config\/dashboard\.js"/);
  assert.match(facadeSource, /from "\.\/config\/features\.js"/);
  assert.match(facadeSource, /from "\.\/config\/runtime\.js"/);

  assert.doesNotMatch(facadeSource, /const envSchema = z\.object/);
  assert.doesNotMatch(facadeSource, /function parseList\(/);
  assert.doesNotMatch(facadeSource, /function parseBoolean\(/);
  assert.doesNotMatch(facadeSource, /function parseInteger\(/);
  assert.doesNotMatch(facadeSource, /function parseRepoMap\(/);
  assert.doesNotMatch(facadeSource, /function parseWebhookSecrets\(/);
  assert.doesNotMatch(facadeSource, /function parseProviderPreferences\(/);

  assert.match(facadeSource, /const features = loadFeatureFlags\(parsed\)/);
  assert.match(facadeSource, /const coreConfig = loadCoreConfig\(parsed,\s*\{\s*appName,\s*appSlug\s*\}\)/s);
  assert.match(facadeSource, /const integrationConfig = loadIntegrationConfig\(parsed,\s*\{\s*appSlug\s*\}\)/s);
  assert.match(facadeSource, /const dashboardConfig = loadDashboardConfig\(parsed\)/);
  assert.match(facadeSource, /const featureConfig = loadFeatureConfig\(parsed,\s*features\)/);
  assert.match(facadeSource, /const runtimeConfig = loadRuntimeConfig\(parsed,\s*features\)/);
});
