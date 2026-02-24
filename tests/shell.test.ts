import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { shellEscape, renderTemplate, sanitizeForLogs, runShellCapture, buildMcpFlags } from "../src/pipeline/shell.js";

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
