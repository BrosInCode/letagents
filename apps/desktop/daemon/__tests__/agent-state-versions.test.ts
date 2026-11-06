import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { agentStateVersionSources, agentStateVersionTriggers, validateAgentStateVersionSchema } from "../daemon-state-database/shared.js";
import { ManifestStore } from "../manifest-store.js";
import { MANIFEST_READS } from "../manifest-store/shared.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { INBOX_READS } from "../supervised-agent-inbox-store/sql.js";
import { entry } from "./helpers/manifest-store-sqlite-fixture.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "letagents-agent-state-versions-"));
  const path = join(root, "daemon-state.sqlite");
  const manifest = new ManifestStore(path);
  await manifest.load();
  const inbox = new SupervisedAgentInboxStore(path);
  // Opening a connection repairs the current shape, which touches every agent's rows once; open before any baseline is taken.
  await inbox.inboxStateVersions();
  const database = new DatabaseSync(path);
  const versions = () => Object.fromEntries((database.prepare("SELECT agent_id, inbox_version, manifest_version FROM agent_state_versions ORDER BY agent_id").all() as Array<Record<string, unknown>>)
    .map((row) => [String(row.agent_id), { inbox: Number(row.inbox_version), manifest: Number(row.manifest_version) }]));
  const ingest = (agentId: string, message: string) => inbox.ingestPoll({ agent_id: agentId, room_id: entry.room_id, last_observed_message_id: message,
    messages: [{ source_message_id: message, source_message: { id: message, text: "hello" }, activation: { for_current_agent: true } }] });
  return { path, manifest, inbox, database, versions, ingest,
    cleanup: async () => { database.close(); await inbox.close(); await manifest.close(); await rm(root, { recursive: true, force: true }); } };
}

/** Every table a query reads, by its FROM and JOIN clauses. */
function tablesRead(sql: string): Set<string> {
  const tables = new Set<string>();
  for (const match of sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/gi)) tables.add(match[1]!);
  return tables;
}

test("every table behind an entry's inbox inputs and manifest projection moves the agent's version", () => {
  const sourceScopes = new Map(agentStateVersionSources.map((source) => [source.table, source.scopes]));
  const inboxReads = [INBOX_READS.receiptProjection, INBOX_READS.receiptTimelines, INBOX_READS.ingressHealth, INBOX_READS.latestRepair];
  // Read inline by blockedHeadSkip, blockedSkipRefusal and followUpFacts (supervised-agent-inbox-store/delivery.ts, queries.ts).
  const inlineInboxTables = ["supervised_agent_inbox", "runtime_deployments", "supervised_agent_provider_turn_bindings",
    "supervised_agent_publications", "supervised_agent_terminal_results", "turn_control_journals"];
  for (const table of [...inboxReads.flatMap((sql) => [...tablesRead(sql)]), ...inlineInboxTables]) {
    if (table === "selected_inbox") continue; // the CTE of receiptTimelines, not a table
    assert.ok(sourceScopes.get(table)?.includes("inbox"), `${table} is read for inbox inputs but does not move inbox_version`);
  }
  const manifestReads = [MANIFEST_READS.allEntries, MANIFEST_READS.entry, MANIFEST_READS.entryIds, MANIFEST_READS.activitySummary,
    MANIFEST_READS.stages, MANIFEST_READS.completedActions, MANIFEST_READS.exitTimestamps, MANIFEST_READS.notices];
  for (const table of manifestReads.flatMap((sql) => [...tablesRead(sql)])) {
    assert.ok(sourceScopes.get(table)?.includes("manifest"), `${table} is read for a manifest entry but does not move manifest_version`);
  }
});

test("the version table and its triggers exist on a fresh database and validate; a dropped trigger is restored on the next open", async () => {
  const env = await fixture();
  try {
    validateAgentStateVersionSchema(env.database);
    const names = new Set((env.database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'agent_state_versions_*'").all() as Array<{ name: string }>).map((row) => row.name));
    for (const source of agentStateVersionSources) {
      for (const name of Object.keys(agentStateVersionTriggers(source))) assert.ok(names.has(name), `${name} missing`);
    }
    env.database.exec("DROP TRIGGER agent_state_versions_activity_events_insert");
    assert.throws(() => validateAgentStateVersionSchema(env.database), /agent_state_versions_activity_events_insert/);
    const reopened = new ManifestStore(env.path);
    try { await reopened.load(); } finally { await reopened.close(); }
    validateAgentStateVersionSchema(env.database);
  } finally {
    await env.cleanup();
  }
});

test("a write moves only the written agent's version, in the scope of the table written, by any connection", async () => {
  const env = await fixture();
  try {
    assert.deepEqual(env.versions(), {});
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
      assert.deepEqual(afterEvent.agent_2, afterIngest.agent_2);

      // A manifest row updated in place, by that connection, for the other agent.
      other.prepare("UPDATE agent_profiles SET display_name='Renamed' WHERE agent_id='agent_2'").run();
      const afterProfile = env.versions();
      assert.equal(afterProfile.agent_2!.manifest, afterEvent.agent_2!.manifest + 1);
      assert.equal(afterProfile.agent_2!.inbox, afterEvent.agent_2!.inbox);
      assert.deepEqual(afterProfile.agent_1, afterEvent.agent_1);

      // Deleting the inbox row counts for its agent too.
      other.prepare("DELETE FROM supervised_agent_inbox WHERE agent_id='agent_1'").run();
      assert.ok(env.versions().agent_1!.inbox > afterProfile.agent_1!.inbox);
    } finally {
      other.close();
    }
    assert.equal(saved.generation, (await env.manifest.load()).generation);
  } finally {
    await env.cleanup();
  }
});
