import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

function createChildEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
  };
}

async function runEntrypoint(args: string[], env: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}> {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  return { code, signal, stderr };
}

test("main entrypoint does not emit punycode deprecation warning in local runtime", async () => {
  const result = await runEntrypoint(
    ["--trace-deprecation", "--import", "tsx", "src/index.ts"],
    createChildEnv({
      SANDBOX_RUNTIME: "local",
      DATABASE_URL: "postgres://gooseherd:gooseherd@127.0.0.1:1/gooseherd",
    }),
  );

  assert.equal(result.signal, null);
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stderr, /\[DEP0040\]/, result.stderr);
});

test("local trigger entrypoint does not emit punycode deprecation warning in local runtime", async () => {
  const result = await runEntrypoint(
    ["--trace-deprecation", "--import", "tsx", "src/local-trigger.ts"],
    createChildEnv({
      SANDBOX_RUNTIME: "local",
    }),
  );

  assert.equal(result.signal, null);
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stderr, /\[DEP0040\]/, result.stderr);
});
