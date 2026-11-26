import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ARCHIVE_TIMESTAMP, normalizeBundleTimestamps } from "./archive-timestamps.mjs";

test("every bundle entry gets the fixed time; the bundle, Contents and Info.plist keep the build time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-archive-times-"));
  try {
    const bundle = join(directory, "LetAgents.app");
    await mkdir(join(bundle, "Contents", "Resources", "app"), { recursive: true });
    await writeFile(join(bundle, "Contents", "Info.plist"), "<plist/>");
    await writeFile(join(bundle, "Contents", "Resources", "app", "main.js"), "1");
    await symlink("app/main.js", join(bundle, "Contents", "Resources", "link.js"));
    const now = new Date("2026-11-26T00:00:00Z");

    assert.equal(await normalizeBundleTimestamps(bundle, { now }), 6);
    for (const path of ["Contents/Resources", "Contents/Resources/app", "Contents/Resources/app/main.js", "Contents/Resources/link.js"]) {
      assert.equal((await lstat(join(bundle, path))).mtime.getTime(), ARCHIVE_TIMESTAMP.getTime(), path);
    }
    for (const path of [bundle, join(bundle, "Contents"), join(bundle, "Contents", "Info.plist")]) {
      assert.equal((await lstat(path)).mtime.getTime(), now.getTime(), path);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
