import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("createServices passes runtime and delivery review config into WorkItemOrchestrator", async () => {
  const indexPath = path.resolve(import.meta.dirname, "../src/index.ts");
  const source = await readFile(indexPath, "utf8");

  assert.match(
    source,
    /workItemOrchestrator\s*=\s*new WorkItemOrchestrator\(db,\s*\{\s*config:\s*\{[\s\S]*defaultBaseBranch:\s*config\.defaultBaseBranch,[\s\S]*sandboxRuntime:\s*config\.sandboxRuntime,[\s\S]*featureDeliverySkipQaPreparation:\s*config\.featureDeliverySkipQaPreparation,[\s\S]*featureDeliverySkipProductReview:\s*config\.featureDeliverySkipProductReview,[\s\S]*\},\s*(?:readyForMergeHandler,\s*)?runManager,\s*\}\);/s,
  );
});

test("main wires failed terminal runs into auto-review prefetch rollback handling", async () => {
  const indexPath = path.resolve(import.meta.dirname, "../src/index.ts");
  const source = await readFile(indexPath, "utf8");

  assert.match(
    source,
    /runManager\.onRunTerminal\(\(runId,\s*status\)\s*=>\s*\{\s*if \(status !== "failed"\) \{\s*return;\s*\}\s*workItemOrchestrator\.handlePrefetchFailure\(runId\)/s,
  );
});

test("main does not drive work item progression from run status callbacks", async () => {
  const indexPath = path.resolve(import.meta.dirname, "../src/index.ts");
  const source = await readFile(indexPath, "utf8");

  assert.doesNotMatch(source, /onRunStatusChange\([\s\S]*writebackWorkItem/);
  assert.match(source, /new RunCheckpointProcessor\(db/);
  assert.match(source, /const replay = await svc\.runCheckpointProcessor\.processUnprocessed\(\{ limit: 500 \}\)/);
  assert.doesNotMatch(source, /^\s*await svc\.runCheckpointProcessor\.processUnprocessed\(\{ limit: 500 \}\);\s*$/m);
});

test("migration journal includes run_checkpoints and migration backfills legacy awaiting_ci runs", async () => {
  const journal = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../drizzle/meta/_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const migration = await readFile(path.resolve(import.meta.dirname, "../drizzle/0020_run_checkpoints.sql"), "utf8");

  assert.ok(journal.entries.some((entry) =>
    entry.idx === 20 &&
    entry.tag === "0020_run_checkpoints" &&
    entry.when > 1779496800000
  ));
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "run_checkpoints"/);
  assert.match(migration, /INSERT INTO "run_checkpoints"[\s\S]*"status" = 'awaiting_ci'/);
  assert.match(migration, /"intent_kind" IN \([\s\S]*'feature_delivery\.self_review'[\s\S]*'feature_delivery\.repair_ci'/);
  assert.match(migration, /UPDATE "runs"[\s\S]*"status" = 'running'[\s\S]*WHERE "status" = 'awaiting_ci'/);
});

test("phase 0 startup wiring uses dynamic imports for optional modules", async () => {
  const indexPath = path.resolve(import.meta.dirname, "../src/index.ts");
  const source = await readFile(indexPath, "utf8");

  assert.doesNotMatch(source, /import \{ ObserverDaemon \} from "\.\/observer\/index\.js";/);
  assert.doesNotMatch(source, /import \{ SessionManager, createLLMPlanGoal, createLLMEvaluateProgress \} from "\.\/sessions\/session-manager\.js";/);
  assert.doesNotMatch(source, /import \{ EvalStore \} from "\.\/eval\/eval-store\.js";/);
  assert.doesNotMatch(source, /import \{ WorkItemStore \} from "\.\/work-items\/store\.js";/);
  assert.doesNotMatch(source, /import \{ WorkItemService \} from "\.\/work-items\/service\.js";/);

  assert.match(source, /await import\("\.\/observer\/index\.js"\)/);
  assert.match(source, /await import\("\.\/sessions\/session-manager\.js"\)/);
  assert.match(source, /await import\("\.\/eval\/eval-store\.js"\)/);
  assert.match(source, /import\("\.\/work-items\/store\.js"\)/);
  assert.match(source, /import\("\.\/work-items\/service\.js"\)/);
});

test("phase 0 startup wiring gates work item bootstrapping and prefetch behind feature flags", async () => {
  const indexPath = path.resolve(import.meta.dirname, "../src/index.ts");
  const source = await readFile(indexPath, "utf8");

  assert.match(source, /isFeatureEnabled\(config,\s*"workItems"\)|isFeatureEnabled\(config,\s*'workItems'\)/);
  assert.match(source, /const runContextPrefetcher = workItemsEnabled\s*\?\s*new RunContextPrefetcher/s);
  assert.match(source, /if \(workItemsEnabled\)\s*\{\s*const \{ ensureDefaultTeam \} = await import\("\.\/work-items\/default-team-bootstrap\.js"\);\s*await ensureDefaultTeam\(db,\s*config\);/s);
  assert.match(source, /startDashboardServer\([\s\S]*workItemsEnabled\s*\?\s*.*dashboardWorkItemsSource.*:\s*undefined/s);
  assert.match(source, /startSlackApp\([\s\S]*workItemsEnabled\s*\?\s*\{\s*recordReviewOutcome:/s);
});

test("phase 0 startup wiring only loads learning store when observer is enabled", async () => {
  const indexPath = path.resolve(import.meta.dirname, "../src/index.ts");
  const source = await readFile(indexPath, "utf8");

  assert.match(source, /const observerEnabled = isFeatureEnabled\(config,\s*"observer"\)|const observerEnabled = isFeatureEnabled\(config,\s*'observer'\)/);
  assert.match(source, /const learningStore = observerEnabled\s*\?\s*new \(await import\("\.\/observer\/learning-store\.js"\)\)\.LearningStore\(db\)\s*:\s*undefined;/s);
});

test("startup keeps late-optional integrations out of core value imports", async () => {
  const indexPath = path.resolve(import.meta.dirname, "../src/index.ts");
  const source = await readFile(indexPath, "utf8");

  assert.doesNotMatch(source, /import \{ RunSupervisor \} from "\.\/supervisor\/run-supervisor\.js";/);
  assert.match(source, /await import\("\.\/supervisor\/run-supervisor\.js"\)/);

  assert.doesNotMatch(source, /import \{ JiraClient \} from "\.\/jira\.js";/);
  assert.match(source, /await import\("\.\/jira\.js"\)/);

  assert.doesNotMatch(source, /import \{ callLLMForJSON/);
  assert.match(source, /await import\("\.\/llm\/caller\.js"\)/);

  assert.doesNotMatch(source, /import \{ UserDirectoryService \} from "\.\/user-directory\/service\.js";/);
  assert.match(source, /import\("\.\/user-directory\/service\.js"\)/);

  assert.doesNotMatch(source, /const \{ WebClient \} = await import\("@slack\/web-api"\);\s*const webClient = config\.slackBotToken \? new WebClient/s);
  assert.match(source, /const webClient = config\.slackBotToken\s*\? new \(await import\("@slack\/web-api"\)\)\.WebClient/s);
});

test("main delegates startup phases into helper boundaries", async () => {
  const indexPath = path.resolve(import.meta.dirname, "../src/index.ts");
  const source = await readFile(indexPath, "utf8");

  assert.match(source, /async function applyActiveAgentProfile\(/);
  assert.match(source, /function wireWorkItemLifecycleHandlers\(/);
  assert.match(source, /async function startBackgroundServices\(/);
  assert.match(source, /async function startInteractiveServices\(/);

  assert.match(source, /await applyActiveAgentProfile\(config,\s*svc\.agentProfileStore\)/);
  assert.match(source, /wireWorkItemLifecycleHandlers\(svc\.runManager,\s*svc\.workItemOrchestrator\)/);
  assert.match(source, /await startBackgroundServices\(config,\s*db,\s*svc\)/);
  assert.match(source, /await startInteractiveServices\(config,\s*db,\s*svc,\s*setupStore,\s*workItemsEnabled\)/);
});
