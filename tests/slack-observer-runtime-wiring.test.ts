import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("slack app does not import the Slack alert adapter from observer sources", async () => {
  const slackAppPath = path.resolve(import.meta.dirname, "../src/slack-app.ts");
  const source = await readFile(slackAppPath, "utf8");

  assert.doesNotMatch(source, /from "\.\/observer\/sources\/slack-channel-adapter\.js";/);
  assert.match(source, /from "\.\/slack-alert-adapter\.js";/);
});

test("plugin bootstrap does not import webhook adapter registry from observer sources", async () => {
  const pluginLoaderPath = path.resolve(import.meta.dirname, "../src/plugins/plugin-loader.ts");
  const pluginTypesPath = path.resolve(import.meta.dirname, "../src/plugins/plugin-types.ts");
  const pluginLoaderSource = await readFile(pluginLoaderPath, "utf8");
  const pluginTypesSource = await readFile(pluginTypesPath, "utf8");

  assert.doesNotMatch(pluginLoaderSource, /from "\.\.\/observer\/sources\/adapter-registry\.js";/);
  assert.match(pluginLoaderSource, /from "\.\.\/webhook-adapter-registry\.js";/);

  assert.doesNotMatch(pluginTypesSource, /from "\.\.\/observer\/sources\/adapter-registry\.js";/);
  assert.match(pluginTypesSource, /from "\.\.\/webhook-adapter-registry\.js";/);
});

test("service bootstrap does not top-level import observer learning store", async () => {
  const indexPath = path.resolve(import.meta.dirname, "../src/index.ts");
  const source = await readFile(indexPath, "utf8");

  assert.doesNotMatch(source, /import \{ LearningStore \} from "\.\/observer\/learning-store\.js";/);
  assert.match(source, /import type \{ LearningStore \} from "\.\/observer\/learning-store\.js";/);
  assert.match(source, /await import\("\.\/observer\/learning-store\.js"\)/);
});
