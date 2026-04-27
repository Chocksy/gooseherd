import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import type { EvalStore } from "../../eval/eval-store.js";
import type { LearningStore } from "../../observer/learning-store.js";
import type { DashboardObserver } from "../contracts.js";
import type { PipelineStore } from "../../pipeline/pipeline-store.js";
import { parseLimit, readBody, sendJson } from "./shared.js";

export interface FeatureRoutesDeps {
  evalStore?: EvalStore;
  learningStore?: LearningStore;
  observer?: DashboardObserver;
  pipelineStore?: PipelineStore;
  requestUrl: URL;
}

export async function handleFeatureRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: FeatureRoutesDeps,
): Promise<boolean> {
  const { evalStore, learningStore, observer, pipelineStore, requestUrl } = deps;

  if (req.method === "GET" && pathname === "/api/observer/state") {
    if (!observer) {
      sendJson(res, 200, { enabled: false });
    } else {
      sendJson(res, 200, { enabled: true, ...(await observer.getStateSnapshot()) });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/observer/events") {
    if (!observer) {
      sendJson(res, 200, { events: [] });
      return true;
    }
    const limit = parseLimit(requestUrl.searchParams.get("limit"));
    sendJson(res, 200, { events: observer.getRecentEvents(limit) });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/observer/rules") {
    if (!observer) {
      sendJson(res, 200, { rules: [] });
      return true;
    }
    const rules = observer.getRules().map((rule) => ({
      id: rule.id,
      source: rule.source,
      conditions: rule.conditions,
      pipeline: rule.pipeline,
      requiresApproval: rule.requiresApproval,
      cooldownMinutes: rule.cooldownMinutes,
      maxRunsPerHour: rule.maxRunsPerHour,
      repoSlug: rule.repoSlug,
      skipTriage: rule.skipTriage,
    }));
    sendJson(res, 200, { rules });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/pipelines") {
    if (!pipelineStore) {
      sendJson(res, 501, { error: "Pipeline store not available" });
      return true;
    }
    sendJson(res, 200, { pipelines: pipelineStore.list() });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/pipelines/validate") {
    if (!pipelineStore) {
      sendJson(res, 501, { error: "Pipeline store not available" });
      return true;
    }
    const body = await readBody(req);
    if (body === null) {
      sendJson(res, 413, { error: "Request body too large" });
      return true;
    }
    let parsed: { yaml?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON" });
      return true;
    }
    if (!parsed.yaml) {
      sendJson(res, 400, { error: "yaml is required" });
      return true;
    }
    try {
      const config = pipelineStore.validate(parsed.yaml);
      sendJson(res, 200, { valid: true, name: config.name, nodeCount: config.nodes.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      sendJson(res, 200, { valid: false, error: msg });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/pipelines") {
    if (!pipelineStore) {
      sendJson(res, 501, { error: "Pipeline store not available" });
      return true;
    }
    const body = await readBody(req);
    if (body === null) {
      sendJson(res, 413, { error: "Request body too large" });
      return true;
    }
    let parsed: { id?: string; yaml?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON" });
      return true;
    }
    if (!parsed.id || !parsed.yaml) {
      sendJson(res, 400, { error: "id and yaml are required" });
      return true;
    }
    try {
      const saved = await pipelineStore.save(parsed.id, parsed.yaml);
      sendJson(res, 201, { pipeline: saved });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      sendJson(res, 400, { error: msg });
    }
    return true;
  }

  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "api" && parts[1] === "pipelines" && parts.length === 3) {
    const id = decodeURIComponent(parts[2]);

    if (req.method === "GET") {
      if (!pipelineStore) {
        sendJson(res, 501, { error: "Pipeline store not available" });
        return true;
      }
      const pipeline = pipelineStore.get(id);
      if (!pipeline) {
        sendJson(res, 404, { error: `Pipeline not found: ${id}` });
      } else {
        sendJson(res, 200, { pipeline });
      }
      return true;
    }

    if (req.method === "PUT") {
      if (!pipelineStore) {
        sendJson(res, 501, { error: "Pipeline store not available" });
        return true;
      }
      const body = await readBody(req);
      if (body === null) {
        sendJson(res, 413, { error: "Request body too large" });
        return true;
      }
      let parsed: { yaml?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON" });
        return true;
      }
      if (!parsed.yaml) {
        sendJson(res, 400, { error: "yaml is required" });
        return true;
      }
      try {
        const saved = await pipelineStore.save(id, parsed.yaml);
        sendJson(res, 200, { pipeline: saved });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        sendJson(res, 400, { error: msg });
      }
      return true;
    }

    if (req.method === "DELETE") {
      if (!pipelineStore) {
        sendJson(res, 501, { error: "Pipeline store not available" });
        return true;
      }
      const deleted = await pipelineStore.delete(id);
      if (!deleted) {
        sendJson(res, 400, { error: "Cannot delete: pipeline not found or is built-in" });
      } else {
        sendJson(res, 200, { ok: true });
      }
      return true;
    }
  }

  if (req.method === "GET" && pathname === "/api/learnings/summary") {
    if (!learningStore) {
      sendJson(res, 501, { error: "Learning store not available" });
      return true;
    }
    sendJson(res, 200, {
      system: await learningStore.getSystemStats(),
      repos: await learningStore.getAllRepoSummaries(),
    });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/learnings/outcomes") {
    if (!learningStore) {
      sendJson(res, 501, { error: "Learning store not available" });
      return true;
    }
    const limit = parseLimit(requestUrl.searchParams.get("limit"));
    let outcomes = await learningStore.getRecentOutcomes(limit);
    const repoFilter = requestUrl.searchParams.get("repo");
    if (repoFilter) outcomes = outcomes.filter((outcome) => outcome.repoSlug === repoFilter);
    const sourceFilter = requestUrl.searchParams.get("source");
    if (sourceFilter) outcomes = outcomes.filter((outcome) => outcome.source === sourceFilter);
    sendJson(res, 200, { outcomes });
    return true;
  }

  if (parts[0] === "api" && parts[1] === "learnings" && parts[2] === "repo" && parts[3]) {
    if (!learningStore) {
      sendJson(res, 501, { error: "Learning store not available" });
      return true;
    }
    const slug = decodeURIComponent(parts.slice(3).join("/"));
    const repoLearnings = await learningStore.getRepoLearnings(slug);
    if (!repoLearnings) {
      sendJson(res, 404, { error: `No learnings for repo: ${slug}` });
    } else {
      sendJson(res, 200, { learnings: repoLearnings });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/eval/results") {
    if (!evalStore) {
      sendJson(res, 501, { error: "Eval store not available" });
      return true;
    }
    const scenario = requestUrl.searchParams.get("scenario");
    const limit = parseLimit(requestUrl.searchParams.get("limit"));
    const results = scenario
      ? await evalStore.getScenarioHistory(scenario, limit)
      : await evalStore.getRecentResults(limit);
    sendJson(res, 200, { results });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/eval/scenarios") {
    try {
      const { loadScenariosFromDir } = await import("../../eval/scenario-loader.js");
      const scenarios = await loadScenariosFromDir("evals");
      sendJson(res, 200, { scenarios: scenarios.map((scenario) => ({ name: scenario.name, description: scenario.description, tags: scenario.tags })) });
    } catch {
      sendJson(res, 200, { scenarios: [] });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/eval/comparison") {
    if (!evalStore) {
      sendJson(res, 501, { error: "Eval store not available" });
      return true;
    }
    const scenario = requestUrl.searchParams.get("scenario");
    if (!scenario) {
      sendJson(res, 400, { error: "Missing 'scenario' query param" });
      return true;
    }
    const comparison = await evalStore.getComparison(scenario);
    sendJson(res, 200, { comparison });
    return true;
  }

  return false;
}
