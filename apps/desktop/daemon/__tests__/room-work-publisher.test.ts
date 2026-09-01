import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { DaemonStateSchema, openDaemonStateObservationDatabase } from "../daemon-state-database.js";
import { ExecutionShadowStore } from "../execution-shadow-store.js";
import { parseExecutionFact } from "../execution-protocol.js";
import { RoomWorkPublicationStore } from "../room-work-publication-store.js";
import { RoomWorkPublisher } from "../room-work-publisher.js";
import { publishRoomWork, type RoomWorkPublishInput, type RoomWorkPublishResult } from "../cloud-http.js";
import { WorkerRuntimeCustody, type CachedWorkerAuthorization, type InstalledHostGrant } from "../worker-runtime-custody.js";
import type { SupervisedIngressAgent } from "../supervised-agent-delivery.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "room-work-publisher-"));
  const path = join(directory, "state.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL");
  new DaemonStateSchema().createSchema(db);
  const custody = new WorkerRuntimeCustody();
  const grant: InstalledHostGrant = { entryId: "agent", roomId: "room", agentKey: "owner/agent", grantId: "grant",
    supervisorGrant: "PRIVATE_HOST_BEARER", grantGeneration: 1, apiUrl: "https://letagents.test", daemonGeneration: 1,
    hostId: "host", installationId: "installation", expiresAt: "2027-01-01T00:00:00Z" };
  const worker: CachedWorkerAuthorization = { entryId: "agent", roomId: "room", agentKey: "owner/agent", workAttemptId: "workspace",
    grantId: "grant", grantGeneration: 1, daemonGeneration: 1, apiUrl: grant.apiUrl, agentSessionId: "session",
    bearer: "PRIVATE_WORKER_BEARER", bearerId: "bearer", expiresAt: null, mintedAtMs: 100,
    agentSession: { session_id: "session", session_token: "PRIVATE_SESSION_TOKEN", room_id: "room", session_kind: "worker",
      runtime: "codex", actor_label: "Agent", agent_key: "owner/agent", agent_instance_id: "daemon:agent", display_name: "Agent",
      owner_label: "Owner", ide_label: "Desktop", created_at: "2026-08-31", updated_at: "2026-08-31", last_seen_at: "2026-08-31", ended_at: null } };
  custody.installHostGrant(grant); custody.installWorkerAuthorization(worker);
  const agent: SupervisedIngressAgent = { agentId: "agent", roomId: "room", provider: "codex", deliveryMode: "daemon_inbox",
    apiUrl: grant.apiUrl, agentSessionId: worker.agentSessionId, bearer: worker.bearer, handle: null,
    workAttemptId: "workspace", providerContinuationId: "conversation", providerConnection: null,
    executionGenerationId: "generation", daemonGeneration: 1 };
  const capture = new ExecutionShadowStore(db);
  const receipts = new RoomWorkPublicationStore(db);
  capture.registerRuntime({ agentId: "agent", executionGenerationId: "generation", runtimeGenerationId: "runtime",
    provider: "codex", authorityMode: "typed_shadow", configRevision: 1, createdAtMs: 100 });
  const observer = capture.bindObserver({ agentId: "agent", subjectRuntimeGenerationId: "runtime", observerRuntimeGenerationId: "runtime",
    sourceId: "source", daemonGenerationId: "1", expectedEpoch: 0, boundAtMs: 100 });
  const sent: RoomWorkPublishInput[] = [];
  const diagnostics: string[] = [];
  const options = {
    custody, daemonGeneration: () => 1, isClosing: () => false, now: () => Date.parse("2026-08-31T00:00:00Z"),
    assertCurrent: async () => {}, diagnostic: (code: string) => { diagnostics.push(code); },
    publish: async (input: RoomWorkPublishInput): Promise<RoomWorkPublishResult> => { sent.push(input); return "acknowledged"; },
  };
  let publisher = new RoomWorkPublisher(openDaemonStateObservationDatabase(path), options);
  t.after(async () => { publisher.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  let sequence = 0;
  const native = (id: number) => ({ turnId: `turn-${id}`, providerContinuationId: "conversation", providerTurnId: `native-${id}` });
  function fact(id: number, extra: Record<string, unknown> = {}) {
    sequence++;
    capture.ingest("source", observer, parseExecutionFact({ factId: `fact-${sequence}`, agentId: "agent", executionGenerationId: "generation",
      runtimeGenerationId: "runtime", observerEpoch: 1, sourceSequence: sequence, observedAtMs: 100 + sequence,
      ...native(id), domain: "turn", kind: "state_changed", ...(extra.domain === "execution" ? {} : { state: "active" }), sideEffects: "none", ...extra }));
    publisher.changed("agent");
  }
  function operation(id: number, extra: Record<string, unknown> = {}) {
    fact(id, { domain: "execution", kind: "started", executionId: `command-${id}`, operation: "command", ...extra });
  }
  function captureMessage(id = 1, pin = true) {
    if (pin) publisher.observeNewSources(agent)?.([`msg_${id}`]);
    const attemptId = capture.trackMessage({ agentId: "agent", roomId: "room", sourceMessageId: `msg_${id}`,
      executionGenerationId: "generation", workspaceId: "workspace", createdAtMs: 100 });
    capture.trackNativeTurn({ agentId: "agent", roomId: "room", executionGenerationId: "generation", runtimeGenerationId: "runtime",
      attemptId, ...native(id), createdAtMs: 100 });
    fact(id);
    return attemptId;
  }
  function summary(id = 1) {
    const result = capture.roomWorkSummary("agent", "room", `msg_${id}`);
    if (result.availability !== "available") assert.fail(JSON.stringify(result));
    return result;
  }
  return { db, path, capture, receipts, custody, grant, worker, agent, sent, diagnostics, options, fact, operation, captureMessage, summary,
    get publisher() { return publisher; },
    restart() { publisher.close(); publisher = new RoomWorkPublisher(openDaemonStateObservationDatabase(path), options); },
    row(id = 1) { return receipts.get("agent", "room", `msg_${id}`)!; },
  };
}

test("new-source attribution is frozen, canonical and never invented from old capture", async t => {
  const f = await fixture(t);
  const hook = f.publisher.observeNewSources(f.agent)!;
  f.custody.installWorkerAuthorization({ ...f.worker, agentSessionId: "replacement", agentSession: { ...f.worker.agentSession!, session_id: "replacement" } });
  hook(["msg_1"]);
  assert.equal(f.row(), null, "a delayed poll cannot attribute work through a replaced session");
  f.custody.installWorkerAuthorization(f.worker);
  f.publisher.observeNewSources(f.agent)!(["msg_1", "desktop-initial-message:1", "msg_0", "msg_2147483648"]);
  assert.equal(f.receipts.list("agent").length, 1);
  assert.equal(f.row().sourceSessionId, "session");
  assert.throws(() => f.receipts.pin({ ...f.row(), installationId: "other" }, ["msg_1"]));
  f.captureMessage(2, false);
  f.publisher.observeNewSources(f.agent)!(["msg_2"]);
  assert.equal(f.row(2), null, "pre-journal or missed attribution stays local-only");
  assert.doesNotMatch(JSON.stringify(f.row()), /PRIVATE_|workspace|conversation/);
  f.custody.installWorkerAuthorization({ ...f.worker, agentSession: undefined });
  assert.equal(f.publisher.observeNewSources(f.agent), undefined, "bare cached session ID is not validated server identity");
});

test("the daemon-wide pin budget preserves existing provenance and makes only new sources local-only", async t => {
  const f = await fixture(t);
  f.publisher.observeNewSources(f.agent)!(["msg_1"]);
  const trigger = String(f.db.prepare("SELECT sql FROM sqlite_master WHERE name='room_work_publication_capacity'").get()!.sql);
  // Bulk seed the already-full boundary without10k repeated trigger scans.
  f.db.exec(`BEGIN; DROP TRIGGER room_work_publication_capacity;
    WITH RECURSIVE ids(n) AS (SELECT 2 UNION ALL SELECT n+1 FROM ids WHERE n<10000)
    INSERT INTO room_work_publications(agent_id,room_id,api_origin,agent_key,agent_instance_id,host_id,installation_id,source_session_id,source_message_id)
      SELECT CASE WHEN n<5000 THEN agent_id ELSE 'other-agent' END,room_id,api_origin,agent_key,agent_instance_id,host_id,installation_id,source_session_id,'msg_'||n
      FROM ids CROSS JOIN room_work_publications WHERE source_message_id='msg_1';
    ${trigger}; COMMIT;`);
  assert.doesNotThrow(() => f.receipts.pin(f.row(), ["msg_1"]), "full journal still accepts exact provenance replay");
  assert.throws(() => f.receipts.pin({ ...f.row(), agentId: "third-agent" }, ["msg_10001"]), /capacity/);
  f.publisher.observeNewSources(f.agent)!(["msg_10001"]);
  assert.equal(f.row(10001), null); assert.equal(f.db.prepare("SELECT COUNT(*) n FROM room_work_publications").get()!.n, 10000);
  assert.throws(() => f.db.exec(`INSERT INTO room_work_publications
    SELECT 'third-agent',room_id,api_origin,agent_key,agent_instance_id,host_id,installation_id,source_session_id,'msg_10001',attempt_id,revision,summary_json,digest,acknowledged_revision,state
    FROM room_work_publications WHERE source_message_id='msg_1'`), /capacity/);
});

test("publisher coalesces structural evidence, not output, and terminal state follows delivery receipt", async t => {
  const f = await fixture(t);
  const attemptId = f.captureMessage();
  f.operation(1); f.operation(1, { kind: "output", outputBytes: 42 });
  f.operation(1, { kind: "completed", outcome: "succeeded" });
  f.fact(1, { state: "terminal", turnOutcome: "completed" });
  await f.publisher.flush();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].revision, 1);
  assert.equal(f.sent[0].summary.recorded_state, "active");
  assert.equal(f.sent[0].summary.operation_counts.succeeded, 1);
  assert.equal(f.row().acknowledgedRevision, 1);
  const before = Number(f.db.prepare("SELECT total_changes() AS n").get()!.n);
  await f.publisher.flush();
  assert.equal(f.sent.length, 1); assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, before);
  f.db.prepare("UPDATE execution_message_attempts SET state='cleanly_concluded',conclusion='acknowledged_no_reply',settled_at_ms=1000 WHERE attempt_id=?").run(attemptId);
  f.publisher.changed("agent"); await f.publisher.flush();
  assert.equal(f.sent.length, 2, "a successful prior upload does not delay a new revision by retry backoff");
  assert.equal(f.sent[1].summary.recorded_state, "completed_no_reply");
  assert.equal(f.sent[1].revision, 2);
  assert.doesNotMatch(JSON.stringify(f.sent[1].summary), /PRIVATE|workspace|conversation|outputBytes|turn-|native-/);
});

test("network retry survives restart and coalesces newer evidence into a stable revision", async t => {
  const f = await fixture(t); f.captureMessage();
  f.options.publish = async input => { f.sent.push(input); throw new Error("offline PRIVATE_ERROR"); };
  await f.publisher.flush();
  assert.equal(f.row().acknowledgedRevision, 0);
  const original = f.row(); f.restart();
  await f.publisher.flush();
  assert.equal(f.sent[1].revision, original.revision); assert.equal(f.row().digest, original.digest);
  f.operation(1); f.operation(1, { kind: "completed", outcome: "failed" });
  await f.publisher.flush();
  assert.equal(f.sent.length, 2, "failed upload keeps backoff even if local evidence changes");
  assert.equal(f.row().revision, 2);
  f.options.now = () => Date.parse("2026-08-31T00:01:00Z");
  f.options.publish = async input => { f.sent.push(input); return "acknowledged"; };
  await f.publisher.flush();
  assert.equal(f.sent[2].revision, 2); assert.equal(f.row().acknowledgedRevision, 2);
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /PRIVATE|offline/);
});

test("late ACK cannot acknowledge a newer revision; a clear stops the whole identity across restart", async t => {
  for (const result of ["acknowledged", "cleared", "conflict"] as const) await t.test(result, async t => {
    const f = await fixture(t); f.captureMessage();
    f.options.publish = async input => {
      f.sent.push(input);
      f.operation(1);
      f.receipts.stage(f.row(), f.summary());
      return result;
    };
    await f.publisher.flush();
    assert.equal(f.row().revision, 2); assert.equal(f.row().acknowledgedRevision, 0);
    assert.equal(f.row().state, result === "acknowledged" ? "open" : result);
    if (result === "acknowledged") {
      f.options.publish = async input => { f.sent.push(input); return "acknowledged"; };
      await f.publisher.flush(); assert.equal(f.row().acknowledgedRevision, 2);
    } else {
      if (result === "cleared") assert.equal(f.row().summary, null);
      assert.throws(() => f.receipts.stage(f.row(), f.summary()));
      f.restart(); await f.publisher.flush(); assert.equal(f.sent.length, 1);
    }
  });
});

test("staging retries a missed terminal hint after temporary storage failure without another hint", async t => {
  const f = await fixture(t); f.captureMessage();
  const prepare = DatabaseSync.prototype.prepare;
  let failed = false;
  const mock = t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
    if (!failed && sql.includes("SELECT f.sequence,f.runtime_generation_id")) { failed = true; throw new Error("database is locked"); }
    return prepare.call(this, sql);
  });
  await f.publisher.flush(); assert.equal(failed, true); assert.equal(f.row().revision, 0);
  mock.mock.restore();
  await f.publisher.flush(); assert.equal(f.row().acknowledgedRevision, 1);
  f.operation(1);
  const summary = t.mock.method(ExecutionShadowStore.prototype, "roomWorkSummary", () => ({ availability: "unavailable" as const }));
  await f.publisher.flush(); assert.equal(f.row().revision, 1);
  summary.mock.restore(); f.options.now = () => Date.parse("2026-08-31T00:01:00Z");
  await f.publisher.flush(); assert.equal(f.row().acknowledgedRevision, 2);
});

test("cold catch-up projects and sends at most four sources per pass without starving failed sources", async t => {
  const f = await fixture(t);
  for (let id = 1; id <= 9; id++) { f.captureMessage(id); f.fact(id, { state: "terminal", turnOutcome: "completed" }); }
  let projections = 0;
  const original = ExecutionShadowStore.prototype.roomWorkSummary;
  t.mock.method(ExecutionShadowStore.prototype, "roomWorkSummary", function(this: ExecutionShadowStore, ...args: Parameters<typeof original>) {
    projections++; return original.apply(this, args);
  });
  f.options.publish = async input => { f.sent.push(input); throw new Error("offline"); };
  await f.publisher.flush(); assert.equal(projections, 4); assert.equal(f.sent.length, 4);
  await f.publisher.flush(); assert.equal(projections, 8); assert.equal(f.sent.length, 8);
  await f.publisher.flush(); assert.equal(projections, 9); assert.equal(f.sent.length, 9);
  assert.equal(new Set(f.sent.map(input => input.sourceMessageId)).size, 9);
  await f.publisher.flush(); assert.equal(projections, 9); assert.equal(f.sent.length, 9);
});

test("missing authority, room move, expiry and worker replacement never borrow operational recovery", async t => {
  const f = await fixture(t); f.captureMessage();
  f.custody.installHostGrant({ ...f.grant, roomId: "moved" });
  await f.publisher.flush(); assert.equal(f.sent.length, 0);
  f.custody.installHostGrant({ ...f.grant, expiresAt: "2020-01-01" });
  await f.publisher.flush(); assert.equal(f.sent.length, 0);
  f.custody.installHostGrant(f.grant);
  let assertions = 0;
  f.options.assertCurrent = async () => {
    // This pass needs no re-projection: assertion1 is scan admission and
    // assertion2 is immediately before send, after worker snapshot capture.
    if (++assertions === 2) {
      f.custody.installWorkerAuthorization({ ...f.worker, agentSessionId: "successor", agentSession: { ...f.worker.agentSession!, session_id: "successor" } });
    }
  };
  await f.publisher.flush(); assert.equal(f.sent.length, 0, "same grant does not authorize stale worker dispatch after an await");
  f.options.assertCurrent = async () => {};
  await f.publisher.flush(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].sessionId, "successor");
  assert.equal(f.row().sourceSessionId, "session", "authorized successor does not rewrite source provenance");
});

test("close aborts optional HTTP and ignores late receipts without a shutdown upload", async t => {
  const f = await fixture(t); f.captureMessage();
  let release!: (result: RoomWorkPublishResult) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  f.options.publish = async input => { f.sent.push(input); started(); return new Promise(resolve => { release = resolve; }); };
  const pending = f.publisher.flush(); await ready;
  f.publisher.close(); assert.equal(f.sent[0].signal.aborted, true);
  release("acknowledged"); await pending;
  assert.equal(f.row().acknowledgedRevision, 0);
  await f.publisher.flush(); assert.equal(f.sent.length, 1);
});

test("capture hints expedite an existing retry timer and singleton loss never dispatches", async t => {
  const f = await fixture(t); f.captureMessage(); f.restart(); await f.publisher.flush();
  const delays: number[] = [];
  const realTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => { delays.push(args[1] ?? 0); return realTimeout(...args); });
  f.publisher.changed("agent");
  assert.deepEqual(delays, [1000], "new evidence replaces the30s retry wake with a1s coalescing wake");
  f.operation(1); f.options.assertCurrent = async () => { throw new Error("stale singleton"); };
  await f.publisher.flush(); assert.equal(f.sent.length, 1); assert.equal(f.row().revision, 1);
});

test("a hint timer firing during an upload remains pending until a new flush can run", async t => {
  const f = await fixture(t); f.captureMessage(); f.restart();
  let release!: (result: RoomWorkPublishResult) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  f.options.publish = async input => { f.sent.push(input); started(); return new Promise(resolve => { release = resolve; }); };
  const uploading = f.publisher.flush(); await ready;
  const timers: Array<{ delay: number; fire: () => void; timer: ReturnType<typeof setTimeout> }> = [];
  const realTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
    const timer = realTimeout(callback, delay); timers.push({ delay, fire: callback, timer }); return timer;
  });
  f.operation(1);
  assert.equal(timers.length, 1); clearTimeout(timers[0].timer); timers[0].fire();
  release("acknowledged"); await uploading;
  assert.deepEqual(timers.map(timer => timer.delay), [1000, 1000], "busy flush cannot consume the only wake for newly captured evidence");
  f.options.publish = async input => { f.sent.push(input); return "acknowledged"; };
  await f.publisher.flush(); assert.equal(f.sent.length, 2); assert.equal(f.row().acknowledgedRevision, 2);
});

test("HTTP publication validates exact receipts, both clear responses, and never follows redirects", async t => {
  const f = await fixture(t); f.captureMessage(); await f.publisher.flush();
  const input = f.sent[0];
  const work = { attempt_id: "28f3e612-1e11-45df-93cf-6789ccbdd814", room_id: input.roomId,
    source_message_id: input.sourceMessageId, agent_key: input.agentKey, revision: input.revision, summary: input.summary };
  let response: unknown = { status: "created", work }; let status = 201;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://letagents.test/supervisor-host-grants/grant/worker-sessions/session/agent-work");
    assert.equal(init.redirect, "error"); assert.equal(init.method, "POST"); assert.ok(init.signal);
    assert.deepEqual(JSON.parse(String(init.body)), { generation: 1, room_id: "room", source_message_id: "msg_1", revision: 1, summary: input.summary });
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer PRIVATE_HOST_BEARER");
    assert.equal((init.headers as Record<string, string>)["x-letagents-supervisor-generation"], "1");
    assert.doesNotMatch(String(init.body), /PRIVATE|sourceSession|workspace|native|outputBytes/);
    return new Response(JSON.stringify(response), { status });
  });
  assert.equal(await publishRoomWork(input), "acknowledged");
  response = { status: "replayed", work: { ...work, summary: { version: 1, availability: "cleared" } } }; status = 200;
  assert.equal(await publishRoomWork(input), "cleared");
  status = 409;
  for (const [code, expected] of [["payload_cleared", "cleared"], ["revision_conflict", "conflict"], ["publisher_conflict", "conflict"]]) {
    response = { code }; assert.equal(await publishRoomWork(input), expected);
  }
  response = { code: "stale_generation" }; await assert.rejects(publishRoomWork(input), /HTTP409|HTTP 409/);
  status = 200;
  for (const bad of [{ ...work, revision: 2 }, { ...work, source_message_id: "msg_2" }, { ...work, attempt_id: "private-native-handle" },
    { ...work, summary: { ...input.summary, command: "PRIVATE" } }]) {
    response = { status: "updated", work: bad }; await assert.rejects(publishRoomWork(input), /different/);
  }
});
