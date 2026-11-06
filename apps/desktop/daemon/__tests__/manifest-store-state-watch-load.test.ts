import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ManifestStore } from "../manifest-store.js";
import { entry, fixture } from "./helpers/manifest-store-sqlite-fixture.js";

test("loadForStateWatch keeps an agent's frozen entry while its rows are unchanged and projects it again after a write to that agent", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    await store.write(0, [entry, { ...entry, id: "agent_2", display_name: "Second" }]);
    const first = await store.loadForStateWatch();
    assert.deepEqual(first, await store.load("summary"), "the state watch reads the same manifest as a summary load");
    assert.ok(Object.isFrozen(first.entries[0]));
    assert.ok(Object.isFrozen(first.entries[0]!.activity));
    assert.throws(() => { (first.entries[0] as { display_name: string }).display_name = "edited"; }, TypeError);

    const second = await store.loadForStateWatch();
    assert.equal(second.entries[0], first.entries[0], "nothing changed: the same entry object again");
    assert.equal(second.entries[1], first.entries[1]);

    // Another connection renames the second agent; no store hook reports it.
    const other = new DatabaseSync(env.databasePath);
    try { other.prepare("UPDATE agent_profiles SET display_name='Renamed' WHERE agent_id='agent_2'").run(); } finally { other.close(); }
    const third = await store.loadForStateWatch();
    assert.equal(third.entries[0], first.entries[0], "the untouched agent keeps its entry");
    assert.notEqual(third.entries[1], first.entries[1]);
    assert.equal(third.entries[1]!.display_name, "Renamed");
    assert.deepEqual(third, await store.load("summary"));

    // A removed agent leaves the list; the order follows the manifest.
    const removal = new DatabaseSync(env.databasePath);
    try { removal.prepare("DELETE FROM agent_identities WHERE agent_id='agent_1'").run(); } finally { removal.close(); }
    const fourth = await store.loadForStateWatch();
    assert.deepEqual(fourth.entries.map((item) => item.id), ["agent_2"]);
    assert.equal(fourth.entries[0], third.entries[1]);
  } finally {
    await store.close();
    await env.cleanup();
  }
});
