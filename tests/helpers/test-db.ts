/**
 * Test database helper — creates an isolated PostgreSQL schema per test suite.
 *
 * Usage:
 *   const { db, cleanup } = await createTestDb();
 *   // ... use db in tests ...
 *   await cleanup(); // drops schema + closes connection
 *
 * Requires a local PostgreSQL instance. Defaults:
 *   DATABASE_URL_TEST=postgres://gooseherd:gooseherd@localhost:5432/gooseherd_test
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../src/db/schema.js";
import type { Database } from "../../src/db/index.js";

const DEFAULT_TEST_URL = "postgres://gooseherd:gooseherd@localhost:5432/gooseherd_test";
const SILENT_TEST_NOTICE = () => undefined;

// Read all migration SQL files once at module load
import { readdirSync } from "node:fs";

const drizzleDir = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "../../drizzle"
);

const migrationStatements = readdirSync(drizzleDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .flatMap((f) =>
    readFileSync(path.join(drizzleDir, f), "utf-8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean)
  );

export interface TestDb {
  db: Database;
  cleanup: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const url = process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_URL;
  const schemaName = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  // Admin connection to create schema + run migration DDL inside it
  const adminSql = postgres(url, { max: 1, onnotice: SILENT_TEST_NOTICE });
  await adminSql.unsafe(`CREATE SCHEMA "${schemaName}"`);
  await adminSql.unsafe(`SET search_path TO "${schemaName}"`);
  for (const stmt of migrationStatements) {
    await adminSql.unsafe(stmt);
  }
  await adminSql.end();

  // Test connection scoped to the new schema
  const testSql = postgres(url, {
    max: 10,
    connection: { search_path: schemaName },
  });
  const db = drizzle(testSql, { schema }) as Database;

  return {
    db,
    cleanup: async () => {
      await testSql.end();
      const dropSql = postgres(url, { max: 1, onnotice: SILENT_TEST_NOTICE });
      await dropSql.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
      await dropSql.end();
    },
  };
}
