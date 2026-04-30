/**
 * Provisions and tears down per-Run isolated test databases on the
 * shared PG / ClickHouse / Redis clusters that hubstaff-server's RSpec
 * suite needs. Called by the K8s backend before launching a runner pod
 * (provision) and by the terminal hook after the pod finishes
 * (teardown).
 *
 * Idempotent on both ends — provision DROPs IF EXISTS first, so it
 * cleans up any residue left by a crashed previous Run on the same
 * slot.
 */

import net from "node:net";
import postgres from "postgres";
import type { RunnerProfile } from "./runner-profile.js";
import type { RunnerDbUrls } from "./runner-db-env.js";
import { logInfo, logWarn } from "../logger.js";

export async function provisionRunnerDb(
  slotId: number,
  profile: RunnerProfile,
  urls: RunnerDbUrls,
): Promise<void> {
  if (!profile.needsDbSlot) return;
  const dbName = `goose_${String(slotId)}`;

  await provisionPgDatabase(urls.pg, dbName);
  await provisionClickhouseDatabase(urls.clickhouse, dbName);
  await flushRedisDb(urls.redis, slotId);

  logInfo("runner-db-resources: provisioned", { slotId, dbName });
}

export async function teardownRunnerDb(
  slotId: number,
  profile: RunnerProfile,
  urls: RunnerDbUrls,
): Promise<void> {
  if (!profile.needsDbSlot) return;
  const dbName = `goose_${String(slotId)}`;

  await dropPgDatabase(urls.pg, dbName);
  await dropClickhouseDatabase(urls.clickhouse, dbName);
  await flushRedisDb(urls.redis, slotId);

  logInfo("runner-db-resources: teardown complete", { slotId, dbName });
}

// ── Postgres ──

async function provisionPgDatabase(url: string | undefined, dbName: string): Promise<void> {
  if (!url) {
    logWarn("runner-db-resources: skip pg provision — no URL configured", { dbName });
    return;
  }
  await withPgConnection(url, async (sql) => {
    await sql.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
    await sql.unsafe(`CREATE DATABASE "${dbName}"`);
  });
}

async function dropPgDatabase(url: string | undefined, dbName: string): Promise<void> {
  if (!url) {
    logWarn("runner-db-resources: skip pg drop — no URL configured", { dbName });
    return;
  }
  await withPgConnection(url, async (sql) => {
    await sql.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });
}

async function withPgConnection(
  url: string,
  fn: (sql: ReturnType<typeof postgres>) => Promise<void>,
): Promise<void> {
  const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10 });
  try {
    await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ── ClickHouse (raw HTTP) ──

async function provisionClickhouseDatabase(url: string | undefined, dbName: string): Promise<void> {
  if (!url) {
    logWarn("runner-db-resources: skip ch provision — no URL configured", { dbName });
    return;
  }
  await runClickhouseStatement(url, `DROP DATABASE IF EXISTS \`${dbName}\``);
  await runClickhouseStatement(url, `CREATE DATABASE \`${dbName}\``);
}

async function dropClickhouseDatabase(url: string | undefined, dbName: string): Promise<void> {
  if (!url) {
    logWarn("runner-db-resources: skip ch drop — no URL configured", { dbName });
    return;
  }
  await runClickhouseStatement(url, `DROP DATABASE IF EXISTS \`${dbName}\` SYNC`);
}

async function runClickhouseStatement(url: string, query: string): Promise<void> {
  const u = new URL(url);
  const headers: Record<string, string> = { "Content-Type": "text/plain" };
  if (u.username) {
    const auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64");
    headers["Authorization"] = `Basic ${auth}`;
    u.username = "";
    u.password = "";
  }
  const response = await fetch(u.toString(), {
    method: "POST",
    headers,
    body: query,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`ClickHouse statement failed (${String(response.status)}): ${text.slice(0, 500)}`);
  }
}

// ── Redis (raw RESP over node:net) ──
//
// Single FLUSHDB on a logical-DB index doesn't justify a client dep.
// Plaintext RESP only — TLS is on the cluster boundary, not our concern.

async function flushRedisDb(url: string | undefined, slotId: number): Promise<void> {
  if (!url) {
    logWarn("runner-db-resources: skip redis flush — no URL configured", { slotId });
    return;
  }
  const u = new URL(url);
  const password = u.password ? decodeURIComponent(u.password) : undefined;
  const user = u.username ? decodeURIComponent(u.username) : undefined;

  const commands: string[][] = [];
  if (password) commands.push(user ? ["AUTH", user, password] : ["AUTH", password]);
  commands.push(["SELECT", String(slotId)]);
  commands.push(["FLUSHDB"]);

  await runRedisCommands(u.hostname, u.port ? Number.parseInt(u.port, 10) : 6379, commands);
}

async function runRedisCommands(host: string, port: number, commands: string[][]): Promise<void> {
  const socket = net.createConnection({ host, port });
  socket.setTimeout(5_000);

  let buffer = "";
  let pending: { resolve: (line: string) => void; reject: (err: Error) => void } | null = null;
  const tryDeliver = (): void => {
    if (!pending) return;
    const idx = buffer.indexOf("\r\n");
    if (idx < 0) return;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    const p = pending;
    pending = null;
    p.resolve(line);
  };

  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    tryDeliver();
  });
  socket.on("error", (err) => pending?.reject(err));
  socket.on("timeout", () => {
    pending?.reject(new Error("redis socket timeout"));
    socket.destroy();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });

    for (const cmd of commands) {
      socket.write(encodeRedisCommand(cmd));
      const reply = await new Promise<string>((resolve, reject) => {
        pending = { resolve, reject };
        tryDeliver();
      });
      if (reply.startsWith("-")) throw new Error(`redis error: ${reply.slice(1)}`);
      if (!reply.startsWith("+")) throw new Error(`redis unexpected reply: ${reply}`);
    }
  } finally {
    socket.destroy();
  }
}

function encodeRedisCommand(parts: string[]): string {
  let out = `*${String(parts.length)}\r\n`;
  for (const p of parts) {
    out += `$${String(Buffer.byteLength(p))}\r\n${p}\r\n`;
  }
  return out;
}
