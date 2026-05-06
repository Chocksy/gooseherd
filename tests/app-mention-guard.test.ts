import assert from "node:assert/strict";
import test from "node:test";
import { shouldIgnoreAppMention } from "../src/slack/app-mention-guard.js";

test("shouldIgnoreAppMention: ignores events with bot_id set", () => {
  assert.equal(
    shouldIgnoreAppMention({ type: "app_mention", text: "@Hubble status", bot_id: "B0123" }),
    true
  );
});

test("shouldIgnoreAppMention: ignores events with subtype 'bot_message'", () => {
  assert.equal(
    shouldIgnoreAppMention({ type: "app_mention", text: "@Hubble tail", subtype: "bot_message" }),
    true
  );
});

test("shouldIgnoreAppMention: ignores events missing both user and bot_id (not actionable)", () => {
  assert.equal(
    shouldIgnoreAppMention({ type: "app_mention", text: "@Hubble status" }),
    true
  );
});

test("shouldIgnoreAppMention: does NOT ignore real user mentions", () => {
  assert.equal(
    shouldIgnoreAppMention({ type: "app_mention", text: "@Hubble run owner/repo", user: "U999" }),
    false
  );
});
