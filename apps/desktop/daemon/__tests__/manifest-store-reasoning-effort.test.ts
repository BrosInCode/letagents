import assert from "node:assert/strict";
import test from "node:test";
import { ManifestStore } from "../manifest-store.js";
import { canonicalManifestEntry } from "../manifest-store/shared.js";
import type { DaemonManifestEntry } from "../types.js";
import { entry, fixture } from "./helpers/manifest-store-sqlite-fixture.js";

// An agent's effort is chosen when it is added. The whole-manifest write path
// rebuilds each entry from its domain projection, and that rebuild once left
// the effort out, so every new agent was saved with its provider's default.
test("a new agent keeps the reasoning effort it was added with", async (t) => {
  const env = await fixture();
  t.after(() => env.cleanup());
  const store = new ManifestStore(env.databasePath);
  t.after(() => store.close());
  const added: DaemonManifestEntry[] = [
    { ...entry, id: "supervised_effort_codex", provider: "codex", model: "gpt-5.6", reasoning_effort: "high" },
    { ...entry, id: "supervised_effort_antigravity", provider: "antigravity", model: "gemini-4-neon", reasoning_effort: "xhigh" },
    { ...entry, id: "supervised_effort_default", provider: "claude-code", model: null, reasoning_effort: null },
  ];
  assert.equal(canonicalManifestEntry(added[0]!).reasoning_effort, "high");
  await store.load();
  await store.write(added);
  assert.equal((await store.getAgentConfiguration("supervised_effort_codex"))?.reasoning_effort, "high");
  assert.equal((await store.getAgentConfiguration("supervised_effort_antigravity"))?.reasoning_effort, "xhigh");
  assert.equal((await store.getAgentConfiguration("supervised_effort_default"))?.reasoning_effort, null);
  // A later whole-manifest write keeps it: the stored configuration is authoritative.
  const reloaded = await store.load();
  await store.write(reloaded.entries);
  assert.equal((await store.getAgentConfiguration("supervised_effort_antigravity"))?.reasoning_effort, "xhigh");
});
