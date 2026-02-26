import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { scanDiffForSecrets, parseGitleaksReport } from "./security-scan.js";
import { runShellCapture, appendLog } from "../shell.js";
import { appendGateReport } from "./gate-report.js";

/**
 * Security scan node: check for leaked secrets in the diff.
 * Tries gitleaks first (pipe mode), falls back to regex patterns.
 * Always a hard fail — secrets in code must never be pushed.
 */
export async function securityScanNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const repoDir = ctx.getRequired<string>("repoDir");
  const logFile = deps.logFile;
  const runId = deps.run.id;

  // Get the diff for scanning
  const diffResult = await runShellCapture(
    "git diff HEAD",
    { cwd: repoDir, logFile }
  );

  if (diffResult.code !== 0) {
    return { outcome: "failure", error: `git diff failed: ${diffResult.stderr}` };
  }

  if (!diffResult.stdout.trim()) {
    return { outcome: "success" };
  }

  // Try gitleaks first
  const gitleaksAvailable = await checkGitleaksAvailable(repoDir, logFile);

  if (gitleaksAvailable) {
    const reportPath = `/tmp/gitleaks-${runId}.json`;
    const gitleaksResult = await runShellCapture(
      `git diff HEAD | gitleaks detect --pipe --report-format json --report-path ${reportPath}`,
      { cwd: repoDir, logFile }
    );

    // gitleaks exit codes: 0 = clean, 1 = leaks found, other = error
    if (gitleaksResult.code === 0) {
      await appendLog(logFile, "\n[gate:security_scan] gitleaks: clean\n");
      appendGateReport(ctx, "security_scan", "pass", []);
      return { outcome: "success", outputs: { securityMethod: "gitleaks" } };
    }

    if (gitleaksResult.code === 1) {
      // Leaks found — read the report file via shell so it works in sandbox mode too
      try {
        const catResult = await runShellCapture(`cat ${reportPath}`, { cwd: repoDir, logFile });
        if (catResult.code === 0 && catResult.stdout.trim()) {
          const scanResult = parseGitleaksReport(catResult.stdout);
          if (scanResult.verdict === "hard_fail") {
            const reasons = scanResult.findings.map(f => `${f.file}:${String(f.line)} [${f.rule}] ${f.match}`);
            await appendLog(logFile, `\n[gate:security_scan] gitleaks: ${String(scanResult.findings.length)} secret(s) found\n`);
            appendGateReport(ctx, "security_scan", "hard_fail", reasons);

            return {
              outcome: "failure",
              error: `Secrets detected by gitleaks:\n${reasons.join("\n")}`,
              outputs: { secretsFound: scanResult.findings, securityMethod: "gitleaks" }
            };
          }
        }
      } catch {
        // Report file unreadable — fall through to regex
      }
    }

    // gitleaks exited with error or report unreadable — fall through to regex
    await appendLog(logFile, `\n[gate:security_scan] gitleaks exit ${String(gitleaksResult.code)}, falling back to regex\n`);
  }

  // Regex fallback
  const scanResult = scanDiffForSecrets(diffResult.stdout);

  await appendLog(logFile, `\n[gate:security_scan] regex: ${scanResult.verdict} (${String(scanResult.findings.length)} findings)\n`);

  const reasons = scanResult.findings.map(f => `${f.file}:${String(f.line)} [${f.rule}] ${f.match}`);
  appendGateReport(ctx, "security_scan", scanResult.verdict, reasons);

  if (scanResult.verdict === "hard_fail") {
    return {
      outcome: "failure",
      error: `Secrets detected by regex scan:\n${reasons.join("\n")}`,
      outputs: { secretsFound: scanResult.findings, securityMethod: "regex" }
    };
  }

  return {
    outcome: "success",
    outputs: { securityMethod: "regex" }
  };
}

async function checkGitleaksAvailable(cwd: string, logFile: string): Promise<boolean> {
  const result = await runShellCapture("which gitleaks", { cwd, logFile });
  return result.code === 0;
}
