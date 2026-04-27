import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import {
  requireDashboardUserActor,
  type DashboardActorPrincipal,
  type DashboardUserActorPrincipal,
} from "../actor-principal.js";
import type { DashboardWorkItemsSource } from "../contracts.js";
import type { ReviewRequestRecord, WorkItemRecord } from "../../work-items/types.js";
import { readBody, requireDashboardActor, sendJson } from "./shared.js";

export interface WorkItemRoutesDeps {
  actorPrincipal?: DashboardActorPrincipal;
  requestUrl: URL;
  workItemsSource?: DashboardWorkItemsSource;
}

export async function handleWorkItemRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: WorkItemRoutesDeps,
): Promise<boolean> {
  const { actorPrincipal, requestUrl, workItemsSource } = deps;

  if (req.method === "GET" && pathname === "/api/work-items") {
    if (!workItemsSource) {
      sendJson(res, 501, { error: "Work item APIs are unavailable" });
      return true;
    }

    const workflow = requestUrl.searchParams.get("workflow") ?? undefined;
    const workItems = await workItemsSource.listWorkItems(workflow || undefined);
    sendJson(res, 200, { workItems });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/work-items/discovery") {
    if (!workItemsSource) {
      sendJson(res, 501, { error: "Work item APIs are unavailable" });
      return true;
    }

    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { error: "Request body too large" });
      return true;
    }
    let parsed: {
      title?: string;
      summary?: string;
      ownerTeamId?: string;
      homeChannelId?: string;
      homeThreadTs?: string;
      originChannelId?: string;
      originThreadTs?: string;
      jiraIssueKey?: string;
    } = {};
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }

    if (!parsed.title) {
      sendJson(res, 400, { error: "title is required" });
      return true;
    }

    let actor: DashboardUserActorPrincipal;
    try {
      actor = requireDashboardUserActor(actorPrincipal);
    } catch (error) {
      sendJson(res, 403, { error: error instanceof Error ? error.message : "Forbidden" });
      return true;
    }

    try {
      const workItem = await workItemsSource.createDiscoveryWorkItem({
        title: parsed.title,
        summary: parsed.summary,
        ownerTeamId: parsed.ownerTeamId,
        homeChannelId: parsed.homeChannelId,
        homeThreadTs: parsed.homeThreadTs,
        originChannelId: parsed.originChannelId,
        originThreadTs: parsed.originThreadTs,
        jiraIssueKey: parsed.jiraIssueKey,
        actor,
      });
      sendJson(res, 201, { workItem });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "Failed to create discovery work item" });
    }
    return true;
  }

  const parts = pathname.split("/").filter(Boolean);

  if (parts[0] === "api" && parts[1] === "work-items" && parts[2]) {
    if (!workItemsSource) {
      sendJson(res, 501, { error: "Work item APIs are unavailable" });
      return true;
    }

    const workItemId = decodeURIComponent(parts[2]);

    if (parts.length === 3 && req.method === "GET") {
      const workItem = await workItemsSource.getWorkItem(workItemId);
      if (!workItem) {
        sendJson(res, 404, { error: `Work item not found: ${workItemId}` });
      } else {
        sendJson(res, 200, { workItem });
      }
      return true;
    }

    if (parts.length === 4 && parts[3] === "review-requests" && req.method === "GET") {
      const reviewRequests = await workItemsSource.listReviewRequestsForWorkItem(workItemId);
      sendJson(res, 200, { reviewRequests });
      return true;
    }

    if (parts.length === 4 && parts[3] === "runs" && req.method === "GET") {
      const runs = await workItemsSource.listRunsForWorkItem(workItemId);
      sendJson(res, 200, { runs });
      return true;
    }

    if (parts.length === 6 && parts[3] === "review-requests" && parts[5] === "comments" && req.method === "GET") {
      const reviewRequestId = decodeURIComponent(parts[4]!);
      const comments = await workItemsSource.listReviewRequestComments(reviewRequestId);
      sendJson(res, 200, { comments });
      return true;
    }

    if (parts.length === 4 && parts[3] === "events" && req.method === "GET") {
      const events = await workItemsSource.listEventsForWorkItem(workItemId);
      sendJson(res, 200, { events });
      return true;
    }

    if (parts.length === 4 && parts[3] === "review-requests" && req.method === "POST") {
      const raw = await readBody(req);
      if (raw === null) {
        sendJson(res, 413, { error: "Request body too large" });
        return true;
      }
      let parsed: {
        requests?: Array<{
          type: ReviewRequestRecord["type"];
          targetType: ReviewRequestRecord["targetType"];
          targetRef: Record<string, unknown>;
          title: string;
          requestMessage?: string;
          focusPoints?: string[];
        }>;
      } = {};
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return true;
      }
      if (!parsed.requests || parsed.requests.length === 0) {
        sendJson(res, 400, { error: "at least one request is required" });
        return true;
      }

      let actor: DashboardUserActorPrincipal;
      try {
        actor = requireDashboardUserActor(actorPrincipal);
      } catch (error) {
        sendJson(res, 403, { error: error instanceof Error ? error.message : "Forbidden" });
        return true;
      }

      try {
        const reviewRequests = await workItemsSource.createReviewRequests({
          workItemId,
          actor,
          requests: parsed.requests,
        });
        sendJson(res, 201, { reviewRequests });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : "Failed to create review requests" });
      }
      return true;
    }

    if (parts.length === 4 && parts[3] === "confirm-discovery" && req.method === "POST") {
      const raw = await readBody(req);
      if (raw === null) {
        sendJson(res, 413, { error: "Request body too large" });
        return true;
      }
      let parsed: { approved?: boolean; jiraIssueKey?: string } = {};
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return true;
      }
      if (typeof parsed.approved !== "boolean") {
        sendJson(res, 400, { error: "approved must be a boolean" });
        return true;
      }

      let actor: DashboardUserActorPrincipal;
      try {
        actor = requireDashboardUserActor(actorPrincipal);
      } catch (error) {
        sendJson(res, 403, { error: error instanceof Error ? error.message : "Forbidden" });
        return true;
      }

      try {
        const workItem = await workItemsSource.confirmDiscovery({
          workItemId,
          approved: parsed.approved,
          actor,
          jiraIssueKey: parsed.jiraIssueKey,
        });
        sendJson(res, 200, { workItem });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : "Failed to confirm discovery" });
      }
      return true;
    }

    if (parts.length === 4 && parts[3] === "stop-processing" && req.method === "POST") {
      const raw = await readBody(req);
      if (raw === null) {
        sendJson(res, 413, { error: "Request body too large" });
        return true;
      }
      try {
        if (raw) JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return true;
      }

      let actor: DashboardUserActorPrincipal;
      try {
        actor = requireDashboardUserActor(actorPrincipal);
      } catch (error) {
        sendJson(res, 403, { error: error instanceof Error ? error.message : "Forbidden" });
        return true;
      }

      try {
        const result = await workItemsSource.stopProcessing({
          workItemId,
          actor,
        });
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : "Failed to stop processing" });
      }
      return true;
    }

    if (parts.length === 4 && parts[3] === "override-state" && req.method === "POST") {
      const raw = await readBody(req);
      if (raw === null) {
        sendJson(res, 413, { error: "Request body too large" });
        return true;
      }
      let parsed: { state?: WorkItemRecord["state"]; substate?: string; reason?: string } = {};
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return true;
      }
      if (!parsed.state || !parsed.reason) {
        sendJson(res, 400, { error: "state and reason are required" });
        return true;
      }

      let actor: DashboardActorPrincipal;
      try {
        actor = requireDashboardActor(actorPrincipal);
      } catch (error) {
        sendJson(res, 403, { error: error instanceof Error ? error.message : "Forbidden" });
        return true;
      }

      try {
        const workItem = await workItemsSource.guardedOverrideState({
          workItemId,
          state: parsed.state,
          substate: parsed.substate,
          actor,
          reason: parsed.reason,
        });
        sendJson(res, 200, { workItem });
      } catch (error) {
        sendJson(res, 409, { error: error instanceof Error ? error.message : "Guarded override rejected" });
      }
      return true;
    }
  }

  if (parts[0] === "api" && parts[1] === "review-requests" && parts[2] && parts[3] === "respond" && req.method === "POST") {
    if (!workItemsSource) {
      sendJson(res, 501, { error: "Work item APIs are unavailable" });
      return true;
    }

    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { error: "Request body too large" });
      return true;
    }
    let parsed: {
      outcome?: NonNullable<ReviewRequestRecord["outcome"]>;
      comment?: string;
    } = {};
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }
    if (!parsed.outcome) {
      sendJson(res, 400, { error: "outcome is required" });
      return true;
    }

    let actor: DashboardUserActorPrincipal;
    try {
      actor = requireDashboardUserActor(actorPrincipal);
    } catch (error) {
      sendJson(res, 403, { error: error instanceof Error ? error.message : "Forbidden" });
      return true;
    }

    try {
      const workItem = await workItemsSource.respondToReviewRequest({
        reviewRequestId: decodeURIComponent(parts[2]),
        outcome: parsed.outcome,
        actor,
        comment: parsed.comment,
      });
      sendJson(res, 200, { workItem });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "Failed to record review response" });
    }
    return true;
  }

  return false;
}
