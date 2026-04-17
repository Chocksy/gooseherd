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
import { rubySyntaxGateNode } from "./nodes/ruby-syntax-gate.js";
import { uploadScreenshotNode } from "./nodes/upload-screenshot.js";
import { generateTitleNode } from "./nodes/generate-title.js";
import { summarizeChangesNode } from "./nodes/summarize-changes.js";
import { runNode } from "./nodes/run.js";
import { setupSandboxNode } from "./nodes/setup-sandbox.js";

// Quality gate node imports
import { classifyTaskNode } from "./quality-gates/classify-task-node.js";
import { diffGateNode } from "./quality-gates/diff-gate-node.js";
import { forbiddenFilesNode } from "./quality-gates/forbidden-files-node.js";
import { securityScanNode } from "./quality-gates/security-scan-node.js";
import { scopeJudgeNode } from "./quality-gates/scope-judge-node.js";
import { browserVerifyNode } from "./quality-gates/browser-verify-node.js";

// Deploy + CI node imports
import { deployPreviewNode } from "./nodes/deploy-preview.js";
import { waitCiNode } from "./ci/wait-ci-node.js";
import { fixCiNode } from "./ci/fix-ci-node.js";
import { fixBrowserNode } from "./nodes/fix-browser.js";
import { decideNextStepNode } from "./nodes/decide-next-step.js";

/**
 * Single source of truth for node action → handler mapping.
 *
 * Both the pipeline engine (to dispatch nodes) and the pipeline loader
 * (to validate YAML) derive their action lists from this registry.
 */
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
  wait_ci: waitCiNode,
  fix_ci: fixCiNode,
  fix_browser: fixBrowserNode,
  scope_judge: scopeJudgeNode,
  deploy_preview: deployPreviewNode,
  browser_verify: browserVerifyNode,
  plan_task: planTaskNode,
  local_test: localTestNode,
  ruby_syntax_gate: rubySyntaxGateNode,
  upload_screenshot: uploadScreenshotNode,
  generate_title: generateTitleNode,
  summarize_changes: summarizeChangesNode,
  decide_next_step: decideNextStepNode,
  run: runNode,
  setup_sandbox: setupSandboxNode
};

/** Set of valid action names, derived from the handler registry. */
export const VALID_ACTIONS = new Set(Object.keys(NODE_HANDLERS));
