import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendLog, flushRunLogMirror, shellEscape, renderTemplate, sanitizeForLogs, runShellCapture, buildMcpFlags } from "../src/pipeline/shell.js";

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  return {
    lines,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

async function makeRunLogFile(t: { after: (fn: () => Promise<void> | void) => void }, runId: string): Promise<string> {
  const workRoot = await mkdtemp(path.join(os.tmpdir(), "run-log-mirror-"));
  const runDir = path.join(workRoot, runId);
  await mkdir(runDir, { recursive: true });
  const logFile = path.join(runDir, "run.log");
  t.after(async () => { await rm(workRoot, { recursive: true, force: true }); });
  return logFile;
}

// ── shellEscape ──

test("shellEscape: wraps simple string in single quotes", () => {
  assert.equal(shellEscape("hello"), "'hello'");
});

test("shellEscape: escapes single quotes inside string", () => {
  assert.equal(shellEscape("it's"), "'it'\"'\"'s'");
});

test("shellEscape: wraps empty string", () => {
  assert.equal(shellEscape(""), "''");
});

test("shellEscape: preserves spaces inside quotes", () => {
  assert.equal(shellEscape("hello world"), "'hello world'");
});

test("shellEscape: neutralizes shell metacharacters", () => {
  const dangerous = "$HOME && rm -rf /";
  const escaped = shellEscape(dangerous);
  assert.equal(escaped, `'${dangerous}'`);
});

test("shellEscape: handles multiple single quotes", () => {
  const result = shellEscape("'a'b'");
  // Should be parseable by bash — each ' breaks out and re-enters
  assert.ok(result.startsWith("'"));
  assert.ok(result.endsWith("'"));
});

// ── renderTemplate ──

test("renderTemplate: replaces single placeholder with shell-escaped value", () => {
  const result = renderTemplate("goose run {{repo_dir}}", { repo_dir: "/tmp/repo" });
  assert.equal(result, "goose run '/tmp/repo'");
});

test("renderTemplate: replaces multiple placeholders", () => {
  const result = renderTemplate("{{repo_dir}} {{prompt_file}}", {
    repo_dir: "/tmp/repo",
    prompt_file: "/tmp/task.md"
  });
  assert.equal(result, "'/tmp/repo' '/tmp/task.md'");
});

test("renderTemplate: leaves unknown placeholders intact", () => {
  const result = renderTemplate("{{unknown}}", {});
  assert.equal(result, "{{unknown}}");
});

test("renderTemplate: replaces all occurrences of same placeholder", () => {
  const result = renderTemplate("{{x}} and {{x}}", { x: "a" });
  assert.equal(result, "'a' and 'a'");
});

test("renderTemplate: empty template returns empty string", () => {
  assert.equal(renderTemplate("", { x: "a" }), "");
});

// ── sanitizeForLogs ──

test("sanitizeForLogs: redacts x-access-token", () => {
  const input = "https://x-access-token:ghp_abc123XYZ@github.com/repo.git";
  const result = sanitizeForLogs(input);
  assert.match(result, /x-access-token:\*\*\*@/);
  assert.ok(!result.includes("ghp_abc123XYZ"));
});

test("sanitizeForLogs: redacts GitHub PAT (ghp_)", () => {
  const result = sanitizeForLogs("token=ghp_ABCdef123456789012345678901234567890"); // gitleaks:allow (fake test token)
  assert.match(result, /\*\*\*/);
  assert.ok(!result.includes("ghp_ABCdef"));
});

test("sanitizeForLogs: redacts GitHub OAuth token (gho_)", () => {
  const result = sanitizeForLogs("header: gho_ABCdef123");
  assert.ok(!result.includes("gho_ABCdef123"));
});

test("sanitizeForLogs: passes clean input unchanged", () => {
  const input = "normal log output without secrets";
  assert.equal(sanitizeForLogs(input), input);
});

test("sanitizeForLogs: redacts multiple tokens in same line", () => {
  const input = "first ghp_aaa111 second ghp_bbb222";
  const result = sanitizeForLogs(input);
  assert.ok(!result.includes("ghp_aaa111"));
  assert.ok(!result.includes("ghp_bbb222"));
});

// ── runShellCapture ──

test("runShellCapture: captures stdout", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shell-test-"));
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const result = await runShellCapture("echo hello", { logFile });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /hello/);
});

test("runShellCapture: captures stderr", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shell-test-"));
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const result = await runShellCapture("echo error >&2", { logFile });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /error/);
});

test("runShellCapture: returns non-zero exit code", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shell-test-"));
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const result = await runShellCapture("exit 42", { logFile });
  assert.equal(result.code, 42);
});

test("runShellCapture: timeout kills long-running process", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shell-test-"));
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const start = Date.now();
  const result = await runShellCapture("sleep 60", { logFile, timeoutMs: 200 });
  const elapsed = Date.now() - start;

  assert.notEqual(result.code, 0);
  assert.ok(elapsed < 10000, `Should complete quickly after timeout, took ${String(elapsed)}ms`);
});

test("runShellCapture: no timeout when timeoutMs is undefined", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shell-test-"));
  const logFile = path.join(dir, "test.log");
  await writeFile(logFile, "", "utf8");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const result = await runShellCapture("echo fast", { logFile });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /fast/);
});

// ── buildMcpFlags ──

test("buildMcpFlags: returns empty string for empty array", () => {
  assert.equal(buildMcpFlags([]), "");
});

test("buildMcpFlags: single extension", () => {
  assert.equal(buildMcpFlags(["npx @cems/mcp"]), "--with-extension 'npx @cems/mcp'");
});

test("buildMcpFlags: multiple extensions", () => {
  const result = buildMcpFlags(["npx @cems/mcp", "npx @other/ext"]);
  assert.equal(result, "--with-extension 'npx @cems/mcp' --with-extension 'npx @other/ext'");
});

test("buildMcpFlags: filters empty strings", () => {
  const result = buildMcpFlags(["npx @cems/mcp", "", "  ", "npx @other/ext"]);
  assert.equal(result, "--with-extension 'npx @cems/mcp' --with-extension 'npx @other/ext'");
});

// ── appendLog stdout mirror ──

test("appendLog: does NOT mirror to stdout when RUN_LOG_MIRROR_STDOUT is unset", async (t) => {
  const runId = "run-mirror-off";
  const logFile = await makeRunLogFile(t, runId);
  const previous = process.env.RUN_LOG_MIRROR_STDOUT;
  delete process.env.RUN_LOG_MIRROR_STDOUT;
  t.after(() => {
    if (previous === undefined) delete process.env.RUN_LOG_MIRROR_STDOUT;
    else process.env.RUN_LOG_MIRROR_STDOUT = previous;
    flushRunLogMirror(runId);
  });

  const captured = captureStdout();
  try {
    await appendLog(logFile, "secret line\n");
  } finally {
    captured.restore();
  }
  assert.equal(captured.lines.join(""), "");
  assert.equal(await readFile(logFile, "utf8"), "secret line\n");
});

test("appendLog: mirrors complete lines with [run:<id>] prefix when flag is on", async (t) => {
  const runId = "run-mirror-on";
  const logFile = await makeRunLogFile(t, runId);
  const previous = process.env.RUN_LOG_MIRROR_STDOUT;
  process.env.RUN_LOG_MIRROR_STDOUT = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.RUN_LOG_MIRROR_STDOUT;
    else process.env.RUN_LOG_MIRROR_STDOUT = previous;
    flushRunLogMirror(runId);
  });

  const captured = captureStdout();
  try {
    await appendLog(logFile, "first line\nsecond line\n");
  } finally {
    captured.restore();
  }

  assert.deepEqual(captured.lines, [
    `[run:${runId}] first line\n`,
    `[run:${runId}] second line\n`,
  ]);
});

test("appendLog: buffers partial line until newline arrives", async (t) => {
  const runId = "run-mirror-partial";
  const logFile = await makeRunLogFile(t, runId);
  const previous = process.env.RUN_LOG_MIRROR_STDOUT;
  process.env.RUN_LOG_MIRROR_STDOUT = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.RUN_LOG_MIRROR_STDOUT;
    else process.env.RUN_LOG_MIRROR_STDOUT = previous;
    flushRunLogMirror(runId);
  });

  const captured = captureStdout();
  try {
    await appendLog(logFile, "hello ");
    assert.equal(captured.lines.length, 0, "no emit until newline");
    await appendLog(logFile, "world\nnext ");
    assert.deepEqual(captured.lines, [`[run:${runId}] hello world\n`]);
    flushRunLogMirror(runId);
    assert.deepEqual(captured.lines, [
      `[run:${runId}] hello world\n`,
      `[run:${runId}] next \n`,
    ]);
  } finally {
    captured.restore();
  }
});

test("appendLog: sanitizes secrets in the mirrored stream", async (t) => {
  const runId = "run-mirror-sanitize";
  const logFile = await makeRunLogFile(t, runId);
  const previous = process.env.RUN_LOG_MIRROR_STDOUT;
  process.env.RUN_LOG_MIRROR_STDOUT = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.RUN_LOG_MIRROR_STDOUT;
    else process.env.RUN_LOG_MIRROR_STDOUT = previous;
    flushRunLogMirror(runId);
  });

  const captured = captureStdout();
  try {
    await appendLog(logFile, "token=ghp_ABCdef123456789012345678901234567890\n");
  } finally {
    captured.restore();
  }

  const emitted = captured.lines.join("");
  assert.match(emitted, new RegExp(`^\\[run:${runId}\\] `));
  assert.ok(!emitted.includes("ghp_ABCdef"), `mirrored output must not contain raw token, got: ${emitted}`);
  // Raw on-disk log preserves content verbatim — sanitization is mirror-only.
  assert.match(await readFile(logFile, "utf8"), /ghp_ABCdef/);
});

test("appendLog: keeps separate buffers for concurrent runs", async (t) => {
  const runIdA = "run-mirror-A";
  const runIdB = "run-mirror-B";
  const logFileA = await makeRunLogFile(t, runIdA);
  const logFileB = await makeRunLogFile(t, runIdB);
  const previous = process.env.RUN_LOG_MIRROR_STDOUT;
  process.env.RUN_LOG_MIRROR_STDOUT = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.RUN_LOG_MIRROR_STDOUT;
    else process.env.RUN_LOG_MIRROR_STDOUT = previous;
    flushRunLogMirror(runIdA);
    flushRunLogMirror(runIdB);
  });

  const captured = captureStdout();
  try {
    await appendLog(logFileA, "alpha-");
    await appendLog(logFileB, "beta-");
    await appendLog(logFileA, "one\n");
    await appendLog(logFileB, "two\n");
  } finally {
    captured.restore();
  }

  assert.deepEqual(captured.lines, [
    `[run:${runIdA}] alpha-one\n`,
    `[run:${runIdB}] beta-two\n`,
  ]);
});
