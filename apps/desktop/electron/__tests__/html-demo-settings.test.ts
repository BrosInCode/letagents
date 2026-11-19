import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("keeps CDN loading off when there is no file yet, and when the file is broken", async () => {
    const missing = new HtmlDemoSettingsStore(join(folder, "missing", "demo-settings.json"));
    assert.equal(missing.cdnLibraries(), false);
    assert.deepEqual(await missing.read(), { cdnLibraries: false });
    // A broken file says nothing for sure, so demos stay offline.
    for (const text of ["not json", "null", "[]", "{\"cdnLibraries\":\"yes\"}", "{\"cdnLibraries\":1}", "{}"]) {
      const path = join(folder, "broken.json");
      await writeFile(path, text);
      assert.deepEqual(await new HtmlDemoSettingsStore(path).read(), { cdnLibraries: false }, text);
    }
    await mkdir(join(folder, "a-folder.json"));
    assert.deepEqual(await new HtmlDemoSettingsStore(join(folder, "a-folder.json")).read(), { cdnLibraries: false });
  });

  it("keeps the saved value when a save fails", async () => {
    const path = join(folder, "demo-settings.json");
    const store = new HtmlDemoSettingsStore(path);
    await store.setCdnLibraries(false);
    await rm(path);
    await mkdir(path);
    await assert.rejects(store.setCdnLibraries(true));
    assert.equal(store.cdnLibraries(), false);
    assert.deepEqual(await store.read(), { cdnLibraries: false });
    // The next save after a failure still runs.
    await rm(path, { recursive: true });
    assert.deepEqual(await store.setCdnLibraries(true), { cdnLibraries: true });
    assert.equal(store.cdnLibraries(), true);
  });

  it("saves the choice, and a new store reads it back", async () => {
    const path = join(folder, "nested", "demo-settings.json");
    const store = new HtmlDemoSettingsStore(path);
    assert.deepEqual(await store.setCdnLibraries(true), { cdnLibraries: true });
    assert.equal(store.cdnLibraries(), true);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { cdnLibraries: true });
    const again = new HtmlDemoSettingsStore(path);
    // Until it reads the file, a store answers the default: off.
    assert.equal(again.cdnLibraries(), false);
    assert.deepEqual(await again.read(), { cdnLibraries: true });
    assert.equal(again.cdnLibraries(), true);
  });

  it("ends with the last choice when saves overlap", async () => {
    const path = join(folder, "demo-settings.json");
    const store = new HtmlDemoSettingsStore(path);
    await Promise.all([store.setCdnLibraries(true), store.setCdnLibraries(false), store.setCdnLibraries(true)]);
    assert.equal(store.cdnLibraries(), true);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { cdnLibraries: true });
  });

  it("shows the hosts with the choice", () => {
    assert.deepEqual(desktopDemoSettings({ cdnLibraries: false }), {
      cdnLibraries: false,
      cdnHosts: ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"],
    });
  });
});
