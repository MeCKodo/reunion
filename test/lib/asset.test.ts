import "../_env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { resolveAssetPath } from "../../src/lib/asset.js";
import type { SourceRoots } from "../../src/types.js";

const roots: SourceRoots = {
  cursor: "/tmp/reunion-roots/cursor",
  claudeCode: "/tmp/reunion-roots/claude",
  codex: "/tmp/reunion-roots/codex",
};

describe("lib/asset/resolveAssetPath", () => {
  it("rejects empty path with 400", () => {
    const out = resolveAssetPath("", roots);
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.status, 400);
      assert.match(out.error, /missing path/i);
    }
  });

  it("rejects non-image extensions with 415", () => {
    const target = path.join(roots.cursor, "foo.json");
    const out = resolveAssetPath(target, roots);
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.status, 415);
  });

  it("rejects paths outside any allowed root with 403", () => {
    const out = resolveAssetPath("/etc/passwd.png", roots);
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.status, 403);
  });

  it("accepts an image directly inside an allowed root", () => {
    const target = path.join(roots.claudeCode, "img", "x.png");
    const out = resolveAssetPath(target, roots);
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.absPath, path.resolve(target));
      assert.equal(out.mime, "image/png");
    }
  });

  it("accepts every whitelisted image type", () => {
    const exts: Array<[string, string]> = [
      ["jpg", "image/jpeg"],
      ["jpeg", "image/jpeg"],
      ["gif", "image/gif"],
      ["webp", "image/webp"],
      ["svg", "image/svg+xml"],
      ["bmp", "image/bmp"],
      ["avif", "image/avif"],
      ["ico", "image/x-icon"],
    ];
    for (const [ext, mime] of exts) {
      const target = path.join(roots.codex, `pic.${ext}`);
      const out = resolveAssetPath(target, roots);
      assert.equal(out.ok, true, `should accept .${ext}`);
      if (out.ok) assert.equal(out.mime, mime);
    }
  });

  it("rejects path traversal attempts that escape the root", () => {
    // resolve() will collapse `..`, so this ends up at /tmp/reunion-roots — not
    // inside any allowed root.
    const out = resolveAssetPath(path.join(roots.cursor, "..", "..", "secret.png"), roots);
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.status, 403);
  });

  it("treats the root itself as in-bounds (defensive, but allowed)", () => {
    // The root usually isn't a *.png file — this just exercises the
    // "abs === root" branch of the membership check.
    const fakeRoot = "/tmp/img.png";
    const out = resolveAssetPath(fakeRoot, { ...roots, cursor: fakeRoot });
    assert.equal(out.ok, true);
  });
});
