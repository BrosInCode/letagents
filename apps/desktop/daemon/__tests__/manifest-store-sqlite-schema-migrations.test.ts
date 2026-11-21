import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { ActivityWriteBatcher, commitActivityBatch } from "../activity-write-batcher.js";
import { DaemonAuthority } from "../daemon-authority.js";
import { DAEMON_STATE_APPLICATION_ID, DAEMON_STATE_USER_VERSION } from "../daemon-state-database.js";
import { projectStateWatchActivity } from "../state-watch-projection.js";
import { ManifestConflictError, ManifestStore } from "../manifest-store.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { DaemonActivityEvent, DaemonManifestEntry } from "../types.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import {
  terminal,
  entry,
  fixture,
  seedTerminalExecution,
} from "./helpers/manifest-store-sqlite-fixture.js";
import { assertOwnerPrivate } from "../../electron/__tests__/platform.js";

test("SQLite manifest round-trips the flat wire projection from relational domain tables", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const undefinedPolicyEntry = { ...entry, id: "agent_2", provider_launch_policy: undefined };
    const saved = await store.write([entry, undefinedPolicyEntry]);
    assert.deepEqual(await store.load(), saved);
    assert.equal(Object.hasOwn(saved.entries[1]!, "provider_launch_policy"), false);

    const database = (store as unknown as { database: DatabaseSync }).database;
    assert.equal((database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
    assert.equal((database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
    assert.equal((database.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5000);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM agents").get() as { count: number }).count, 2);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM activity_events").get() as { count: number }).count, 2);
    const notices = JSON.parse(String((database.prepare("SELECT reconciliation_notices_json FROM agents WHERE agent_id = ?").get(entry.id) as { reconciliation_notices_json: string }).reconciliation_notices_json)) as Array<{ terminal: { terminal_cause: string } }>;
    assert.equal(notices[0]?.terminal.terminal_cause, terminal.terminal_cause);
    await assertOwnerPrivate(env.root, "directory");
    await assertOwnerPrivate(env.databasePath, "file");

    await store.close();
    await assert.rejects(() => store.load(), /closed/);
    const reopened = new ManifestStore(env.databasePath);
    assert.deepEqual(await reopened.load(), saved);
    await reopened.close();
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("SQLite manifest preserves the complete OpenCode server identity across reopen", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const openModel: DaemonManifestEntry = {
    ...entry,
    id: "agent_open_model",
    provider: "open-model",
    model: "moonshotai/kimi-k3",
    provider_ref: {
      work_attempt_id: "attempt_open_model",
      provider_continuation_id: "session_open_model",
      execution_generation_id: "generation_open_model",
      provider_connection: {
        kind: "opencode_server",
        url: "http://127.0.0.1:52486",
        pid: 45550,
        processIdentity: "opencode-birth-45550",
        serverAuthPath: "/runtime/attempt_open_model/server-auth.json",
      },
    },
  };
  try {
    await store.write([openModel]);
    await store.close();
    const reopened = new ManifestStore(env.databasePath);
    assert.deepEqual((await reopened.getEntry(openModel.id))?.provider_ref, openModel.provider_ref);
    await reopened.close();
  } finally {
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("SQLite manifest per-agent version CAS serializes competing updates without blocking unrelated agents", async () => {
  const env = await fixture();
  const first = new ManifestStore(env.databasePath);
  const second = new ManifestStore(env.databasePath);
  try {
    const entries = [entry, { ...entry, id: "agent_2", display_name: "OwlSolar" }];
    await first.write(entries);
    assert.deepEqual((await second.load()).versions, { agent_1: 1, agent_2: 1 });
    const results = await Promise.allSettled([
      first.replaceEntry(1, { ...entries[0]!, observed_state: "idle" }),
      second.replaceEntry(1, { ...entries[0]!, observed_state: "paused" }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && result.reason instanceof ManifestConflictError).length, 1);
    // Unrelated agent_2 still succeeds at version 1 while agent_1 advanced to version 2.
    const independent = await second.replaceEntry(1, { ...entries[1]!, observed_state: "idle" });
    assert.equal(independent.version, 2);
    const durable = await first.load();
    assert.deepEqual(durable.versions, { agent_1: 2, agent_2: 2 });
    assert.deepEqual(durable.entries.map((item) => item.id), ["agent_1", "agent_2"]);
  } finally {
    await first.close();
    await second.close();
    await env.cleanup();
  }
});

test("future SQLite schema versions are rejected without being downgraded", async () => {
  const env = await fixture();
  const futureVersion = DAEMON_STATE_USER_VERSION + 1;
  const database = new DatabaseSync(env.databasePath);
  database.exec(`PRAGMA application_id = ${DAEMON_STATE_APPLICATION_ID}; PRAGMA user_version = ${futureVersion}`);
  database.close();
  const store = new ManifestStore(env.databasePath);
  try {
    await assert.rejects(() => store.load(), /Unsupported daemon state schema version/i);
    const inspection = new DatabaseSync(env.databasePath);
    assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, futureVersion);
    inspection.close();
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("all explicit optional undefined fields normalize to absence without fabricated state", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const minimal: DaemonManifestEntry = {
    id: "minimal_agent",
    room_id: "room_minimal",
    display_name: "Minimal",
    provider: "codex",
    model: null,
    charter: "Only required state.",
    desired_state: "paused",
    observed_state: "absent",
    condition: "none",
    permission_profile_id: null,
    created_by: "user_1",
    created_at: "2026-07-19T00:00:00.000Z",
    last_error: undefined,
    provider_launch_policy: undefined,
    source_repo_path: undefined,
    workspace_path: undefined,
    work_attempt_id: undefined,
    provider_ref: undefined,
    workplace_liveness: undefined,
    native_liveness: undefined,
    ready_reached_at: undefined,
    activity: undefined,
    turn_control: undefined,
    last_worker_binding: undefined,
    reconciliation: undefined,
    reconciliation_notices: undefined,
  };
  try {
    const saved = await store.write([minimal]);
    const persisted = (await store.load()).entries[0]!;
    assert.deepEqual(persisted, saved.entries[0]);
    assert.deepEqual(persisted.activity, []);
    for (const optional of [
      "last_error", "provider_launch_policy", "source_repo_path", "workspace_path", "work_attempt_id",
      "provider_ref", "workplace_liveness", "native_liveness", "ready_reached_at",
      "turn_control", "last_worker_binding", "reconciliation", "reconciliation_notices",
    ]) assert.equal(Object.hasOwn(persisted, optional), false, `${optional} remains absent`);
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("targeted activity writes keep presentation-only events out of lifecycle fields and avoid full replacement", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const others = Array.from({ length: 23 }, (_, index) => ({
      ...entry,
      id: `agent_other_${index}`,
      display_name: `Other Agent ${index}`,
    }));
    const other = others[0]!;
    const created = await store.write([entry, ...others]);
    const database = (store as unknown as { database: DatabaseSync }).database;
    const tables = ["agents", "activity_events"];
    const snapshot = () => Object.fromEntries(tables.map((table) => [
      table,
      database.prepare(`SELECT rowid, * FROM ${table} WHERE agent_id <> ? ORDER BY agent_id, rowid`).all(entry.id),
    ]));
    const before = snapshot();
    const raw = store as unknown as { replaceEntries: () => never };
    raw.replaceEntries = () => { throw new Error("full replacement must not run on the activity path"); };

    const nextEvent = { ...entry.activity![0]!, sequence: 5, observed_at: "2026-07-19T00:04:00.000Z", summary: "Targeted event" };
    const recorded = await store.recordActivity(1, entry.id, nextEvent, {
      observedState: "idle",
      nativeLiveness: { state: "idle", observed_at: nextEvent.observed_at, detail: nextEvent.summary },
    }, 1);
    assert.equal(recorded.version, 2);
    const result = { entry: (await store.getEntry(entry.id))! };
    assert.deepEqual(result.entry.activity, [nextEvent]);
    assert.equal(result.entry.observed_state, "idle");
    assert.equal(result.entry.native_liveness?.state, "idle");
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(await store.getEntry(other.id), created.entries.find((candidate) => candidate.id === other.id));

    const presentationEvent = {
      ...nextEvent,
      sequence: 6,
      observed_at: "2026-07-19T00:05:00.000Z",
      summary: "Presentation-only event",
      status: "working" as const,
    };
    const presentation = await store.appendActivityOnly(2, entry.id, presentationEvent, 1);
    assert.equal(presentation.version, 3);
    assert.deepEqual(presentation.entry.activity, [presentationEvent]);
    assert.equal(presentation.entry.observed_state, result.entry.observed_state);
    assert.deepEqual(presentation.entry.native_liveness, result.entry.native_liveness,
      "presentation-only persistence cannot acquire lifecycle or liveness authority");
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(await store.getEntry(other.id), created.entries.find((candidate) => candidate.id === other.id));
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("targeted batch replacement updates multiple agents in one transaction without touching unrelated rows", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const entries = Array.from({ length: 24 }, (_, index) => ({
      ...entry,
      id: `batch_agent_${index}`,
      display_name: `Batch Agent ${index}`,
    }));
    await store.write(entries);
    const database = (store as unknown as { database: DatabaseSync }).database;
    const tables = ["agents", "activity_events"];
    const changedIds = [entries[0]!.id, entries[1]!.id];
    const snapshot = () => Object.fromEntries(tables.map((table) => [
      table,
      database.prepare(`SELECT rowid, * FROM ${table} WHERE agent_id NOT IN (?, ?) ORDER BY agent_id, rowid`).all(...changedIds),
    ]));
    const before = snapshot();
    const raw = store as unknown as { replaceEntries: () => never };
    raw.replaceEntries = () => { throw new Error("full replacement must not run on the targeted batch path"); };

    const result = await store.replaceEntriesBatch({ [entries[0]!.id]: 1, [entries[1]!.id]: 1 }, [
      { ...entries[0]!, reconciliation: { ...entries[0]!.reconciliation!, next_restart_at_ms: 101 } },
      { ...entries[1]!, reconciliation: { ...entries[1]!.reconciliation!, next_restart_at_ms: 202 } },
    ]);
    assert.deepEqual(result.versions, { [entries[0]!.id]: 2, [entries[1]!.id]: 2 });
    assert.deepEqual(result.entries.map((item) => item.reconciliation?.next_restart_at_ms), [101, 202]);
    assert.deepEqual(snapshot(), before);
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("permission housekeeping failure aborts initialization without changing state", async () => {
  const env = await fixture();
  const initialized = new ManifestStore(env.databasePath);
  try {
    assert.deepEqual(await initialized.load(), { versions: {}, entries: [] });
    await initialized.close();

    const failing = new ManifestStore(env.databasePath, async () => {
      throw new Error("injected permission failure");
    });
    await assert.rejects(() => failing.load(), /injected permission failure/);
    await failing.close();

    const reopened = new ManifestStore(env.databasePath);
    assert.equal((await reopened.write([entry])).versions[entry.id], 1);
    await reopened.close();
  } finally {
    await initialized.close();
    await env.cleanup();
  }
});

test("fresh schema creation rolls back every DDL statement when initialization fails", async () => {
  const env = await fixture();
  const failing = new ManifestStore(env.databasePath, undefined, () => {
    throw new Error("injected schema initialization failure");
  });
  try {
    await assert.rejects(() => failing.load(), /injected schema initialization failure/);
    await failing.close();
    const inspection = new DatabaseSync(env.databasePath);
    assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 0);
    assert.equal((inspection.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'agents'").get() as { count: number }).count, 0);
    inspection.close();

    const recovered = new ManifestStore(env.databasePath);
    assert.deepEqual(await recovered.load(), { versions: {}, entries: [] });
    await recovered.close();
  } finally {
    await failing.close();
    await env.cleanup();
  }
});

test("targeted writes return their committed projection without any post-commit getEntry", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const initial = await store.write([entry]);
    const raw = store as unknown as { getEntry: () => never };
    raw.getEntry = () => { throw new Error("injected post-commit read failure"); };

    const replaced = await store.replaceEntry(1, { ...initial.entries[0]!, observed_state: "idle" });
    assert.equal(replaced.version, 2);
    assert.equal(replaced.entry.observed_state, "idle");
    const event = { ...entry.activity![0]!, sequence: 5, observed_at: "2026-07-19T01:00:00.000Z" };
    const appended = await store.appendActivityOnly(2, entry.id, event);
    assert.equal(appended.version, 3);
    assert.equal(appended.entry.activity?.at(-1)?.sequence, 5);
    const live = await store.updateWorkplaceLiveness(3, entry.id, { state: "reachable", observed_at: event.observed_at, detail: "online" });
    assert.equal(live.version, 4);
    const batched = await store.replaceEntriesBatch({ [entry.id]: 4 }, [{ ...live.entry, condition: "none" }]);
    assert.equal(batched.versions[entry.id], 5);
    assert.equal(batched.entries[0]?.condition, "none");
    assert.equal((await store.load()).versions[entry.id], 5);
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("targeted projection failure occurs before commit and rolls back generation", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const before = await store.write([entry]);
    const raw = store as unknown as {
      readEntryFromDatabase: (database: DatabaseSync, agentId: string) => DaemonManifestEntry | undefined;
    };
    const original = raw.readEntryFromDatabase.bind(store);
    raw.readEntryFromDatabase = () => { throw new Error("injected projection failure"); };
    await assert.rejects(
      () => store.updateWorkplaceLiveness(1, entry.id, { state: "stale", observed_at: null, detail: "stale" }),
      /injected projection failure/,
    );
    raw.readEntryFromDatabase = original;
    assert.deepEqual(await store.load(), before);
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("detached deployment identity survives full manifest writes and restart", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const neverLaunched: DaemonManifestEntry = {
      ...entry,
      id: "never_launched",
      display_name: "Never Launched",
      provider_ref: undefined,
      work_attempt_id: undefined,
    };
    const created = await store.write([entry, neverLaunched]);
    const launched = created.entries[0]!;
    assert.equal(launched.run_id, entry.provider_ref?.execution_generation_id);
    assert.ok(launched.deployment_id);
    assert.equal(Object.hasOwn(created.entries[1]!, "run_id"), false);

    const detached = await store.replaceEntry(1, { ...launched, provider_ref: undefined });
    assert.equal(Object.hasOwn(detached.entry, "provider_ref"), false);
    assert.equal(detached.entry.run_id, launched.run_id);
    assert.equal(detached.entry.deployment_id, launched.deployment_id);

    const beforeFullWrite = await store.load();
    await store.write(beforeFullWrite.entries);
    await store.close();

    const reopened = new ManifestStore(env.databasePath);
    const durable = await reopened.load();
    assert.equal(durable.entries[0]?.run_id, launched.run_id);
    assert.equal(durable.entries[0]?.deployment_id, launched.deployment_id);
    assert.equal(Object.hasOwn(durable.entries[0]!, "provider_ref"), false);
    assert.equal(Object.hasOwn(durable.entries[1]!, "run_id"), false);
    const database = (reopened as unknown as { database: DatabaseSync }).database;
    const unlaunchedRuntime = database.prepare("SELECT run_id, deployment_id FROM agents WHERE agent_id = ?").get(neverLaunched.id) as { run_id: null; deployment_id: null };
    assert.equal(unlaunchedRuntime.run_id, null);
    assert.equal(unlaunchedRuntime.deployment_id, null);
    await reopened.close();
  } finally {
    await store.close();
    await env.cleanup();
  }
});

test("managed launch receipts survive reopening and reject relabeling", async () => {
  const env = await fixture();
  let store = new ManifestStore(env.databasePath);
  const connection = { kind: "codex_app_server" as const, url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "managed-birth" };
  const agent: DaemonManifestEntry = { ...entry, condition: "none", observed_state: "idle", delivery_mode: "daemon_inbox",
    turn_control: undefined, work_attempt_id: "attempt_1", provider_ref: { work_attempt_id: "attempt_1", execution_generation_id: "run_1",
      provider_continuation_id: "thread_1", provider_connection: connection } };
  const scope = { agentId: agent.id, executionGenerationId: "run_1", providerConnection: connection };
  const birth = { entry: agent, executionGenerationId: "run_1", providerConnection: connection, appliedRevision: 1,
    requestedAuthorityMode: "typed" as const, observedAtMs: 100, managedLaunchContract: "a".repeat(64) };
  const bindings = new WorkerBindingStore(join(env.root, "bindings.json"), undefined, env.databasePath);
  try {
    const written = await store.write([agent]);
    const v1 = written.versions[agent.id]!;
    seedTerminalExecution(env.databasePath, "attempt_1", "run_1");
    await assert.rejects(store.checkpointProviderBirth(v1, birth, async () => { throw new Error("fenced"); }), /fenced/);
    assert.equal(await store.readManagedLaunchContract(scope), null, "a rejected birth has no receipt");
    const first = await store.checkpointProviderBirth(v1, birth);
    assert.equal(await store.readManagedLaunchContract(scope), birth.managedLaunchContract);
    await assert.rejects(store.checkpointProviderBirth(first.version, { ...birth, managedLaunchContract: "b".repeat(64) }), /cannot change/);
    assert.equal((await store.load()).versions[agent.id], first.version);
    assert.equal(await store.readManagedLaunchContract({ ...scope, providerConnection: { ...connection, processIdentity: "other-birth" } }), null);
    await bindings.bind({ entry_id: agent.id, room_id: agent.room_id, work_attempt_id: "attempt_1", execution_generation_id: "run_1",
      agent_session_id: "session", agent_session_token: "test-token", api_url: "https://example.test" });
    const current = await store.validateManagedRuntimeReplacement({ ...scope, configurationRevision: 1, apiUrl: "https://example.test",
      roomId: agent.room_id, workAttemptId: "attempt_1", providerContinuationId: "thread_1" });
    current();
    await store.replaceEntry(first.version, { ...first.entry, desired_state: "stopped" });
    assert.throws(current, /durable idle authority/);
    await store.close();
    store = new ManifestStore(env.databasePath);
    assert.equal(await store.readManagedLaunchContract(scope), birth.managedLaunchContract);
  } finally { await bindings.close(); await store.close(); await env.cleanup(); }
});


test("a birth committed while a two-entry batch is in flight keeps the other entry's events and skips the retired one", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const connection = { kind: "codex_app_server" as const, url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "handoff-birth" };
  const agent: DaemonManifestEntry = { ...entry, condition: "none", observed_state: "idle", delivery_mode: "daemon_inbox",
    turn_control: undefined, work_attempt_id: "attempt_1", provider_ref: { work_attempt_id: "attempt_1", execution_generation_id: "run_1",
      provider_continuation_id: "thread_1", provider_connection: connection } };
  const peer: DaemonManifestEntry = { ...entry, id: "agent_2", display_name: "Peer", observed_state: "working", turn_control: undefined,
    reconciliation: undefined, reconciliation_notices: undefined, activity: [] };
  const authority = new DaemonAuthority({ assertCurrent: async () => {}, isHandoffScheduled: () => true, notifyStateChanged: () => {} });
  const diagnostics: number[] = [];
  const results: { skipped: number; written: number }[] = [];
  const batcher = new ActivityWriteBatcher({
    serialize: (operation) => authority.serializeManifestMutationWithoutFlush(operation),
    // Exactly as main.ts commits a batch.
    commit: async (items) => {
      const next = await commitActivityBatch({ store, items,
        fence: (commit) => authority.fenceAdmittedTransitionCommit(commit), mayWrite: (agentId) => batcher.mayWrite(agentId) });
      results.push({ skipped: next.skipped, written: next.written });
    },
    diagnostic: (_error, dropped) => diagnostics.push(dropped),
  });
  // The retiring daemon's birth path: persistReturnedProviderForHandoff's commit
  // fence, which calls retirePendingActivity right after its commit.
  const retirePendingActivity = (entryId: string) => batcher.retireEntry(entryId);
  const late = (id: string, sequence: number, status: DaemonActivityEvent["status"]) => ({ agentId: id,
    event: { ...entry.activity![0]!, sequence, status, summary: `${id} ${status}` },
    runtimeUpdate: { observedState: status === "idle" ? "idle" as const : "working" as const,
      nativeLiveness: { state: status === "idle" ? "idle" as const : "active" as const, observed_at: "2026-07-19T00:05:00.000Z", detail: `${id} ${status}` } },
    limit: 200 });
  let releaseBirth!: () => void;
  const birthGate = new Promise<void>((resolve) => { releaseBirth = resolve; });
  let birthHoldsStore!: () => void;
  const birthStarted = new Promise<void>((resolve) => { birthHoldsStore = resolve; });
  try {
    const initialVersion = (await store.write([agent, peer])).versions[agent.id]!;
    seedTerminalExecution(env.databasePath, "attempt_1", "run_1");
    // Admitted just before retirement began: a late working event for the
    // retiring entry, and the peer's final idle state.
    await batcher.serializeAdmission(async () => {
      batcher.admit(late(agent.id, 50, "working"));
      batcher.admit(late(peer.id, 60, "idle"));
    });
    const birth = store.checkpointProviderBirth(initialVersion, {
      entry: { ...agent, observed_state: "idle" }, executionGenerationId: "run_1", providerConnection: connection,
      appliedRevision: 1, requestedAuthorityMode: "typed", observedAtMs: 100, managedLaunchContract: "c".repeat(64),
    }, async (commit) => {
      birthHoldsStore();
      await birthGate;
      await authority.serializeManifestCommit(async () => { await commit(); retirePendingActivity(agent.id); });
    });
    await birthStarted;
    // The batch waits behind the birth on the store.
    const flushed = batcher.flush();
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(results.length, 0, "the batch is in flight, not yet committed");
    releaseBirth();
    await birth;
    await flushed;
    assert.deepEqual(results, [{ skipped: 1, written: 1 }],
      "mayWrite skipped the retired entry inside the transaction while committing the peer without conflict");
    assert.deepEqual(diagnostics, []);
    const saved = (await store.getEntry(agent.id))!;
    assert.equal(saved.observed_state, "idle", "the birth record keeps its state");
    assert.equal(saved.activity?.some((event) => event.sequence === 50), false, "the older event was not written after the birth");
    const savedPeer = (await store.getEntry(peer.id))!;
    assert.equal(savedPeer.observed_state, "idle", "the peer's final idle state survived the birth");
    assert.equal(savedPeer.activity?.at(-1)?.sequence, 60);
  } finally { releaseBirth?.(); await batcher.close(); await store.close(); await env.cleanup(); }
});

test("a conflict during batch commit drops and reports the batch without per-event retry", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const peer: DaemonManifestEntry = { ...entry, turn_control: undefined, reconciliation: undefined, reconciliation_notices: undefined, activity: [] };
  try {
    await store.write([peer]);
    const failingStore = {
      recordActivityBatch: async () => {
        throw new ManifestConflictError("injected batch conflict");
      },
    };
    const authority = new DaemonAuthority({ assertCurrent: async () => {}, isHandoffScheduled: () => false, notifyStateChanged: () => {} });
    const dropped: { error: unknown; count: number }[] = [];
    let attempts = 0;
    const batcher = new ActivityWriteBatcher({
      serialize: (operation) => authority.serializeManifestMutationWithoutFlush(operation),
      commit: async (items) => {
        attempts += 1;
        await commitActivityBatch({ store: failingStore, items,
          fence: (commit) => authority.fenceAdmittedTransitionCommit(commit), mayWrite: () => true });
      },
      diagnostic: (error, count) => dropped.push({ error, count }),
    });
    await batcher.serializeAdmission(async () => {
      batcher.admit({ agentId: peer.id, event: { ...entry.activity![0]!, sequence: 80 }, runtimeUpdate: null, limit: 200 });
      batcher.admit({ agentId: peer.id, event: { ...entry.activity![0]!, sequence: 81 }, runtimeUpdate: null, limit: 200 });
    });
    await batcher.close();
    assert.equal(attempts, 1, "no per-event retry after a conflict");
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0]!.count, 2);
    assert.ok(dropped[0]!.error instanceof ManifestConflictError);
  } finally { await store.close(); await env.cleanup(); }
});

test("a managed runtime replacement is refused while a working event is still pending", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const connection = { kind: "codex_app_server" as const, url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "managed-birth" };
  const agent: DaemonManifestEntry = { ...entry, condition: "none", observed_state: "idle", delivery_mode: "daemon_inbox",
    turn_control: undefined, work_attempt_id: "attempt_1", provider_ref: { work_attempt_id: "attempt_1", execution_generation_id: "run_1",
      provider_continuation_id: "thread_1", provider_connection: connection } };
  const bindings = new WorkerBindingStore(join(env.root, "bindings.json"), undefined, env.databasePath);
  let pending: { observedState: DaemonManifestEntry["observed_state"] | null } | null = null;
  store.setPendingActivityState(() => pending);
  const input = { agentId: agent.id, executionGenerationId: "run_1", providerConnection: connection, configurationRevision: 1,
    apiUrl: "https://example.test", roomId: agent.room_id, workAttemptId: "attempt_1", providerContinuationId: "thread_1" };
  try {
    const written = await store.write([agent]);
    seedTerminalExecution(env.databasePath, "attempt_1", "run_1");
    await store.checkpointProviderBirth(written.versions[agent.id]!, { entry: agent, executionGenerationId: "run_1", providerConnection: connection,
      appliedRevision: 1, requestedAuthorityMode: "typed", observedAtMs: 100, managedLaunchContract: "a".repeat(64) });
    await bindings.bind({ entry_id: agent.id, room_id: agent.room_id, work_attempt_id: "attempt_1", execution_generation_id: "run_1",
      agent_session_id: "session", agent_session_token: "test-token", api_url: "https://example.test" });
    pending = { observedState: "working" };
    await assert.rejects(store.validateManagedRuntimeReplacement(input), /durable idle authority/,
      "committed idle is not durable idle while a newer working event is pending");
    pending = { observedState: null };
    const assertDurable = await store.validateManagedRuntimeReplacement(input);
    assertDurable();
    // A working event admitted between the check and the native signal boundary.
    pending = { observedState: "working" };
    assert.throws(assertDurable, /durable idle authority/);
    pending = null;
    assertDurable();
  } finally { await bindings.close(); await store.close(); await env.cleanup(); }
});

test("scoped manifest reads hydrate only matching entries and prepared reads observe new commits", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const saved = await store.write([
      { ...entry, id: "outside", room_id: "other-room" },
      { ...entry, id: "selected-z", room_id: "selected-room" },
      { ...entry, id: "selected-a", room_id: "selected-room" },
    ]);
    const expected = saved.entries.filter(value => value.room_id === "selected-room");
    assert.deepEqual(await store.listRoomEntries("selected-room"), expected);
    assert.deepEqual(await store.getEntry("selected-a"), expected[1]);
    assert.deepEqual(await store.listRoomEntries("missing-room"), []);
    assert.equal(await store.getEntry("missing-entry"), undefined);
    const database = new DatabaseSync(env.databasePath);
    try {
      database.prepare("UPDATE activity_events SET payload_json='invalid-json' WHERE agent_id=?").run("outside");
      assert.deepEqual(await store.listRoomEntries("selected-room"), expected,
        "an unrelated room payload must not be hydrated");
      assert.deepEqual(await store.getEntry("selected-a"), expected[1]);
      await assert.rejects(store.load(), /JSON/);
      database.prepare("UPDATE agents SET display_name=? WHERE agent_id=?").run("Changed elsewhere", "selected-a");
      assert.equal((await store.getEntry("selected-a"))?.display_name, "Changed elsewhere");
      assert.deepEqual((await store.listRoomEntries("selected-room")).map(value => value.id), ["selected-z", "selected-a"],
        "room reads preserve canonical sort order");
      assert.equal((await store.listRoomEntries("selected-room"))[1]?.display_name, "Changed elsewhere",
        "cached statements never cache authority results");
    } finally { database.close(); }
  } finally { await store.close(); await env.cleanup(); }
});

test("native activity records avoid history hydration and preserve transactional admission and retention", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const base = entry.activity![0]!;
    await store.write([{ ...entry, observed_state: "recovering",
      activity: [{ ...base, sequence: 100 }, { ...base, sequence: 5 }] }]);
    assert.deepEqual(await store.getActivityState(entry.id), { version: 1, observed_state: "recovering", last_sequence: 5 },
      "admission uses the last sort-order event, not the maximum sequence");
    assert.equal(await store.getActivityState("missing"), undefined);
    const database = new DatabaseSync(env.databasePath);
    try {
      database.prepare("UPDATE activity_events SET payload_json='invalid-json' WHERE agent_id=? AND sort_order=0").run(entry.id);
      const recorded = await store.recordActivity(1, entry.id, { ...base, sequence: 6 }, null, 2);
      assert.deepEqual(recorded, { version: 2 });
      const current = (await store.getEntry(entry.id))!;
      assert.equal(current.observed_state, "recovering", "presentation-only records cannot alter lifecycle state");
      assert.deepEqual(current.native_liveness, entry.native_liveness);
      assert.deepEqual(current.activity?.map(event => event.sequence), [5, 6]);
      await assert.rejects(store.recordActivity(2, entry.id, { ...base, sequence: 6 }, null), /not newer/);
      await assert.rejects(store.recordActivity(1, entry.id, { ...base, sequence: 7 }, null), ManifestConflictError);
      await assert.rejects(store.recordActivity(2, entry.id, { ...base, sequence: 7 }, null, 2,
        async () => { throw new Error("fenced"); }), /fenced/);
      assert.deepEqual(await store.getEntry(entry.id), current);
      assert.equal((await store.load()).versions[entry.id], 2);
      // A stale scalar admission cannot bypass the sequence check inside the write transaction.
      database.prepare("UPDATE activity_events SET sequence=9 WHERE agent_id=? AND sequence=6").run(entry.id);
      await assert.rejects(store.recordActivity(2, entry.id, { ...base, sequence: 7 }, {
        observedState: "working", nativeLiveness: { state: "active" },
      }), /not newer than 9/);
      assert.equal((await store.getEntry(entry.id))?.observed_state, "recovering", "failed append rolls back runtime fields");
      assert.equal((await store.load()).versions[entry.id], 2);
    } finally { database.close(); }
  } finally { await store.close(); await env.cleanup(); }
});

test("state summary loads only the newest payload-free activity without changing full reads", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  try {
    const activity = Array.from({ length: 200 }, (_, index) => ({ ...entry.activity![0]!,
      // Deliberately unsorted with ties: SQL must match the stable wire projection.
      sequence: (index * 31) % 47, summary: `event-${index}`, payload: { text: "x".repeat(8192) },
    }));
    await store.write([{ ...entry, activity }]);
    const full = await store.load();
    const summary = await store.load("summary");
    assert.deepEqual(summary, { ...full, entries: full.entries.map(value => ({ ...value, activity: projectStateWatchActivity(value.activity) })) });
    assert.equal(summary.entries[0]!.activity!.length, 16);
    assert.equal(full.entries[0]!.activity!.length, 200);
    assert.deepEqual(await store.getEntry(entry.id), full.entries[0]);
    assert.deepEqual(await store.getEntry(entry.id, "summary"), summary.entries[0]);
    assert.equal(await store.getEntry("missing", "summary"), undefined);
    const database = new DatabaseSync(env.databasePath);
    try {
      // Invalid raw JSON proves the summary path never parses discarded payloads.
      database.exec("UPDATE activity_events SET payload_json='invalid-json'");
      assert.deepEqual(await store.load("summary"), summary);
      assert.deepEqual(await store.getEntry(entry.id, "summary"), summary.entries[0]);
      await assert.rejects(store.load(), /JSON/);
      await assert.rejects(store.getEntry(entry.id), /JSON/);
      const plan = database.prepare(`EXPLAIN QUERY PLAN SELECT sequence,summary FROM activity_events
        WHERE agent_id=? ORDER BY sequence DESC,sort_order DESC LIMIT 16`).all(entry.id);
      assert.match(JSON.stringify(plan), /activity_events_summary/);
      assert.doesNotMatch(JSON.stringify(plan), /TEMP B-TREE/);
    } finally { database.close(); }
  } finally { await store.close(); await env.cleanup(); }
});

test("a Cursor prepared turn leaves a claimed notice's batch queued until the turn completes", async () => {
  const env = await fixture();
  const store = new ManifestStore(env.databasePath);
  const inbox = new SupervisedAgentInboxStore(env.databasePath, () => "2026-10-01T07:00:00.000Z");
  const bindings = new WorkerBindingStore(env.legacyPath, undefined, env.databasePath);
  const continuation = "cursor-pending:notice-batch";
  const wrapper = { kind: "cursor_cli" as const, pid: 4813, processIdentity: "cursor-wrapper:4813:birth" };
  const cursor: DaemonManifestEntry = {
    ...entry, id: "cursor-notice-batch", room_id: "cursor-notice-room", provider: "cursor", condition: "none", delivery_mode: "daemon_inbox",
    provider_ref: { work_attempt_id: "cursor-notice-attempt", provider_continuation_id: continuation, provider_connection: null,
      execution_generation_id: "cursor-notice-generation" },
    work_attempt_id: "cursor-notice-attempt", turn_control: undefined, last_turn_control_sequence: 0,
  };
  const notice = (id: string) => ({ source_message_id: id, activation: { decision: "activate", reason: "explicit_mention", addressed: true },
    source_message: { id, sender: "letagents", source: "system", agent_identity: null, text: `Board intent bi_${id} was approved.` } });
  const live = async () => (await inbox.receipts(cursor.id)).filter((item) => !item.acknowledged_at).map((item) => item.source_message_id);
  try {
    const version = (await store.write([cursor])).versions[cursor.id]!;
    const worker = await bindings.bind({ entry_id: cursor.id, room_id: cursor.room_id, work_attempt_id: cursor.work_attempt_id!,
      execution_generation_id: cursor.provider_ref!.execution_generation_id, agent_session_id: "cursor-notice-worker",
      agent_session_token: "memory-only-test-token", api_url: "https://letagents.test" });
    await inbox.ingestPoll({ agent_id: cursor.id, room_id: cursor.room_id, last_observed_message_id: "msg_3",
      messages: [notice("msg_1"), notice("msg_2"), notice("msg_3")] });
    const head = (await inbox.claimHead(cursor.id))!;
    assert.deepEqual((head.activation.queued_notices as { notices: Array<{ id: string }> }).notices.map((row) => row.id), ["msg_2", "msg_3"]);
    await store.checkpointCursorPreparedTurn(version, {
      agentId: cursor.id, roomId: cursor.room_id, inboxItemId: head.inbox_item_id, providerTurnId: "cursor-notice-turn",
      providerContinuationId: continuation, workAttemptId: cursor.work_attempt_id!,
      executionGenerationId: cursor.provider_ref!.execution_generation_id, agentSessionId: worker.agent_session_id,
      credentialRef: worker.credential_ref, apiUrl: worker.api_url, expectedProviderContinuationId: continuation,
      expectedProviderConnection: null, providerConnection: wrapper, configurationRevision: 1,
      requestedAuthorityMode: "typed", observedAt: "2026-10-01T07:00:00.000Z",
    });
    assert.deepEqual(await live(), ["msg_1", "msg_2", "msg_3"], "a prepared turn can still be reset as not dispatched");
    // Delivery's terminal checkpoint for every provider: the idempotent turn start, then the normalized result.
    const authority = { work_attempt_id: cursor.work_attempt_id!, origin_execution_generation_id: cursor.provider_ref!.execution_generation_id,
      provider_continuation_id: continuation };
    await inbox.checkpointTurnStarted(head.inbox_item_id, "cursor-notice-turn", authority);
    await inbox.checkpointNormalizedTerminal({ inbox_item_id: head.inbox_item_id, agent_id: cursor.id,
      execution_generation_id: cursor.provider_ref!.execution_generation_id, provider_turn_id: "cursor-notice-turn",
      outcome: "no_reply", text: null, evidence: "stream",
      terminal_evidence: { turnId: "cursor-notice-turn", providerContinuationId: continuation, outcome: "no_reply", text: null, evidence: "stream" } });
    assert.deepEqual(await live(), ["msg_1"], "the completed Cursor turn settles the notices it carried");
  } finally {
    await inbox.close().catch(() => undefined);
    await bindings.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});
