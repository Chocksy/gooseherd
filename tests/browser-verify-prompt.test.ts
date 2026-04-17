import assert from "node:assert/strict";
import test from "node:test";
import { buildVerifyPrompt } from "../src/pipeline/quality-gates/browser-verify.js";

test("buildVerifyPrompt: filters internal-generated files from changed files", () => {
  const prompt = buildVerifyPrompt("Verify the homepage update", ["AGENTS.md", "app/views/home/index.html.erb"]);

  assert.ok(prompt.includes("app/views/home/index.html.erb"));
  assert.ok(!prompt.includes("AGENTS.md"));
});
