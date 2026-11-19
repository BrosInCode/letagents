import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { desktopDemoSettings, HtmlDemoSettingsStore } from "../main/attachments/html-demo-settings.js";

describe("HTML demo settings", () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "demo-settings-"));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("allows CDN loading by default, and when the file is missing or broken", async () => {
    const missing = new HtmlDemoSettingsStore(join(folder, "missing", "demo-settings.json"));
    assert.equal(missing.cdnLibraries(), true);
    assert.deepEqual(await missing.read(), { cdnLibraries: true });
    for (const text of ["not json", "null", "[]", "{\"cdnLibraries\":\"no\"}", "{}"]) {
      const path = join(folder, "broken.json");
      await writeFile(path, text);
      assert.deepEqual(await new HtmlDemoSettingsStore(path).read(), { cdnLibraries: true }, text);
    }
  });

  it("saves the choice, and a new store reads it back", async () => {
    const path = join(folder, "nested", "demo-settings.json");
    const store = new HtmlDemoSettingsStore(path);
    assert.deepEqual(await store.setCdnLibraries(false), { cdnLibraries: false });
    assert.equal(store.cdnLibraries(), false);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { cdnLibraries: false });
    const again = new HtmlDemoSettingsStore(path);
    // Until it reads the file, a store answers the default.
    assert.equal(again.cdnLibraries(), true);
    assert.deepEqual(await again.read(), { cdnLibraries: false });
    assert.equal(again.cdnLibraries(), false);
  });

  it("ends with the last choice when saves overlap", async () => {
    const path = join(folder, "demo-settings.json");
    const store = new HtmlDemoSettingsStore(path);
    await Promise.all([store.setCdnLibraries(false), store.setCdnLibraries(true), store.setCdnLibraries(false)]);
    assert.equal(store.cdnLibraries(), false);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { cdnLibraries: false });
  });

  it("shows the hosts with the choice", () => {
    assert.deepEqual(desktopDemoSettings({ cdnLibraries: false }), {
      cdnLibraries: false,
      cdnHosts: ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"],
    });
  });
});
