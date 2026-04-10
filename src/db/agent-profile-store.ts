import { eq, desc, sql } from "drizzle-orm";
import type { Database } from "./index.js";
import { agentProfiles } from "./schema.js";
import type { AppConfig } from "../config.js";
import {
  buildBuiltinAgentProfiles,
  createAgentProfileRecord,
  type AgentProfile,
  type AgentProfileInput,
  resolveProfileCommandTemplate,
  sanitizeAgentProfileInput,
  validateAgentProfile,
} from "../agent-profile.js";

function toRecord(row: typeof agentProfiles.$inferSelect): AgentProfile {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    runtime: row.runtime as AgentProfile["runtime"],
    provider: (row.provider ?? undefined) as AgentProfile["provider"],
    model: row.model ?? undefined,
    tools: row.tools ?? [],
    mode: row.mode ?? undefined,
    extensions: row.extensions ?? [],
    extraArgs: row.extraArgs ?? undefined,
    isBuiltin: row.isBuiltIn,
    isActive: row.isActive,
    customCommandTemplate: row.customCommandTemplate ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class AgentProfileStore {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  async init(): Promise<void> {
    const existing = await this.db.select({ id: agentProfiles.id }).from(agentProfiles).limit(1);
    if (existing.length > 0) return;

    const builtins = buildBuiltinAgentProfiles(this.config).map((input, index) => {
      const record = createAgentProfileRecord({ ...input, isActive: index === 0 });
      return {
        id: record.id,
        name: record.name,
        description: record.description,
        runtime: record.runtime,
        provider: record.provider,
        model: record.model,
        tools: record.tools,
        mode: record.mode,
        extensions: record.extensions,
        extraArgs: record.extraArgs,
        isBuiltIn: record.isBuiltin,
        isActive: record.isActive,
        customCommandTemplate: record.customCommandTemplate,
      };
    });

    if (builtins.length > 0) {
      await this.db.insert(agentProfiles).values(builtins);
    }
  }

  async list(): Promise<AgentProfile[]> {
    const rows = await this.db.select().from(agentProfiles).orderBy(desc(agentProfiles.isActive), agentProfiles.name);
    return rows.map(toRecord);
  }

  async get(id: string): Promise<AgentProfile | undefined> {
    const rows = await this.db.select().from(agentProfiles).where(eq(agentProfiles.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async getActive(): Promise<AgentProfile | undefined> {
    const rows = await this.db.select().from(agentProfiles).where(eq(agentProfiles.isActive, true)).limit(1);
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async save(input: AgentProfileInput, id?: string): Promise<AgentProfile> {
    const clean = sanitizeAgentProfileInput(input);
    const validation = validateAgentProfile(clean, this.config);
    if (!validation.ok) {
      throw new Error(validation.errors.join("; "));
    }

    const record = createAgentProfileRecord(clean);
    const profileId = id ?? record.id;
    const now = new Date();
    if (clean.isActive) {
      await this.db.update(agentProfiles).set({ isActive: false, updatedAt: now });
    }

    await this.db.insert(agentProfiles).values({
      id: profileId,
      name: clean.name,
      description: clean.description,
      runtime: clean.runtime,
      provider: clean.provider,
      model: clean.model,
      tools: clean.tools ?? [],
      mode: clean.mode,
      extensions: clean.extensions ?? [],
      extraArgs: clean.extraArgs,
      isBuiltIn: Boolean(clean.isBuiltin),
      isActive: Boolean(clean.isActive),
      customCommandTemplate: clean.customCommandTemplate,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: agentProfiles.id,
      set: {
        name: clean.name,
        description: clean.description,
        runtime: clean.runtime,
        provider: clean.provider,
        model: clean.model,
        tools: clean.tools ?? [],
        mode: clean.mode,
        extensions: clean.extensions ?? [],
        extraArgs: clean.extraArgs,
        isActive: Boolean(clean.isActive),
        customCommandTemplate: clean.customCommandTemplate,
        updatedAt: now,
      },
    });

    if (!clean.isActive) {
      const active = await this.getActive();
      if (!active) {
        await this.setActive(profileId);
      }
    }

    const saved = await this.get(profileId);
    if (!saved) {
      throw new Error("Failed to load saved agent profile");
    }
    return saved;
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing || existing.isBuiltin) return false;
    await this.db.delete(agentProfiles).where(eq(agentProfiles.id, id));
    if (existing.isActive) {
      const replacement = await this.db.select().from(agentProfiles).orderBy(agentProfiles.name).limit(1);
      if (replacement[0]) {
        await this.setActive(replacement[0].id);
      }
    }
    return true;
  }

  async setActive(id: string): Promise<AgentProfile | undefined> {
    await this.db.transaction(async (tx) => {
      await tx.update(agentProfiles).set({ isActive: false, updatedAt: new Date() });
      await tx.update(agentProfiles).set({ isActive: true, updatedAt: new Date() }).where(eq(agentProfiles.id, id));
    });
    return this.get(id);
  }

  async getEffectiveCommandTemplate(fallbackTemplate: string): Promise<string> {
    const active = await this.getActive();
    return resolveProfileCommandTemplate(active, fallbackTemplate);
  }

  async count(): Promise<number> {
    const rows = await this.db.select({ count: sql<number>`count(*)::int` }).from(agentProfiles);
    return rows[0]?.count ?? 0;
  }
}
