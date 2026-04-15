import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

interface JournalEntry {
  tag: string;
}

interface MigrationJournal {
  entries: JournalEntry[];
}

test("drizzle journal covers every migration file", async () => {
  const rootDir = process.cwd();
  const drizzleDir = path.join(rootDir, "drizzle");
  const journalPath = path.join(drizzleDir, "meta", "_journal.json");

  const [journalRaw, allEntries] = await Promise.all([
    readFile(journalPath, "utf8"),
    readdir(drizzleDir, { withFileTypes: true }),
  ]);

  const migrationFiles = allEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name.replace(/\.sql$/, ""))
    .sort();
  const journal = JSON.parse(journalRaw) as MigrationJournal;
  const journalTags = journal.entries.map((entry) => entry.tag).sort();

  assert.deepEqual(journalTags, migrationFiles);
});

test("next migration slot is reserved for work items schema", async () => {
  const rootDir = process.cwd();
  const drizzleDir = path.join(rootDir, "drizzle");
  const allEntries = await readdir(drizzleDir, { withFileTypes: true });

  const migrationFiles = allEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  assert.ok(
    migrationFiles.includes("0007_work_items.sql"),
    "Expected work items migration file drizzle/0007_work_items.sql to exist"
  );
});
