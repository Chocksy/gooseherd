import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("model_prices partial index stays aligned between schema and migration", async () => {
  const schemaPath = path.resolve(import.meta.dirname, "../src/db/schema.ts");
  const migrationPath = path.resolve(import.meta.dirname, "../drizzle/0019_model_prices.sql");
  const [schemaSource, migrationSource] = await Promise.all([
    readFile(schemaPath, "utf8"),
    readFile(migrationPath, "utf8"),
  ]);

  assert.match(
    schemaSource,
    /index\("model_prices_missing_idx"\)\s*\.on\(t\.source,\s*t\.lastSeenAt\)\s*\.where\(sql`\$\{t\.inputPerM\} IS NULL OR \$\{t\.outputPerM\} IS NULL`\)/s,
  );
  assert.match(
    migrationSource,
    /CREATE INDEX IF NOT EXISTS "model_prices_missing_idx"[\s\S]*WHERE "input_per_m" IS NULL OR "output_per_m" IS NULL;/,
  );
});
