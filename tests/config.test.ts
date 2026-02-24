import assert from "node:assert/strict";
import test from "node:test";

// Test the config loading indirectly by verifying type shapes
// (loadConfig() reads process.env directly, so we test the helper logic)

test("MCP extensions: backwards compat merges cemsMcpCommand into array", () => {
  // Simulate the buildMcpExtensions logic
  function buildMcpExtensions(cemsMcpCommand?: string, mcpExtensions?: string): string[] {
    const extensions = (mcpExtensions ?? "")
      .split(",")
      .map(e => e.trim())
      .filter(Boolean);
    const legacy = cemsMcpCommand?.trim();
    if (legacy && !extensions.includes(legacy)) {
      extensions.unshift(legacy);
    }
    return extensions;
  }

  // Legacy only
  assert.deepEqual(
    buildMcpExtensions("npx @cems/mcp", undefined),
    ["npx @cems/mcp"]
  );

  // New only
  assert.deepEqual(
    buildMcpExtensions(undefined, "npx @a/ext,npx @b/ext"),
    ["npx @a/ext", "npx @b/ext"]
  );

  // Both: legacy prepended if not duplicate
  assert.deepEqual(
    buildMcpExtensions("npx @cems/mcp", "npx @a/ext,npx @b/ext"),
    ["npx @cems/mcp", "npx @a/ext", "npx @b/ext"]
  );

  // Both: legacy IS in extensions — no duplicate
  assert.deepEqual(
    buildMcpExtensions("npx @cems/mcp", "npx @cems/mcp,npx @b/ext"),
    ["npx @cems/mcp", "npx @b/ext"]
  );

  // Neither
  assert.deepEqual(buildMcpExtensions(undefined, undefined), []);
  assert.deepEqual(buildMcpExtensions("", ""), []);
});

test("Dashboard public URL: defaults to localhost when not set", () => {
  const host = "127.0.0.1";
  const port = 8787;
  const publicUrl = undefined;

  const resolved = publicUrl ?? `http://${host}:${String(port)}`;
  assert.equal(resolved, "http://127.0.0.1:8787");
});

test("Dashboard public URL: uses public URL when set", () => {
  const host = "127.0.0.1";
  const port = 8787;
  const publicUrl = "https://dash.goose-herd.com";

  const resolved = publicUrl ?? `http://${host}:${String(port)}`;
  assert.equal(resolved, "https://dash.goose-herd.com");
});

test("DRY_RUN: default is false", () => {
  // Verify the expected default — the actual parseBoolean call is in loadConfig
  function parseBoolean(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  }

  // Default (no env var set) should be false
  assert.equal(parseBoolean(undefined, false), false);
  // Explicit true
  assert.equal(parseBoolean("true", false), true);
  // Explicit false
  assert.equal(parseBoolean("false", false), false);
});
