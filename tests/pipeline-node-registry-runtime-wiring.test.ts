import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("pipeline node registry lazy-loads browser verify and CI handlers", async () => {
  const source = await readFile(path.join(repoRoot, "src/pipeline/node-registry.ts"), "utf8");

  const forbiddenImports = [
    "./quality-gates/browser-verify-node.js",
    "./nodes/deploy-preview.js",
    "./ci/wait-ci-node.js",
    "./ci/fix-ci-node.js",
    "./nodes/fix-browser.js",
    "./nodes/upload-screenshot.js",
    "./nodes/decide-next-step.js",
  ];

  for (const modulePath of forbiddenImports) {
    assert.ok(
      !source.includes(`from "${modulePath}"`),
      `Expected node-registry to avoid static import for ${modulePath}`,
    );
    assert.ok(
      source.includes(`lazyNodeHandler("${modulePath}"`),
      `Expected node-registry to register ${modulePath} through lazyNodeHandler(...)`,
    );
  }
});
