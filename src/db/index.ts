/**
 * Database connection pool and Drizzle instance.
 *
 * Uses postgres.js (pure JS, fast, Drizzle-native).
 * Runs Drizzle-kit migrations on startup via initDatabase().
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.js";
import { backfillLegacySetupConfigSections } from "./setup-legacy-storage.js";

const DEFAULT_URL = "postgres://gooseherd:gooseherd@postgres:5432/gooseherd";

let sql: ReturnType<typeof postgres> | undefined;
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export function getDb(): Database {
  if (!_db) {
    throw new Error("Database not initialized — call initDatabase() first");
  }
  return _db;
}

export async function initDatabase(url?: string): Promise<Database> {
  const connectionUrl = url ?? process.env.DATABASE_URL ?? DEFAULT_URL;
  sql = postgres(connectionUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  await backfillLegacySetupConfigSections(sql);

  _db = drizzle(sql, { schema });

  // Run migrations
  await migrate(_db, { migrationsFolder: "./drizzle" });

  return _db;
}

export async function closeDatabase(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = undefined;
    _db = undefined;
  }
}

// Re-export schema for convenience
export { schema };
