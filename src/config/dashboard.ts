import type { AppConfig } from "../config.js";
import type { ParsedEnv } from "./shared.js";
import { parseBoolean, parseInteger } from "./shared.js";

type DashboardConfigSlice = Pick<
  AppConfig,
  | "dashboardEnabled"
  | "dashboardHost"
  | "dashboardPort"
  | "dashboardPublicUrl"
  | "dashboardToken"
  | "teamChannelMap"
>;

export function parseTeamChannelMap(value?: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!value || value.trim() === "") return map;
  try {
    const parsed = JSON.parse(value) as Record<string, string[]>;
    for (const [team, channels] of Object.entries(parsed)) {
      if (Array.isArray(channels)) {
        map.set(team, channels.map((channelId) => String(channelId).trim()).filter(Boolean));
      }
    }
  } catch {
    // Ignore invalid JSON
  }
  return map;
}

export function resolveTeamFromChannel(
  channelId: string,
  teamChannelMap: Map<string, string[]>,
): string | undefined {
  for (const [team, channels] of teamChannelMap) {
    if (channels.includes(channelId)) return team;
  }
  return undefined;
}

export function loadDashboardConfig(parsed: ParsedEnv): DashboardConfigSlice {
  return {
    dashboardEnabled: parseBoolean(parsed.DASHBOARD_ENABLED, true),
    dashboardHost: parsed.DASHBOARD_HOST?.trim() || "127.0.0.1",
    dashboardPort: parseInteger(parsed.DASHBOARD_PORT, 8787),
    dashboardPublicUrl: parsed.DASHBOARD_PUBLIC_URL?.trim() || undefined,
    dashboardToken: parsed.DASHBOARD_TOKEN?.trim() || undefined,
    teamChannelMap: parseTeamChannelMap(parsed.TEAM_CHANNEL_MAP),
  };
}
