import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { appendLog } from "../shell.js";
import { resolveRepoSandboxImage } from "../../sandbox/image-resolver.js";

/**
 * setup_sandbox node: resolve sandbox image from .gooseherd.yml and request
 * sandbox creation with the resolved image.
 *
 * Must be placed AFTER clone (needs repoDir) and BEFORE any node that
 * requires sandbox execution.
 *
 * When sandbox runtime is non-docker (config.sandboxRuntime !== "docker"), this
 * node is a no-op that returns success with sandboxSource "runtime_disabled".
 *
 * When sandbox is disabled (config.sandboxEnabled === false), this node is also
 * a no-op that returns success.
 */
export async function setupSandboxNode(
  _nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const logFile = deps.logFile;

  if (deps.config.sandboxRuntime && deps.config.sandboxRuntime !== "docker") {
    await appendLog(logFile, `[setup_sandbox] runtime=${deps.config.sandboxRuntime}, skipping\n`);
    return { outcome: "success", outputs: { sandboxImage: "none", sandboxSource: "runtime_disabled" } };
  }

  if (!deps.config.sandboxEnabled) {
    await appendLog(logFile, "[setup_sandbox] sandbox disabled, skipping\n");
    return { outcome: "success", outputs: { sandboxImage: "none", sandboxSource: "disabled" } };
  }

  if (!deps.requestSandbox) {
    await appendLog(logFile, "[setup_sandbox] no requestSandbox callback — sandbox creation handled externally\n");
    return { outcome: "success", outputs: { sandboxImage: deps.config.sandboxImage, sandboxSource: "default" } };
  }

  const repoDir = ctx.get<string>("repoDir");
  const defaultImage = deps.config.sandboxImage;

  let resolvedImage = defaultImage;
  let source = "default";
  let builtLocally = false;

  if (repoDir) {
    const result = await resolveRepoSandboxImage(repoDir, defaultImage, deps.containerManager);
    resolvedImage = result.image;
    source = result.source;
    builtLocally = result.builtLocally;
    await appendLog(logFile, `[setup_sandbox] resolved image: ${resolvedImage} (source: ${source}, built: ${String(builtLocally)})\n`);
  } else {
    await appendLog(logFile, `[setup_sandbox] no repoDir in context, using default image: ${defaultImage}\n`);
  }

  // Request sandbox creation with the resolved image
  await deps.requestSandbox(resolvedImage);
  await appendLog(logFile, `[setup_sandbox] sandbox requested with image: ${resolvedImage}\n`);

  return {
    outcome: "success",
    outputs: {
      sandboxImage: resolvedImage,
      sandboxSource: source,
      sandboxBuiltLocally: builtLocally
    }
  };
}
