import type { AppConfig } from "../config.js";
import type { ParsedEnv } from "./shared.js";
import { parseInteger, parseList, parseBoolean } from "./shared.js";

interface IntegrationDefaults {
  appSlug: string;
}

type IntegrationConfigSlice = Pick<
  AppConfig,
  | "slackBotToken"
  | "slackAppToken"
  | "slackSigningSecret"
  | "slackCommandName"
  | "slackAllowedChannels"
  | "slackClientId"
  | "slackClientSecret"
  | "slackAuthRedirectUri"
  | "githubToken"
  | "githubAppId"
  | "githubAppPrivateKey"
  | "githubAppInstallationId"
  | "githubDefaultOwner"
  | "repoAllowlist"
  | "defaultTeamName"
  | "defaultTeamSlackChannelId"
  | "jiraBaseUrl"
  | "jiraCloudId"
  | "jiraUser"
  | "jiraApiToken"
  | "jiraRequestTimeoutMs"
  | "cemsApiUrl"
  | "cemsApiKey"
  | "cemsEnabled"
  | "cemsTeamId"
  | "mcpExtensions"
  | "piAgentExtensions"
>;

export function loadIntegrationConfig(parsed: ParsedEnv, defaults: IntegrationDefaults): IntegrationConfigSlice {
  return {
    slackBotToken: parsed.SLACK_BOT_TOKEN?.trim() || undefined,
    slackAppToken: parsed.SLACK_APP_TOKEN?.trim() || undefined,
    slackSigningSecret: parsed.SLACK_SIGNING_SECRET?.trim() || undefined,
    slackCommandName: parsed.SLACK_COMMAND_NAME?.trim() || defaults.appSlug,
    slackAllowedChannels: parseList(parsed.SLACK_ALLOWED_CHANNELS),
    slackClientId: parsed.SLACK_CLIENT_ID?.trim() || undefined,
    slackClientSecret: parsed.SLACK_CLIENT_SECRET?.trim() || undefined,
    slackAuthRedirectUri: parsed.SLACK_AUTH_REDIRECT_URI?.trim() || undefined,
    githubToken: parsed.GITHUB_TOKEN,
    githubAppId: parsed.GITHUB_APP_ID ? parseInteger(parsed.GITHUB_APP_ID, 0) || undefined : undefined,
    githubAppPrivateKey: parsed.GITHUB_APP_PRIVATE_KEY?.trim() || undefined,
    githubAppInstallationId: parsed.GITHUB_APP_INSTALLATION_ID
      ? parseInteger(parsed.GITHUB_APP_INSTALLATION_ID, 0) || undefined
      : undefined,
    githubDefaultOwner: parsed.GITHUB_DEFAULT_OWNER,
    repoAllowlist: parseList(parsed.REPO_ALLOWLIST),
    defaultTeamName: parsed.DEFAULT_TEAM_NAME?.trim() || "default",
    defaultTeamSlackChannelId: parsed.DEFAULT_TEAM_SLACK_CHANNEL_ID?.trim() || undefined,
    jiraBaseUrl: parsed.JIRA_BASE_URL?.trim() || undefined,
    jiraCloudId: parsed.JIRA_CLOUD_ID?.trim() || undefined,
    jiraUser: parsed.JIRA_USER?.trim() || undefined,
    jiraApiToken: parsed.JIRA_API_TOKEN?.trim() || undefined,
    jiraRequestTimeoutMs: parseInteger(parsed.JIRA_REQUEST_TIMEOUT_MS, 10_000),
    cemsApiUrl: parsed.CEMS_API_URL?.trim() || undefined,
    cemsApiKey: parsed.CEMS_API_KEY?.trim() || undefined,
    cemsEnabled: parseBoolean(parsed.CEMS_ENABLED, false),
    cemsTeamId: parsed.CEMS_TEAM_ID?.trim() || undefined,
    mcpExtensions: parseList(parsed.MCP_EXTENSIONS),
    piAgentExtensions: parseList(parsed.PI_AGENT_EXTENSIONS),
  };
}
