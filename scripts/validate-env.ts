#!/usr/bin/env tsx
/**
 * Validate environment: load config, check required vars, verify goose binary.
 * Usage: npx tsx scripts/validate-env.ts  (or: npm run validate)
 */

import "dotenv/config";

const REQUIRED_HINTS: Record<string, string> = {
  SLACK_BOT_TOKEN: "Get from https://api.slack.com/apps → OAuth & Permissions → Bot User OAuth Token",
  SLACK_APP_TOKEN: "Get from https://api.slack.com/apps → Basic Information → App-Level Tokens (needs connections:write)",
  SLACK_SIGNING_SECRET: "Get from https://api.slack.com/apps → Basic Information → Signing Secret"
};

async function main(): Promise<void> {
  console.log("Validating Gooseherd environment...\n");

  let hasErrors = false;

  // Try loading config via the actual schema
  try {
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    console.log(`  App name:  ${config.appName}`);
    console.log(`  Data dir:  ${config.dataDir}`);
    console.log(`  Work root: ${config.workRoot}`);
    console.log(`  Dashboard: ${config.dashboardEnabled ? `http://${config.dashboardHost}:${String(config.dashboardPort)}` : "disabled"}`);
    console.log(`  Pipeline:  ${config.pipelineFile}`);
    console.log(`  Observer:  ${config.observerEnabled ? "enabled" : "disabled"}`);
    console.log(`  Auth:      ${config.dashboardToken ? "token set" : "no auth (localhost only)"}`);
    console.log("");
  } catch (err) {
    if (err && typeof err === "object" && "issues" in err) {
      const zodError = err as { issues: Array<{ path: string[]; message: string }> };
      console.error("Missing or invalid environment variables:\n");
      for (const issue of zodError.issues) {
        const key = issue.path.join(".");
        const hint = REQUIRED_HINTS[key];
        console.error(`  ${key}: ${issue.message}`);
        if (hint) {
          console.error(`    Hint: ${hint}`);
        }
      }
      console.error("");
      hasErrors = true;
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Config load error: ${msg}\n`);
      hasErrors = true;
    }
  }

  // Check goose binary (if AGENT_COMMAND_TEMPLATE uses goose)
  const agentCmd = process.env.AGENT_COMMAND_TEMPLATE ?? "";
  if (agentCmd.includes("goose")) {
    try {
      const { execSync } = await import("node:child_process");
      const version = execSync("goose --version 2>/dev/null", { encoding: "utf8" }).trim();
      console.log(`  Goose binary: ${version}`);
    } catch {
      console.warn("  Goose binary: NOT FOUND (install goose if using goose-based agent command)");
      hasErrors = true;
    }
  }

  // Check GitHub token validity (basic format check)
  const ghToken = process.env.GITHUB_TOKEN;
  if (ghToken) {
    if (ghToken.startsWith("ghp_") || ghToken.startsWith("ghs_") || ghToken.startsWith("github_pat_")) {
      console.log("  GitHub token: format OK");
    } else {
      console.warn("  GitHub token: unexpected format (expected ghp_*, ghs_*, or github_pat_*)");
    }
  } else {
    console.warn("  GitHub token: not set (required for creating PRs)");
  }

  console.log("");
  if (hasErrors) {
    console.error("Validation failed. Fix the issues above and try again.");
    process.exit(1);
  } else {
    console.log("All checks passed.");
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
