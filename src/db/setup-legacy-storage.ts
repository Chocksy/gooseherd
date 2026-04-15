import { readFile } from "node:fs/promises";
import path from "node:path";
import type postgres from "postgres";
import { decrypt, encrypt } from "./encryption.js";

type SqlClient = ReturnType<typeof postgres>;
type ConfigSectionName = "github" | "llm" | "slack";
type JsonObject = { [prop: string]: postgres.JSONValue | undefined };

interface LegacySetupRow {
  github_config: JsonObject | null;
  github_token_enc: Buffer | null;
  github_app_key_enc: Buffer | null;
  llm_config: JsonObject | null;
  llm_api_key_enc: Buffer | null;
  slack_config: JsonObject | null;
  slack_bot_token_enc: Buffer | null;
  slack_app_token_enc: Buffer | null;
}

export async function backfillLegacySetupConfigSections(
  sql: SqlClient,
  encryptionKey?: string,
): Promise<{ migratedSections: ConfigSectionName[] }> {
  const schemaName = await currentSchemaName(sql);
  if (!schemaName) return { migratedSections: [] };

  const tableNames = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = ${schemaName}
      AND table_name IN ('setup', 'config_sections')
  `;
  const availableTables = new Set(tableNames.map((row) => row.table_name));
  if (!availableTables.has("setup")) return { migratedSections: [] };

  const columnNames = await sql<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = ${schemaName}
      AND table_name = 'setup'
      AND column_name IN (
        'github_config',
        'github_token_enc',
        'github_app_key_enc',
        'llm_config',
        'llm_api_key_enc',
        'slack_config',
        'slack_bot_token_enc',
        'slack_app_token_enc'
      )
  `;
  const availableLegacyColumns = new Set(columnNames.map((row) => row.column_name));
  if (availableLegacyColumns.size === 0) return { migratedSections: [] };

  const setupRows = await sql<LegacySetupRow[]>`
    SELECT
      github_config,
      github_token_enc,
      github_app_key_enc,
      llm_config,
      llm_api_key_enc,
      slack_config,
      slack_bot_token_enc,
      slack_app_token_enc
    FROM setup
    WHERE id = 1
    LIMIT 1
  `;
  const row = setupRows[0];
  if (!row) return { migratedSections: [] };

  const hasLegacyData = Boolean(
    row.github_config ||
    row.github_token_enc ||
    row.github_app_key_enc ||
    row.llm_config ||
    row.llm_api_key_enc ||
    row.slack_config ||
    row.slack_bot_token_enc ||
    row.slack_app_token_enc
  );

  if (!availableTables.has("config_sections")) {
    if (hasLegacyData) {
      throw new Error(
        "Legacy setup data exists but config_sections is missing. Upgrade through a version that creates config_sections before removing legacy setup storage."
      );
    }
    return { migratedSections: [] };
  }

  const existingRows = await sql<{ section: string }[]>`SELECT section FROM config_sections`;
  const existingSections = new Set(existingRows.map((row) => row.section));
  const migratedSections: ConfigSectionName[] = [];
  const key = await resolveBackfillEncryptionKey({
    row,
    encryptionKey,
  });

  if (!existingSections.has("github") && (row.github_config || row.github_token_enc || row.github_app_key_enc)) {
    const secrets: Record<string, string> = {};
    if (row.github_token_enc) secrets.token = decrypt(row.github_token_enc, key);
    if (row.github_app_key_enc) secrets.privateKey = decrypt(row.github_app_key_enc, key);
    await insertConfigSection(sql, "github", row.github_config ?? {}, secrets, key);
    migratedSections.push("github");
  }

  if (!existingSections.has("llm") && (row.llm_config || row.llm_api_key_enc)) {
    const secrets: Record<string, string> = {};
    if (row.llm_api_key_enc) secrets.apiKey = decrypt(row.llm_api_key_enc, key);
    await insertConfigSection(sql, "llm", row.llm_config ?? {}, secrets, key);
    migratedSections.push("llm");
  }

  if (!existingSections.has("slack") && (row.slack_config || row.slack_bot_token_enc || row.slack_app_token_enc)) {
    const legacySlackConfig = row.slack_config ?? {};
    const slackConfig: JsonObject = {};
    if (legacySlackConfig.commandName !== undefined) {
      slackConfig.commandName = legacySlackConfig.commandName;
    }

    const secrets: Record<string, string> = {};
    if (row.slack_bot_token_enc) secrets.botToken = decrypt(row.slack_bot_token_enc, key);
    if (row.slack_app_token_enc) secrets.appToken = decrypt(row.slack_app_token_enc, key);
    if (typeof legacySlackConfig.signingSecret === "string" && legacySlackConfig.signingSecret.length > 0) {
      secrets.signingSecret = legacySlackConfig.signingSecret;
    }

    await insertConfigSection(sql, "slack", slackConfig, secrets, key);
    migratedSections.push("slack");
  }

  return { migratedSections };
}

async function currentSchemaName(sql: SqlClient): Promise<string | undefined> {
  const rows = await sql<{ schema_name: string | null }[]>`SELECT current_schema() AS schema_name`;
  return rows[0]?.schema_name ?? undefined;
}

async function resolveBackfillEncryptionKey({
  row,
  encryptionKey,
}: {
  row: LegacySetupRow;
  encryptionKey?: string;
}): Promise<string> {
  const needsKey = Boolean(
    row.github_token_enc ||
    row.github_app_key_enc ||
    row.llm_api_key_enc ||
    row.slack_bot_token_enc ||
    row.slack_app_token_enc
  );
  if (!needsKey) {
    return encryptionKey ?? process.env.ENCRYPTION_KEY ?? "";
  }
  if (encryptionKey) return encryptionKey;
  if (process.env.ENCRYPTION_KEY) return process.env.ENCRYPTION_KEY;

  const keyPath = process.env.ENCRYPTION_KEY_FILE ?? path.join(process.env.DATA_DIR ?? "data", ".encryption-key");
  try {
    const key = (await readFile(keyPath, "utf8")).trim();
    if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key)) {
      return key;
    }
  } catch {
    // handled below with a clearer error
  }

  throw new Error(
    "Legacy setup secrets exist but no encryption key is available. Set ENCRYPTION_KEY or ENCRYPTION_KEY_FILE before starting the upgraded app."
  );
}

async function insertConfigSection(
  sql: SqlClient,
  section: ConfigSectionName,
  config: JsonObject,
  secrets: Record<string, string>,
  encryptionKey: string,
): Promise<void> {
  const secretsEnc = Object.keys(secrets).length > 0
    ? encrypt(JSON.stringify(secrets), encryptionKey)
    : null;

  await sql`
    INSERT INTO config_sections (section, config, secrets_enc)
    VALUES (${section}, ${sql.json(config)}, ${secretsEnc})
  `;
}
