import postgres from "postgres";
import { backfillLegacySetupConfigSections } from "../src/db/setup-legacy-storage.js";

const DEFAULT_URL = "postgres://gooseherd:gooseherd@postgres:5432/gooseherd";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? DEFAULT_URL;
  const sql = postgres(url, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  try {
    const result = await backfillLegacySetupConfigSections(sql);
    const migrated = result.migratedSections.length > 0
      ? result.migratedSections.join(", ")
      : "none";
    console.log(`Legacy setup config backfill complete. Migrated sections: ${migrated}`);
  } finally {
    await sql.end();
  }
}

await main();
