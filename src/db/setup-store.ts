/**
 * Setup store — manages single-row wizard configuration in PostgreSQL.
 *
 * Handles first-run detection, credential encryption, and config injection.
 */

import { eq } from "drizzle-orm";
import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { open, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Database } from "./index.js";
import { configSections, setup } from "./schema.js";
import { encrypt, decrypt, generateEncryptionKey } from "./encryption.js";

const scryptAsync = promisify(scrypt);

export interface SetupStatus {
  complete: boolean;
  hasPassword: boolean;
  hasGithub: boolean;
  hasLlm: boolean;
  hasSlack: boolean;
}

export type SetupValueSource = "env" | "wizard" | "none";

export interface SetupPrefillValue {
  value?: string;
  source: SetupValueSource;
}

export interface SetupWizardState extends SetupStatus {
  prefill: {
    github: {
      authMode: SetupPrefillValue;
      defaultOwner: SetupPrefillValue;
      token: SetupPrefillValue;
      appId: SetupPrefillValue;
      installationId: SetupPrefillValue;
      privateKey: SetupPrefillValue;
    };
    llm: {
      provider: SetupPrefillValue;
      apiKey: SetupPrefillValue;
      defaultModel: SetupPrefillValue;
    };
    slack: {
      botToken: SetupPrefillValue;
      appToken: SetupPrefillValue;
      signingSecret: SetupPrefillValue;
      commandName: SetupPrefillValue;
      clientId: SetupPrefillValue;
      clientSecret: SetupPrefillValue;
      authRedirectUri: SetupPrefillValue;
    };
  };
}

export interface GitHubSetupConfig {
  authMode: "pat" | "app";
  defaultOwner?: string;
  repos?: string[];
  // PAT mode
  token?: string;
  // App mode
  appId?: string;
  installationId?: string;
  privateKey?: string;
}

export interface LLMSetupConfig {
  provider: "openrouter" | "anthropic" | "openai";
  apiKey: string;
  defaultModel?: string;
}

export interface SlackSetupConfig {
  botToken: string;
  appToken: string;
  signingSecret?: string;
  commandName?: string;
  clientId?: string;
  clientSecret?: string;
  authRedirectUri?: string;
}

const SCRYPT_KEYLEN = 64;
type ConfigSectionName = "github" | "llm" | "slack";

interface StoredConfigSection {
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
  overrideFromEnv: boolean;
}

export class SetupStore {
  private readonly db: Database;
  private encryptionKey: string | undefined;

  // In-memory cache to avoid 2 DB queries per HTTP request
  private cachedComplete: boolean | undefined;
  private cachedPasswordHash: string | undefined | null; // null = queried, not set
  constructor(db: Database, encryptionKey?: string) {
    this.db = db;
    this.encryptionKey = encryptionKey;
  }

  /** Check if first-run setup is complete. */
  async isComplete(): Promise<boolean> {
    if (this.cachedComplete !== undefined) return this.cachedComplete;
    const rows = await this.db.select().from(setup).where(eq(setup.id, 1));
    this.cachedComplete = rows[0]?.completedAt != null;
    return this.cachedComplete;
  }

  /** Get current setup status for the wizard UI. */
  async getStatus(): Promise<SetupStatus> {
    const rows = await this.db.select().from(setup).where(eq(setup.id, 1));
    const row = rows[0];
    const sections = await this.db
      .select({ section: configSections.section })
      .from(configSections);
    const sectionNames = new Set(sections.map((entry) => entry.section));
    if (!row) {
      return {
        complete: false,
        hasPassword: false,
        hasGithub: sectionNames.has("github"),
        hasLlm: sectionNames.has("llm"),
        hasSlack: sectionNames.has("slack"),
      };
    }
    return {
      complete: row.completedAt != null,
      hasPassword: row.passwordHash != null,
      hasGithub: sectionNames.has("github"),
      hasLlm: sectionNames.has("llm"),
      hasSlack: sectionNames.has("slack"),
    };
  }

  async getWizardState(): Promise<SetupWizardState> {
    const status = await this.getStatus();
    const github = await this.readConfigSection("github");
    const llm = await this.readConfigSection("llm");
    const slack = await this.readConfigSection("slack");

    return {
      ...status,
      prefill: {
        github: {
          authMode: this.pickPrefillValue(resolveGitHubEnvAuthMode(), stringOrUndefined(github?.config.authMode)),
          defaultOwner: this.pickPrefillValue(process.env.GITHUB_DEFAULT_OWNER, stringOrUndefined(github?.config.defaultOwner)),
          token: this.pickPrefillValue(process.env.GITHUB_TOKEN, stringOrUndefined(github?.secrets.token)),
          appId: this.pickPrefillValue(process.env.GITHUB_APP_ID, stringOrUndefined(github?.config.appId)),
          installationId: this.pickPrefillValue(process.env.GITHUB_APP_INSTALLATION_ID, stringOrUndefined(github?.config.installationId)),
          privateKey: this.pickPrefillValue(process.env.GITHUB_APP_PRIVATE_KEY, stringOrUndefined(github?.secrets.privateKey)),
        },
        llm: {
          provider: this.pickPrefillValue(resolveLlmEnvProvider(), stringOrUndefined(llm?.config.provider)),
          apiKey: this.pickPrefillValue(resolveLlmEnvApiKey(), stringOrUndefined(llm?.secrets.apiKey)),
          defaultModel: this.pickPrefillValue(process.env.DEFAULT_LLM_MODEL, stringOrUndefined(llm?.config.defaultModel)),
        },
        slack: {
          botToken: this.pickPrefillValue(process.env.SLACK_BOT_TOKEN, stringOrUndefined(slack?.secrets.botToken)),
          appToken: this.pickPrefillValue(process.env.SLACK_APP_TOKEN, stringOrUndefined(slack?.secrets.appToken)),
          signingSecret: this.pickPrefillValue(process.env.SLACK_SIGNING_SECRET, stringOrUndefined(slack?.secrets.signingSecret)),
          commandName: this.pickPrefillValue(process.env.SLACK_COMMAND_NAME, stringOrUndefined(slack?.config.commandName)),
          clientId: this.pickPrefillValue(process.env.SLACK_CLIENT_ID, stringOrUndefined(slack?.config.clientId)),
          clientSecret: this.pickPrefillValue(process.env.SLACK_CLIENT_SECRET, stringOrUndefined(slack?.secrets.clientSecret)),
          authRedirectUri: this.pickPrefillValue(process.env.SLACK_AUTH_REDIRECT_URI, stringOrUndefined(slack?.config.authRedirectUri)),
        },
      },
    };
  }

  /** Hash and save the dashboard password (scrypt). */
  async setPassword(password: string): Promise<string> {
    const hash = await hashPassword(password);

    // Ensure encryption key exists
    await this.ensureEncryptionKey();

    await this.db
      .insert(setup)
      .values({ id: 1, passwordHash: hash, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: setup.id,
        set: { passwordHash: hash, updatedAt: new Date() },
      });

    // Invalidate cache
    this.cachedPasswordHash = hash;

    return hash;
  }

  /** Get the stored password hash for auth. */
  async getPasswordHash(): Promise<string | undefined> {
    if (this.cachedPasswordHash !== undefined) {
      return this.cachedPasswordHash ?? undefined;
    }
    const rows = await this.db
      .select({ passwordHash: setup.passwordHash })
      .from(setup)
      .where(eq(setup.id, 1));
    const hash = rows[0]?.passwordHash ?? null;
    this.cachedPasswordHash = hash;
    return hash ?? undefined;
  }

  /** Save GitHub configuration (encrypted). */
  async saveGitHub(config: GitHubSetupConfig): Promise<void> {
    const githubConfig: Record<string, unknown> = {
      authMode: config.authMode,
      defaultOwner: config.defaultOwner,
      repos: config.repos,
    };
    const githubSecrets: Record<string, unknown> = {};

    if (config.authMode === "pat" && config.token) {
      githubSecrets.token = config.token;
    } else if (config.authMode === "app") {
      githubConfig.appId = config.appId;
      githubConfig.installationId = config.installationId;
      if (config.privateKey) {
        githubSecrets.privateKey = config.privateKey;
      }
    }

    await this.upsertConfigSection("github", githubConfig, githubSecrets);
  }

  /** Save LLM configuration (encrypted). */
  async saveLLM(config: LLMSetupConfig): Promise<void> {
    const llmConfig: Record<string, unknown> = {
      provider: config.provider,
      defaultModel: config.defaultModel,
    };
    await this.upsertConfigSection("llm", llmConfig, { apiKey: config.apiKey });
  }

  /** Save Slack configuration (encrypted). */
  async saveSlack(config: SlackSetupConfig): Promise<void> {
    const slackConfig: Record<string, unknown> = {
      commandName: config.commandName,
      clientId: config.clientId,
      authRedirectUri: config.authRedirectUri,
    };
    const slackSecrets: Record<string, unknown> = {
      botToken: config.botToken,
      appToken: config.appToken,
    };
    if (config.signingSecret) {
      slackSecrets.signingSecret = config.signingSecret;
    }
    if (config.clientSecret) {
      slackSecrets.clientSecret = config.clientSecret;
    }
    await this.upsertConfigSection("slack", slackConfig, slackSecrets);
  }

  /** Mark setup as complete. Throws if password hasn't been set. */
  async markComplete(): Promise<void> {
    const status = await this.getStatus();
    if (!status.hasPassword) {
      throw new Error("Cannot complete setup without a password");
    }
    await this.db
      .update(setup)
      .set({ completedAt: new Date(), updatedAt: new Date() })
      .where(eq(setup.id, 1));

    // Invalidate cache
    this.cachedComplete = true;
  }

  /** Get the full setup row for config injection. */
  async getSetupRow(): Promise<typeof setup.$inferSelect | undefined> {
    const rows = await this.db.select().from(setup).where(eq(setup.id, 1));
    return rows[0];
  }

  /**
   * Apply wizard-stored secrets into process.env (env vars always win via ??=).
   * Called on startup (if setup complete) and after wizard completion.
   */
  async applyToEnv(): Promise<void> {
    const row = await this.getSetupRow();
    if (!row || !row.completedAt) return;

    const github = await this.readConfigSection("github");
    if (github && !this.shouldUseEnvOverride("github", github.overrideFromEnv)) {
      const authMode = String(github.config.authMode ?? "");
      const token = stringOrUndefined(github.secrets.token);
      const privateKey = stringOrUndefined(github.secrets.privateKey);
      setEnvValue("GITHUB_DEFAULT_OWNER", stringOrUndefined(github.config.defaultOwner));
      const repos = Array.isArray(github.config.repos) ? github.config.repos.filter((entry): entry is string => typeof entry === "string") : [];
      setEnvValue("REPO_ALLOWLIST", repos.length > 0 ? repos.join(",") : undefined);
      if (authMode === "app") {
        setEnvValue("GITHUB_TOKEN", undefined);
        setEnvValue("GITHUB_APP_ID", stringOrUndefined(github.config.appId));
        setEnvValue("GITHUB_APP_INSTALLATION_ID", stringOrUndefined(github.config.installationId));
        setEnvValue("GITHUB_APP_PRIVATE_KEY", privateKey);
      } else {
        setEnvValue("GITHUB_TOKEN", token);
        setEnvValue("GITHUB_APP_ID", undefined);
        setEnvValue("GITHUB_APP_INSTALLATION_ID", undefined);
        setEnvValue("GITHUB_APP_PRIVATE_KEY", undefined);
      }
    }

    const llm = await this.readConfigSection("llm");
    if (llm && !this.shouldUseEnvOverride("llm", llm.overrideFromEnv)) {
      const provider = stringOrUndefined(llm.config.provider) ?? "openrouter";
      const apiKey = stringOrUndefined(llm.secrets.apiKey);
      setEnvValue("ANTHROPIC_API_KEY", provider === "anthropic" ? apiKey : undefined);
      setEnvValue("OPENAI_API_KEY", provider === "openai" ? apiKey : undefined);
      setEnvValue("CODEX_API_KEY", provider === "openai" ? apiKey : undefined);
      setEnvValue("OPENROUTER_API_KEY", provider === "openrouter" ? apiKey : undefined);
      setEnvValue("DEFAULT_LLM_MODEL", stringOrUndefined(llm.config.defaultModel));
    }

    const slack = await this.readConfigSection("slack");
    if (slack && !this.shouldUseEnvOverride("slack", slack.overrideFromEnv)) {
      setEnvValue("SLACK_BOT_TOKEN", stringOrUndefined(slack.secrets.botToken));
      setEnvValue("SLACK_APP_TOKEN", stringOrUndefined(slack.secrets.appToken));
      setEnvValue("SLACK_SIGNING_SECRET", stringOrUndefined(slack.secrets.signingSecret));
      setEnvValue("SLACK_COMMAND_NAME", stringOrUndefined(slack.config.commandName));
      setEnvValue("SLACK_CLIENT_ID", stringOrUndefined(slack.config.clientId));
      setEnvValue("SLACK_CLIENT_SECRET", stringOrUndefined(slack.secrets.clientSecret));
      setEnvValue("SLACK_AUTH_REDIRECT_URI", stringOrUndefined(slack.config.authRedirectUri));
    }
  }

  private async upsertConfigSection(
    section: ConfigSectionName,
    config: Record<string, unknown>,
    secrets: Record<string, unknown>,
  ): Promise<void> {
    const key = await this.getEncryptionKey();
    const hasSecrets = Object.keys(secrets).length > 0;
    const secretsEnc = hasSecrets ? encrypt(JSON.stringify(secrets), key) : null;
    await this.db
      .insert(configSections)
      .values({
        section,
        config,
        secretsEnc,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: configSections.section,
        set: {
          config,
          secretsEnc,
          updatedAt: new Date(),
        },
      });
  }

  private async readConfigSection(section: ConfigSectionName): Promise<StoredConfigSection | undefined> {
    const rows = await this.db
      .select()
      .from(configSections)
      .where(eq(configSections.section, section));
    const row = rows[0];
    if (!row) return undefined;

    const key = row.secretsEnc ? await this.getEncryptionKey() : undefined;
    const secrets = row.secretsEnc && key
      ? JSON.parse(decrypt(row.secretsEnc, key)) as Record<string, unknown>
      : {};

    return {
      config: row.config ?? {},
      secrets,
      overrideFromEnv: row.overrideFromEnv,
    };
  }

  private shouldUseEnvOverride(section: ConfigSectionName, sectionOverrideFromEnv: boolean): boolean {
    if (sectionOverrideFromEnv) return true;
    const varName = section === "github"
      ? "GITHUB_CONFIG_OVERRIDE_FROM_ENV"
      : section === "slack"
        ? "SLACK_CONFIG_OVERRIDE_FROM_ENV"
        : "LLM_CONFIG_OVERRIDE_FROM_ENV";
    return parseOverrideFlag(process.env[varName]);
  }

  private pickPrefillValue(envValue?: string, wizardValue?: string): SetupPrefillValue {
    const normalizedEnv = stringOrUndefined(envValue);
    if (normalizedEnv !== undefined) {
      return { value: normalizedEnv, source: "env" };
    }
    const normalizedWizard = stringOrUndefined(wizardValue);
    if (normalizedWizard !== undefined) {
      return { value: normalizedWizard, source: "wizard" };
    }
    return { source: "none" };
  }

  // ── Encryption key management ──

  /**
   * Ensure an encryption key exists.
   * Priority: env var → key file → auto-generate to file (exclusive create).
   */
  private async ensureEncryptionKey(): Promise<void> {
    if (this.encryptionKey) return;

    // Try reading from key file
    const keyPath = this.keyFilePath();
    try {
      const key = (await readFile(keyPath, "utf8")).trim();
      if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key)) {
        this.encryptionKey = key;
        return;
      }
    } catch {
      // File doesn't exist yet
    }

    // Generate and write atomically (O_EXCL prevents TOCTOU race)
    const newKey = generateEncryptionKey();
    await mkdir(path.dirname(keyPath), { recursive: true });
    try {
      const fh = await open(keyPath, "wx", 0o600);
      await fh.writeFile(newKey);
      await fh.close();
      this.encryptionKey = newKey;
    } catch (err) {
      // Another process created the file first — read their key
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        const key = (await readFile(keyPath, "utf8")).trim();
        this.encryptionKey = key;
      } else {
        throw err;
      }
    }
  }

  /** Get the encryption key (from memory, env, or key file). */
  private async getEncryptionKey(): Promise<string> {
    if (this.encryptionKey) return this.encryptionKey;
    await this.ensureEncryptionKey();
    if (!this.encryptionKey) {
      throw new Error("No encryption key available. Set ENCRYPTION_KEY env var or ensure the key file is writable.");
    }
    return this.encryptionKey;
  }

  /** Resolve the key file path (env override or default). Uses data/ dir which is writable. */
  private keyFilePath(): string {
    return process.env.ENCRYPTION_KEY_FILE ?? path.join(process.env.DATA_DIR ?? "data", ".encryption-key");
  }
}

function setEnvValue(name: string, value: string | undefined): void {
  if (value === undefined || value === "") {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function resolveGitHubEnvAuthMode(): string | undefined {
  if (stringOrUndefined(process.env.GITHUB_TOKEN)) return "pat";
  if (
    stringOrUndefined(process.env.GITHUB_APP_ID)
    || stringOrUndefined(process.env.GITHUB_APP_INSTALLATION_ID)
    || stringOrUndefined(process.env.GITHUB_APP_PRIVATE_KEY)
  ) {
    return "app";
  }
  return undefined;
}

function resolveLlmEnvProvider(): string | undefined {
  if (stringOrUndefined(process.env.OPENROUTER_API_KEY)) return "openrouter";
  if (stringOrUndefined(process.env.ANTHROPIC_API_KEY)) return "anthropic";
  if (stringOrUndefined(process.env.OPENAI_API_KEY) || stringOrUndefined(process.env.CODEX_API_KEY)) return "openai";
  return undefined;
}

function resolveLlmEnvApiKey(): string | undefined {
  return stringOrUndefined(process.env.OPENROUTER_API_KEY)
    ?? stringOrUndefined(process.env.ANTHROPIC_API_KEY)
    ?? stringOrUndefined(process.env.OPENAI_API_KEY)
    ?? stringOrUndefined(process.env.CODEX_API_KEY);
}

function parseOverrideFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/** Password hashing using async scrypt (N=16384, r=8, p=1, keylen=64). */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN) as Buffer;
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** Verify password against stored scrypt hash using constant-time comparison. */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expectedHash = Buffer.from(parts[2]!, "hex");
  const actualHash = await scryptAsync(password, salt, SCRYPT_KEYLEN) as Buffer;
  if (actualHash.length !== expectedHash.length) return false;
  return timingSafeEqual(actualHash, expectedHash);
}
