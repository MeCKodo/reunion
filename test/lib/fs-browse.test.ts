import "../_env.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";

import {
  listBookmarks,
  listDirectory,
  resolveBrowsePath,
} from "../../src/lib/fs-browse.js";
import { mkTmpDir, rmDir } from "../_helpers.js";

const scratch = mkTmpDir("reunion-browse");
after(async () => rmDir(scratch));

describe("lib/fs-browse/resolveBrowsePath", () => {
  it("falls back to home for empty / null / whitespace input", () => {
    const home = os.homedir();
    assert.equal(resolveBrowsePath(""), home);
    assert.equal(resolveBrowsePath("   "), home);
    assert.equal(resolveBrowsePath(null), home);
    assert.equal(resolveBrowsePath(undefined), home);
  });

  it("expands ~ and ~/ to the home directory", () => {
    const home = os.homedir();
    assert.equal(resolveBrowsePath("~"), home);
    assert.equal(resolveBrowsePath("~/foo/bar"), path.resolve(home, "foo/bar"));
  });

  it("resolves absolute paths as-is", () => {
    assert.equal(resolveBrowsePath("/tmp"), path.resolve("/tmp"));
  });
});

describe("lib/fs-browse/listDirectory", () => {
  it("returns directories only and floats git repos to the top", async () => {
    // Layout:
    //   scratch/browse/
    //     a-plain/
    //     b-repo/.git/
    //     c-hidden/   (hidden — sinks to bottom)
    //     file.txt    (filtered out)
    const root = path.join(scratch, "browse");
    await fsp.mkdir(root);
    await fsp.mkdir(path.join(root, "a-plain"));
    await fsp.mkdir(path.join(root, "b-repo", ".git"), { recursive: true });
    await fsp.mkdir(path.join(root, ".hidden"));
    await fsp.writeFile(path.join(root, "file.txt"), "ignored");

    const result = await listDirectory(root);

    assert.equal(result.path, root);
    assert.equal(result.parent, path.dirname(root));

    const names = result.entries.map((entry) => entry.name);
    assert.deepEqual(names, ["b-repo", "a-plain", ".hidden"]);

    const repo = result.entries.find((entry) => entry.name === "b-repo")!;
    assert.equal(repo.isGitRepo, true);
    assert.equal(repo.hidden, false);

    const hidden = result.entries.find((entry) => entry.name === ".hidden")!;
    assert.equal(hidden.hidden, true);
  });

  it("rejects when target is not a directory", async () => {
    const f = path.join(scratch, "not-a-dir.txt");
    await fsp.writeFile(f, "x");
    await assert.rejects(() => listDirectory(f), /not a directory/i);
  });

  it("returns parent=null for the filesystem root", async () => {
    const root = path.parse(scratch).root;
    const result = await listDirectory(root);
    assert.equal(result.parent, null);
  });
});

describe("lib/fs-browse/listBookmarks", () => {
  it("always returns the user home dir, plus any common workspace folders that exist", async () => {
    const out = await listBookmarks();
    assert.equal(out.home, os.homedir());
    assert.ok(Array.isArray(out.workspaces));
    for (const ws of out.workspaces) {
      const stat = await fsp.stat(ws);
      assert.ok(stat.isDirectory());
    }
  });
});
