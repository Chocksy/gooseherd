import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { encrypt, decrypt } from "../src/db/encryption.js";

const TEST_URL = process.env.DATABASE_URL_TEST ?? "postgres://gooseherd:gooseherd@127.0.0.1:5432/gooseherd_test";

const drizzleDir = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "../drizzle"
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

async function withLegacySchema(fn: (sql: ReturnType<typeof postgres>) => Promise<void>): Promise<void> {
  const schemaName = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const adminSql = postgres(TEST_URL, { max: 1 });
  await adminSql.unsafe(`CREATE SCHEMA "${schemaName}"`);
  await adminSql.unsafe(`
    CREATE TABLE "${schemaName}"."setup" (
      "id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
      "password_hash" text,
      "github_config" jsonb,
      "github_token_enc" bytea,
      "github_app_key_enc" bytea,
      "llm_config" jsonb,
      "llm_api_key_enc" bytea,
      "slack_config" jsonb,
      "slack_bot_token_enc" bytea,
      "slack_app_token_enc" bytea,
      "completed_at" timestamp with time zone,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `);
  await adminSql.unsafe(`
    CREATE TABLE "${schemaName}"."config_sections" (
      "section" text PRIMARY KEY NOT NULL,
      "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
      "secrets_enc" bytea,
      "override_from_env" boolean DEFAULT false NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `);
  await adminSql.end();

  const sql = postgres(TEST_URL, {
    max: 1,
    connection: { search_path: schemaName },
  });

  try {
    await fn(sql);
  } finally {
    await sql.end();
    const dropSql = postgres(TEST_URL, { max: 1 });
    await dropSql.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
    await dropSql.end();
  }
}

test("backfillLegacySetupConfigSections migrates legacy setup secrets into config_sections", async () => {
  const { backfillLegacySetupConfigSections } = await import("../src/db/setup-legacy-storage.js");
  const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  await withLegacySchema(async (sql) => {
    await sql`
      INSERT INTO setup (
        id,
        github_config,
        github_token_enc,
        llm_config,
        llm_api_key_enc,
        slack_config,
        slack_bot_token_enc,
        slack_app_token_enc
      ) VALUES (
        1,
        ${sql.json({ authMode: "pat", defaultOwner: "acme" })},
        ${encrypt("ghp_test_123", encryptionKey)},
        ${sql.json({ provider: "openrouter", defaultModel: "openrouter/auto" })},
        ${encrypt("sk-or-test", encryptionKey)},
        ${sql.json({ commandName: "gooseherd", signingSecret: "signing-secret" })},
        ${encrypt("xoxb-test", encryptionKey)},
        ${encrypt("xapp-test", encryptionKey)}
      )
    `;

    const result = await backfillLegacySetupConfigSections(sql, encryptionKey);
    assert.deepEqual(result.migratedSections.sort(), ["github", "llm", "slack"]);

    const sections = await sql`
      SELECT section, config, secrets_enc
      FROM config_sections
      ORDER BY section
    `;

    assert.equal(sections.length, 3);

    const github = sections.find((row) => row.section === "github");
    assert.deepEqual(github?.config, { authMode: "pat", defaultOwner: "acme" });
    assert.deepEqual(JSON.parse(decrypt(github!.secrets_enc, encryptionKey)), { token: "ghp_test_123" });

    const llm = sections.find((row) => row.section === "llm");
    assert.deepEqual(llm?.config, { provider: "openrouter", defaultModel: "openrouter/auto" });
    assert.deepEqual(JSON.parse(decrypt(llm!.secrets_enc, encryptionKey)), { apiKey: "sk-or-test" });

    const slack = sections.find((row) => row.section === "slack");
    assert.deepEqual(slack?.config, { commandName: "gooseherd" });
    assert.deepEqual(JSON.parse(decrypt(slack!.secrets_enc, encryptionKey)), {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      signingSecret: "signing-secret",
    });
  });
});

test("backfillLegacySetupConfigSections does not overwrite existing config_sections rows", async () => {
  const { backfillLegacySetupConfigSections } = await import("../src/db/setup-legacy-storage.js");
  const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  await withLegacySchema(async (sql) => {
    await sql`
      INSERT INTO setup (id, github_config, github_token_enc)
      VALUES (
        1,
        ${sql.json({ authMode: "pat", defaultOwner: "legacy-org" })},
        ${encrypt("ghp-legacy", encryptionKey)}
      )
    `;
    await sql`
      INSERT INTO config_sections (section, config, secrets_enc)
      VALUES (
        'github',
        ${sql.json({ authMode: "app", defaultOwner: "wizard-org" })},
        ${encrypt(JSON.stringify({ privateKey: "wizard-key" }), encryptionKey)}
      )
    `;

    const result = await backfillLegacySetupConfigSections(sql, encryptionKey);
    assert.deepEqual(result.migratedSections, []);

    const rows = await sql`SELECT config, secrets_enc FROM config_sections WHERE section = 'github'`;
    assert.deepEqual(rows[0]?.config, { authMode: "app", defaultOwner: "wizard-org" });
    assert.deepEqual(JSON.parse(decrypt(rows[0]!.secrets_enc, encryptionKey)), { privateKey: "wizard-key" });
  });
});

test("current migrations leave setup table with wizard-state columns only", async () => {
  const schemaName = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const adminSql = postgres(TEST_URL, { max: 1 });
  await adminSql.unsafe(`CREATE SCHEMA "${schemaName}"`);
  await adminSql.unsafe(`SET search_path TO "${schemaName}"`);
  for (const stmt of migrationStatements) {
    await adminSql.unsafe(stmt);
  }

  const columns = await adminSql.unsafe<{ column_name: string }[]>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = '${schemaName}'
      AND table_name = 'setup'
    ORDER BY ordinal_position
  `);
  await adminSql.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
  await adminSql.end();

  assert.deepEqual(
    columns.map((row) => row.column_name),
    ["id", "password_hash", "completed_at", "created_at", "updated_at"]
  );
});
