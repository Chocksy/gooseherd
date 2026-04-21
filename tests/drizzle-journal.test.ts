import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

test("drizzle journal tracks every SQL migration file", async () => {
  const drizzleDir = path.resolve("drizzle");
  const metaJournalPath = path.join(drizzleDir, "meta", "_journal.json");

  const files = await readdir(drizzleDir);
  const sqlTags = files
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .map((file) => file.replace(/\.sql$/, ""))
    .sort();

  const journalRaw = await readFile(metaJournalPath, "utf8");
  const journal = JSON.parse(journalRaw) as { entries?: Array<{ tag?: string }> };
  const journalTags = (journal.entries ?? [])
    .map((entry) => entry.tag)
    .filter((tag): tag is string => typeof tag === "string")
    .sort();

  assert.deepEqual(journalTags, sqlTags);
});
