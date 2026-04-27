import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("dashboard contracts live in a dedicated boundary module", async () => {
  const contractsPath = path.resolve(import.meta.dirname, "../src/dashboard/contracts.ts");
  const serverPath = path.resolve(import.meta.dirname, "../src/dashboard-server.ts");
  const indexPath = path.resolve(import.meta.dirname, "../src/index.ts");

  const contractsSource = await readFile(contractsPath, "utf8");
  const serverSource = await readFile(serverPath, "utf8");
  const indexSource = await readFile(indexPath, "utf8");

  assert.match(contractsSource, /export interface DashboardObserver/);
  assert.match(contractsSource, /export interface DashboardConversationSource/);
  assert.match(contractsSource, /export interface DashboardWorkItemsSource/);

  assert.match(serverSource, /from "\.\/dashboard\/contracts\.js"/);
  assert.doesNotMatch(serverSource, /export interface DashboardObserver/);
  assert.doesNotMatch(serverSource, /export interface DashboardConversationSource/);
  assert.doesNotMatch(serverSource, /export interface DashboardWorkItemsSource/);

  assert.match(indexSource, /import \{ startDashboardServer \} from "\.\/dashboard-server\.js";/);
  assert.match(indexSource, /import type \{ DashboardWorkItemsSource \} from "\.\/dashboard\/contracts\.js";/);
});
