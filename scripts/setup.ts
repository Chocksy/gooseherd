#!/usr/bin/env tsx
/**
 * Interactive setup wizard for Gooseherd.
 * Guides through Slack, GitHub, Agent, and Runtime configuration.
 * Generates a .env file.
 *
 * Usage: npx tsx scripts/setup.ts  (or: npm run setup)
 */

import * as p from "@clack/prompts";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

// ── Helpers ──────────────────────────────────────────────────────────────────

export function maskSecret(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function validateSlackToken(value: string, prefix: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "Required";
  if (!trimmed.startsWith(prefix)) return `Must start with ${prefix}`;
  return undefined;
}

export function validateGithubToken(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined; // optional
  if (trimmed.startsWith("ghp_") || trimmed.startsWith("ghs_") || trimmed.startsWith("github_pat_")) {
    return undefined;
  }
  return "Expected format: ghp_*, ghs_*, or github_pat_*";
}

export function validateOpenRouterKey(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined; // optional
  if (trimmed.startsWith("sk-or-")) return undefined;
  return "Expected format: sk-or-*";
}

export function detectGooseBinary(): string | null {
  try {
    return execSync("goose --version 2>/dev/null", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function parseExistingEnv(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {};
  const content = readFileSync(envPath, "utf8");
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex);
    let val = trimmed.slice(eqIndex + 1);
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

export function mergeEnvValues(
  existing: Record<string, string>,
  newValues: Record<string, string>
): Record<string, string> {
  const merged = { ...existing };
  for (const [key, val] of Object.entries(newValues)) {
    if (val !== undefined && val !== "") {
      merged[key] = val;
    }
  }
  return merged;
}

export function generateEnvContent(values: Record<string, string>): string {
  const sections: Array<{ header: string; keys: Array<{ key: string; comment?: string }> }> = [
    {
      header: "App branding",
      keys: [{ key: "APP_NAME" }]
    },
    {
      header: "Slack (required)",
      keys: [
        { key: "SLACK_BOT_TOKEN" },
        { key: "SLACK_APP_TOKEN" },
        { key: "SLACK_SIGNING_SECRET" },
        { key: "SLACK_COMMAND_NAME", comment: "Display name used in help/status hints" }
      ]
    },
    {
      header: "GitHub — use EITHER a PAT or GitHub App credentials",
      keys: [
        { key: "GITHUB_TOKEN", comment: "Option A: Personal Access Token" },
        { key: "GITHUB_APP_ID", comment: "Option B: GitHub App (recommended for organizations)" },
        { key: "GITHUB_APP_PRIVATE_KEY", comment: "PEM contents (single-line with literal \\n escapes)" },
        { key: "GITHUB_APP_INSTALLATION_ID" },
        { key: "REPO_ALLOWLIST", comment: "Comma-separated: owner/repo1,owner/repo2" }
      ]
    },
    {
      header: "Agent",
      keys: [
        { key: "AGENT_COMMAND_TEMPLATE" },
        { key: "OPENROUTER_API_KEY", comment: "Used for scope_judge, plan_task, and smart triage LLM calls" }
      ]
    },
    {
      header: "Runtime",
      keys: [
        { key: "DRY_RUN" },
        { key: "RUNNER_CONCURRENCY" },
        { key: "PIPELINE_FILE" },
        { key: "DASHBOARD_TOKEN", comment: "Set to require auth (recommended for non-localhost)" }
      ]
    }
  ];

  const lines: string[] = [];
  for (const section of sections) {
    lines.push(`# ${section.header}`);
    for (const entry of section.keys) {
      if (entry.comment) lines.push(`# ${entry.comment}`);
      const val = values[entry.key] ?? "";
      lines.push(`${entry.key}=${val}`);
    }
    lines.push("");
  }

  // Append any extra keys from the existing .env that aren't in our sections
  const knownKeys = new Set(sections.flatMap((s) => s.keys.map((k) => k.key)));
  const extras = Object.entries(values).filter(([k]) => !knownKeys.has(k));
  if (extras.length > 0) {
    lines.push("# Additional configuration");
    for (const [key, val] of extras) {
      lines.push(`${key}=${val}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function verifyGithubToken(token: string): Promise<string | null> {
  try {
    const resp = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "gooseherd-setup" }
    });
    if (resp.ok) {
      const data = (await resp.json()) as { login: string };
      return data.login;
    }
    return null;
  } catch {
    return null;
  }
}

function generateRandomToken(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  for (const b of bytes) {
    result += chars[b % chars.length];
  }
  return result;
}

// ── Main Wizard ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const envPath = resolve(".env");
  const existing = parseExistingEnv(envPath);
  const isUpdate = existsSync(envPath) && Object.keys(existing).length > 0;

  // Non-TTY: fall back to validation only
  if (!process.stdin.isTTY) {
    console.log("Non-interactive mode detected. Running validation only...");
    try {
      await import("dotenv/config");
      const { loadConfig } = await import("../src/config.js");
      loadConfig();
      console.log("Config validation passed.");
    } catch (err) {
      console.error("Config validation failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }

  p.intro("Welcome to Gooseherd Setup!");

  if (isUpdate) {
    p.note(
      `Found existing .env with ${String(Object.keys(existing).length)} variables.\nExisting values will be used as defaults. A backup will be saved to .env.backup.`,
      "Update mode"
    );
  }

  const collected: Record<string, string> = {};

  // ── Step 1: Slack ──────────────────────────────────────────────────────────
  p.log.step("Step 1/4: Slack App");
  p.log.message(
    "Create a Slack App using the manifest at slack-app-manifest.yml\n" +
    "Then get your credentials from https://api.slack.com/apps"
  );

  const slack = await p.group(
    {
      botToken: () =>
        p.text({
          message: "SLACK_BOT_TOKEN",
          placeholder: "xoxb-...",
          initialValue: existing.SLACK_BOT_TOKEN || "",
          validate: (v) => validateSlackToken(v, "xoxb-")
        }),
      appToken: () =>
        p.text({
          message: "SLACK_APP_TOKEN",
          placeholder: "xapp-...",
          initialValue: existing.SLACK_APP_TOKEN || "",
          validate: (v) => validateSlackToken(v, "xapp-")
        }),
      signingSecret: () =>
        p.password({
          message: "SLACK_SIGNING_SECRET",
          validate: (v) => {
            if (!v || v.trim().length < 10) return "Must be at least 10 characters";
            return undefined;
          }
        })
    },
    {
      onCancel: () => {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }
    }
  );

  collected.SLACK_BOT_TOKEN = String(slack.botToken).trim();
  collected.SLACK_APP_TOKEN = String(slack.appToken).trim();
  collected.SLACK_SIGNING_SECRET = String(slack.signingSecret).trim();

  // ── Step 2: GitHub ─────────────────────────────────────────────────────────
  p.log.step("Step 2/4: GitHub Access");

  const ghToken = await p.password({
    message: "GITHUB_TOKEN (personal access token, or press Enter to skip)",
  });

  if (p.isCancel(ghToken)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const ghTokenStr = String(ghToken ?? "").trim();
  if (ghTokenStr) {
    const formatErr = validateGithubToken(ghTokenStr);
    if (formatErr) {
      p.log.warn(formatErr);
    } else {
      const s = p.spinner();
      s.start("Verifying GitHub token...");
      const username = await verifyGithubToken(ghTokenStr);
      if (username) {
        s.stop(`Authenticated as ${username}`);
      } else {
        s.stop("Could not verify (token may still work)");
      }
    }
    collected.GITHUB_TOKEN = ghTokenStr;
  }

  const repoAllowlist = await p.text({
    message: "REPO_ALLOWLIST (comma-separated, or press Enter to skip)",
    placeholder: "owner/repo1,owner/repo2",
    initialValue: existing.REPO_ALLOWLIST || "",
  });

  if (p.isCancel(repoAllowlist)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  if (String(repoAllowlist).trim()) {
    collected.REPO_ALLOWLIST = String(repoAllowlist).trim();
  }

  p.log.message("GitHub App auth is also supported — see .env.example for GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID");

  // ── Step 3: Agent / LLM ───────────────────────────────────────────────────
  p.log.step("Step 3/4: AI Agent");

  const gooseVersion = detectGooseBinary();
  if (gooseVersion) {
    p.log.success(`Goose binary found: ${gooseVersion}`);
  } else {
    p.log.warn("Goose binary not found. Install from https://block.github.io/goose/docs/quick-start/");
    p.log.message("Using dummy agent for testing. Set AGENT_COMMAND_TEMPLATE later for production.");
  }

  const openrouterKey = await p.password({
    message: "OPENROUTER_API_KEY (for scope judge, planning, smart triage — or press Enter to skip)"
  });

  if (p.isCancel(openrouterKey)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const openrouterKeyStr = String(openrouterKey ?? "").trim();
  if (openrouterKeyStr) {
    const keyErr = validateOpenRouterKey(openrouterKeyStr);
    if (keyErr) {
      p.log.warn(keyErr);
    }
    collected.OPENROUTER_API_KEY = openrouterKeyStr;
  }

  // ── Step 4: Runtime ────────────────────────────────────────────────────────
  p.log.step("Step 4/4: Runtime Options");

  const dryRun = await p.confirm({
    message: "Start in DRY_RUN mode? (no real PRs, safe for testing)",
    initialValue: existing.DRY_RUN === "false" ? false : true
  });

  if (p.isCancel(dryRun)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  collected.DRY_RUN = dryRun ? "true" : "false";

  const wantDashboardAuth = await p.confirm({
    message: "Generate a DASHBOARD_TOKEN for authentication?",
    initialValue: !existing.DASHBOARD_TOKEN
  });

  if (p.isCancel(wantDashboardAuth)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  if (wantDashboardAuth) {
    const token = generateRandomToken();
    collected.DASHBOARD_TOKEN = token;
    p.log.info(`Dashboard token: ${maskSecret(token)} (saved to .env)`);
  }

  // ── Generate .env ──────────────────────────────────────────────────────────
  // Set sensible defaults for keys that weren't prompted
  collected.APP_NAME = existing.APP_NAME || "Gooseherd";
  collected.SLACK_COMMAND_NAME = existing.SLACK_COMMAND_NAME || "gooseherd";
  collected.RUNNER_CONCURRENCY = existing.RUNNER_CONCURRENCY || "1";
  collected.PIPELINE_FILE = existing.PIPELINE_FILE || "pipelines/default.yml";

  // Keep the agent command from existing config, or use default
  if (!collected.AGENT_COMMAND_TEMPLATE) {
    collected.AGENT_COMMAND_TEMPLATE =
      existing.AGENT_COMMAND_TEMPLATE ||
      "bash scripts/dummy-agent.sh {{repo_dir}} {{prompt_file}} {{run_id}}";
  }

  const merged = mergeEnvValues(existing, collected);
  const content = generateEnvContent(merged);

  if (isUpdate) {
    copyFileSync(envPath, `${envPath}.backup`);
    p.log.info("Backed up existing .env to .env.backup");
  }

  writeFileSync(envPath, content, "utf8");

  // ── Summary ────────────────────────────────────────────────────────────────
  const summaryLines = [
    `Slack:     ${maskSecret(collected.SLACK_BOT_TOKEN ?? "")}`,
    `GitHub:    ${collected.GITHUB_TOKEN ? maskSecret(collected.GITHUB_TOKEN) : "not set"}`,
    `Agent:     ${gooseVersion ? "goose" : "dummy-agent (testing)"}`,
    `Dry run:   ${collected.DRY_RUN}`,
    `Dashboard: ${collected.DASHBOARD_TOKEN ? "auth enabled" : "no auth"}`,
  ];

  p.note(summaryLines.join("\n"), "Configuration saved to .env");

  p.log.step("Next steps:");
  p.log.message("1. Run: npm run validate");
  p.log.message("2. Run: npm run dev");
  p.log.message(`3. In Slack: @${collected.SLACK_COMMAND_NAME || "gooseherd"} run owner/repo | your task here`);

  p.outro("Setup complete!");
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
