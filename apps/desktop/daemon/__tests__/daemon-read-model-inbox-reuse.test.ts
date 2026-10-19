import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { NATIVE_LIVENESS_STALE_AFTER_MS } from "../cloud-http.js";
import { DaemonReadModel } from "../daemon-read-model.js";
import type { ProviderActionHandle } from "../provider-action-port.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { DaemonManifestEntry } from "../types.js";
import type { WorkerSessionBinding } from "../worker-binding-store.js";

const OBSERVED_AT = "2026-10-19T00:00:00.000Z";

const entry: DaemonManifestEntry = {
  id: "agent_1", room_id: "room_1", display_name: "Agent One", provider: "codex", model: null,
  charter: "Handle room work.", desired_state: "running", observed_state: "working", condition: "none",
  permission_profile_id: null, delivery_mode: "daemon_inbox", created_by: "user_1", created_at: OBSERVED_AT,
  work_attempt_id: "attempt_1",
  provider_ref: { work_attempt_id: "attempt_1", provider_continuation_id: "continuation_1", provider_connection: null, execution_generation_id: "generation_1" },
  workplace_liveness: { state: "reachable", observed_at: OBSERVED_AT, detail: null },
  native_liveness: { state: "active", observed_at: OBSERVED_AT, detail: "Provider activity observed." },
};

const binding: WorkerSessionBinding = {
  entry_id: entry.id, room_id: entry.room_id, work_attempt_id: "attempt_1", execution_generation_id: "generation_1",
  agent_session_id: "session_1", credential_ref: "credential_ref_1", api_url: "https://letagents.chat",
  room_cursor: "message_0", last_sequence: 4, last_observed_at_ms: Date.parse(OBSERVED_AT), updated_at: OBSERVED_AT,
};

const handle: ProviderActionHandle = { workAttemptId: "attempt_1", pid: 41, providerContinuationId: "continuation_1", observedState: "idle" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "letagents-read-model-reuse-"));
  const path = join(root, "daemon-state.sqlite");
  const store = new SupervisedAgentInboxStore(path);
  const reads = { receipts: 0, repairs: 0, ingress: 0 };
  const authority = {
    nowMs: Date.parse(OBSERVED_AT),
    credential: "bearer" as string | null,
    hostGrant: true,
    binding: binding as WorkerSessionBinding | null,
    liveHandles: new Map<string, ProviderActionHandle>([[entry.id, handle]]),
  };
  const model = new DaemonReadModel({
    currentDaemonGeneration: () => 1, nowMs: () => authority.nowMs, startedAt: OBSERVED_AT,
    capabilities: { hasDelivery: () => true, supportsRoomTurns: () => true, supportsContinuationRepair: () => false },
    recoveryDiagnostics: () => { throw new Error("unused"); }, deliveryAdmission: () => null,
    manifest: { load: async () => ({ entries: [] }), getEntry: async () => undefined, pendingRuntimeRecovery: async () => null,
      getAgentConfiguration: async () => undefined },
    bindings: {
      credentialFor: async () => authority.credential,
      get: async () => authority.binding,
      list: async () => authority.binding ? [authority.binding] : [],
    },
    inbox: {
      detail: async () => { throw new Error("unused"); },
      receiptProjection: (agentId) => { reads.receipts += 1; return store.receiptProjection(agentId); },
      latestContinuationRepair: (agentId) => { reads.repairs += 1; return store.latestContinuationRepair(agentId); },
      ingressHealth: (agentId) => { reads.ingress += 1; return store.ingressHealth(agentId); },
      blockedHeadSkip: (agentId) => store.blockedHeadSkip(agentId),
      committedStateVersion: () => store.committedStateVersion(),
    },
    durability: { getAttempt: async () => { throw new Error("unused"); } },
    workerAuthority: { currentHostGrant: () => authority.hostGrant ? {} as never : null, pollingContract: async () => null },
    liveHandles: authority.liveHandles, delivery: null,
  });
  const watch = async (entries: DaemonManifestEntry[] = [entry]) =>
    model.entriesWithDerivedLiveness(entries, { reuseUnchangedInboxInputs: true });
  const ingest = (message: string) => store.ingestPoll({ agent_id: entry.id, room_id: entry.room_id, last_observed_message_id: message,
    messages: [{ source_message_id: message, source_message: { id: message, text: "hello" }, activation: { for_current_agent: true } }] });
  return {
    path, store, model, reads, authority, watch, ingest,
    cleanup: async () => { await store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test("the inbox version changes for every committed write, by this connection or another, and is withheld inside a transaction", async () => {
  const env = await fixture();
  const other = new DatabaseSync(env.path);
  try {
    await env.ingest("1");
    const first = await env.store.committedStateVersion();
    assert.ok(first);
    assert.equal(await env.store.committedStateVersion(), first, "reads alone leave it unchanged");
    await env.store.receiptProjection(entry.id);
    assert.equal(await env.store.committedStateVersion(), first);

    await env.ingest("2");
    const afterOwnWrite = await env.store.committedStateVersion();
    assert.notEqual(afterOwnWrite, first);

    // A writer that never tells the inbox store, on its own connection.
    other.prepare("UPDATE supervised_agent_inbox SET last_error='changed elsewhere' WHERE source_message_id='1'").run();
    const afterOtherWrite = await env.store.committedStateVersion();
    assert.notEqual(afterOtherWrite, afterOwnWrite);

    // A schema change on the store's own connection moves neither data_version nor total_changes().
    const database = (env.store as unknown as { database: DatabaseSync }).database;
    database.exec("CREATE TABLE reuse_probe(value INTEGER)");
    const afterCreate = await env.store.committedStateVersion();
    assert.notEqual(afterCreate, afterOtherWrite);
    database.exec("ALTER TABLE reuse_probe ADD COLUMN extra TEXT");
    const afterAlter = await env.store.committedStateVersion();
    assert.notEqual(afterAlter, afterCreate);
    database.exec("DROP TABLE reuse_probe");
    assert.notEqual(await env.store.committedStateVersion(), afterAlter);

    database.exec("BEGIN IMMEDIATE");
    try { assert.equal(await env.store.committedStateVersion(), null); }
    finally { database.exec("ROLLBACK"); }
  } finally {
    other.close();
    await env.cleanup();
  }
});

test("an unchanged database reuses the inbox inputs, and any write shows on the next projection", async () => {
  const env = await fixture();
  const other = new DatabaseSync(env.path);
  try {
    await env.ingest("1");
    const first = await env.watch();
    assert.deepEqual(first[0]?.delivery_receipts?.map((receipt) => receipt.source_message_id), ["1"]);
    assert.deepEqual(env.reads, { receipts: 1, repairs: 1, ingress: 1 });

    // Hit: nothing was written, so no inbox input is read again.
    const second = await env.watch();
    assert.deepEqual(env.reads, { receipts: 1, repairs: 1, ingress: 1 });
    assert.deepEqual(second, first);

    // Invalidation by this connection's own write.
    await env.ingest("2");
    const afterIngest = await env.watch();
    assert.deepEqual(afterIngest[0]?.delivery_receipts?.map((receipt) => receipt.source_message_id), ["1", "2"]);
    assert.equal(env.reads.receipts, 2);

    // Invalidation by a write on another connection that no hook reports.
    other.prepare("UPDATE supervised_agent_inbox SET last_error='changed elsewhere' WHERE source_message_id='2'").run();
    const afterOther = await env.watch();
    assert.equal(afterOther[0]?.delivery_receipts?.find((receipt) => receipt.source_message_id === "2")?.error, "changed elsewhere");
    assert.equal(env.reads.receipts, 3);

    // A projection that does not ask for reuse reads everything, and leaves the kept inputs alone.
    await env.model.entriesWithDerivedLiveness([entry]);
    assert.equal(env.reads.receipts, 4);
    await env.watch();
    assert.equal(env.reads.receipts, 4);

    // An entry that was not in the last projection is read, not guessed.
    await env.watch([entry, { ...entry, id: "agent_2" }]);
    assert.equal(env.reads.receipts, 5);
    await env.watch([entry, { ...entry, id: "agent_2" }]);
    assert.equal(env.reads.receipts, 5);
  } finally {
    other.close();
    await env.cleanup();
  }
});

test("kept inbox inputs are frozen, so editing one view cannot change the next wake", async () => {
  const env = await fixture();
  try {
    await env.ingest("1");
    const first = (await env.watch())[0]!;
    const receipt = first.delivery_receipts![0]!;
    assert.ok(receipt.timeline.length > 0);
    assert.ok(Object.isFrozen(receipt.timeline));
    assert.ok(Object.isFrozen(receipt.timeline[0]));
    assert.throws(() => (receipt.timeline as unknown[]).reverse(), TypeError);
    assert.throws(() => { (receipt.timeline[0] as { phase: string }).phase = "published"; }, TypeError);
    const second = (await env.watch())[0]!;
    assert.equal(env.reads.receipts, 1);
    assert.deepEqual(second.delivery_receipts, first.delivery_receipts);
    assert.equal(second.delivery_receipts![0]!.timeline[0]!.phase, "received");

    // A projection that keeps nothing hands out ordinary objects.
    const unkept = (await env.model.entriesWithDerivedLiveness([entry]))[0]!;
    assert.equal(Object.isFrozen(unkept.delivery_receipts![0]!.timeline), false);
  } finally {
    await env.cleanup();
  }
});

test("reused inputs never hold back the clock or an authority change", async () => {
  const env = await fixture();
  try {
    await env.ingest("1");
    const fresh = (await env.watch())[0]!;
    assert.equal(fresh.native_liveness?.state, "active");
    assert.equal(fresh.room_agent_state?.connection.state, "connected");

    // The clock alone moves: the agent turns stale while its inputs are reused.
    env.authority.nowMs = Date.parse(OBSERVED_AT) + NATIVE_LIVENESS_STALE_AFTER_MS + 1;
    const stale = (await env.watch())[0]!;
    assert.equal(env.reads.receipts, 1);
    assert.equal(stale.native_liveness?.state, "stale");

    // The credential is lost: the very next projection shows it.
    env.authority.credential = null;
    const withoutCredential = (await env.watch())[0]!;
    assert.equal(env.reads.receipts, 1);
    assert.equal(withoutCredential.room_agent_state?.connection.state, "disconnected");
    assert.equal(withoutCredential.room_agent_state?.inbox.state, "waiting_for_desktop_credentials");
    env.authority.credential = "bearer";
    assert.equal((await env.watch())[0]!.room_agent_state?.connection.state, "connected");

    // The live handle goes away.
    env.authority.liveHandles.delete(entry.id);
    assert.equal((await env.watch())[0]!.room_agent_state?.connection.detail, "No live provider handle.");

    // The host grant: a starting agent waits for it, then no longer.
    const starting: DaemonManifestEntry = { ...entry, observed_state: "starting" };
    env.authority.binding = null;
    env.authority.hostGrant = false;
    assert.equal((await env.watch([starting]))[0]!.room_agent_state?.connection.detail, "Waiting for desktop credential handoff.");
    env.authority.hostGrant = true;
    assert.equal((await env.watch([starting]))[0]!.room_agent_state?.connection.detail, "Restoring the provider and exact worker binding.");
    assert.equal(env.reads.receipts, 1);
  } finally {
    await env.cleanup();
  }
});
