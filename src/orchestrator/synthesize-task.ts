/**
 * Synthesize a clean task spec from a Slack conversation transcript.
 * Used at the moment a conversation run promotes to build phase, so
 * pi-agent receives a focused prompt instead of the raw chat history.
 */
import type { ChatMessage, LLMCallerConfig } from "../llm/caller.js";
import { callLLMWithTools } from "../llm/caller.js";
import { logWarn } from "../logger.js";

export interface SynthesizeTaskInput {
  llmConfig: LLMCallerConfig;
  model: string;
  messages: ChatMessage[];
  proposal: { repoSlug: string; summary: string };
  /** Test seam — replaces callLLMWithTools when set. */
  _callLLMOverride?: typeof callLLMWithTools;
}

export interface SynthesizeTaskResult {
  task: string;
  tokenUsage: Array<{ model: string; input: number; output: number }>;
  fallback: boolean;
}

const SYSTEM_PROMPT = `You are converting a Slack conversation into a clean task spec for a coding agent.
Output the spec in markdown with these sections (omit any that don't apply):

## Goal
One sentence describing what to build.

## Context
Relevant facts from the conversation — what's broken, what was found.

## Files / Areas
Specific files, modules, or paths the agent should focus on.

## Approach
The plan agreed on in the conversation.

## Constraints
Anything to avoid or preserve.

## Success criteria
How the agent knows it's done.

Keep it concise — the agent reads this once and runs.`;

function fallbackTask(proposal: { repoSlug: string; summary: string }): string {
  return `## Goal\n${proposal.summary}\n\n## Repo\n${proposal.repoSlug}\n`;
}

function messageToText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (part.type === "text" ? part.text : "[non-text]"))
      .join("\n");
  }
  return "";
}

export async function synthesizeTask(input: SynthesizeTaskInput): Promise<SynthesizeTaskResult> {
  const callFn = input._callLLMOverride ?? callLLMWithTools;
  const transcript = input.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `**${m.role}:** ${messageToText(m)}`)
    .join("\n\n");
  const userMessage = `Conversation transcript:\n\n${transcript}\n\n---\n\nProposed change: ${input.proposal.summary}\nRepo: ${input.proposal.repoSlug}\n\nWrite the task spec.`;

  try {
    const result = await callFn(input.llmConfig, {
      system: SYSTEM_PROMPT,
      initialMessages: [{ role: "user", content: userMessage }],
      tools: [],
      executeTool: async () => "",
      model: input.model,
      maxTokens: 1500,
      timeoutMs: 90_000,
      wallClockTimeoutMs: 90_000,
    });
    return {
      task: result.content || fallbackTask(input.proposal),
      tokenUsage: result.perModelUsage ?? [],
      fallback: !result.content,
    };
  } catch (err) {
    logWarn("synthesizeTask: LLM call failed; falling back", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      task: fallbackTask(input.proposal),
      tokenUsage: [],
      fallback: true,
    };
  }
}
