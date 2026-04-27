export interface WorkItemSlackActionPayload {
  reviewRequestId: string;
  workItemId: string;
  homeChannelId: string;
  homeThreadTs: string;
  requestTitle: string;
  detailUrl?: string;
}

export function buildWorkItemSlackActionValue(payload: WorkItemSlackActionPayload): string {
  return JSON.stringify(payload);
}

export function parseWorkItemSlackActionValue(value: string | undefined): WorkItemSlackActionPayload | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Partial<WorkItemSlackActionPayload>;
    if (!parsed.reviewRequestId || !parsed.workItemId || !parsed.homeChannelId || !parsed.homeThreadTs || !parsed.requestTitle) {
      return undefined;
    }

    return {
      reviewRequestId: parsed.reviewRequestId,
      workItemId: parsed.workItemId,
      homeChannelId: parsed.homeChannelId,
      homeThreadTs: parsed.homeThreadTs,
      requestTitle: parsed.requestTitle,
      detailUrl: parsed.detailUrl,
    };
  } catch {
    return undefined;
  }
}
