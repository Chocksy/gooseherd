import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCloneReference } from "../src/pipeline/clone-reference-resolver.js";

test("resolveCloneReference returns undefined when seed dir is missing", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "seed-resolver-"));
  try {
    assert.equal(await resolveCloneReference(path.join(tmp, "nonexistent")), undefined);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("resolveCloneReference returns undefined when seed dir exists but lacks .git", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "seed-resolver-"));
  try {
    assert.equal(await resolveCloneReference(tmp), undefined);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("resolveCloneReference returns seed path when seed/.git is a directory", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "seed-resolver-"));
  try {
    await mkdir(path.join(tmp, ".git"));
    assert.equal(await resolveCloneReference(tmp), tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
