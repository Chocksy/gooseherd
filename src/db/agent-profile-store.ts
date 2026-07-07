import { randomUUID } from "node:crypto";
import { eq, desc, asc, sql } from "drizzle-orm";
import type { Database } from "./index.js";
import { agentProfilePolicies, agentProfilePolicyMembers, agentProfiles } from "./schema.js";
import type { AppConfig } from "../config.js";
import {
  buildBuiltinAgentProfiles,
  createAgentProfileRecord,
  type AgentProfile,
  type AgentProfileInput,
  renderAgentProfileTemplate,
  resolveProfileCommandTemplate,
  sanitizeAgentProfileInput,
  validateAgentProfile,
} from "../agent-profile.js";
import {
  AGENT_PROFILE_POLICY_MODES,
  type AgentProfilePolicyMode,
  type AgentProfileTargetCatalog,
  type AgentProfileTarget,
  targetKeyFromTarget,
  validateAgentProfileTarget,
} from "../agent-profile-targets.js";
import type {
  AgentProfilePolicyMemberSnapshot,
  AgentProfilePolicySnapshot,
  AgentProfileSnapshot,
} from "../agent-profile-resolver.js";

export interface AgentProfilePolicyMemberInput {
  profileId: string;
  role?: string;
  ordinal?: number;
  weight?: number;
  enabled?: boolean;
}

export interface AgentProfilePolicyInput {
  target: AgentProfileTarget;
  mode: AgentProfilePolicyMode;
  enabled?: boolean;
  members: AgentProfilePolicyMemberInput[];
}

interface NormalizedAgentProfilePolicyMember {
  profileId: string;
  role?: string;
  ordinal: number;
  weight?: number;
  enabled: boolean;
}

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

function toSnapshot(profile: AgentProfile): AgentProfileSnapshot {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    runtime: profile.runtime,
    provider: profile.provider,
    model: profile.model,
    tools: profile.tools,
    mode: profile.mode,
    extensions: profile.extensions,
    extraArgs: profile.extraArgs,
    isBuiltin: profile.isBuiltin,
    isActive: profile.isActive,
    customCommandTemplate: profile.customCommandTemplate,
    commandTemplate: renderAgentProfileTemplate(profile),
    source: "profile",
  };
}

function toPolicySnapshot(
  policy: typeof agentProfilePolicies.$inferSelect,
  members: Array<typeof agentProfilePolicyMembers.$inferSelect>,
): AgentProfilePolicySnapshot {
  return {
    id: policy.id,
    scope: policy.scope,
    ...(policy.pipelineId ? { pipelineId: policy.pipelineId } : {}),
    ...(policy.intentKind ? { intentKind: policy.intentKind } : {}),
    ...(policy.nodeId ? { nodeId: policy.nodeId } : {}),
    ...(policy.action ? { action: policy.action } : {}),
    ...(policy.purpose ? { purpose: policy.purpose } : {}),
    targetKey: policy.targetKey,
    mode: policy.mode,
    enabled: policy.enabled,
    members: members
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((member): AgentProfilePolicyMemberSnapshot => ({
        id: member.id,
        policyId: member.policyId,
        profileId: member.profileId,
        ...(member.role ? { role: member.role } : {}),
        ordinal: member.ordinal,
        ...(member.weight !== null && member.weight !== undefined ? { weight: member.weight } : {}),
        enabled: member.enabled,
      })),
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

  async listPolicies(): Promise<AgentProfilePolicySnapshot[]> {
    const policies = await this.db.select().from(agentProfilePolicies).orderBy(asc(agentProfilePolicies.targetKey));
    const members = await this.db.select().from(agentProfilePolicyMembers).orderBy(asc(agentProfilePolicyMembers.ordinal));
    const membersByPolicy = new Map<string, Array<typeof agentProfilePolicyMembers.$inferSelect>>();
    for (const member of members) {
      const bucket = membersByPolicy.get(member.policyId) ?? [];
      bucket.push(member);
      membersByPolicy.set(member.policyId, bucket);
    }
    return policies.map((policy) => toPolicySnapshot(policy, membersByPolicy.get(policy.id) ?? []));
  }

  async getPolicy(id: string): Promise<AgentProfilePolicySnapshot | undefined> {
    const policies = await this.db.select().from(agentProfilePolicies).where(eq(agentProfilePolicies.id, id)).limit(1);
    if (!policies[0]) return undefined;
    const members = await this.db.select().from(agentProfilePolicyMembers).where(eq(agentProfilePolicyMembers.policyId, id));
    return toPolicySnapshot(policies[0], members);
  }

  async savePolicy(input: AgentProfilePolicyInput, id?: string, catalog?: AgentProfileTargetCatalog): Promise<AgentProfilePolicySnapshot> {
    const validationErrors = validatePolicyInput(input, catalog);
    if (validationErrors.length > 0) {
      throw new Error(validationErrors.join("; "));
    }

    await this.assertProfileIdsExist(input.members.map((member) => member.profileId));

    const targetKey = targetKeyFromTarget(input.target);
    let policyId = id ?? randomUUID();
    if (!id) {
      const existing = await this.db
        .select({ id: agentProfilePolicies.id })
        .from(agentProfilePolicies)
        .where(eq(agentProfilePolicies.targetKey, targetKey))
        .limit(1);
      if (existing[0]) {
        policyId = existing[0].id;
      }
    }
    const now = new Date();
    const members = normalizeMembers(input.members);

    await this.db.transaction(async (tx) => {
      const policyValues = {
        id: policyId,
        scope: input.target.scope,
        pipelineId: input.target.pipelineId,
        intentKind: input.target.intentKind,
        nodeId: input.target.nodeId,
        action: input.target.action,
        purpose: input.target.purpose,
        targetKey,
        mode: input.mode,
        enabled: input.enabled ?? true,
        updatedAt: now,
      };
      const policySet = {
        scope: input.target.scope,
        pipelineId: input.target.pipelineId,
        intentKind: input.target.intentKind,
        nodeId: input.target.nodeId,
        action: input.target.action,
        purpose: input.target.purpose,
        targetKey,
        mode: input.mode,
        enabled: input.enabled ?? true,
        updatedAt: now,
      };
      if (id) {
        await tx.insert(agentProfilePolicies).values(policyValues).onConflictDoUpdate({
          target: agentProfilePolicies.id,
          set: policySet,
        });
      } else {
        const upserted = await tx.insert(agentProfilePolicies).values(policyValues).onConflictDoUpdate({
          target: agentProfilePolicies.targetKey,
          set: policySet,
        }).returning({ id: agentProfilePolicies.id });
        policyId = upserted[0]?.id ?? policyId;
      }

      await tx.delete(agentProfilePolicyMembers).where(eq(agentProfilePolicyMembers.policyId, policyId));
      await tx.insert(agentProfilePolicyMembers).values(members.map((member) => ({
        id: randomUUID(),
        policyId,
        profileId: member.profileId,
        role: member.role,
        ordinal: member.ordinal,
        weight: member.weight,
        enabled: member.enabled,
        updatedAt: now,
      })));
    });

    const saved = await this.getPolicy(policyId);
    if (!saved) {
      throw new Error("Failed to load saved agent profile policy");
    }
    return saved;
  }

  async deletePolicy(id: string): Promise<boolean> {
    const existing = await this.getPolicy(id);
    if (!existing) return false;
    await this.db.delete(agentProfilePolicies).where(eq(agentProfilePolicies.id, id));
    return true;
  }

  async getRoutingSnapshot(): Promise<{ profiles: AgentProfileSnapshot[]; policies: AgentProfilePolicySnapshot[] }> {
    const profiles = (await this.list()).map(toSnapshot);
    const policies = await this.listPolicies();
    return { profiles, policies };
  }

  async count(): Promise<number> {
    const rows = await this.db.select({ count: sql<number>`count(*)::int` }).from(agentProfiles);
    return rows[0]?.count ?? 0;
  }

  private async assertProfileIdsExist(profileIds: string[]): Promise<void> {
    const uniqueIds = [...new Set(profileIds)];
    if (uniqueIds.length === 0) return;
    const profiles = await this.db.select({ id: agentProfiles.id }).from(agentProfiles);
    const existing = new Set(profiles.map((profile) => profile.id));
    const missing = uniqueIds.filter((id) => !existing.has(id));
    if (missing.length > 0) {
      throw new Error(`Unknown agent profile id(s): ${missing.join(", ")}`);
    }
  }
}

function validatePolicyInput(input: AgentProfilePolicyInput, catalog?: AgentProfileTargetCatalog): string[] {
  const errors = validateAgentProfileTarget(input.target, catalog);
  if (!AGENT_PROFILE_POLICY_MODES.includes(input.mode)) {
    errors.push(`Unsupported policy mode: ${input.mode}`);
  }
  if (!Array.isArray(input.members) || input.members.length === 0) {
    errors.push("At least one policy member profile is required");
  }
  if (input.mode === "single" && input.members.length !== 1) {
    errors.push("Single profile policy mode requires exactly one member");
  }
  for (const [index, member] of input.members.entries()) {
    if (!member.profileId || typeof member.profileId !== "string") {
      errors.push(`members[${String(index)}].profileId is required`);
    }
  }
  return errors;
}

function normalizeMembers(members: AgentProfilePolicyMemberInput[]): NormalizedAgentProfilePolicyMember[] {
  return members.map((member, index) => ({
    profileId: member.profileId,
    ...(trimOrUndefined(member.role) ? { role: trimOrUndefined(member.role) } : {}),
    ordinal: Number.isInteger(member.ordinal) ? Number(member.ordinal) : index,
    ...(member.weight === undefined || member.weight === null ? {} : { weight: Number(member.weight) }),
    enabled: member.enabled ?? true,
  }));
}

function trimOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
