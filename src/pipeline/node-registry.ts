import type { NodeHandler } from "./types.js";

// Node handler imports
import { cloneNode } from "./nodes/clone.js";
import { hydrateContextNode } from "./nodes/hydrate-context.js";
import { implementNode } from "./nodes/implement.js";
import { lintFixNode } from "./nodes/lint-fix.js";
import { validateNode } from "./nodes/validate.js";
import { fixValidationNode } from "./nodes/fix-validation.js";
import { commitNode } from "./nodes/commit.js";
import { pushNode } from "./nodes/push.js";
import { createPrNode } from "./nodes/create-pr.js";
import { notifyNode } from "./nodes/notify.js";
import { planTaskNode } from "./nodes/plan-task.js";
import { localTestNode } from "./nodes/local-test.js";
import { lightweightChecksNode } from "./nodes/lightweight-checks.js";
import { rubySyntaxGateNode } from "./nodes/ruby-syntax-gate.js";
import { generateTitleNode } from "./nodes/generate-title.js";
import { summarizeChangesNode } from "./nodes/summarize-changes.js";
import { runNode } from "./nodes/run.js";
import { setupSandboxNode } from "./nodes/setup-sandbox.js";
import { syncBaseBranchNode } from "./nodes/sync-base-branch.js";

// Quality gate node imports
import { classifyTaskNode } from "./quality-gates/classify-task-node.js";
import { diffGateNode } from "./quality-gates/diff-gate-node.js";
import { forbiddenFilesNode } from "./quality-gates/forbidden-files-node.js";
import { securityScanNode } from "./quality-gates/security-scan-node.js";
import { scopeJudgeNode } from "./quality-gates/scope-judge-node.js";

/**
 * Single source of truth for node action → handler mapping.
 *
 * Both the pipeline engine (to dispatch nodes) and the pipeline loader
 * (to validate YAML) derive their action lists from this registry.
 */
function lazyNodeHandler(
  modulePath: string,
  exportName: string,
  options?: { loadErrorHint?: string },
): NodeHandler {
  let cachedHandler: NodeHandler | undefined;

  return async (nodeConfig, ctx, deps) => {
    if (!cachedHandler) {
      let mod: Record<string, unknown>;
      try {
        mod = await import(modulePath) as Record<string, unknown>;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (options?.loadErrorHint) {
          throw new Error(`${message}. ${options.loadErrorHint}`);
        }
        throw error;
      }
      const resolved = mod[exportName];
      if (typeof resolved !== "function") {
        throw new Error(`Invalid node handler export '${exportName}' from ${modulePath}`);
      }
      cachedHandler = resolved as NodeHandler;
    }

    return cachedHandler(nodeConfig, ctx, deps);
  };
}

export const NODE_HANDLERS: Record<string, NodeHandler> = {
  clone: cloneNode,
  hydrate_context: hydrateContextNode,
  implement: implementNode,
  lint_fix: lintFixNode,
  validate: validateNode,
  fix_validation: fixValidationNode,
  commit: commitNode,
  push: pushNode,
  create_pr: createPrNode,
  notify: notifyNode,
  classify_task: classifyTaskNode,
  diff_gate: diffGateNode,
  forbidden_files: forbiddenFilesNode,
  security_scan: securityScanNode,
  wait_ci: lazyNodeHandler("./ci/wait-ci-node.js", "waitCiNode"),
  fix_ci: lazyNodeHandler("./ci/fix-ci-node.js", "fixCiNode"),
  fix_browser: lazyNodeHandler("./nodes/fix-browser.js", "fixBrowserNode"),
  scope_judge: scopeJudgeNode,
  deploy_preview: lazyNodeHandler("./nodes/deploy-preview.js", "deployPreviewNode"),
  browser_verify: lazyNodeHandler("./quality-gates/browser-verify-node.js", "browserVerifyNode", {
    loadErrorHint: "Rebuild the runtime image with INSTALL_BROWSER_VERIFY=true to enable browser verification.",
  }),
  plan_task: planTaskNode,
  local_test: localTestNode,
  lightweight_checks: lightweightChecksNode,
  ruby_syntax_gate: rubySyntaxGateNode,
  upload_screenshot: lazyNodeHandler("./nodes/upload-screenshot.js", "uploadScreenshotNode"),
  generate_title: generateTitleNode,
  summarize_changes: summarizeChangesNode,
  decide_next_step: lazyNodeHandler("./nodes/decide-next-step.js", "decideNextStepNode"),
  run: runNode,
  setup_sandbox: setupSandboxNode,
  sync_base_branch: syncBaseBranchNode,
};

/** Set of valid action names, derived from the handler registry. */
export const VALID_ACTIONS = new Set(Object.keys(NODE_HANDLERS));
