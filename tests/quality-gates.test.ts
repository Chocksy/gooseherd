import assert from "node:assert/strict";
import test from "node:test";
import { classifyTask, classifyExecutionMode, escalateMode } from "../src/pipeline/quality-gates/task-classifier.js";
import { parseDiffNumstat, evaluateDiffGate } from "../src/pipeline/quality-gates/diff-gate.js";
import { checkForbiddenFiles, globToRegex } from "../src/pipeline/quality-gates/forbidden-files.js";
import { scanDiffForSecrets, parseGitleaksReport } from "../src/pipeline/quality-gates/security-scan.js";

// ── Task Classifier ──

test("classifyTask: fix-related keywords → bugfix", () => {
  assert.equal(classifyTask("Fix login crash on iOS"), "bugfix");
  assert.equal(classifyTask("fix the broken pagination"), "bugfix");
  assert.equal(classifyTask("resolve null pointer in auth"), "bugfix");
  assert.equal(classifyTask("hotfix: production error"), "bugfix");
  assert.equal(classifyTask("patch regression in payment flow"), "bugfix");
});

test("classifyTask: refactor keywords → refactor", () => {
  assert.equal(classifyTask("Refactor the user service"), "refactor");
  assert.equal(classifyTask("rename UserManager to UserService"), "refactor");
  assert.equal(classifyTask("clean up dead code in utils"), "refactor");
  assert.equal(classifyTask("extract helper from controller"), "refactor");
  assert.equal(classifyTask("simplify the auth middleware"), "refactor");
});

test("classifyTask: chore keywords → chore", () => {
  assert.equal(classifyTask("bump dependencies"), "chore");
  assert.equal(classifyTask("update deps to latest"), "chore");
  assert.equal(classifyTask("upgrade React to v19"), "chore");
  assert.equal(classifyTask("chore: update CI config"), "chore");
});

test("classifyTask: feature keywords → feature", () => {
  assert.equal(classifyTask("Add user profile page"), "feature");
  assert.equal(classifyTask("create new API endpoint"), "feature");
  assert.equal(classifyTask("implement dark mode"), "feature");
  assert.equal(classifyTask("build notification system"), "feature");
});

test("classifyTask: no match defaults to feature", () => {
  assert.equal(classifyTask("do something with the codebase"), "feature");
  assert.equal(classifyTask(""), "feature");
});

test("classifyTask: priority order — bugfix wins over feature", () => {
  // "fix" matches bugfix before "add" matches feature
  assert.equal(classifyTask("fix and add error handling"), "bugfix");
});

// ── Execution Mode Classifier ──

test("classifyExecutionMode: simple tasks → simple", () => {
  assert.equal(classifyExecutionMode("fix a typo in the readme"), "simple");
  assert.equal(classifyExecutionMode("bump version to 2.0"), "simple");
  assert.equal(classifyExecutionMode("update deps"), "simple");
  assert.equal(classifyExecutionMode("rename the variable"), "simple");
  assert.equal(classifyExecutionMode("config change for CI"), "simple");
  assert.equal(classifyExecutionMode("remove unused import"), "simple");
});

test("classifyExecutionMode: research tasks → research", () => {
  assert.equal(classifyExecutionMode("refactor the authentication system"), "research");
  assert.equal(classifyExecutionMode("migrate from MySQL to Postgres"), "research");
  assert.equal(classifyExecutionMode("investigate the memory leak"), "research");
  assert.equal(classifyExecutionMode("security audit of the API"), "research");
  assert.equal(classifyExecutionMode("rewrite the parser module"), "research");
  assert.equal(classifyExecutionMode("analyze performance bottleneck in search"), "research");
});

test("classifyExecutionMode: normal tasks → standard", () => {
  assert.equal(classifyExecutionMode("add a footer link to the homepage"), "standard");
  assert.equal(classifyExecutionMode("fix the broken login button"), "standard");
  assert.equal(classifyExecutionMode("create new API endpoint for users"), "standard");
});

test("classifyExecutionMode: empty string → standard", () => {
  assert.equal(classifyExecutionMode(""), "standard");
});

test("classifyExecutionMode: research wins over simple when both match", () => {
  // "upgrade" matches simple, but "migrate" makes it research — research checked first
  assert.equal(classifyExecutionMode("upgrade and migrate the database"), "research");
  // "remove unused" matches simple, but "refactor...module" makes it research
  assert.equal(classifyExecutionMode("remove unused code and refactor the module"), "research");
  // Pure simple still works when no research pattern present
  assert.equal(classifyExecutionMode("rename the variable"), "simple");
  assert.equal(classifyExecutionMode("remove unused import"), "simple");
});

// ── Mode Escalation ──

test("escalateMode: simple → standard after 1 failure", () => {
  assert.equal(escalateMode("simple", 0), "simple");
  assert.equal(escalateMode("simple", 1), "standard");
  assert.equal(escalateMode("simple", 2), "standard");
});

test("escalateMode: standard → research after 2 failures", () => {
  assert.equal(escalateMode("standard", 0), "standard");
  assert.equal(escalateMode("standard", 1), "standard");
  assert.equal(escalateMode("standard", 2), "research");
});

test("escalateMode: research stays research", () => {
  assert.equal(escalateMode("research", 0), "research");
  assert.equal(escalateMode("research", 5), "research");
});

// ── Diff Size Gate ──

test("parseDiffNumstat: parses standard output", () => {
  const output = "10\t5\tsrc/index.ts\n20\t0\tsrc/new-file.ts\n0\t15\tsrc/removed.ts\n";
  const stats = parseDiffNumstat(output);
  assert.equal(stats.linesAdded, 30);
  assert.equal(stats.linesRemoved, 20);
  assert.equal(stats.totalLines, 50);
  assert.equal(stats.filesChanged, 3);
});

test("parseDiffNumstat: handles binary files", () => {
  const output = "-\t-\timage.png\n5\t3\tsrc/app.ts\n";
  const stats = parseDiffNumstat(output);
  assert.equal(stats.linesAdded, 6);  // 1 (binary) + 5
  assert.equal(stats.linesRemoved, 4); // 1 (binary) + 3
  assert.equal(stats.filesChanged, 2);
});

test("parseDiffNumstat: empty output → zero stats", () => {
  const stats = parseDiffNumstat("");
  assert.equal(stats.totalLines, 0);
  assert.equal(stats.filesChanged, 0);
});

test("evaluateDiffGate: within soft limits → pass", () => {
  const result = evaluateDiffGate({ linesAdded: 100, linesRemoved: 50, totalLines: 150, filesChanged: 5 }, "bugfix");
  assert.equal(result.verdict, "pass");
  assert.equal(result.reasons.length, 0);
});

test("evaluateDiffGate: exceeds soft but within hard → soft_fail", () => {
  const result = evaluateDiffGate({ linesAdded: 200, linesRemoved: 100, totalLines: 300, filesChanged: 5 }, "bugfix");
  assert.equal(result.verdict, "soft_fail");
  assert.ok(result.reasons.length > 0);
});

test("evaluateDiffGate: exceeds hard → hard_fail", () => {
  const result = evaluateDiffGate({ linesAdded: 400, linesRemoved: 300, totalLines: 700, filesChanged: 5 }, "bugfix");
  assert.equal(result.verdict, "hard_fail");
});

test("evaluateDiffGate: file count limits", () => {
  // Soft exceed on files (bugfix: soft 12)
  const soft = evaluateDiffGate({ linesAdded: 10, linesRemoved: 10, totalLines: 20, filesChanged: 15 }, "bugfix");
  assert.equal(soft.verdict, "soft_fail");

  // Hard exceed on files (bugfix: hard 25)
  const hard = evaluateDiffGate({ linesAdded: 10, linesRemoved: 10, totalLines: 20, filesChanged: 30 }, "bugfix");
  assert.equal(hard.verdict, "hard_fail");
});

test("evaluateDiffGate: exactly at soft limit → pass", () => {
  const result = evaluateDiffGate({ linesAdded: 125, linesRemoved: 125, totalLines: 250, filesChanged: 12 }, "bugfix");
  assert.equal(result.verdict, "pass");
});

test("evaluateDiffGate: feature profile is more permissive", () => {
  // 500 lines would soft_fail bugfix but pass feature
  const result = evaluateDiffGate({ linesAdded: 300, linesRemoved: 200, totalLines: 500, filesChanged: 10 }, "feature");
  assert.equal(result.verdict, "pass");
});

test("evaluateDiffGate: chore profile is strictest", () => {
  const result = evaluateDiffGate({ linesAdded: 100, linesRemoved: 60, totalLines: 160, filesChanged: 5 }, "chore");
  assert.equal(result.verdict, "soft_fail");
});

// ── Forbidden Files ──

test("globToRegex: matches basic patterns", () => {
  assert.ok(globToRegex("**/.env*").test(".env"));
  assert.ok(globToRegex("**/.env*").test(".env.local"));
  assert.ok(globToRegex("**/.env*").test("config/.env.production"));
  assert.ok(!globToRegex("**/.env*").test("src/environment.ts"));
});

test("globToRegex: matches extension patterns", () => {
  assert.ok(globToRegex("**/*.pem").test("certs/server.pem"));
  assert.ok(globToRegex("**/*.pem").test("server.pem"));
  assert.ok(!globToRegex("**/*.pem").test("server.pem.bak"));
});

test("globToRegex: matches directory patterns", () => {
  assert.ok(globToRegex("**/secrets/**").test("secrets/api_key.txt"));
  assert.ok(globToRegex("**/secrets/**").test("config/secrets/prod.yml"));
  assert.ok(!globToRegex("**/secrets/**").test("src/secret_helper.ts"));
});

test("checkForbiddenFiles: deny .env file → hard_fail", () => {
  const result = checkForbiddenFiles([".env", "src/index.ts"], "add feature");
  assert.equal(result.verdict, "hard_fail");
  assert.deepEqual(result.deniedFiles, [".env"]);
});

test("checkForbiddenFiles: deny .pem file → hard_fail", () => {
  const result = checkForbiddenFiles(["certs/server.pem", "src/index.ts"], "add SSL support");
  assert.equal(result.verdict, "hard_fail");
  assert.deepEqual(result.deniedFiles, ["certs/server.pem"]);
});

test("checkForbiddenFiles: deny internal generated file → hard_fail", () => {
  const result = checkForbiddenFiles(["AGENTS.md", "src/index.ts"], "add feature");
  assert.equal(result.verdict, "hard_fail");
  assert.deepEqual(result.deniedFiles, ["AGENTS.md"]);
  assert.ok(result.reasons.some((reason) => reason.includes("internal-generated")));
});

test("checkForbiddenFiles: guarded workflow file → soft_fail", () => {
  const result = checkForbiddenFiles([".github/workflows/ci.yml", "src/index.ts"], "add feature");
  assert.equal(result.verdict, "soft_fail");
  assert.deepEqual(result.guardedFiles, [".github/workflows/ci.yml"]);
});

test("checkForbiddenFiles: guarded workflow file OK if task mentions workflows", () => {
  const result = checkForbiddenFiles([".github/workflows/ci.yml"], "update workflows config");
  assert.equal(result.verdict, "pass");
  assert.equal(result.guardedFiles.length, 0);
});

test("checkForbiddenFiles: guarded migration file → soft_fail", () => {
  const result = checkForbiddenFiles(["db/migrations/001_create_users.rb", "src/index.ts"], "add feature");
  assert.equal(result.verdict, "soft_fail");
  assert.ok(result.guardedFiles.includes("db/migrations/001_create_users.rb"));
});

test("checkForbiddenFiles: lockfile without manifest → soft_fail", () => {
  const result = checkForbiddenFiles(["package-lock.json", "src/index.ts"], "add feature");
  assert.equal(result.verdict, "soft_fail");
  assert.deepEqual(result.lockfileViolations, ["package-lock.json"]);
});

test("checkForbiddenFiles: lockfile WITH manifest → pass", () => {
  const result = checkForbiddenFiles(["package-lock.json", "package.json", "src/index.ts"], "add feature");
  assert.equal(result.verdict, "pass");
  assert.equal(result.lockfileViolations.length, 0);
});

test("checkForbiddenFiles: clean files → pass", () => {
  const result = checkForbiddenFiles(["src/index.ts", "src/app.ts", "README.md"], "add feature");
  assert.equal(result.verdict, "pass");
});

test("checkForbiddenFiles: Gemfile.lock without Gemfile → soft_fail", () => {
  const result = checkForbiddenFiles(["Gemfile.lock"], "update something");
  assert.equal(result.verdict, "soft_fail");
  assert.deepEqual(result.lockfileViolations, ["Gemfile.lock"]);
});

// ── Security Scan (Regex) ──

test("scanDiffForSecrets: detects GitHub token", () => {
  const diff = `--- a/config.ts
+++ b/config.ts
@@ -1,3 +1,3 @@
-const token = "old";
+const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh1234";
 export default token;
`;
  const result = scanDiffForSecrets(diff);
  assert.equal(result.verdict, "hard_fail");
  assert.ok(result.findings.length >= 1);
  assert.ok(result.findings.some(f => f.rule === "github_token"));
  assert.equal(result.findings[0]!.file, "config.ts");
});

test("scanDiffForSecrets: detects AWS access key", () => {
  const diff = `--- a/config.ts
+++ b/config.ts
@@ -1,2 +1,2 @@
-const key = "";
+const key = "AKIAIOSFODNN7EXAMPLE";
`;
  const result = scanDiffForSecrets(diff);
  assert.equal(result.verdict, "hard_fail");
  assert.equal(result.findings[0]!.rule, "aws_access_key");
});

test("scanDiffForSecrets: detects Slack token", () => {
  const diff = `--- a/config.ts
+++ b/config.ts
@@ -1,2 +1,2 @@
-const slack = "";
+const slack = "xoxb-123456789012-1234567890123-abcdefABCDEF";
`;
  const result = scanDiffForSecrets(diff);
  assert.equal(result.verdict, "hard_fail");
  assert.equal(result.findings[0]!.rule, "slack_token");
});

test("scanDiffForSecrets: detects generic API key assignment", () => {
  const diff = `--- a/config.ts
+++ b/config.ts
@@ -1,2 +1,2 @@
-const config = {};
+const api_key = "supersecretlongvalue12345";
`;
  const result = scanDiffForSecrets(diff);
  assert.equal(result.verdict, "hard_fail");
  assert.ok(result.findings.some(f => f.rule === "generic_secret"));
});

test("scanDiffForSecrets: detects private key header", () => {
  const diff = `--- a/key.pem
+++ b/key.pem
@@ -0,0 +1,3 @@
+-----BEGIN RSA PRIVATE KEY-----
+MIIEpAIBAAKCAQEA...
+-----END RSA PRIVATE KEY-----
`;
  const result = scanDiffForSecrets(diff);
  assert.equal(result.verdict, "hard_fail");
  assert.ok(result.findings.some(f => f.rule === "private_key_header"));
});

test("scanDiffForSecrets: clean diff → pass", () => {
  const diff = `--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 import { App } from "./app";
+import { Logger } from "./logger";

 const app = new App();
`;
  const result = scanDiffForSecrets(diff);
  assert.equal(result.verdict, "pass");
  assert.equal(result.findings.length, 0);
});

test("scanDiffForSecrets: only scans added lines, not removed", () => {
  const diff = `--- a/config.ts
+++ b/config.ts
@@ -1,2 +1,2 @@
-const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh1234";
+const token = process.env.GITHUB_TOKEN;
`;
  const result = scanDiffForSecrets(diff);
  assert.equal(result.verdict, "pass");
});

test("scanDiffForSecrets: redacts secret values in findings", () => {
  const diff = `--- a/config.ts
+++ b/config.ts
@@ -1,2 +1,2 @@
-const key = "";
+const key = "AKIAIOSFODNN7EXAMPLE";
`;
  const result = scanDiffForSecrets(diff);
  assert.ok(result.findings[0]!.match.includes("..."));
  assert.ok(!result.findings[0]!.match.includes("AKIAIOSFODNN7EXAMPLE"));
});

test("scanDiffForSecrets: detects Anthropic key", () => {
  const diff = `--- a/config.ts
+++ b/config.ts
@@ -1,2 +1,2 @@
-const key = "";
+const key = "sk-ant-api03-1234567890abcdefgh";
`;
  const result = scanDiffForSecrets(diff);
  assert.equal(result.verdict, "hard_fail");
  assert.equal(result.findings[0]!.rule, "anthropic_key");
});

// ── Gitleaks Report Parsing ──

test("parseGitleaksReport: parses findings", () => {
  const json = JSON.stringify([
    { File: "config.ts", StartLine: 5, RuleID: "github-pat", Match: "ghp_ABCDEFGHIJKLMNOP1234567890abcdefghij" }
  ]);
  const result = parseGitleaksReport(json);
  assert.equal(result.verdict, "hard_fail");
  assert.equal(result.findings.length, 1);
  assert.equal(result.method, "gitleaks");
});

test("parseGitleaksReport: empty array → pass", () => {
  const result = parseGitleaksReport("[]");
  assert.equal(result.verdict, "pass");
});

test("parseGitleaksReport: invalid JSON → hard_fail (fail-secure)", () => {
  const result = parseGitleaksReport("not json");
  assert.equal(result.verdict, "hard_fail");
  assert.ok(result.findings.some(f => f.rule === "parse_error"));
});

// ── New Pattern Coverage ──

test("scanDiffForSecrets: detects modern OpenAI project key", () => {
  const diff = `--- a/config.ts\n+++ b/config.ts\n@@ -1,2 +1,2 @@\n-const key = "";\n+const key = "sk-proj-abcdefghijklmnopqrstuvwxyz1234";\n`;
  const result = scanDiffForSecrets(diff);
  assert.equal(result.verdict, "hard_fail");
  assert.ok(result.findings.some(f => f.rule === "openai_project_key"));
});

test("scanDiffForSecrets: detects OpenAI service account key", () => {
  const diff = `--- a/config.ts\n+++ b/config.ts\n@@ -1,2 +1,2 @@\n-const key = "";\n+const key = "sk-svcacct-abcdefghijklmnopqrstuvwxyz";\n`;
  const result = scanDiffForSecrets(diff);
  assert.equal(result.verdict, "hard_fail");
  assert.ok(result.findings.some(f => f.rule === "openai_svcacct_key"));
});

test("scanDiffForSecrets: detects generic secret with backticks", () => {
  const diff = "--- a/config.ts\n+++ b/config.ts\n@@ -1,2 +1,2 @@\n-const config = {};\n+const api_key = \`supersecretlongvalue12345\`;\n";
  const result = scanDiffForSecrets(diff);
  assert.equal(result.verdict, "hard_fail");
  assert.ok(result.findings.some(f => f.rule === "generic_secret"));
});

test("checkForbiddenFiles: guarded workflow file OK if task mentions github", () => {
  const result = checkForbiddenFiles([".github/workflows/ci.yml"], "update github actions");
  assert.equal(result.verdict, "pass");
  assert.equal(result.guardedFiles.length, 0);
});
