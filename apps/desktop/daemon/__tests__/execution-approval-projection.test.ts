import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { serializeExecutionApprovalProjectionV1 } from "../../../../shared/execution-approval-projection.mjs";
import { DaemonStateSchema } from "../daemon-state-database.js";
import {
  readExecutionApprovalProjection,
  recordExecutionApprovalProjection,
} from "../execution-approval-projection-journal.js";
import {
  ExecutionApprovalProjectionError,
  produceExecutionApprovalProjection,
} from "../execution-approval-projection.js";
import type { ApprovalReference } from "../execution-approval-journal.js";
import type { ExecutionApprovalProjectionSource } from "../execution-approval-projection.js";

const expectedBase = {
  requestId: "request",
  requestVersion: 1,
  agentId: "agent",
  roomId: "room",
  executionGenerationId: "generation",
  runtimeGenerationId: "runtime",
  turnId: "turn",
  providerContinuationId: "continuation",
  providerTurnId: "native-turn",
  connectionId: "connection",
  nativeRequestId: 1,
} satisfies Omit<ApprovalReference, "requestSha256">;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "letagents-approval-projection-"));
  const workspace = join(directory, "workspace");
  await mkdir(join(workspace, "src"), { recursive: true });
  const database = new DatabaseSync(join(directory, "state.sqlite"));
  database.exec("PRAGMA foreign_keys=ON");
  new DaemonStateSchema().createSchema(database);
  database.prepare(`INSERT INTO work_attempts(
    work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,
    workspace_remote_url,workspace_resolved_revision,workspace_bare_path,state,created_at
  ) VALUES('workspace','task','lease',1,?,'owner/repo','https://example.test/repo.git','revision',?,'active','2026-09-03T00:00:00.000Z')`)
    .run(workspace, workspace);
  database.exec(`
    INSERT INTO execution_generations VALUES('generation','agent',100);
    INSERT INTO execution_runtime_generations(
      runtime_generation_id,execution_generation_id,agent_id,provider,runtime_state,control_state,
      continuation_state,config_revision,created_at_ms
    ) VALUES('runtime','generation','agent','codex','ready','responsive','available',1,100);
    INSERT INTO execution_message_attempts(
      attempt_id,agent_id,room_id,source_message_id,state,created_at_ms
    ) VALUES('attempt','agent','room','message','active',100);
    INSERT INTO execution_attempt_generations
      VALUES('attempt','agent','room','generation','workspace',100);
    INSERT INTO execution_turns(
      turn_id,attempt_id,agent_id,room_id,execution_generation_id,runtime_generation_id,
      provider_continuation_id,provider_turn_id,state,side_effects,created_at_ms
    ) VALUES('turn','attempt','agent','room','generation','runtime','continuation','native-turn','active','none',100);
  `);
  return { database, directory, workspace, cleanup: async () => { database.close(); await rm(directory, { recursive: true, force: true }); } };
}

function code(error: unknown): string | undefined {
  return error instanceof ExecutionApprovalProjectionError ? error.code : undefined;
}

function admitRequest(database: DatabaseSync, source: ExecutionApprovalProjectionSource,
  requestId = "request", nativeRequestId = 1): ApprovalReference {
  const requestSha256 = createHash("sha256").update(JSON.stringify(source)).digest("hex");
  database.prepare("DELETE FROM execution_approval_requests WHERE request_id=?").run(requestId);
  database.prepare(`INSERT INTO execution_approval_requests(
    request_id,request_version,agent_id,room_id,execution_generation_id,runtime_generation_id,
    turn_id,provider_continuation_id,provider_turn_id,connection_id,native_request_id_type,
    native_request_id,kind,risk,delegatable,request_sha256,state,recovery_boundary,created_at_ms,expires_at_ms
  ) VALUES(?,1,'agent','room','generation','runtime','turn','continuation','native-turn',
    'connection','number',?,'file_change','low',1,?,'requested','connection',100,1000)`)
    .run(requestId, String(nativeRequestId), requestSha256);
  return { ...expectedBase, requestId, nativeRequestId, requestSha256 };
}

test("projection persists only canonical workspace-relative counts and survives reopen", async () => {
  const f = await fixture();
  const diff = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
  try {
    const native = [
      { path: join(f.workspace, "src/a.ts"), kind: { type: "update" as const, move_path: null }, diff },
      { path: "src/new.ts", kind: { type: "add" as const }, diff: "+first\n+second\n" },
    ];
    const source = { request: { id: 1 }, changes: native } satisfies ExecutionApprovalProjectionSource;
    const expected = admitRequest(f.database, source);
    const projection = await produceExecutionApprovalProjection(f.database, expected, source);
    assert.equal(serializeExecutionApprovalProjectionV1({
      ...projection.value,
      changes: [...projection.value.changes].reverse(),
    }), projection.json);
    assert.deepEqual(projection.value.changes.map(({ path, kind, added_lines, removed_lines }) => (
      { path, kind, added_lines, removed_lines }
    )), [
      { path: "src/a.ts", kind: "update", added_lines: 1, removed_lines: 1 },
      { path: "src/new.ts", kind: "add", added_lines: 2, removed_lines: 0 },
    ]);
    assert.equal(projection.value.totals.diff_bytes, Buffer.byteLength(diff) + Buffer.byteLength("+first\n+second\n"));
    assert.equal(projection.json.includes(f.workspace), false);
    assert.doesNotMatch(projection.json, /-old|\+new|https:/);
    assert.equal(projection.sha256, createHash("sha256").update(projection.json).digest("hex"));

    f.database.exec("BEGIN IMMEDIATE");
    const recorded = recordExecutionApprovalProjection(f.database, { expected, projection, producedAtMs: 120 });
    assert.equal(recorded.created, true);
    const replayed = recordExecutionApprovalProjection(f.database, { expected, projection, producedAtMs: 121 });
    assert.equal(replayed.created, false);
    assert.equal(replayed.projection.producedAtMs, 120);
    f.database.exec("COMMIT");
    const reopened = new DatabaseSync(join(f.directory, "state.sqlite"));
    reopened.exec("PRAGMA foreign_keys=ON");
    assert.equal(readExecutionApprovalProjection(reopened, expected)?.json, projection.json);
    reopened.close();
  } finally { await f.cleanup(); }
});

test("projection refuses the whole request for escaping, sensitive, ambiguous, or oversized paths", async () => {
  const f = await fixture();
  const outside = join(f.directory, "outside");
  await mkdir(outside);
  await symlink(outside, join(f.workspace, "src/link"));
  try {
    for (const path of [join(outside, "escape.ts"), "../escape.ts", "src/../escape.ts", "src//escape.ts",
      "src/link/escape.ts", "C:\\escape.ts"]) {
      const source = { request: { id: 1 }, changes: [
        { path, kind: { type: "add" as const }, diff: "+secret\n" },
      ] } satisfies ExecutionApprovalProjectionSource;
      const expected = admitRequest(f.database, source);
      await assert.rejects(produceExecutionApprovalProjection(f.database, expected, source),
        (error) => code(error) === "unsafe_path", path);
    }
    for (const path of [".env", "src/private.pem"]) {
      const source = { request: { id: 1 }, changes: [
        { path, kind: { type: "add" }, diff: "+secret\n" },
      ] } satisfies ExecutionApprovalProjectionSource;
      const expected = admitRequest(f.database, source);
      await assert.rejects(produceExecutionApprovalProjection(f.database, expected, source),
        (error) => code(error) === "not_eligible", path);
    }
    const lossy = { request: { id: 1 }, changes: [
      { path: "src/cafe\u0301.ts", kind: { type: "add" }, diff: "+one\n" },
    ] } satisfies ExecutionApprovalProjectionSource;
    await assert.rejects(produceExecutionApprovalProjection(f.database, admitRequest(f.database, lossy), lossy),
      (error) => code(error) === "unsafe_path");
    await writeFile(join(f.workspace, "src/straße.ts"), "same physical file");
    const filesystemAlias = { request: { id: 1 }, changes: [
      { path: "src/straße.ts", kind: { type: "update", move_path: null }, diff: "+one\n" },
      { path: "src/STRASSE.ts", kind: { type: "update", move_path: null }, diff: "+two\n" },
    ] } satisfies ExecutionApprovalProjectionSource;
    await assert.rejects(produceExecutionApprovalProjection(f.database,
      admitRequest(f.database, filesystemAlias), filesystemAlias),
    (error) => code(error) === "not_eligible");
    const oversized = { request: { id: 1 }, changes: Array.from({ length: 128 }, (_, index) => ({
      path: `src/${String(index).padStart(3, "0")}-${"x".repeat(220)}.ts`, kind: { type: "add" as const }, diff: "+x\n",
    })) } satisfies ExecutionApprovalProjectionSource;
    await assert.rejects(produceExecutionApprovalProjection(f.database, admitRequest(f.database, oversized), oversized),
      (error) => code(error) === "invalid_input");
    assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM execution_approval_projections").get()?.count, 0);
  } finally { await f.cleanup(); }
});

test("journal rechecks request state and expiry and fails closed on stored-byte corruption", async () => {
  const f = await fixture();
  try {
    const source = { request: { id: 1 }, changes: [
      { path: "src/a.ts", kind: { type: "update", move_path: null }, diff: "+safe\n" },
    ] } satisfies ExecutionApprovalProjectionSource;
    const expected = admitRequest(f.database, source);
    const projection = await produceExecutionApprovalProjection(f.database, expected, source);
    await assert.rejects(produceExecutionApprovalProjection(f.database, expected, {
      ...source,
      changes: [{ ...source.changes[0]!, diff: "+different\n" }],
    }), (error) => code(error) === "invalid_input");
    assert.throws(() => recordExecutionApprovalProjection(f.database, { expected, projection, producedAtMs: 120 }),
      (error) => code(error) === "invalid_input");
    f.database.exec("BEGIN IMMEDIATE; UPDATE execution_approval_requests SET state='decision_recorded'");
    assert.throws(() => recordExecutionApprovalProjection(f.database, { expected, projection, producedAtMs: 120 }),
      (error) => code(error) === "not_eligible");
    f.database.exec("ROLLBACK; BEGIN IMMEDIATE");
    assert.throws(() => recordExecutionApprovalProjection(f.database, { expected, projection, producedAtMs: 1000 }),
      (error) => code(error) === "expired");
    recordExecutionApprovalProjection(f.database, { expected, projection, producedAtMs: 120 });
    f.database.exec("COMMIT");
    for (const [key, value] of [
      ["runtimeGenerationId", "wrong-runtime"], ["providerContinuationId", "wrong-continuation"],
      ["providerTurnId", "wrong-turn"], ["connectionId", "wrong-connection"], ["nativeRequestId", 2],
    ] as const) {
      assert.throws(() => readExecutionApprovalProjection(f.database, { ...expected, [key]: value }),
        (error) => code(error) === "corrupt", key);
    }
    f.database.exec("DROP TRIGGER execution_approval_projection_immutable");
    f.database.prepare("UPDATE execution_approval_projections SET projection_sha256=?").run("b".repeat(64));
    assert.throws(() => readExecutionApprovalProjection(f.database, expected), (error) => code(error) === "corrupt");
  } finally { await f.cleanup(); }
});

test("projection counts header-looking source lines only inside unified-diff hunks", async () => {
  const f = await fixture();
  try {
    const source = { request: { id: 1 }, changes: [{
      path: "src/a.ts",
      kind: { type: "update" as const, move_path: null },
      diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n--- removed-looking\n+++ added-looking\n",
    }] } satisfies ExecutionApprovalProjectionSource;
    const projection = await produceExecutionApprovalProjection(f.database, admitRequest(f.database, source), source);
    assert.equal(projection.value.totals.added_lines, 1);
    assert.equal(projection.value.totals.removed_lines, 1);
  } finally { await f.cleanup(); }
});

test("journal rejects cross-request and sensitive-path projection transplants", async () => {
  const f = await fixture();
  try {
    const sourceA = { request: { id: 1 }, changes: [
      { path: "src/a.ts", kind: { type: "add" as const }, diff: "+safe\n" },
    ] } satisfies ExecutionApprovalProjectionSource;
    const expectedA = admitRequest(f.database, sourceA, "request-a", 1);
    const projectionA = await produceExecutionApprovalProjection(f.database, expectedA, sourceA);
    const sourceB = { request: { id: 2 }, changes: [
      { path: "src/b.ts", kind: { type: "add" as const }, diff: "+other\n" },
    ] } satisfies ExecutionApprovalProjectionSource;
    const expectedB = admitRequest(f.database, sourceB, "request-b", 2);
    f.database.exec("BEGIN IMMEDIATE");
    assert.throws(() => recordExecutionApprovalProjection(f.database,
      { expected: expectedB, projection: projectionA, producedAtMs: 120 }),
    (error) => code(error) === "conflict");

    const unsafeValue = {
      ...projectionA.value,
      changes: [{ ...projectionA.value.changes[0]!, path: ".env" }],
    };
    const unsafeJson = serializeExecutionApprovalProjectionV1(unsafeValue)!;
    assert.throws(() => recordExecutionApprovalProjection(f.database, {
      expected: expectedA,
      projection: {
        ...projectionA,
        value: JSON.parse(unsafeJson),
        json: unsafeJson,
        sha256: createHash("sha256").update(unsafeJson).digest("hex"),
      },
      producedAtMs: 120,
    }), (error) => code(error) === "invalid_input");
    f.database.exec("ROLLBACK");
  } finally { await f.cleanup(); }
});
