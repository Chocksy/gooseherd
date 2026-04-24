import dotenv from "dotenv";
dotenv.config({ override: true });
import path from "node:path";
import { loadConfig, type AppConfig } from "./config.js";
import { initDatabase, closeDatabase, type Database } from "./db/index.js";
import { RunStore } from "./store.js";
import { GitHubService } from "./github.js";
import type { JiraClient } from "./jira.js";
import { PipelineEngine } from "./pipeline/index.js";
import { CemsProvider } from "./memory/cems-provider.js";
import { RunLifecycleHooks } from "./hooks/run-lifecycle.js";
import { RunManager } from "./run-manager.js";
import { startSlackApp } from "./slack-app.js";
import { startDashboardServer } from "./dashboard-server.js";
import type { DashboardWorkItemsSource } from "./dashboard/contracts.js";
import type {
  DashboardActorPrincipal,
  DashboardUserActorPrincipal,
} from "./dashboard/actor-principal.js";
import { WorkspaceCleaner } from "./workspace-cleaner.js";
import { execSync } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { logError, logInfo, logWarn } from "./logger.js";
import { ContainerManager } from "./sandbox/container-manager.js";
import { setSandboxManager } from "./pipeline/shell.js";
import type { RunSupervisor } from "./supervisor/run-supervisor.js";
import { ConversationStore } from "./orchestrator/conversation-store.js";
import { PipelineStore } from "./pipeline/pipeline-store.js";
import { loadPlugins, getPluginDir } from "./plugins/plugin-loader.js";
import { NODE_HANDLERS, VALID_ACTIONS } from "./pipeline/node-registry.js";
import type { LLMCallerConfig } from "./llm/caller.js";
import { SetupStore } from "./db/setup-store.js";
import { AgentProfileStore } from "./db/agent-profile-store.js";
import { ModelPriceStore } from "./db/model-price-store.js";
import { DockerExecutionBackend } from "./runtime/docker-backend.js";
import { LocalExecutionBackend } from "./runtime/local-backend.js";
import type { RuntimeRegistry } from "./runtime/backend.js";
import { ControlPlaneStore } from "./runtime/control-plane-store.js";
import { FileArtifactStore } from "./runtime/file-artifact-store.js";
import type { ArtifactStore } from "./runtime/artifact-store.js";
import { RuntimeReconciler } from "./runtime/reconciler.js";
import { recoverRunsAfterRestart } from "./runtime/startup-recovery.js";
import { RunContextPrefetcher } from "./runtime/run-context-prefetcher.js";
import {
  resolveKubernetesInternalBaseUrl,
  resolveKubernetesNamespace,
  resolveKubernetesRunnerEnvConfigMapName,
  resolveKubernetesRunnerEnvSecretName,
  resolveKubernetesRunnerImage,
} from "./runtime/kubernetes-env.js";
import type { WorkItemActor } from "./work-items/actor.js";
import {
  hasSandboxRuntimeHotReloadChange,
  preflightSandboxRuntime
} from "./runtime/runtime-mode.js";
import { isFeatureEnabled } from "./utils/feature-flags.js";
import type { ObserverDaemon } from "./observer/index.js";
import type { LearningStore } from "./observer/learning-store.js";
import type { EvalStore } from "./eval/eval-store.js";
import type { WorkItemStore } from "./work-items/store.js";
import type { ReviewRequestStore } from "./work-items/review-request-store.js";
import type { WorkItemEventsStore } from "./work-items/events-store.js";
import type { WorkItemService } from "./work-items/service.js";
import type { WorkItemIdentityStore } from "./work-items/identity-store.js";
import type { WorkItemContextResolver } from "./work-items/context-resolver.js";
import type { GitHubWorkItemSync } from "./work-items/github-sync.js";
import type { JiraWorkItemSync } from "./work-items/jira-sync.js";
import type { WorkItemOrchestrator } from "./work-items/orchestrator.js";

// ── Service container ──

interface Services {
  config: AppConfig;
  store: RunStore;
  agentProfileStore: AgentProfileStore;
  modelPriceStore: ModelPriceStore;
  githubService: GitHubService | undefined;
  memoryProvider: CemsProvider | undefined;
  hooks: RunLifecycleHooks;
  containerManager: ContainerManager | undefined;
  pipelineEngine: PipelineEngine;
  pipelineStore: PipelineStore;
  learningStore?: LearningStore;
  evalStore?: EvalStore;
  webClient: import("@slack/web-api").WebClient | undefined;
  runManager: RunManager;
  conversationStore: ConversationStore;
  controlPlaneStore: ControlPlaneStore;
  runnerArtifactStore: ArtifactStore;
  runtimeReconciler: RuntimeReconciler;
  dashboardWorkItemsSource?: DashboardWorkItemsSource;
  workItemService?: WorkItemService;
  workItemOrchestrator?: WorkItemOrchestrator;
  workItemGitHubSync?: GitHubWorkItemSync;
  workItemJiraSync?: JiraWorkItemSync;
}

type HomeThreadCreator = (input: { channelId: string; text: string }) => Promise<string>;

interface CoreServicesBundle {
  store: RunStore;
  agentProfileStore: AgentProfileStore;
  modelPriceStore: ModelPriceStore;
  githubService: GitHubService | undefined;
  memoryProvider: CemsProvider | undefined;
  hooks: RunLifecycleHooks;
  containerManager: ContainerManager | undefined;
  pipelineStore: PipelineStore;
  pipelineEngine: PipelineEngine;
  learningStore?: LearningStore;
  evalStore?: EvalStore;
  webClient: import("@slack/web-api").WebClient | undefined;
  controlPlaneStore: ControlPlaneStore;
  jiraClient: JiraClient | undefined;
  createHomeThread?: HomeThreadCreator;
}

interface WorkItemServicesBundle {
  createHomeThread?: HomeThreadCreator;
  workItemStore?: WorkItemStore;
  reviewRequestStore?: ReviewRequestStore;
  workItemEventsStore?: WorkItemEventsStore;
  workItemService?: WorkItemService;
  readyForMergeHandler?: (workItem: import("./work-items/types.js").WorkItemRecord) => Promise<void> | void;
  workItemIdentityStore?: WorkItemIdentityStore;
  workItemContextResolver?: WorkItemContextResolver;
  workItemGitHubSync?: GitHubWorkItemSync;
  workItemJiraSync?: JiraWorkItemSync;
  postWorkItemReviewNotifications?:
    | typeof import("./work-items/slack-actions.js").postWorkItemReviewNotifications
    | undefined;
  workItemOrchestratorRef: { current?: WorkItemOrchestrator };
}

interface DashboardWorkItemsBundle {
  dashboardWorkItemsSource?: DashboardWorkItemsSource;
  workItemOrchestrator?: WorkItemOrchestrator;
}

function systemActor(userId: string): WorkItemActor {
  return {
    principalType: "user",
    userId,
    authMethod: "system",
  };
}

function dashboardActor(actor: DashboardActorPrincipal): WorkItemActor {
  if (actor.principalType === "admin_session") {
    return {
      principalType: "admin_session",
      authMethod: "admin_password",
      sessionId: actor.sessionId,
    };
  }

  return dashboardUserActor(actor);
}

function dashboardUserActor(actor: DashboardUserActorPrincipal): WorkItemActor {
  return {
    principalType: "user",
    userId: actor.userId,
    authMethod: actor.authMethod,
    sessionId: actor.sessionId,
  };
}

function slackActor(userId: string): WorkItemActor {
  return {
    principalType: "user",
    userId,
    authMethod: "slack",
  };
}

async function createCoreServices(config: AppConfig, db: Database): Promise<CoreServicesBundle> {
  const observerEnabled = isFeatureEnabled(config, "observer");
  const evalEnabled = isFeatureEnabled(config, "eval");
  const store = new RunStore(db);
  await store.init();
  const agentProfileStore = new AgentProfileStore(db, config);
  await agentProfileStore.init();
  const modelPriceStore = new ModelPriceStore(db);
  await modelPriceStore.seedFallbackPrices();

  const githubService = GitHubService.create(config);
  const memoryProvider = config.cemsEnabled && config.cemsApiUrl && config.cemsApiKey
    ? new CemsProvider({ apiUrl: config.cemsApiUrl, apiKey: config.cemsApiKey, teamId: config.cemsTeamId })
    : undefined;
  const hooks = new RunLifecycleHooks(memoryProvider);
  if (memoryProvider) {
    logInfo("Memory integration enabled", { provider: memoryProvider.name, url: config.cemsApiUrl });
  }

  // Sandbox container manager (Docker-out-of-Docker)
  let containerManager: ContainerManager | undefined;
  const sandboxPreflight = await preflightSandboxRuntime(config, {
    pingDocker: async () => {
      containerManager ??= new ContainerManager();
      return containerManager.ping();
    }
  });
  if (!sandboxPreflight.sandboxEnabled) {
    if (sandboxPreflight.fallbackReason === "missing_host_work_path") {
      logWarn("SANDBOX_HOST_WORK_PATH is required when SANDBOX_RUNTIME=docker — sandbox disabled");
    }
    if (sandboxPreflight.fallbackReason === "docker_unreachable") {
      logWarn("Docker daemon not reachable — sandbox disabled. Mount the Docker socket or set SANDBOX_RUNTIME=local");
    }
    containerManager = undefined;
    config.sandboxEnabled = false;
  } else if (containerManager) {
    const orphans = await containerManager.cleanupOrphans();
    if (orphans > 0) {
      logInfo("Cleaned up orphaned sandbox containers", { count: orphans });
    }
    setSandboxManager(containerManager, config.workRoot);
    logInfo("Sandbox mode enabled", { image: config.sandboxImage, hostWorkPath: config.sandboxHostWorkPath });
  }

  const pipelineStore = new PipelineStore(db);
  await pipelineStore.init(path.resolve("pipelines"));
  logInfo("Pipeline store ready", { count: pipelineStore.list().length });

  const pipelineEngine = new PipelineEngine(config, githubService, hooks, containerManager);
  logInfo("Pipeline engine ready", { pipelineFile: config.pipelineFile });
  const learningStore = observerEnabled
    ? new (await import("./observer/learning-store.js")).LearningStore(db)
    : undefined;
  if (learningStore) {
    await learningStore.load();
  }

  const evalStore = evalEnabled
    ? new (await import("./eval/eval-store.js")).EvalStore(db)
    : undefined;

  const webClient = config.slackBotToken
    ? new (await import("@slack/web-api")).WebClient(config.slackBotToken)
    : undefined;

  const controlPlaneStore = new ControlPlaneStore(db);
  const jiraClient = isFeatureEnabled(config, "workItems")
    ? (await import("./jira.js")).JiraClient.create(config)
    : undefined;
  const createHomeThread = webClient
    ? async (input: { channelId: string; text: string }) => {
        const response = await webClient.chat.postMessage({
          channel: input.channelId,
          text: input.text,
          ...(config.slackCommandName ? { username: config.slackCommandName } : {}),
        });
        if (!response.ts) {
          throw new Error(`Slack did not return a thread timestamp for channel ${input.channelId}`);
        }
        return response.ts;
      }
    : undefined;

  return {
    store,
    agentProfileStore,
    modelPriceStore,
    githubService,
    memoryProvider,
    hooks,
    containerManager,
    pipelineStore,
    pipelineEngine,
    learningStore,
    evalStore,
    webClient,
    controlPlaneStore,
    jiraClient,
    createHomeThread,
  };
}

async function createWorkItemServices(
  config: AppConfig,
  db: Database,
  githubService: GitHubService | undefined,
  jiraClient: JiraClient | undefined,
  createHomeThread?: HomeThreadCreator,
): Promise<WorkItemServicesBundle> {
  if (!isFeatureEnabled(config, "workItems")) {
    return {
      createHomeThread,
      workItemOrchestratorRef: {},
    };
  }

  let workItemStore: WorkItemStore | undefined;
  let reviewRequestStore: ReviewRequestStore | undefined;
  let workItemEventsStore: WorkItemEventsStore | undefined;
  let workItemService: WorkItemService | undefined;
  let readyForMergeHandler: ((workItem: import("./work-items/types.js").WorkItemRecord) => Promise<void> | void) | undefined;
  let workItemIdentityStore: WorkItemIdentityStore | undefined;
  let workItemContextResolver: WorkItemContextResolver | undefined;
  let workItemGitHubSync: GitHubWorkItemSync | undefined;
  let workItemJiraSync: JiraWorkItemSync | undefined;
  let postWorkItemReviewNotifications:
    | typeof import("./work-items/slack-actions.js").postWorkItemReviewNotifications
    | undefined;
  const workItemOrchestratorRef: { current?: WorkItemOrchestrator } = {};

  {
    const [
      workItemStoreMod,
      reviewRequestStoreMod,
      workItemEventsStoreMod,
      workItemServiceMod,
      workItemSlackActionsMod,
      workItemIdentityStoreMod,
      workItemContextResolverMod,
      workItemGitHubSyncMod,
      workItemJiraSyncMod,
      readyForMergeActionsMod,
      userDirectoryServiceMod,
    ] = await Promise.all([
      import("./work-items/store.js"),
      import("./work-items/review-request-store.js"),
      import("./work-items/events-store.js"),
      import("./work-items/service.js"),
      import("./work-items/slack-actions.js"),
      import("./work-items/identity-store.js"),
      import("./work-items/context-resolver.js"),
      import("./work-items/github-sync.js"),
      import("./work-items/jira-sync.js"),
      import("./work-items/ready-for-merge-actions.js"),
      import("./user-directory/service.js"),
    ]);
    const userDirectoryService = new userDirectoryServiceMod.UserDirectoryService(db);
    workItemStore = new workItemStoreMod.WorkItemStore(db);
    reviewRequestStore = new reviewRequestStoreMod.ReviewRequestStore(db);
    workItemEventsStore = new workItemEventsStoreMod.WorkItemEventsStore(db);
    const readyForMergeActions = githubService
      ? new readyForMergeActionsMod.ReadyForMergeActions({
          githubService,
          queueReadyForMergeRun: async (workItemId: string, reason?: string) => {
            await workItemOrchestratorRef.current?.queueReadyForMergeRun(workItemId, reason);
          },
        })
      : undefined;
    readyForMergeHandler = readyForMergeActions?.handleEntry.bind(readyForMergeActions);
    workItemService = new workItemServiceMod.WorkItemService(db, {
      readyForMergeHandler,
    });
    workItemIdentityStore = new workItemIdentityStoreMod.WorkItemIdentityStore(db);
    workItemContextResolver = new workItemContextResolverMod.WorkItemContextResolver(db);
    postWorkItemReviewNotifications = workItemSlackActionsMod.postWorkItemReviewNotifications;

    const requiredWorkItemStore = workItemStore;
    const requiredWorkItemIdentityStore = workItemIdentityStore;
    const requiredWorkItemContextResolver = workItemContextResolver;

    workItemGitHubSync = new workItemGitHubSyncMod.GitHubWorkItemSync(db, {
      adoptionLabels: config.workItemGithubAdoptionLabels,
      githubService,
      readyForMergeHandler,
      resetEngineeringReviewOnNewCommits: config.featureDeliveryResetEngineeringReviewOnNewCommits,
      resetQaReviewOnNewCommits: config.featureDeliveryResetQaReviewOnNewCommits,
      skipQaPreparation: config.featureDeliverySkipQaPreparation,
      skipProductReview: config.featureDeliverySkipProductReview,
      reconcileWorkItem: async (workItemId, reason) => {
        await workItemOrchestratorRef.current?.reconcileWorkItem(workItemId, reason);
      },
      resolveDeliveryContext: async ({ jiraIssueKey, repo, prNumber, prTitle, authorLogin }) => {
        const githubLogin = authorLogin?.trim();
        if (!githubLogin) {
          return undefined;
        }

        const defaultTeam = await requiredWorkItemIdentityStore.getDefaultTeam();
        if (!defaultTeam) {
          return undefined;
        }

        let actor = await requiredWorkItemIdentityStore.getUserByGitHubLogin(githubLogin);
        if (!actor) {
          const created = await userDirectoryService.createUser({
            displayName: githubLogin,
            slackUserId: null,
            githubLogin,
            jiraAccountId: null,
            primaryTeamId: null,
            isActive: true,
          });
          await requiredWorkItemIdentityStore.ensureUserTeamMembership(created.id, defaultTeam.id, "default_team", true);
          await userDirectoryService.updateUser(created.id, {
            displayName: created.displayName,
            slackUserId: created.slackUserId ?? null,
            githubLogin: created.githubLogin,
            jiraAccountId: created.jiraAccountId ?? null,
            primaryTeamId: defaultTeam.id,
            isActive: created.isActive,
          });
          actor = await requiredWorkItemIdentityStore.getUser(created.id);
        } else {
          const primaryTeam = await requiredWorkItemIdentityStore.getPrimaryTeamForUser(actor.id);
          if (!primaryTeam) {
            await requiredWorkItemIdentityStore.ensureUserTeamMembership(actor.id, defaultTeam.id, "default_team", true);
            await userDirectoryService.updateUser(actor.id, {
              displayName: actor.displayName,
              slackUserId: actor.slackUserId ?? null,
              githubLogin: actor.githubLogin ?? null,
              jiraAccountId: actor.jiraAccountId ?? null,
              primaryTeamId: defaultTeam.id,
              isActive: actor.isActive,
            });
            actor = await requiredWorkItemIdentityStore.getUser(actor.id);
          }
        }

        if (!actor) {
          return undefined;
        }

        const resolvedPrimaryTeam = await requiredWorkItemIdentityStore.getPrimaryTeamForUser(actor.id);
        const ownerTeamId = resolvedPrimaryTeam?.id ?? defaultTeam.id;
        const existing = repo && typeof prNumber === "number"
          ? await requiredWorkItemStore.findByRepoAndGitHubPrNumber(repo, prNumber)
          : undefined;
        if (existing) {
          return {
            ownerTeamId: existing.ownerTeamId,
            homeChannelId: existing.homeChannelId,
            homeThreadTs: existing.homeThreadTs,
            createdByUserId: existing.createdByUserId,
            originChannelId: existing.originChannelId,
            originThreadTs: existing.originThreadTs,
          };
        }

        return requiredWorkItemContextResolver.resolveDeliveryContext({
          createdByUserId: actor.id,
          ownerTeamId,
          title: prTitle ?? jiraIssueKey ?? (typeof prNumber === "number" ? `PR #${String(prNumber)}` : "Delivery work item"),
          createHomeThread,
        });
      },
    });

    workItemJiraSync = new workItemJiraSyncMod.JiraWorkItemSync(db, {
      resolveDiscoveryContext: (input) => requiredWorkItemContextResolver.resolveDiscoveryContext({
        ...input,
        createHomeThread,
      }),
      resolveDeliveryContext: (input) => requiredWorkItemContextResolver.resolveDeliveryContext({
        ...input,
        createHomeThread,
      }),
    });
  }

  return {
    createHomeThread,
    workItemStore,
    reviewRequestStore,
    workItemEventsStore,
    workItemService,
    readyForMergeHandler,
    workItemIdentityStore,
    workItemContextResolver,
    workItemGitHubSync,
    workItemJiraSync,
    postWorkItemReviewNotifications,
    workItemOrchestratorRef,
  };
}

async function createDashboardWorkItemsBundle(
  config: AppConfig,
  db: Database,
  store: RunStore,
  runManager: RunManager,
  githubService: GitHubService | undefined,
  webClient: import("@slack/web-api").WebClient | undefined,
  workItemServices: WorkItemServicesBundle,
): Promise<DashboardWorkItemsBundle> {
  const {
    createHomeThread,
    workItemStore,
    reviewRequestStore,
    workItemEventsStore,
    workItemService,
    readyForMergeHandler,
    workItemIdentityStore,
    workItemContextResolver,
    postWorkItemReviewNotifications,
    workItemOrchestratorRef,
  } = workItemServices;

  if (
    !isFeatureEnabled(config, "workItems") ||
    !workItemStore ||
    !reviewRequestStore ||
    !workItemEventsStore ||
    !workItemService ||
    !workItemIdentityStore ||
    !workItemContextResolver ||
    !postWorkItemReviewNotifications
  ) {
    return {};
  }

  const { WorkItemOrchestrator } = await import("./work-items/orchestrator.js");
  const requiredWorkItemStore = workItemStore;
  const requiredReviewRequestStore = reviewRequestStore;
  const requiredWorkItemEventsStore = workItemEventsStore;
  const requiredWorkItemService = workItemService;
  const requiredWorkItemIdentityStore = workItemIdentityStore;
  const requiredWorkItemContextResolver = workItemContextResolver;
  const postReviewNotifications = postWorkItemReviewNotifications;

  const dashboardWorkItemsSource: DashboardWorkItemsSource = {
    listRunsForWorkItem: async (workItemId) => {
      const runs = await store.listRunsForWorkItem(workItemId);
      return runs.map((run) => ({
        id: run.id,
        status: run.status,
        phase: run.phase,
        title: run.title,
        repoSlug: run.repoSlug,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      }));
    },
    listWorkItems: async (workflow?: string) => {
      const activeStatuses = new Set(["queued", "running", "validating", "pushing", "awaiting_ci", "ci_fixing"]);
      const workItems = await requiredWorkItemStore.listWorkItems();
      const filtered = workflow ? workItems.filter((workItem) => workItem.workflow === workflow) : workItems;
      return Promise.all(filtered.map(async (workItem) => {
        const runs = await store.listRunsForWorkItem(workItem.id);
        return {
          ...workItem,
          activeRunCount: runs.filter((run) => activeStatuses.has(run.status)).length,
        };
      }));
    },
    getWorkItem: async (id) => {
      const workItem = await requiredWorkItemStore.getWorkItem(id);
      if (!workItem) {
        return undefined;
      }
      const activeStatuses = new Set(["queued", "running", "validating", "pushing", "awaiting_ci", "ci_fixing"]);
      const runs = await store.listRunsForWorkItem(id);
      return {
        ...workItem,
        activeRunCount: runs.filter((run) => activeStatuses.has(run.status)).length,
      };
    },
    listReviewRequestsForWorkItem: (workItemId) => requiredReviewRequestStore.listReviewRequestsForWorkItem(workItemId),
    listReviewRequestComments: (reviewRequestId) => requiredReviewRequestStore.listComments(reviewRequestId),
    listEventsForWorkItem: (workItemId) => requiredWorkItemEventsStore.listForWorkItem(workItemId),
    createDiscoveryWorkItem: async (input) => {
      if (!input.ownerTeamId || !input.homeChannelId || !input.homeThreadTs) {
        const resolved = await requiredWorkItemContextResolver.resolveDiscoveryContext({
          createdByUserId: input.actor.userId,
          ownerTeamId: input.ownerTeamId,
          originChannelId: input.originChannelId,
          originThreadTs: input.originThreadTs,
          title: input.title,
          createHomeThread,
        });
        return requiredWorkItemService.createDiscoveryWorkItem({
          title: input.title,
          summary: input.summary,
          ownerTeamId: resolved.ownerTeamId,
          homeChannelId: resolved.homeChannelId,
          homeThreadTs: resolved.homeThreadTs,
          originChannelId: resolved.originChannelId,
          originThreadTs: resolved.originThreadTs,
          jiraIssueKey: input.jiraIssueKey,
          createdByUserId: resolved.createdByUserId,
        });
      }
      return requiredWorkItemService.createDiscoveryWorkItem({
        title: input.title,
        summary: input.summary,
        ownerTeamId: input.ownerTeamId,
        homeChannelId: input.homeChannelId,
        homeThreadTs: input.homeThreadTs,
        originChannelId: input.originChannelId,
        originThreadTs: input.originThreadTs,
        jiraIssueKey: input.jiraIssueKey,
        createdByUserId: input.actor.userId,
      });
    },
    createReviewRequests: async (input) => {
      const reviewRequests = await requiredWorkItemService.requestReview({
        workItemId: input.workItemId,
        actor: dashboardUserActor(input.actor),
        requests: input.requests,
      });
      if (webClient) {
        const workItem = await requiredWorkItemService.getWorkItem(input.workItemId);
        if (workItem) {
          await postReviewNotifications(webClient, config, requiredWorkItemIdentityStore, workItem, reviewRequests);
        }
      }
      return reviewRequests;
    },
    respondToReviewRequest: (input) => {
      return requiredWorkItemService.recordReviewOutcome({
        reviewRequestId: input.reviewRequestId,
        actor: dashboardUserActor(input.actor),
        outcome: input.outcome,
        comment: input.comment,
      });
    },
    confirmDiscovery: (input) => requiredWorkItemService.confirmDiscovery({
      workItemId: input.workItemId,
      approved: input.approved,
      actor: dashboardUserActor(input.actor),
      jiraIssueKey: input.jiraIssueKey,
    }),
    stopProcessing: (input) => requiredWorkItemService.stopProcessing({
      workItemId: input.workItemId,
      actor: dashboardUserActor(input.actor),
      cancelRun: (runId) => runManager.cancelRun(runId),
    }),
    guardedOverrideState: (input) => requiredWorkItemService.guardedOverrideState({
      workItemId: input.workItemId,
      state: input.state,
      substate: input.substate,
      actor: dashboardActor(input.actor),
      reason: input.reason,
      hasActiveProcessing: async (workItem) => requiredWorkItemService.hasActiveProcessing(workItem.id),
    }),
  };

  const workItemOrchestrator = new WorkItemOrchestrator(db, {
    config: {
      defaultBaseBranch: config.defaultBaseBranch,
      sandboxRuntime: config.sandboxRuntime,
      autoReviewBranchSyncMaxBehindCommits: config.autoReviewBranchSyncMaxBehindCommits,
      featureDeliverySkipQaPreparation: config.featureDeliverySkipQaPreparation,
      featureDeliverySkipProductReview: config.featureDeliverySkipProductReview,
    },
    readyForMergeHandler,
    runManager,
  });
  workItemOrchestratorRef.current = workItemOrchestrator;

  if (
    config.autoReviewBranchSyncEnabled &&
    githubService &&
    typeof githubService.compareBranchRefs === "function"
  ) {
    const { startBranchSyncMonitor } = await import("./work-items/branch-sync-monitor.js");
    startBranchSyncMonitor({
      workItems: requiredWorkItemStore,
      runs: store,
      maxBehindCommits: config.autoReviewBranchSyncMaxBehindCommits,
      intervalMs: config.autoReviewBranchSyncIntervalMs,
      compareBranchRefs: githubService.compareBranchRefs.bind(githubService),
      queueBranchSyncRun: async (workItemId, reason) => {
        await workItemOrchestrator.queueBranchSyncRun(workItemId, reason);
      },
    });
  }

  return {
    dashboardWorkItemsSource,
    workItemOrchestrator,
  };
}

async function createServices(config: AppConfig, db: Database): Promise<Services> {
  const workItemsEnabled = isFeatureEnabled(config, "workItems");
  const coreServices = await createCoreServices(config, db);
  const workItemServices = await createWorkItemServices(
    config,
    db,
    coreServices.githubService,
    coreServices.jiraClient,
    coreServices.createHomeThread,
  );

  const runContextPrefetcher = workItemsEnabled
    ? new RunContextPrefetcher({
        workItems: workItemServices.workItemStore!,
        github: coreServices.githubService,
        jira: coreServices.jiraClient,
      })
    : undefined;
  const runtimeFactsReader = config.sandboxRuntime === "kubernetes"
    ? new (await import("./runtime/kubernetes/runtime-facts.js")).KubernetesRuntimeFactsReader({
        namespace: resolveKubernetesNamespace(),
      })
    : {
        getTerminalFact: async () => "running" as const,
      };
  const runtimeReconciler = new RuntimeReconciler(
    coreServices.controlPlaneStore,
    runtimeFactsReader,
    coreServices.store
  );
  const publicBaseUrl = config.dashboardPublicUrl ?? `http://${config.dashboardHost}:${String(config.dashboardPort)}`;
  const runnerArtifactStore: ArtifactStore = new FileArtifactStore(
    config.workRoot,
    publicBaseUrl,
    coreServices.controlPlaneStore,
  );
  const kubernetesBackend = config.sandboxRuntime === "kubernetes"
    ? new (await import("./runtime/kubernetes-backend.js")).KubernetesExecutionBackend({
        controlPlaneStore: coreServices.controlPlaneStore,
        artifactStore: runnerArtifactStore,
        runStore: coreServices.store,
        workRoot: config.workRoot,
        runnerImage: resolveKubernetesRunnerImage(),
        internalBaseUrl: resolveKubernetesInternalBaseUrl(config),
        dryRun: config.dryRun,
        runnerEnvSecretName: resolveKubernetesRunnerEnvSecretName(),
        runnerEnvConfigMapName: resolveKubernetesRunnerEnvConfigMapName(),
        namespace: resolveKubernetesNamespace(),
        runnerConfigSource: config,
      })
    : undefined;
  const runtimeRegistry: RuntimeRegistry = {
    local: new LocalExecutionBackend(coreServices.pipelineEngine),
    docker: new DockerExecutionBackend(coreServices.pipelineEngine),
    kubernetes: kubernetesBackend,
  };
  const runManager = new RunManager(
    config,
    coreServices.store,
    runtimeRegistry,
    coreServices.webClient,
    coreServices.hooks,
    coreServices.pipelineStore,
    coreServices.learningStore,
    runContextPrefetcher,
  );
  runManager.onRunTerminal((runId, _status, runtime) => {
    if (runtime !== "kubernetes") {
      return;
    }

    runtimeReconciler.reconcileRun(runId).catch((error) => {
      const message = error instanceof Error ? error.message : "unknown";
      logError("Failed to reconcile terminal kubernetes run", { runId, error: message });
    });
  });

  const conversationStore = new ConversationStore({ db });
  await conversationStore.load();
  conversationStore.startCleanupTimer();

  const dashboardWorkItems = await createDashboardWorkItemsBundle(
    config,
    db,
    coreServices.store,
    runManager,
    coreServices.githubService,
    coreServices.webClient,
    workItemServices,
  );

  return {
    config,
    store: coreServices.store,
    agentProfileStore: coreServices.agentProfileStore,
    modelPriceStore: coreServices.modelPriceStore,
    githubService: coreServices.githubService,
    memoryProvider: coreServices.memoryProvider,
    hooks: coreServices.hooks,
    containerManager: coreServices.containerManager,
    pipelineEngine: coreServices.pipelineEngine,
    pipelineStore: coreServices.pipelineStore,
    learningStore: coreServices.learningStore,
    evalStore: coreServices.evalStore,
    webClient: coreServices.webClient,
    runManager,
    conversationStore,
    controlPlaneStore: coreServices.controlPlaneStore,
    runnerArtifactStore,
    runtimeReconciler,
    dashboardWorkItemsSource: dashboardWorkItems.dashboardWorkItemsSource,
    workItemService: workItemServices.workItemService,
    workItemOrchestrator: dashboardWorkItems.workItemOrchestrator,
    workItemGitHubSync: workItemServices.workItemGitHubSync,
    workItemJiraSync: workItemServices.workItemJiraSync,
  };
}

// ── Helpers ──

function checkAgentDefault(config: { agentCommandTemplate: string }): void {
  if (!config.agentCommandTemplate.includes("dummy-agent")) return;

  try {
    execSync("which pi", { stdio: "pipe" });
    logWarn("Using dummy agent but pi is on PATH. Set AGENT_COMMAND_TEMPLATE to use the real agent.");
  } catch {
    logWarn("No AGENT_COMMAND_TEMPLATE set and pi not found on PATH. Using dummy agent.");
  }
}

async function applyActiveAgentProfile(config: AppConfig, agentProfileStore: AgentProfileStore): Promise<void> {
  const activeAgentProfile = await agentProfileStore.getActive();
  if (activeAgentProfile) {
    config.agentCommandTemplate = await agentProfileStore.getEffectiveCommandTemplate(
      config.baseAgentCommandTemplate ?? config.agentCommandTemplate,
    );
    config.activeAgentProfile = {
      id: activeAgentProfile.id,
      name: activeAgentProfile.name,
      runtime: activeAgentProfile.runtime,
      provider: activeAgentProfile.provider,
      model: activeAgentProfile.model,
      commandTemplate: config.agentCommandTemplate,
      source: "profile",
    };
    return;
  }

  config.activeAgentProfile = {
    id: "env-template",
    name: "Raw AGENT_COMMAND_TEMPLATE",
    runtime: "custom",
    commandTemplate: config.agentCommandTemplate,
    source: "env",
  };
}

function wireWorkItemLifecycleHandlers(runManager: RunManager, workItemOrchestrator?: WorkItemOrchestrator): void {
  if (!workItemOrchestrator) {
    return;
  }

  runManager.onRunStatusChange((runId, status) => {
    if (status !== "awaiting_ci" && status !== "completed") {
      return;
    }

    workItemOrchestrator.writebackWorkItem(runId).catch((error) => {
      const message = error instanceof Error ? error.message : "unknown";
      logError("Failed to write back auto-review run status", { runId, status, error: message });
    });
  });

  runManager.onRunTerminal((runId, status) => {
    if (status !== "failed") {
      return;
    }

    workItemOrchestrator.handlePrefetchFailure(runId).catch((error) => {
      const message = error instanceof Error ? error.message : "unknown";
      logError("Failed to roll back auto-review work item after prefetch failure", { runId, error: message });
    });
  });
}

async function startSessionServices(config: AppConfig, db: Database, svc: Services): Promise<void> {
  if (!isFeatureEnabled(config, "sessions") || !config.openrouterApiKey) {
    return;
  }

  const { SessionManager, createLLMPlanGoal, createLLMEvaluateProgress } = await import("./sessions/session-manager.js");
  const { callLLMForJSON } = await import("./llm/caller.js");
  const sessionLlmConfig: LLMCallerConfig = {
    apiKey: config.openrouterApiKey,
    defaultModel: config.defaultLlmModel,
    defaultTimeoutMs: 30_000,
    providerPreferences: config.openrouterProviderPreferences,
  };
  const planGoal = createLLMPlanGoal(async <T>(system: string, userMessage: string, maxTokens: number) => {
    const { parsed } = await callLLMForJSON<T>(sessionLlmConfig, { system, userMessage, maxTokens });
    return parsed;
  });
  const evaluateProgress = createLLMEvaluateProgress(async <T>(system: string, userMessage: string, maxTokens: number) => {
    const { parsed } = await callLLMForJSON<T>(sessionLlmConfig, { system, userMessage, maxTokens });
    return parsed;
  });
  const sessionManager = new SessionManager(db, svc.runManager, planGoal, evaluateProgress);
  await sessionManager.load();
  svc.runManager.onRunTerminal((runId, status) => {
    sessionManager.onRunCompleted(runId, status).catch((err) => {
      const msg = err instanceof Error ? err.message : "unknown";
      logWarn("SessionManager: onRunCompleted error", { runId, error: msg });
    });
  });
  logInfo("Session manager enabled");
}

async function startBackgroundServices(config: AppConfig, db: Database, svc: Services): Promise<void> {
  await startSessionServices(config, db, svc);

  const cleaner = new WorkspaceCleaner(config, svc.store);
  cleaner.start();

  if (isFeatureEnabled(config, "supervisor")) {
    const { RunSupervisor } = await import("./supervisor/run-supervisor.js");
    const supervisor = new RunSupervisor(config, svc.runManager, svc.pipelineEngine, svc.store, svc.webClient);
    supervisor.start();
    globalRefs.supervisor = supervisor;
    logInfo("Run supervisor enabled");
  }

  if (!isFeatureEnabled(config, "observer")) {
    return;
  }

  const { ObserverDaemon } = await import("./observer/index.js");
  const workItemGitHubSyncMod = svc.workItemGitHubSync
    ? await import("./work-items/github-sync.js")
    : undefined;
  const workItemJiraSyncMod = svc.workItemJiraSync
    ? await import("./work-items/jira-sync.js")
    : undefined;
  const tokenGetter = svc.githubService ? () => svc.githubService!.getToken() : undefined;
  const observer = new ObserverDaemon(config, svc.runManager, svc.webClient, tokenGetter, svc.learningStore, db, {
    onGitHubWebhookPayload: async (headers, payload) => {
      if (!svc.workItemGitHubSync || !workItemGitHubSyncMod) return;
      const webhookPayload = workItemGitHubSyncMod.parseGitHubWorkItemWebhookPayload(headers, payload);
      if (!webhookPayload) return;
      await svc.workItemGitHubSync.handleWebhookPayload(webhookPayload);
    },
    onAdapterPayload: async (source, _headers, payload) => {
      if (!svc.workItemJiraSync || !workItemJiraSyncMod) return false;
      if (source !== "jira") return false;
      const webhookPayload = workItemJiraSyncMod.parseJiraWorkItemWebhookPayload(payload);
      if (!webhookPayload) return false;
      await svc.workItemJiraSync.handleWebhookPayload(webhookPayload);
      return true;
    },
  });
  await observer.start();
  globalRefs.observer = observer;
  logInfo("Observer system enabled");

  try {
    let debounce: NodeJS.Timeout | undefined;
    globalRefs.rulesWatcher = watch(config.observerRulesFile, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        logInfo("Trigger rules file changed — reloading");
        observer.reloadRules().catch((err) => {
          const msg = err instanceof Error ? err.message : "unknown";
          logError("Failed to reload trigger rules", { error: msg });
        });
      }, 500);
    });
    logInfo("Watching trigger rules for hot-reload", { file: config.observerRulesFile });
  } catch {
    logWarn("Could not watch trigger rules file (file may not exist yet)", { file: config.observerRulesFile });
  }
}

async function startInteractiveServices(
  config: AppConfig,
  db: Database,
  svc: Services,
  setupStore: SetupStore,
  workItemsEnabled: boolean,
): Promise<void> {
  if (config.dashboardEnabled) {
    startDashboardServer(
      config, svc.store, svc.runManager, globalRefs.observer, svc.conversationStore, svc.pipelineStore, svc.learningStore,
      setupStore,
      async () => {
        await setupStore.applyToEnv();
        logInfo("Setup wizard completed — restarting to apply new configuration");
        setTimeout(() => shutdown("WIZARD_COMPLETE"), 1000);
      },
      svc.evalStore,
      svc.agentProfileStore,
      svc.controlPlaneStore,
      svc.runnerArtifactStore,
      workItemsEnabled ? svc.dashboardWorkItemsSource : undefined,
      db,
      svc.modelPriceStore,
    );
  }

  const slackConfigured = Boolean(config.slackBotToken && config.slackAppToken && config.slackSigningSecret);
  if (slackConfigured) {
    await startSlackApp(
      config,
      svc.runManager,
      globalRefs.observer,
      svc.memoryProvider,
      svc.githubService,
      svc.conversationStore,
      workItemsEnabled ? {
        recordReviewOutcome: async (input) => {
          const { WorkItemIdentityStore } = await import("./work-items/identity-store.js");
          const actor = input.authorUserId
            ? await new WorkItemIdentityStore(db).getUserBySlackUserId(input.authorUserId)
            : undefined;
          if (!actor) {
            throw new Error("Unknown Slack actor");
          }
          return svc.workItemService!.recordReviewOutcome({
            reviewRequestId: input.reviewRequestId,
            actor: slackActor(actor.id),
            outcome: input.outcome,
            comment: input.comment,
            source: "slack",
          });
        },
      } : undefined,
    );
    return;
  }

  logInfo("Slack tokens not configured — running in dashboard-only mode");
}

// ── Main ──

async function main(): Promise<void> {
  // 1. Database + setup wizard config injection
  const db = await initDatabase(process.env.DATABASE_URL ?? "postgres://gooseherd:gooseherd@postgres:5432/gooseherd");
  const setupStore = new SetupStore(db, process.env.ENCRYPTION_KEY);
  if (await setupStore.isComplete()) {
    await setupStore.applyToEnv();
  }

  // 2. Load config (reads env vars, including any injected by wizard)
  const config = loadConfig();
  const workItemsEnabled = isFeatureEnabled(config, "workItems");

  // 3. Bootstrap default team (required for work-item startup paths)
  if (workItemsEnabled) {
    const { ensureDefaultTeam } = await import("./work-items/default-team-bootstrap.js");
    await ensureDefaultTeam(db, config);
  }

  // 4. One-time registrations (plugins)
  const pluginResult = await loadPlugins(getPluginDir());
  if (pluginResult.loaded.length > 0) {
    logInfo("Plugins loaded", { count: pluginResult.loaded.length, names: pluginResult.loaded });
  }
  for (const [action, handler] of Object.entries(pluginResult.nodeHandlers)) {
    NODE_HANDLERS[action] = handler;
    VALID_ACTIONS.add(action);
  }

  // 5. Create core services
  const svc = await createServices(config, db);
  await applyActiveAgentProfile(config, svc.agentProfileStore);
  checkAgentDefault(config);
  globalRefs.config = config;

  wireWorkItemLifecycleHandlers(svc.runManager, svc.workItemOrchestrator);

  // 5. Recover stale in-progress runs from before restart
  const recovery = await recoverRunsAfterRestart(
    svc.store,
    svc.runManager,
    svc.runtimeReconciler,
    "Recovered after process restart. Auto-requeued."
  );
  if (recovery.recoveredRuns.length > 0) {
    logInfo("Recovered stale in-progress runs", { count: recovery.recoveredRuns.length });
  }
  if (recovery.requeuedCount > 0) {
    logInfo("Auto-requeued recovered runs", { count: recovery.requeuedCount });
  }
  if (recovery.skippedLocalCount > 0) {
    logInfo("Skipped auto-requeue for local-trigger runs", { count: recovery.skippedLocalCount });
  }
  if (recovery.kubernetesRuns.length > 0) {
    logInfo("Reconciled in-progress kubernetes runs after restart", { count: recovery.kubernetesRuns.length });
  }

  await startBackgroundServices(config, db, svc);
  await startInteractiveServices(config, db, svc, setupStore, workItemsEnabled);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  logError("Gooseherd failed to start", { error: message });
  process.exit(1);
});

// ── Shutdown + signals ──

async function shutdown(signal: string): Promise<void> {
  logInfo(`Shutting down (${signal})`);
  try {
    globalRefs.supervisor?.stop();
  } catch { /* swallow */ }
  try {
    const { observer: obs } = globalRefs;
    if (obs) await obs.stop();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    logError("Error during observer shutdown", { error: msg });
  }
  await closeDatabase();
  process.exit(0);
}

const globalRefs: {
  observer?: ObserverDaemon;
  supervisor?: RunSupervisor;
  rulesWatcher?: FSWatcher;
  config?: AppConfig;
} = {};

process.on("SIGINT", () => { shutdown("SIGINT"); });
process.on("SIGTERM", () => { shutdown("SIGTERM"); });

// SIGHUP → config hot-reload
process.on("SIGHUP", () => {
  logInfo("SIGHUP received — reloading configuration");
  try {
    dotenv.config({ override: true });
    const newConfig = loadConfig();
    if (globalRefs.config && hasSandboxRuntimeHotReloadChange(globalRefs.config, newConfig)) {
      logWarn("Sandbox runtime config changes require restart; ignoring hot reload", {
        currentRuntime: globalRefs.config.sandboxRuntime,
        nextRuntime: newConfig.sandboxRuntime
      });
      return;
    }
    if (globalRefs.observer) {
      globalRefs.observer.reload(newConfig).catch((err) => {
        const msg = err instanceof Error ? err.message : "unknown";
        logError("Config hot-reload failed for observer", { error: msg });
      });
    }
    globalRefs.config = newConfig;
    logInfo("Configuration reloaded successfully");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    logError("Config hot-reload failed", { error: msg });
  }
});
