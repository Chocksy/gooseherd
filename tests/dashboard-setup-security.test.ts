import assert from "node:assert/strict";
import test from "node:test";
import { SetupStore, type SetupWizardState } from "../src/db/setup-store.js";

test("wizard state keeps non-secret prefill values but never returns secret values", async () => {
  const setupStore = new SetupStore({} as never);

  setupStore.getStatus = async () => ({
    complete: false,
    hasPassword: false,
    hasGithub: true,
    hasLlm: true,
    hasSlack: true,
  });

  (setupStore as any).readConfigSection = async (section: string) => {
    if (section === "github") {
      return {
        config: { authMode: "pat", defaultOwner: "acme" },
        secrets: { token: "ghp_secret" },
      };
    }
    if (section === "llm") {
      return {
        config: { provider: "openrouter", defaultModel: "openrouter/auto" },
        secrets: { apiKey: "sk-or-secret" },
      };
    }
    if (section === "slack") {
      return {
        config: {
          commandName: "/goose",
          clientId: "client-id",
          authRedirectUri: "https://example.test/slack/callback",
        },
        secrets: {
          botToken: "xoxb-secret",
          appToken: "xapp-secret",
          clientSecret: "client-secret",
        },
      };
    }
    return undefined;
  };

  const state = await setupStore.getWizardState();
  const prefill = state.prefill as SetupWizardState["prefill"];
  const serialized = JSON.stringify(state);

  assert.equal(prefill.github.defaultOwner.value, "acme");
  assert.notEqual(prefill.github.token.source, "none");
  assert.equal(prefill.github.token.value, undefined);
  assert.notEqual(prefill.llm.apiKey.source, "none");
  assert.equal(prefill.llm.apiKey.value, undefined);
  assert.equal(prefill.llm.defaultModel.value, "openrouter/auto");
  assert.notEqual(prefill.slack.botToken.source, "none");
  assert.equal(prefill.slack.botToken.value, undefined);
  assert.equal(prefill.slack.clientId.value, "client-id");
  assert.notEqual(prefill.slack.clientSecret.source, "none");
  assert.equal(prefill.slack.clientSecret.value, undefined);
  assert.equal(prefill.slack.authRedirectUri.value, "https://example.test/slack/callback");
  assert.doesNotMatch(serialized, /ghp_secret|sk-or-secret|xoxb-secret|xapp-secret|client-secret/);
});
