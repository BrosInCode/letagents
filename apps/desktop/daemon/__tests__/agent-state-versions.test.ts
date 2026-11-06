import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { agentStateVersionSources, agentStateVersionTriggers, dropAgentStateVersionTriggers, validateAgentStateVersionSchema } from "../daemon-state-database/shared.js";
import { ManifestStore } from "../manifest-store.js";
import { MANIFEST_READS } from "../manifest-store/shared.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { INBOX_READS } from "../supervised-agent-inbox-store/sql.js";
import { entry } from "./helpers/manifest-store-sqlite-fixture.js";

type Versions = Record<string, { inbox: number; manifest: number }>;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "letagents-agent-state-versions-"));
  const path = join(root, "daemon-state.sqlite");
  // The first open of a fresh database is the manifest store's, and is where a repair rebuilds tables.
  const manifest = new ManifestStore(path);
  await manifest.load();
  const database = new DatabaseSync(path);
  const triggerNames = () => new Set((database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'agent_state_versions_*'").all() as Array<{ name: string }>).map((row) => row.name));
  const versions = (): Versions => Object.fromEntries((database.prepare("SELECT agent_id, inbox_version, manifest_version FROM agent_state_versions ORDER BY agent_id").all() as Array<Record<string, unknown>>)
    .map((row) => [String(row.agent_id), { inbox: Number(row.inbox_version), manifest: Number(row.manifest_version) }]));
  const inbox = new SupervisedAgentInboxStore(path);
  const ingest = (agentId: string, message: string) => inbox.ingestPoll({ agent_id: agentId, room_id: entry.room_id, last_observed_message_id: message,
    messages: [{ source_message_id: message, source_message: { id: message, text: "hello" }, activation: { for_current_agent: true } }] });
  return { path, manifest, inbox, database, triggerNames, versions, ingest,
    cleanup: async () => { database.close(); await inbox.close(); await manifest.close(); await rm(root, { recursive: true, force: true }); } };
}

/** Every table a query reads, by its FROM and JOIN clauses. */
function tablesRead(sql: string): Set<string> {
  const tables = new Set<string>();
  for (const match of sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/gi)) tables.add(match[1]!);
  return tables;
}

const scopesByTable = new Map<string, Set<"inbox" | "manifest">>();
for (const source of agentStateVersionSources) {
  const scopes = scopesByTable.get(source.table) ?? new Set();
  for (const scope of source.scope === "both" ? ["inbox", "manifest"] as const : [source.scope]) scopes.add(scope);
  scopesByTable.set(source.table, scopes);
}

test("every table behind an entry's inbox inputs and manifest projection moves the agent's version", () => {
  const inboxReads = [INBOX_READS.receiptProjection, INBOX_READS.receiptTimelines, INBOX_READS.ingressHealth, INBOX_READS.latestRepair];
  // Read inline by blockedHeadSkip and blockedSkipRefusal (delivery.ts), followUpFacts (queries.ts) and
  // hasUncertainTaskEffects (task-continuations.ts). supervised_agent_terminal_results is read there too, but it is
  // only written in the transaction that also updates the item's inbox row, whose trigger counts for both.
  const inlineInboxTables = ["supervised_agent_inbox", "runtime_deployments", "supervised_agent_provider_turn_bindings",
    "supervised_agent_publications", "turn_control_journals", "supervised_agent_effects", "supervised_agent_effect_tombstones"];
  for (const table of [...inboxReads.flatMap((sql) => [...tablesRead(sql)]), ...inlineInboxTables]) {
    if (table === "selected_inbox") continue; // the CTE of receiptTimelines, not a table
    assert.ok(scopesByTable.get(table)?.has("inbox"), `${table} is read for inbox inputs but does not move inbox_version`);
  }
  const manifestReads = [MANIFEST_READS.allEntries, MANIFEST_READS.entry, MANIFEST_READS.entryIds, MANIFEST_READS.activitySummary,
    MANIFEST_READS.stages, MANIFEST_READS.completedActions, MANIFEST_READS.exitTimestamps, MANIFEST_READS.notices];
  for (const table of manifestReads.flatMap((sql) => [...tablesRead(sql)])) {
    assert.ok(scopesByTable.get(table)?.has("manifest"), `${table} is read for a manifest entry but does not move manifest_version`);
  }
});

test("a fresh database has the version table and every trigger after its first open, validates, and gets a dropped trigger back on the next open", async () => {
  const env = await fixture();
  try {
    validateAgentStateVersionSchema(env.database);
    const names = env.triggerNames();
    for (const source of agentStateVersionSources) {
      for (const name of Object.keys(agentStateVersionTriggers(source))) assert.ok(names.has(name), `${name} missing after the first open`);
    }
    // The previous daemon refuses a database with any trigger on the terminal-result authority.
    assert.equal(env.database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name='supervised_agent_terminal_results'").get()!.n, 0);

    env.database.exec("DROP TRIGGER agent_state_versions_activity_events_manifest_insert");
    assert.throws(() => validateAgentStateVersionSchema(env.database), /agent_state_versions_activity_events_manifest_insert/);
    const reopened = new ManifestStore(env.path);
    try { await reopened.load(); } finally { await reopened.close(); }
    validateAgentStateVersionSchema(env.database);

    // A migration that rebuilds a source table drops them all first; a store open puts them back.
    dropAgentStateVersionTriggers(env.database);
    assert.equal(env.triggerNames().size, 0);
    assert.throws(() => validateAgentStateVersionSchema(env.database));
    await env.inbox.inboxStateVersions();
    validateAgentStateVersionSchema(env.database);
  } finally {
    await env.cleanup();
  }
});

test("a write moves only the written agent's version, in the scope of the table and columns written, by any connection", async () => {
  const env = await fixture();
  try {
    await env.inbox.inboxStateVersions(); // open the inbox connection before any baseline: its open applies the schema too
    const saved = await env.manifest.write(0, [entry, { ...entry, id: "agent_2" }]);
    const afterManifest = env.versions();
    assert.ok(afterManifest.agent_1!.manifest > 0);
    assert.ok(afterManifest.agent_2!.manifest > 0);

    await env.ingest("agent_1", "1");
    const afterIngest = env.versions();
    assert.ok(afterIngest.agent_1!.inbox > afterManifest.agent_1!.inbox, "an inbox row moves inbox_version");
    assert.equal(afterIngest.agent_1!.manifest, afterManifest.agent_1!.manifest, "an inbox row leaves manifest_version");
    assert.deepEqual(afterIngest.agent_2, afterManifest.agent_2, "the other agent is untouched");

    // A row keyed by the inbox item, written by a connection no store knows about.
    const other = new DatabaseSync(env.path);
    try {
      const item = other.prepare("SELECT inbox_item_id FROM supervised_agent_inbox WHERE agent_id='agent_1'").get() as { inbox_item_id: string };
      other.prepare("INSERT INTO supervised_agent_inbox_events(inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail) VALUES (?,99,'probe:99','received',?,NULL)")
        .run(item.inbox_item_id, new Date().toISOString());
      const afterEvent = env.versions();
      assert.equal(afterEvent.agent_1!.inbox, afterIngest.agent_1!.inbox + 1);
      assert.equal(afterEvent.agent_1!.manifest, afterIngest.agent_1!.manifest);
      assert.deepEqual(afterEvent.agent_2, afterIngest.agent_2);

      // A manifest row updated in place, by that connection, for the other agent.
      other.prepare("UPDATE agent_profiles SET display_name='Renamed' WHERE agent_id='agent_2'").run();
      const afterProfile = env.versions();
      assert.equal(afterProfile.agent_2!.manifest, afterEvent.agent_2!.manifest + 1);
      assert.equal(afterProfile.agent_2!.inbox, afterEvent.agent_2!.inbox);
      assert.deepEqual(afterProfile.agent_1, afterEvent.agent_1);

      // The runtime row counts for the inbox only through the columns a blocked head's refusal reads.
      other.prepare("UPDATE runtime_deployments SET native_liveness_detail='probe' WHERE agent_id='agent_1'").run();
      const afterLiveness = env.versions();
      assert.equal(afterLiveness.agent_1!.manifest, afterProfile.agent_1!.manifest + 1, "liveness is part of the entry");
      assert.equal(afterLiveness.agent_1!.inbox, afterProfile.agent_1!.inbox, "liveness is no inbox input");
      other.prepare("UPDATE runtime_deployments SET provider_continuation_id='continuation_2' WHERE agent_id='agent_1'").run();
      const afterConversation = env.versions();
      assert.equal(afterConversation.agent_1!.manifest, afterLiveness.agent_1!.manifest + 1);
      assert.equal(afterConversation.agent_1!.inbox, afterLiveness.agent_1!.inbox + 1, "the runtime's conversation decides a blocked head's refusal");

      // Deleting the inbox row counts for its agent too.
      other.prepare("DELETE FROM supervised_agent_inbox WHERE agent_id='agent_1'").run();
      assert.ok(env.versions().agent_1!.inbox > afterConversation.agent_1!.inbox);
    } finally {
      other.close();
    }
    assert.equal(saved.generation, (await env.manifest.load()).generation);
  } finally {
    await env.cleanup();
  }
});
