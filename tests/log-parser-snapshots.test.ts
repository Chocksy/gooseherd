import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseRunLog, getEventStats, type RunEvent } from "../src/log-parser.js";

const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures");

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

/** Extract a minimal snapshot shape from events for stable comparison */
function snapshot(events: RunEvent[]): Array<{
  type: string;
  tool?: string;
  extension?: string;
  params?: Record<string, string>;
  result?: string;
  command?: string;
  phase?: string;
  provider?: string;
  model?: string;
  contentPreview: string;
}> {
  return events.map((e) => ({
    type: e.type,
    ...(e.tool ? { tool: e.tool } : {}),
    ...(e.extension ? { extension: e.extension } : {}),
    ...(e.params && Object.keys(e.params).length > 0 ? { params: e.params } : {}),
    ...(e.result ? { result: e.result } : {}),
    ...(e.command ? { command: e.command } : {}),
    ...(e.phase ? { phase: e.phase } : {}),
    ...(e.provider ? { provider: e.provider } : {}),
    ...(e.model ? { model: e.model } : {}),
    contentPreview: e.content.slice(0, 80),
  }));
}

// ── memory-batch.log ─────────────────────────────────────
// Tests: batched parallel memory_search calls with orphaned Annotated results,
// memory_add with inline result, and basic tool/shell interleaving.

test("memory-batch: event count and types", () => {
  const events = parseRunLog(loadFixture("memory-batch.log"));
  const stats = getEventStats(events);

  assert.ok(events.length >= 12, `Expected >= 12 events, got ${events.length}`);
  assert.ok(stats.toolCalls >= 5, `Expected >= 5 tool calls, got ${stats.toolCalls}`);
  assert.ok(stats.tools["memory_search"] === 3, `Expected 3 memory_search, got ${stats.tools["memory_search"]}`);
  assert.ok(stats.tools["memory_add"] === 1, `Expected 1 memory_add, got ${stats.tools["memory_add"]}`);
});

test("memory-batch: memory_search results extracted from orphaned Annotated blocks", () => {
  const events = parseRunLog(loadFixture("memory-batch.log"));
  const memSearchEvents = events.filter(
    (e) => e.type === "tool_call" && e.tool === "memory_search"
  );

  assert.equal(memSearchEvents.length, 3, "Should find 3 memory_search events");

  // First search: "SEO improvements for landing pages"
  const first = memSearchEvents[0]!;
  assert.equal(first.params?.query, "SEO improvements for landing pages");
  assert.equal(first.params?.project, "org/repo");
  assert.ok(first.result, "First memory_search should have a result");
  assert.ok(first.result!.includes("1 result"), `Result should mention count: ${first.result}`);
  assert.ok(first.result!.includes("Previous SEO work"), `Result should include content preview`);

  // Second search: "past mistakes corrections"
  const second = memSearchEvents[1]!;
  assert.equal(second.params?.query, "past mistakes corrections");
  assert.ok(second.result, "Second memory_search should have a result");
  assert.ok(second.result!.includes("Correction:"), `Result should include correction content`);
});

test("memory-batch: memory_add result extracted inline", () => {
  const events = parseRunLog(loadFixture("memory-batch.log"));
  const memAddEvents = events.filter(
    (e) => e.type === "tool_call" && e.tool === "memory_add"
  );

  assert.equal(memAddEvents.length, 1, "Should find 1 memory_add event");
  const addEvent = memAddEvents[0]!;
  assert.equal(addEvent.params?.content, "Completed SEO improvements on org/repo. Changed index.ts.");
  assert.equal(addEvent.result, "stored", "memory_add result should be 'stored'");
});

test("memory-batch: non-memory tool calls have no result field", () => {
  const events = parseRunLog(loadFixture("memory-batch.log"));
  const nonMemory = events.filter(
    (e) => e.type === "tool_call" && !e.tool?.startsWith("memory")
  );

  assert.ok(nonMemory.length > 0, "Should have non-memory tool calls");
  for (const ev of nonMemory) {
    assert.equal(ev.result, undefined, `${ev.tool} should not have result field`);
  }
});

test("memory-batch: shell command output preserved", () => {
  const events = parseRunLog(loadFixture("memory-batch.log"));
  const shellEvents = events.filter((e) => e.type === "tool_call" && e.tool === "shell");

  assert.ok(shellEvents.length >= 1, "Should find shell tool calls");
  const gitLog = shellEvents.find((e) => e.params?.command?.includes("git log"));
  assert.ok(gitLog, "Should find git log shell call");
  assert.ok(gitLog!.content.includes("abc1234"), "Shell output should include commit hash");
});

test("memory-batch: agent thinking captured between tool calls", () => {
  const events = parseRunLog(loadFixture("memory-batch.log"));
  const thinking = events.filter((e) => e.type === "agent_thinking");

  assert.ok(thinking.length >= 1, "Should have at least 1 thinking block");
  assert.ok(
    thinking.some((t) => t.content.includes("implement the changes")),
    "Should capture 'Now I'll implement the changes' thinking"
  );
});

test("memory-batch: phase markers detected", () => {
  const events = parseRunLog(loadFixture("memory-batch.log"));
  const phases = events.filter((e) => e.type === "phase_marker");

  const phaseNames = phases.map((p) => p.phase).filter(Boolean);
  assert.ok(phaseNames.includes("cloning"), "Should detect cloning phase");
  assert.ok(phaseNames.includes("pushing"), "Should detect pushing phase");
});

test("memory-batch: zero-result memory_search handled gracefully", () => {
  const events = parseRunLog(loadFixture("memory-batch.log"));
  const memSearchEvents = events.filter(
    (e) => e.type === "tool_call" && e.tool === "memory_search"
  );

  // Third search: "nonexistent topic with zero results"
  const third = memSearchEvents[2]!;
  assert.equal(third.params?.query, "nonexistent topic with zero results");
  assert.ok(third.result, "Zero-result search should still have a result string");
  assert.ok(third.result!.includes("0 results"), `Result should say '0 results': ${third.result}`);
});

// ── simple-run.log ───────────────────────────────────────
// Tests: basic run without memory tools — the common case.

test("simple-run: parses basic structure", () => {
  const events = parseRunLog(loadFixture("simple-run.log"));
  const stats = getEventStats(events);

  assert.ok(events.length >= 10, `Expected >= 10 events, got ${events.length}`);
  assert.ok(stats.toolCalls >= 3, `Expected >= 3 tool calls, got ${stats.toolCalls}`);
  assert.equal(stats.tools["memory_search"] ?? 0, 0, "Should have no memory_search");
});

test("simple-run: session start parsed", () => {
  const events = parseRunLog(loadFixture("simple-run.log"));
  const session = events.find((e) => e.type === "session_start");

  assert.ok(session, "Should have session_start event");
  assert.equal(session!.provider, "openrouter");
  assert.equal(session!.model, "grok-4");
});

test("simple-run: text_editor params extracted", () => {
  const events = parseRunLog(loadFixture("simple-run.log"));
  const editors = events.filter((e) => e.type === "tool_call" && e.tool === "text_editor");

  assert.ok(editors.length >= 1, "Should find text_editor calls");
  const edit = editors[0]!;
  assert.equal(edit.params?.command, "str_replace");
  assert.ok(edit.params?.old_str, "Should have old_str param");
  assert.ok(edit.params?.new_str, "Should have new_str param");
});

test("simple-run: progress percentages assigned", () => {
  const events = parseRunLog(loadFixture("simple-run.log"));
  const withProgress = events.filter((e) => e.progressPercent > 0);

  assert.ok(withProgress.length > 0, "Some events should have progress > 0");

  // Last significant event should be near 100%
  const significant = events.filter(
    (e) => e.type === "tool_call" || e.type === "agent_thinking" || e.type === "session_start"
  );
  if (significant.length > 0) {
    const last = significant[significant.length - 1]!;
    assert.equal(last.progressPercent, 100, "Last significant event should be 100%");
  }
});

test("simple-run: no result field on non-memory tools", () => {
  const events = parseRunLog(loadFixture("simple-run.log"));
  for (const ev of events) {
    if (ev.type === "tool_call" && !ev.tool?.startsWith("memory")) {
      assert.equal(ev.result, undefined, `${ev.tool} should not have result`);
    }
  }
});

// ── Snapshot stability ───────────────────────────────────
// These tests use the snapshot() helper to ensure parser output
// remains structurally stable across code changes.

test("memory-batch: snapshot shape is stable", () => {
  const events = parseRunLog(loadFixture("memory-batch.log"));
  const snap = snapshot(events);

  // Verify key structural properties
  assert.ok(snap.length >= 12, "Snapshot should have >= 12 entries");

  // First tool_call should be todo_write or memory_search
  const firstTool = snap.find((s) => s.type === "tool_call");
  assert.ok(firstTool, "Should have at least one tool call in snapshot");
  assert.ok(
    ["todo_write", "memory_search"].includes(firstTool!.tool ?? ""),
    `First tool should be todo_write or memory_search, got ${firstTool!.tool}`
  );
});

test("getEventStats matches manual count", () => {
  const events = parseRunLog(loadFixture("memory-batch.log"));
  const stats = getEventStats(events);

  const manualToolCalls = events.filter((e) => e.type === "tool_call").length;
  const manualThinking = events.filter((e) => e.type === "agent_thinking").length;

  assert.equal(stats.toolCalls, manualToolCalls, "toolCalls should match manual count");
  assert.equal(stats.thinkingBlocks, manualThinking, "thinkingBlocks should match manual count");

  const manualShell = events.filter((e) => e.type === "shell_cmd" || e.type === "phase_marker").length;
  assert.equal(stats.shellCommands, manualShell, "shellCommands should match manual count");
});
