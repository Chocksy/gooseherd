import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyThreadMessage,
  parseFollowUpMessage,
  stripMentions
} from "../src/slack-app.js";

// ── stripMentions ───────────────────────────────────────

test("stripMentions removes Slack user mentions", () => {
  assert.equal(stripMentions("<@U1234> hello"), "hello");
  assert.equal(stripMentions("<@U1234> <@U5678> fix the bug"), "fix the bug");
  assert.equal(stripMentions("no mentions here"), "no mentions here");
  assert.equal(stripMentions("<@UBOT>"), "");
});

// ── classifyThreadMessage ───────────────────────────────

test("classifyThreadMessage: casual greetings and acknowledgments", () => {
  const casualInputs = [
    "thanks", "thank you!", "thx", "ty", "ok", "okay", "cool",
    "nice", "great!", "awesome", "perfect", "good", "yep", "yeah",
    "yes", "no", "nah", "nope", "sure", "np", "lol", "haha", "wow",
    "👍", "👎", "🎉", "✅", "❌", "k"
  ];
  for (const input of casualInputs) {
    assert.equal(
      classifyThreadMessage(input),
      "casual",
      `"${input}" should be casual`
    );
  }
});

test("classifyThreadMessage: casual with trailing punctuation", () => {
  assert.equal(classifyThreadMessage("thanks!"), "casual");
  assert.equal(classifyThreadMessage("ok."), "casual");
  assert.equal(classifyThreadMessage("cool?"), "casual");
  assert.equal(classifyThreadMessage("nice!!"), "casual");
});

test("classifyThreadMessage: casual ignores mentions before classifying", () => {
  assert.equal(classifyThreadMessage("<@U1234> thanks"), "casual");
  assert.equal(classifyThreadMessage("<@UBOT> ok"), "casual");
  assert.equal(classifyThreadMessage("<@U1234> 👍"), "casual");
});

test("classifyThreadMessage: empty or mention-only is casual", () => {
  assert.equal(classifyThreadMessage(""), "casual");
  assert.equal(classifyThreadMessage("<@U1234>"), "casual");
  assert.equal(classifyThreadMessage("   "), "casual");
});

test("classifyThreadMessage: approval signals", () => {
  const approvalInputs = [
    "lgtm", "looks good", "approved", "approve", "ship it",
    "ship", "merge it", "merge", "good to go", "all good"
  ];
  for (const input of approvalInputs) {
    assert.equal(
      classifyThreadMessage(input),
      "approval",
      `"${input}" should be approval`
    );
  }
});

test("classifyThreadMessage: approval case-insensitive", () => {
  assert.equal(classifyThreadMessage("LGTM"), "approval");
  assert.equal(classifyThreadMessage("Looks Good!"), "approval");
  assert.equal(classifyThreadMessage("Ship It."), "approval");
});

test("classifyThreadMessage: retry patterns (standalone only)", () => {
  assert.equal(classifyThreadMessage("retry"), "retry");
  assert.equal(classifyThreadMessage("rerun"), "retry");
  assert.equal(classifyThreadMessage("run again"), "retry");
  assert.equal(classifyThreadMessage("try again"), "retry");
  assert.equal(classifyThreadMessage("Retry"), "retry");
  assert.equal(classifyThreadMessage("retry!"), "retry");
  assert.equal(classifyThreadMessage("retry."), "retry");
});

test("classifyThreadMessage: retry with directives becomes follow_up", () => {
  // "retry base=develop" should be follow_up so the base override is preserved
  assert.equal(classifyThreadMessage("retry base=develop"), "follow_up");
  assert.equal(classifyThreadMessage("retry and fix the tests"), "follow_up");
});

test("classifyThreadMessage: follow_up for action-oriented messages", () => {
  assert.equal(classifyThreadMessage("add error handling to the form"), "follow_up");
  assert.equal(classifyThreadMessage("fix the typo in the header"), "follow_up");
  assert.equal(classifyThreadMessage("change the button color to blue"), "follow_up");
  assert.equal(classifyThreadMessage("update the README with the new API"), "follow_up");
  assert.equal(classifyThreadMessage("remove the deprecated method"), "follow_up");
  assert.equal(classifyThreadMessage("refactor the auth module"), "follow_up");
});

test("classifyThreadMessage: short messages without action verbs are casual", () => {
  assert.equal(classifyThreadMessage("I see"), "casual");
  assert.equal(classifyThreadMessage("got it"), "casual");
  // "hmm interesting" is 15 chars, at the boundary — longer messages become follow_up
  assert.equal(classifyThreadMessage("hmm"), "casual");
});

test("classifyThreadMessage: longer messages are follow_up even without action verbs", () => {
  assert.equal(
    classifyThreadMessage("the button on the landing page should be green instead of red"),
    "follow_up"
  );
});

test("classifyThreadMessage: mentions stripped before classifying follow_up", () => {
  assert.equal(
    classifyThreadMessage("<@UBOT> add a new endpoint for user profiles"),
    "follow_up"
  );
});

// ── parseFollowUpMessage ────────────────────────────────

test("parseFollowUpMessage: basic task extraction", () => {
  const result = parseFollowUpMessage("fix the login bug");
  assert.equal(result.task, "fix the login bug");
  assert.equal(result.baseBranch, undefined);
  assert.equal(result.retry, false);
});

test("parseFollowUpMessage: strips mentions before parsing", () => {
  const result = parseFollowUpMessage("<@U1234> add error handling");
  assert.equal(result.task, "add error handling");
});

test("parseFollowUpMessage: extracts base= directive", () => {
  const result = parseFollowUpMessage("fix the bug base=develop");
  assert.equal(result.baseBranch, "develop");
  assert.ok(!result.task.includes("base=develop"));
  assert.ok(result.task.includes("fix the bug"));
});

test("parseFollowUpMessage: extracts branch: directive", () => {
  const result = parseFollowUpMessage("branch: main fix the header");
  assert.equal(result.baseBranch, "main");
  assert.ok(!result.task.includes("branch:"));
});

test("parseFollowUpMessage: extracts natural branch reference", () => {
  const result = parseFollowUpMessage("base is staging fix the deploy script");
  assert.equal(result.baseBranch, "staging");
});

test("parseFollowUpMessage: detects retry", () => {
  const result = parseFollowUpMessage("retry");
  assert.equal(result.retry, true);
  assert.equal(result.task, "retry");
});

test("parseFollowUpMessage: retry with base override", () => {
  const result = parseFollowUpMessage("base=develop retry");
  assert.equal(result.retry, true); // after branch extracted, remaining task is "retry"
  assert.equal(result.baseBranch, "develop");
});

test("parseFollowUpMessage: empty input", () => {
  const result = parseFollowUpMessage("");
  assert.equal(result.task, "");
  assert.equal(result.baseBranch, undefined);
  assert.equal(result.retry, false);
});

test("parseFollowUpMessage: mention-only input", () => {
  const result = parseFollowUpMessage("<@U1234>");
  assert.equal(result.task, "");
  assert.equal(result.retry, false);
});

test("parseFollowUpMessage: complex branch names", () => {
  const result = parseFollowUpMessage("base=feature/auth-v2 update the login");
  assert.equal(result.baseBranch, "feature/auth-v2");
  assert.ok(result.task.includes("update the login"));
});

test("parseFollowUpMessage: branch to natural form", () => {
  const result = parseFollowUpMessage("branch to release/1.0 fix the tests");
  assert.equal(result.baseBranch, "release/1.0");
});
