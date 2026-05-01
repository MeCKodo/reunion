import "../_env.js";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { atomicWriteFile, ensureDataDir, tryReadFile } from "../../src/lib/fs.js";
import { TEST_DIRS } from "../_env.js";
import { mkTmpDir, rmDir } from "../_helpers.js";

const scratch = mkTmpDir("reunion-fs");
after(async () => rmDir(scratch));

describe("lib/fs/ensureDataDir", () => {
  it("creates the configured DATA_DIR (idempotent)", async () => {
    // The env bootstrap already mkdir'd it; running again must not throw.
    await ensureDataDir();
    await ensureDataDir();
    const stat = await fsp.stat(TEST_DIRS.data);
    assert.ok(stat.isDirectory());
  });
});

describe("lib/fs/atomicWriteFile", () => {
  it("writes the given content via a .tmp + rename", async () => {
    const target = path.join(scratch, "out.json");
    await atomicWriteFile(target, '{"k":1}');
    const text = await fsp.readFile(target, "utf-8");
    assert.equal(text, '{"k":1}');
    // The .tmp side-file should have been renamed away.
    await assert.rejects(fsp.access(`${target}.tmp`));
  });

  it("overwrites an existing file with the latest content", async () => {
    const target = path.join(scratch, "out2.json");
    await atomicWriteFile(target, "first");
    await atomicWriteFile(target, "second");
    assert.equal(await fsp.readFile(target, "utf-8"), "second");
  });
});

describe("lib/fs/tryReadFile", () => {
  it("returns the buffer for an existing file", async () => {
    const target = path.join(scratch, "exists.txt");
    await fsp.writeFile(target, "hello");
    const buf = await tryReadFile(target);
    assert.ok(buf);
    assert.equal(buf!.toString("utf-8"), "hello");
  });

  it("returns null for a missing file (does not throw)", async () => {
    const buf = await tryReadFile(path.join(scratch, "nope-does-not-exist"));
    assert.equal(buf, null);
  });
});
