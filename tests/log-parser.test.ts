import assert from "node:assert/strict";
import test from "node:test";
import { parseRunLog, getEventStats, type RunEvent } from "../src/log-parser.js";

// ── Minimal synthetic log ─────────────────────────────────

const MINIMAL_LOG = `Gooseherd run abc-123

$ git clone 'https://x-access-token:***@github.com/org/repo.git' '/tmp/repo'
--- loading .bash_profile
🎊 All secrets loaded from cache! Go forth and code!
Cloning into '/tmp/repo'...

$ git checkout 'main'
--- loading .bash_profile
🎊 All secrets loaded from cache! Go forth and code!
Already on 'main'

$ git checkout -b 'gooseherd/abc12345'
Switched to a new branch 'gooseherd/abc12345'

$ cd '/tmp/repo' && goose run --no-session --provider openrouter --model test-model -i '/tmp/task.md'
--- loading .bash_profile
🎊 All secrets loaded from cache! Go forth and code!
starting session | provider: openrouter model: test-model
    session id: 20260217_1
    working directory: /tmp/repo
I'll help you implement this feature. Let me start by exploring the codebase.
─── analyze | developer ──────────────────────────
path: /tmp/repo
max_depth: 2

Annotated {
    raw: Text(
        RawTextContent {
            text: "SUMMARY: 5 files",
            meta: None,
        },
    ),
    annotations: None,
}

─── shell | developer ──────────────────────────
command: find . -name "*.ts" -type f

./src/index.ts
./src/config.ts
Annotated {
    raw: Text(
        RawTextContent {
            text: "./src/index.ts\\n./src/config.ts",
            meta: None,
        },
    ),
    annotations: None,
}

Now I see the file structure. Let me edit the main file.
─── text_editor | developer ──────────────────────────
path: /tmp/repo/src/index.ts
command: str_replace
old_str: console.log("hello")
new_str: console.log("hello world")

Annotated {
    raw: Text(
        RawTextContent {
            text: "OK",
            meta: None,
        },
    ),
    annotations: None,
}

─── todo_write | todo ──────────────────────────
content: - [x] Explore codebase
- [x] Edit main file
- [ ] Run tests

Annotated {
    raw: Text(
        RawTextContent {
            text: "Updated (60 chars)",
            meta: None,
        },
    ),
    annotations: None,
}

$ git add -A
$ git commit -m 'gooseherd: run abc-123'
[gooseherd/abc12345 1234abc] gooseherd: run abc-123

$ git push origin 'gooseherd/abc12345'
remote: Create a pull request on GitHub by visiting:
remote:   https://github.com/org/repo/pull/new/gooseherd/abc12345
`;

test("parseRunLog extracts correct event types from synthetic log", () => {
  const events = parseRunLog(MINIMAL_LOG);

  // Should have info (Gooseherd run header)
  const infoEvents = events.filter((e) => e.type === "info");
  assert.ok(infoEvents.length >= 1, "should have at least 1 info event");
  assert.ok(infoEvents[0].content.includes("Gooseherd run abc-123"));

  // Should have session_start
  const sessionEvents = events.filter((e) => e.type === "session_start");
  assert.equal(sessionEvents.length, 1, "should have exactly 1 session start");
  assert.equal(sessionEvents[0].provider, "openrouter");
  assert.equal(sessionEvents[0].model, "test-model");

  // Should have tool_call events
  const toolEvents = events.filter((e) => e.type === "tool_call");
  assert.ok(toolEvents.length >= 3, `expected >= 3 tool calls, got ${toolEvents.length}`);

  const toolNames = toolEvents.map((e) => e.tool);
  assert.ok(toolNames.includes("analyze"), "should have analyze tool call");
  assert.ok(toolNames.includes("shell"), "should have shell tool call");
  assert.ok(toolNames.includes("text_editor"), "should have text_editor tool call");
  assert.ok(toolNames.includes("todo_write"), "should have todo_write tool call");

  // analyze should have path param
  const analyzeEvent = toolEvents.find((e) => e.tool === "analyze");
  assert.ok(analyzeEvent?.params?.path?.includes("/tmp/repo"));
  assert.equal(analyzeEvent?.params?.max_depth, "2");

  // shell should have command param
  const shellEvent = toolEvents.find((e) => e.tool === "shell");
  assert.ok(shellEvent?.params?.command?.includes("find"));

  // text_editor should have path param
  const editorEvent = toolEvents.find((e) => e.tool === "text_editor");
  assert.ok(editorEvent?.params?.path?.includes("index.ts"));
});

test("parseRunLog extracts agent thinking blocks", () => {
  const events = parseRunLog(MINIMAL_LOG);
  const thinking = events.filter((e) => e.type === "agent_thinking");
  assert.ok(thinking.length >= 1, "should have at least 1 thinking block");

  const thinkingText = thinking.map((e) => e.content).join(" ");
  assert.ok(
    thinkingText.includes("help you implement") || thinkingText.includes("file structure"),
    "thinking should include agent reasoning text"
  );
});

test("parseRunLog assigns progress percentages", () => {
  const events = parseRunLog(MINIMAL_LOG);
  const significant = events.filter(
    (e) => e.type === "tool_call" || e.type === "agent_thinking" || e.type === "session_start"
  );

  // First significant event should have progress > 0
  assert.ok(significant[0].progressPercent > 0, "first event should have progress > 0");

  // Last significant event should be ~100%
  const last = significant[significant.length - 1];
  assert.ok(last.progressPercent >= 90, `last event should be near 100%, got ${last.progressPercent}`);

  // Progress should be monotonically increasing
  for (let j = 1; j < significant.length; j++) {
    assert.ok(
      significant[j].progressPercent >= significant[j - 1].progressPercent,
      `progress should be monotonic: ${significant[j - 1].progressPercent} -> ${significant[j].progressPercent}`
    );
  }
});

test("parseRunLog filters noise lines", () => {
  const events = parseRunLog(MINIMAL_LOG);
  for (const event of events) {
    assert.ok(
      !event.content.includes("loading .bash_profile"),
      "should not contain bash_profile noise"
    );
    assert.ok(
      !event.content.includes("All secrets loaded"),
      "should not contain secrets loaded noise"
    );
  }
});

test("parseRunLog handles phase markers for git commands", () => {
  const events = parseRunLog(MINIMAL_LOG);
  const phaseEvents = events.filter((e) => e.type === "phase_marker");

  const phases = phaseEvents.map((e) => e.phase).filter(Boolean);
  assert.ok(phases.includes("cloning"), "should detect cloning phase");
  assert.ok(phases.includes("agent"), "should detect agent phase");
  assert.ok(phases.includes("pushing"), "should detect pushing phase");
});

test("parseRunLog handles empty and minimal logs", () => {
  assert.deepEqual(parseRunLog(""), []);
  assert.deepEqual(parseRunLog("\n\n\n"), []);

  const minimal = "Gooseherd run test-123\n";
  const events = parseRunLog(minimal);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "info");
});

test("getEventStats returns correct counts", () => {
  const events = parseRunLog(MINIMAL_LOG);
  const stats = getEventStats(events);

  assert.ok(stats.totalEvents > 0, "should have events");
  assert.ok(stats.toolCalls >= 3, `expected >= 3 tool calls, got ${stats.toolCalls}`);
  assert.ok(stats.thinkingBlocks >= 1, "should have thinking blocks");
  assert.ok(stats.shellCommands >= 1, "should have shell commands");
  assert.ok(stats.tools["analyze"] >= 1, "should count analyze tool");
  assert.ok(stats.tools["shell"] >= 1, "should count shell tool");
});

test("shortenPath strips .work/<uuid>/repo/ prefix in tool call content", () => {
  const log = `─── text_editor | developer ──────────────────────────
path: /Users/dev/gooseherd/.work/abc-def-123/repo/app/models/user.rb
command: view

Annotated {
    raw: Text(
        RawTextContent {
            text: "ok",
            meta: None,
        },
    ),
    annotations: None,
}
`;
  const events = parseRunLog(log);
  const toolEvent = events.find((e) => e.type === "tool_call");
  assert.ok(toolEvent, "should have tool event");
  assert.ok(
    toolEvent.content.includes("app/models/user.rb"),
    "content should use shortened path"
  );
  assert.ok(
    !toolEvent.content.includes(".work/abc-def"),
    "content should not include .work prefix"
  );
});

// ── Test with a real-ish multi-tool sequence ────────────

test("parseRunLog handles interleaved tool calls correctly", () => {
  const log = `starting session | provider: openrouter model: gpt-4
    session id: 20260217_5
    working directory: /tmp/repo
Let me analyze the code first.
─── analyze | developer ──────────────────────────
path: /tmp/repo
max_depth: 1

Annotated {
    raw: Text(
        RawTextContent {
            text: "SUMMARY",
            meta: None,
        },
    ),
    annotations: None,
}

I see the structure. Now let me search for the relevant file.
─── shell | developer ──────────────────────────
command: grep -r "TODO" src/

src/index.ts:// TODO: implement
Annotated {
    raw: Text(
        RawTextContent {
            text: "src/index.ts:// TODO: implement",
            meta: None,
        },
    ),
    annotations: None,
}

Found it! Let me make the change.
─── text_editor | developer ──────────────────────────
path: /tmp/repo/src/index.ts
command: str_replace
old_str: // TODO: implement
new_str: console.log("implemented")

Annotated {
    raw: Text(
        RawTextContent {
            text: "OK",
            meta: None,
        },
    ),
    annotations: None,
}

All done! The changes have been applied.
`;

  const events = parseRunLog(log);
  const types = events.map((e) => e.type);

  // Should alternate: session -> thinking -> tool -> thinking -> tool -> thinking -> tool -> thinking
  assert.equal(types[0], "session_start");
  assert.equal(types[1], "agent_thinking"); // "Let me analyze..."
  assert.equal(types[2], "tool_call"); // analyze
  assert.equal(types[3], "agent_thinking"); // "I see the structure..."
  assert.equal(types[4], "tool_call"); // shell
  assert.equal(types[5], "agent_thinking"); // "Found it..."
  assert.equal(types[6], "tool_call"); // text_editor
  assert.equal(types[7], "agent_thinking"); // "All done..."
});

test("parseRunLog handles braces inside quoted strings in Annotated blocks", () => {
  const log = `─── analyze | developer ──────────────────────────
path: /tmp/repo

Annotated {
    raw: Text(
        RawTextContent {
            text: ".container { display: flex; } .header { color: red; } body { margin: 0; }",
            meta: None,
        },
    ),
    annotations: Some(
        Annotations {
            audience: Some(
                [
                    User,
                ],
            ),
            priority: Some(
                0.0,
            ),
        },
    ),
}

Now I understand the CSS structure.
`;
  const events = parseRunLog(log);
  const types = events.map((e) => e.type);

  // Should be: tool_call, then agent_thinking
  assert.equal(types[0], "tool_call");
  assert.equal(types[1], "agent_thinking");
  assert.equal(events[1].content, "Now I understand the CSS structure.");

  // The thinking block should NOT contain Annotated content
  assert.ok(
    !events[1].content.includes("RawTextContent"),
    "thinking should not contain leaked Annotated content"
  );
  assert.ok(
    !events[1].content.includes("annotations"),
    "thinking should not contain annotations"
  );
});

test("parseRunLog filters leaked Annotated content from thinking", () => {
  // Simulate a case where Annotated block content leaks into thinking
  // (e.g., if skipAnnotatedBlock exits early)
  const log = `I'll analyze the code.
─── shell | developer ──────────────────────────
command: ls

file1.txt
file2.txt
Annotated {
    raw: Text(
        RawTextContent {
            text: "file1.txt\\nfile2.txt",
            meta: None,
        },
    ),
    annotations: None,
}

Great, I see the files. Let me continue.
`;
  const events = parseRunLog(log);
  const thinking = events.filter((e) => e.type === "agent_thinking");

  for (const t of thinking) {
    assert.ok(
      !t.content.includes("RawTextContent"),
      "thinking should not contain RawTextContent: " + t.content.slice(0, 100)
    );
    assert.ok(
      !t.content.includes("annotations: None"),
      "thinking should not contain annotations: None"
    );
  }
});
