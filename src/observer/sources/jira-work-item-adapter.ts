import type { TriggerEvent } from "../types.js";
import type { WebhookAdapter } from "./adapter-registry.js";

function readBearerToken(headers: Record<string, string>): string | undefined {
  const auth = headers["authorization"];
  if (!auth) return undefined;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

export const jiraWorkItemAdapter: WebhookAdapter = {
  source: "jira",
  verifySignature(_body: string, headers: Record<string, string>, secret: string): boolean {
    const bearer = readBearerToken(headers);
    const headerSecret = headers["x-webhook-secret"] || headers["x-gooseherd-webhook-secret"];
    return bearer === secret || headerSecret === secret;
  },
  parseEvent(): TriggerEvent | null {
    return null;
  },
};
