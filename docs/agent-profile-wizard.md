# Agent Profile Wizard

## Goal

Replace the single raw `AGENT_COMMAND_TEMPLATE` env var as the primary configuration
mechanism with a structured "Agent Profile" system stored in the database and
editable from the web UI.

The intent is to make agent configuration:

- easier to understand
- easier to validate
- safer to edit
- less dependent on hand-written shell strings

This should be conceptually similar to the existing `/setup` wizard: a guided UI
flow that helps the operator choose a valid configuration.

## Why

Today, the agent runtime is configured by a raw shell template, for example:

```bash
cd {{repo_dir}} && pi -p @{{prompt_file}} --model openrouter/openai/gpt-4.1-mini --no-session --mode json --tools read,write,edit,bash,grep,find,ls
```

This has several problems:

- easy to break quoting or argument structure
- hard to validate before saving
- hard to explain in the UI
- easy to create invalid combinations of runtime, provider, and model
- impossible to guide the user based on configured API keys

## Core Idea

Instead of storing only a raw template string, Gooseherd should store a structured
Agent Profile and derive the final command from it.

An Agent Profile represents:

- which CLI/runtime to use
- which provider to use
- which model to use
- which tools to enable
- optional extra runtime-specific settings

The rendered command becomes a derived artifact, not the main source of truth.

## First-Version Scope

The first version should focus on a guided wizard and a minimal structured model.

Suggested supported runtimes:

- `pi`
- `codex`
- `claude`

The first version should also keep an escape hatch:

- `custom` profile type with a raw command template

This avoids blocking uncommon or experimental setups while still moving the main
path toward structured configuration.

## Agent Profile Data Model

Suggested fields:

- `id`
- `name`
- `description`
- `runtime`
- `provider`
- `model`
- `tools`
- `mode`
- `extensions`
- `extra_args`
- `is_builtin`
- `is_active`
- `custom_command_template`

Notes:

- `runtime` is the CLI, such as `pi` or `codex`
- `provider` is the API/backend provider, such as `openai` or `openrouter`
- `model` is the selected model id
- `tools` is the selected tool set for runtimes that support tool selection
- `custom_command_template` is only for the `custom` escape hatch

## UI Direction

Add a dedicated Agent Profile wizard in the web UI, similar in spirit to `/setup`.

Suggested flow:

1. Choose runtime
2. Choose provider
3. Choose model
4. Choose tools
5. Review generated command preview
6. Save profile and optionally mark it active/default

The UI should explain what the profile does in plain language, not only show the
 generated shell command.

## Provider Availability

The wizard should only offer providers that are actually configured in the current
environment.

Examples:

- If `OPENAI_API_KEY` is configured, show `openai`
- If `OPENROUTER_API_KEY` is not configured, do not offer `openrouter`
- If `ANTHROPIC_API_KEY` is configured, show `anthropic`

This prevents users from building profiles that are guaranteed to fail at runtime.

It is useful to distinguish:

- provider configured or not configured
- model list available or not available
- runtime/provider combination supported or not supported

## Online Model Loading

For each selected provider, the wizard should load the available models online.

This should be done live from the backend when the provider is selected.

Proposed behavior:

- frontend requests models for the selected provider
- backend loads the provider's current model catalog
- frontend shows the available models for selection
- user may still manually enter a model id if needed

Important decision:

- do not cache model-catalog results

Rationale:

- model availability changes often enough that stale data is misleading
- this is an operator-facing configuration flow, not a hot path
- correctness is more important than hiding an extra network call
- fallback to manual model entry is sufficient if the provider catalog request fails

## Validation Rules

The wizard should validate configuration before saving.

Examples:

- `pi + openai` is valid when `OPENAI_API_KEY` exists
- `pi + openrouter` is valid when `OPENROUTER_API_KEY` exists
- `pi + openrouter` should not even be selectable without that key
- unsupported runtime/provider pairs should be rejected by the backend even if the
  UI somehow submits them

Validation should happen in two places:

- frontend for good UX
- backend for correctness

## Command Rendering

Each runtime should have its own renderer that converts an Agent Profile into the
final command string.

Examples:

- `pi` renderer
- `codex` renderer
- `claude` renderer

This is preferable to one giant generic template builder because each CLI has its
own conventions and arguments.

The generated command should be shown in the UI as a preview, but the profile data
should remain the canonical representation.

## Built-In Profiles

Gooseherd should likely ship with a small set of built-in profiles such as:

- `pi + OpenAI`
- `pi + OpenRouter`
- `claude + Anthropic`

Built-in profiles should include:

- human-readable name
- short description
- reasonable default tools
- recommended default model where possible

These profiles should help users get started quickly without writing commands by
hand.

## API / Backend Shape

Likely backend needs:

- endpoint to list available providers based on current env
- endpoint to load models for a provider
- CRUD for agent profiles
- endpoint or service to render a profile into a command preview
- validation layer for runtime/provider/model/tool compatibility

## Non-Goals For First Version

- caching provider model catalogs
- abstracting every possible CLI at once
- removing the raw-template escape hatch
- making the UI depend entirely on provider model APIs

## Summary

The recommended direction is:

- move from raw shell template editing to structured Agent Profiles
- add an Agent Profile wizard in the web UI
- only show configured providers
- load model lists online per provider without caching
- keep a `custom` fallback for advanced cases
- render final commands from structured profile data via runtime-specific renderers

This should make agent configuration much more understandable and much harder to
misconfigure.
