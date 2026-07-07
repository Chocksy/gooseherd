import assert from "node:assert/strict";
import test from "node:test";
import {
  extractJsonObjectAfterPrefix,
  extractSentinelJson,
  extractSentinelMatch,
  findSentinelText,
} from "../src/pipeline/agent-output/sentinel.js";

const TRIAGE_PATTERN = /^\s*GOOSEHERD_CI_TRIAGE:/m;
const TRIAGE_PREFIX = "GOOSEHERD_CI_TRIAGE:";

test("extractSentinelJson parses a plain-text sentinel line", () => {
  const output = [
    "Some preceding agent log line",
    'GOOSEHERD_CI_TRIAGE: {"verdict":"rerun","reason":"flaky","evidence":["x"]}',
    "trailing",
  ].join("\n");

  const result = extractSentinelJson(output, TRIAGE_PATTERN, TRIAGE_PREFIX);
  assert.equal(result.found, true);
  assert.equal(result.match?.method, "plain_text");
  assert.deepEqual(result.parsed, {
    verdict: "rerun",
    reason: "flaky",
    evidence: ["x"],
  });
});

test("extractSentinelJson returns parseError when JSON is malformed", () => {
  const output = 'GOOSEHERD_CI_TRIAGE: {"verdict": "rerun", oops bad}';
  const result = extractSentinelJson(output, TRIAGE_PATTERN, TRIAGE_PREFIX);
  // The JSON object scanner is brace-balanced, so it returns "missing_json" or "invalid_json"
  // depending on whether it could even isolate a {…} blob. Either way, parsed should be undefined.
  assert.equal(result.found, true);
  assert.equal(result.parsed, undefined);
  assert.ok(
    result.parseError === "invalid_json" || result.parseError === "missing_json",
    `unexpected parseError: ${String(result.parseError)}`,
  );
});

test("extractSentinelJson reports missing_json when sentinel has no object", () => {
  const output = "GOOSEHERD_CI_TRIAGE: bare text without JSON";
  const result = extractSentinelJson(output, TRIAGE_PATTERN, TRIAGE_PREFIX);
  assert.equal(result.found, true);
  assert.equal(result.parseError, "missing_json");
});

test("extractSentinelJson returns found=false when sentinel is absent", () => {
  const result = extractSentinelJson("nothing here", TRIAGE_PATTERN, TRIAGE_PREFIX);
  assert.equal(result.found, false);
});

test("extractSentinelMatch in JSONL fallback prefers JSON-bearing match", () => {
  // Two JSONL events: bare-text first, then a JSON-payload one. With
  // requireJsonObject=true the parser must skip the bare match and return
  // the JSON-bearing one.
  const bareEvent = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "GOOSEHERD_CI_TRIAGE: just a label" }],
    },
  });
  const jsonEvent = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: 'GOOSEHERD_CI_TRIAGE: {"verdict":"fix_needed","reason":"ok"}',
        },
      ],
    },
  });
  const output = [bareEvent, jsonEvent].join("\n");

  const match = extractSentinelMatch(output, TRIAGE_PATTERN, TRIAGE_PREFIX, {
    requireJsonObject: true,
  });
  assert.ok(match);
  assert.match(match!.text, /\{"verdict":"fix_needed"/);
});

test("extractJsonObjectAfterPrefix handles nested braces and string escapes", () => {
  const value = 'GOOSEHERD_CI_TRIAGE: {"a":{"b":"c with \\"quote\\""},"d":"}"}';
  const json = extractJsonObjectAfterPrefix(value, TRIAGE_PREFIX);
  assert.ok(json);
  const parsed = JSON.parse(json!);
  assert.deepEqual(parsed, { a: { b: 'c with "quote"' }, d: "}" });
});

test("findSentinelText with requireJsonObject extracts JSON from across lines", () => {
  const value = [
    'GOOSEHERD_CI_TRIAGE: {',
    '  "verdict": "rerun",',
    '  "reason": "infra"',
    '}',
  ].join("\n");
  const text = findSentinelText(value, TRIAGE_PREFIX, { requireJsonObject: true });
  assert.ok(text);
  assert.match(text!, /\{[\s\S]*"verdict"[\s\S]*"rerun"[\s\S]*\}/);
});

test("extractSentinelJson finds sentinel inside pi-agent JSONL message_end", () => {
  const jsonlLine = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: 'wrap GOOSEHERD_CI_TRIAGE: {"verdict":"rerun","reason":"flaky"} unwrap',
        },
      ],
    },
  });
  const output = [
    "some plain log",
    jsonlLine,
    "more plain log",
  ].join("\n");

  const result = extractSentinelJson(output, TRIAGE_PATTERN, TRIAGE_PREFIX);
  assert.equal(result.found, true);
  assert.equal(result.match?.method, "pi_jsonl_message_end");
  assert.deepEqual(result.parsed, { verdict: "rerun", reason: "flaky" });
});
