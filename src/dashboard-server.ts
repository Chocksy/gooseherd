import { createServer, type Server } from "node:http";
import type { AppConfig } from "./config.js";
import type { SetupStore } from "./db/setup-store.js";
import type { Database } from "./db/index.js";
import type { AgentProfileStore } from "./db/agent-profile-store.js";
import type { ModelPriceStore } from "./db/model-price-store.js";
import type { EvalStore } from "./eval/eval-store.js";
import { GitHubService } from "./github.js";
import { logError, logInfo } from "./logger.js";
import type { LearningStore } from "./observer/learning-store.js";
import type { PipelineStore } from "./pipeline/pipeline-store.js";
import type { RunManager } from "./run-manager.js";
import type { ArtifactStore } from "./runtime/artifact-store.js";
import type { ControlPlaneStore } from "./runtime/control-plane-store.js";
import { routeControlPlaneRequest } from "./runtime/control-plane-router.js";
import type { RunStore } from "./store.js";
import { DashboardAuthSessionStore } from "./dashboard/auth-session-store.js";
import { checkAuth, type AuthOptions } from "./dashboard/auth.js";
import {
  resolveDashboardActorPrincipal,
} from "./dashboard/actor-principal.js";
import type {
  DashboardConversationSource,
  DashboardObserver,
  DashboardWorkItemsSource,
} from "./dashboard/contracts.js";
import { SlackAuthFlow, isSlackAuthConfigured } from "./dashboard/slack-auth.js";
import { handleAuthRoutes } from "./dashboard/routes/auth-routes.js";
import { handleFeatureRoutes } from "./dashboard/routes/feature-routes.js";
import { handleRunRoutes } from "./dashboard/routes/run-routes.js";
import type { CachedGitHubRepositories } from "./dashboard/routes/settings-routes.js";
import { handleSettingsRoutes } from "./dashboard/routes/settings-routes.js";
import { sendJson } from "./dashboard/routes/shared.js";
import { handleSetupRoutes } from "./dashboard/routes/setup-routes.js";
import { handleWorkItemRoutes } from "./dashboard/routes/work-item-routes.js";
import { UserDirectoryService } from "./user-directory/service.js";

export type { DashboardConversationSource, DashboardObserver, DashboardWorkItemsSource } from "./dashboard/contracts.js";

type DashboardRunManager = Pick<RunManager, "retryRun" | "continueRun" | "getRunChain" | "saveFeedbackFromSlackAction" | "cancelRun" | "enqueueRun">;

export function startDashboardServer(
  config: AppConfig,
  store: RunStore,
  runManager?: DashboardRunManager,
  observer?: DashboardObserver,
  conversationSource?: DashboardConversationSource,
  pipelineStore?: PipelineStore,
  learningStore?: LearningStore,
  setupStore?: SetupStore,
  onSetupComplete?: () => Promise<void>,
  evalStore?: EvalStore,
  agentProfileStore?: AgentProfileStore,
  modelPriceStore?: ModelPriceStore,
  controlPlaneStore?: ControlPlaneStore,
  runnerArtifactStore?: ArtifactStore,
  workItemsSource?: DashboardWorkItemsSource,
  db?: Database,
): Server {
  const githubService = GitHubService.create(config);
  let githubRepositoriesCache: CachedGitHubRepositories | undefined;
  const authSessionStore = db ? new DashboardAuthSessionStore(db) : undefined;
  const slackAuthFlow = new SlackAuthFlow(config);
  const userDirectory = db ? new UserDirectoryService(db) : undefined;

  const server = createServer(async (req, res) => {
    try {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:");

      const requestUrl = new URL(req.url ?? "/", `http://${config.dashboardHost}:${String(config.dashboardPort)}`);
      const pathname = requestUrl.pathname;

      if (controlPlaneStore && runnerArtifactStore) {
        const handled = await routeControlPlaneRequest(req, res, pathname, controlPlaneStore, runnerArtifactStore, store);
        if (handled) return;
      }

      if (pathname.startsWith("/webhooks/")) {
        const handled = await observer?.handleWebhookHttpRequest?.(req, res) ?? false;
        if (handled) return;
      }

      const setupComplete = setupStore ? await setupStore.isComplete() : true;
      const passwordHash = setupStore ? await setupStore.getPasswordHash() : undefined;
      const authOpts: AuthOptions = {
        dashboardToken: config.dashboardToken,
        passwordHash,
        setupComplete,
        slackAuthEnabled: isSlackAuthConfigured(config),
        sessionStore: authSessionStore,
      };

      if (!await checkAuth(req, res, authOpts, pathname)) return;

      const actorPrincipal = await resolveDashboardActorPrincipal(req, authSessionStore);

      if (req.method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (await handleSetupRoutes(req, res, pathname, {
        actorPrincipal,
        config,
        onSetupComplete,
        requestUrl,
        setupComplete,
        setupStore,
      })) return;

      if (await handleAuthRoutes(req, res, pathname, {
        authOpts,
        authSessionStore,
        config,
        db,
        passwordHash,
        requestUrl,
        slackAuthFlow,
      })) return;

      if (await handleSettingsRoutes(req, res, pathname, {
        actorPrincipal,
        agentProfileStore,
        config,
        githubRepositoriesCache,
        githubService,
        modelPriceStore,
        requestUrl,
        setGitHubRepositoriesCache: (cache) => {
          githubRepositoriesCache = cache;
        },
        store,
        userDirectory,
      })) return;

      if (await handleRunRoutes(req, res, pathname, {
        config,
        conversationSource,
        requestUrl,
        runManager,
        store,
      })) return;

      if (await handleWorkItemRoutes(req, res, pathname, {
        actorPrincipal,
        requestUrl,
        workItemsSource,
      })) return;

      if (await handleFeatureRoutes(req, res, pathname, {
        evalStore,
        learningStore,
        observer,
        pipelineStore,
        requestUrl,
      })) return;

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown dashboard error";
      logError("Dashboard request failed", { error: message });
      sendJson(res, 500, { error: "Internal server error" });
    }
  });

  server.listen(config.dashboardPort, config.dashboardHost, () => {
    logInfo("Dashboard server started", {
      url: `http://${config.dashboardHost}:${String(config.dashboardPort)}`,
    });
  });

  return server;
}
