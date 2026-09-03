import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WebSocketServer } from "ws";

import { HostApprovalBroker } from "../host-approval-broker.js";
import type { RecordedApprovalDecision } from "../execution-approval-native-application.js";
import { ManifestStore } from "../manifest-store.js";
import { ProviderActionPortRouter, type NativeProviderAdapter } from "../provider-action-port-router.js";
import { systemProcessIdentity } from "../process-identity.js";
import { providerStreamLifecycle } from "../provider-stream-policy.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { DaemonManifestEntry } from "../types.js";
import type { ProviderActionHandle, ProviderActionPort, ProviderActionStreamEvent } from "../provider-action-port.js";
import { CodexProviderAdapter } from "../../electron/main/agents/codex-provider-adapter.js";
import { CodexRpcClient } from "../../electron/main/agents/codex-rpc-client.js";
import type { NativeExecutionObservation } from "../../shared/execution-protocol.js";
import type { HostApprovalCandidate, HostApprovalDecision } from "../../shared/host-approvals.js";
import type { CodexPermissionFileChange, ProviderPermissionObservation, ProviderPermissionRequest } from "../../shared/provider-permissions.js";

const secret = "PRIVATE-APPROVAL-CONTENT";
const now = Date.parse("2026-08-31T00:00:00.000Z");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function fixture(providerId: "codex" | "open-model" = "codex") {
  const root = await mkdtemp(join(tmpdir(), "letagents-approval-broker-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const path = join(root, "daemon-state.sqlite");
  const store = new ManifestStore(path);
  const inbox = new SupervisedAgentInboxStore(path, () => new Date(now).toISOString());
  const connection = providerId === "codex"
    ? { kind: "codex_app_server" as const, url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "native-birth" }
    : { kind: "opencode_server" as const, url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "native-birth", serverAuthPath: "/private/native-auth" };
  const entry: DaemonManifestEntry = { id: "agent", room_id: "room", display_name: "GardenPoint", provider: providerId,
    model: null, charter: "Help", desired_state: "running", observed_state: "working", condition: "none",
    permission_profile_id: "ask_before_write", delivery_mode: "daemon_inbox", created_by: "owner", created_at: new Date(now).toISOString(),
    work_attempt_id: "workspace", provider_ref: { work_attempt_id: "workspace", execution_generation_id: "generation",
      provider_continuation_id: "continuation", provider_connection: connection } };
  await store.write(0, [entry]);
  const db = new DatabaseSync(path); db.exec("PRAGMA foreign_keys=ON");
  db.prepare(`INSERT INTO work_attempts(work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,
    workspace_remote_url,workspace_resolved_revision,workspace_bare_path,state,created_at)
    VALUES('workspace','task','lease',1,?,'repo','remote','revision','/bare','active',?)`).run(workspace, entry.created_at);
  db.prepare("INSERT INTO work_attempt_executions VALUES('generation','workspace',?,'provider',1,NULL)").run(entry.created_at);
  const item = await inbox.enqueueInitialMessage({ agent_id: "agent", room_id: "room", source_message_id: "message",
    source_message: { id: "message", content: "Assess the project" }, activation: { kind: "deliver", reason: "direct_mention" } });
  await inbox.claimHead("agent");
  await inbox.checkpointTurnStarted(item.inbox_item_id, "native-turn", { work_attempt_id: "workspace",
    origin_execution_generation_id: "generation", provider_continuation_id: "continuation" });
  const handle: ProviderActionHandle = { workAttemptId: "workspace", pid: 4311, providerContinuationId: "continuation",
    providerConnection: connection, appliedConfigurationRevision: 1, observedState: "working" };
  const native: ProviderPermissionRequest = providerId === "codex"
    ? { provider: "codex", native: { id: 1, connectionId: "connection", method: "item/commandExecution/requestApproval",
      params: { threadId: "continuation", turnId: "native-turn", command: `printf '${secret}'`, reason: "\u001b[31m\u202eFake trusted label" } } }
    : { provider: "open-model", native: { id: "permission", sessionID: "continuation", permission: "bash", patterns: [secret],
      metadata: { command: secret }, always: [], tool: { messageID: "assistant-message", callID: "call" } } };
  const state = { current: true, owned: true, correlation: true, turnId: "native-turn", live: handle as ProviderActionHandle | undefined,
    fileChanges: null as CodexPermissionFileChange[] | null,
    authorityChecks: 0, authorityFailAt: null as number | null,
    failBefore: false, failAfter: false, afterBefore: null as (() => void | Promise<void>) | null };
  const sends: string[] = []; const order: string[] = [];
  let permissionChanges = 0;
  let receive: ((event: ProviderPermissionObservation) => void) | null = null;
  let signal: AbortSignal | null = null;
  const provider = {
    observePermissions: async (_handle: ProviderActionHandle, listener: (event: ProviderPermissionObservation) => void, abort: AbortSignal) => {
      receive = listener; signal = abort;
    },
    correlatePermissionTurn: async (_handle: ProviderActionHandle, request: ProviderPermissionRequest) => state.correlation
      ? { outcome: "correlated" as const, providerContinuationId: "continuation", providerTurnId: state.turnId,
          kind: request.provider === "codex" && request.native.method === "item/fileChange/requestApproval"
            ? "file_change" as const : "command" as const,
          ...(state.fileChanges ? { fileChanges: state.fileChanges } : {}) }
      : { outcome: "correlation_unproven" as const },
    replyPermission: async (_handle: ProviderActionHandle, _request: ProviderPermissionRequest, reply: "once" | "reject",
      options: Parameters<NonNullable<ProviderActionPort["replyPermission"]>>[3]) => {
      assert.equal(db.prepare("SELECT dispatch_state FROM execution_approval_decisions").get()!.dispatch_state, "not_dispatched");
      order.push("decision_committed");
      if (state.failBefore) throw new Error("native request inspection failed");
      await options.beforeNativeDispatch();
      assert.equal(db.prepare("SELECT dispatch_state FROM execution_approval_decisions").get()!.dispatch_state, "dispatching");
      order.push("dispatch_committed");
      await state.afterBefore?.();
      options.assertNativeDispatch!();
      sends.push(reply); order.push("native_write");
      if (state.failAfter) throw new Error("native response lost");
      return providerId === "codex" ? { outcome: "sent_unacknowledged" as const, nativeScope: "request" as const }
        : { outcome: "native_processed" as const, nativeScope: reply === "reject" ? "session_pending" as const : "request" as const };
    },
  } as unknown as ProviderActionPort;
  const makeBroker = () => new HostApprovalBroker({ store, inbox, provider, currentHandle: () => state.live,
    isCurrent: () => state.current, exactAuthority: async () => {
      state.authorityChecks += 1;
      return state.owned && state.authorityChecks !== state.authorityFailAt;
    },
    fenceCommit: async commit => { if (!state.current) throw new Error("daemon generation changed"); await commit(); },
    onPermissionChanged: () => { permissionChanges += 1; }, nowMs: () => now + 10 });
  let broker = makeBroker();
  const emit = (requests: ProviderPermissionRequest[] = [native]) => {
    assert.ok(receive, "broker must subscribe before the fixture emits"); assert.equal(signal?.aborted, false);
    receive!({ type: "snapshot", connectionId: "connection", requests });
  };
  broker.install("agent", handle, "generation"); emit();
  return { store, inbox, db, item, state, native, handle, workspace, sends, order, emit,
    get permissionChanges() { return permissionChanges; },
    get broker() { return broker; },
    reinstall() { broker.close(); broker = makeBroker(); broker.install("agent", handle, "generation"); emit(); },
    async close() { broker.close(); db.close(); await inbox.close(); await store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("native permission observations wake delegated decision reconciliation", async () => {
  const f = await fixture();
  try { assert.equal(f.permissionChanges, 1); }
  finally { await f.close(); }
});

function decision(candidate: HostApprovalCandidate, changes: Partial<HostApprovalDecision> = {}): HostApprovalDecision {
  assert.ok(candidate.reference, "a decision requires an exact journal reference");
  return { expected: candidate.reference, decisionId: "decision", actorId: "host-owner", decision: "allow_once",
    projectionSha256: hash(candidate.presentation), ...changes };
}

function fileChangeRequest(native: ProviderPermissionRequest, workspace: string): ProviderPermissionRequest {
  assert.equal(native.provider, "codex");
  return { provider: "codex", native: { ...native.native, method: "item/fileChange/requestApproval",
    params: { threadId: "continuation", turnId: "native-turn", itemId: "edit-1",
      grantRoot: workspace, reason: "Approve these edits" } } };
}

test("host approvals use exact operational turns without capture and commit selection and intent before native response", async () => {
  for (const provider of ["codex", "open-model"] as const) {
    const f = await fixture(provider);
    try {
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM execution_turns").get()!.n, 0);
      const [candidate] = await f.broker.list("room"); assert.ok(candidate?.reference, "operational turn must admit an approval without capture");
      assert.equal(candidate.status, "pending"); assert.equal(candidate.presentation.title, "Run a command");
      assert.match(candidate.presentation.details, /PRIVATE-APPROVAL-CONTENT/);
      assert.equal(candidate.presentation.denyScope, provider === "codex" ? "request" : "session_pending");
      if (provider === "codex") {
        assert.match(candidate.presentation.details, /\\u001b/); assert.match(candidate.presentation.details, /\\u202e/);
        assert.doesNotMatch(candidate.presentation.details, /[\u001b\u202e]/);
      }
      assert.equal(f.db.prepare("SELECT state FROM execution_turns").get()!.state, "none");
      assert.equal(await f.broker.decide(decision(candidate, { decision: provider === "codex" ? "allow_once" : "deny" })), provider === "codex" ? "decision_sent" : "resolved");
      assert.deepEqual(f.order, ["decision_committed", "dispatch_committed", "native_write"]);
      assert.deepEqual(f.sends, [provider === "codex" ? "once" : "reject"]);
      const row = await f.store.getExecutionApproval(candidate.reference);
      assert.equal(row!.decision!.dispatchState, provider === "codex" ? "uncertain" : "acknowledged");
      for (const table of f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'execution_%'").all()) {
        assert.doesNotMatch(JSON.stringify(f.db.prepare(`SELECT * FROM ${table.name}`).all()), /PRIVATE-APPROVAL-CONTENT|Fake trusted label|native-auth/);
      }
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM execution_facts").get()!.n, 0);
    } finally { await f.close(); }
  }
});

test("Codex file-change approvals stay unavailable without exact native edit inspection", async () => {
  const f = await fixture();
  try {
    assert.equal(f.native.provider, "codex");
    const fileChange: ProviderPermissionRequest = { provider: "codex", native: { ...f.native.native,
      method: "item/fileChange/requestApproval", params: { threadId: "continuation", turnId: "native-turn",
        itemId: "edit-1", grantRoot: "/workspace", reason: "Approve these edits" } } };
    f.emit([fileChange]);
    const [unavailable] = await f.broker.list("room");
    assert.equal(unavailable!.status, "unavailable"); assert.equal(unavailable!.reference, null);
    assert.equal(unavailable!.presentation.title, "Approval unavailable");
    assert.match(unavailable!.detail!, /actual edits are not available to inspect/);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM execution_approval_requests").get()!.n, 0);
    f.emit();
    const [command] = await f.broker.list("room"); const selected = decision(command!);
    f.emit([fileChange]);
    await assert.rejects(f.broker.decide(selected), /actual edits are not available to inspect/);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM execution_approval_decisions").get()!.n, 0);
    assert.deepEqual(f.sends, []);
  } finally { await f.close(); }
});

test("exact safe Codex file changes are delegatable while sensitive paths stay host-only", async () => {
  for (const scenario of ["safe", "sensitive"] as const) {
    const f = await fixture();
    try {
      const fileChange = fileChangeRequest(f.native, f.workspace);
      f.state.fileChanges = [{ path: scenario === "safe" ? join(f.workspace, "src/app.ts") : join(f.workspace, ".env"),
        kind: { type: "add" }, diff: "+value\n" }];
      f.emit([fileChange]);
      const [candidate] = await f.broker.list("room");
      assert.ok(candidate?.reference); assert.equal(candidate.status, "pending");
      const stored = await f.store.getExecutionApproval(candidate.reference);
      assert.equal(stored!.request.risk, scenario === "safe" ? "low" : "high");
      assert.equal(stored!.request.delegatable, scenario === "safe");
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM execution_approval_projections").get()!.n,
        scenario === "safe" ? 1 : 0);
      if (scenario === "safe") {
        f.state.owned = false;
        const unavailable = await f.broker.list("room");
        assert.equal(unavailable.length, 1, "authority loss does not duplicate a live request and its durable recovery card");
        assert.deepEqual(unavailable[0]!.reference, candidate.reference);
        assert.equal(unavailable[0]!.status, "unavailable");
        assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM execution_approval_requests").get()!.n, 1);
        assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM execution_approval_projections").get()!.n, 1);
        f.state.owned = true;
        assert.equal(await f.broker.decide(decision(candidate)), "decision_sent",
          "the owner path remains valid for a delegatable request");
        f.reinstall(); f.emit([fileChange]);
        const recovered = await f.broker.list("room");
        assert.equal(recovered.length, 1, "one exact live card replaces the durable recovery fallback");
        assert.deepEqual(recovered[0]!.reference, candidate.reference);
        assert.equal(recovered[0]!.status, "uncertain");
      }
    } finally { await f.close(); }
  }
});

test("file-change admission rechecks exact authority after projection and at commit", async () => {
  for (const failAt of [2, 3]) {
    const f = await fixture();
    try {
      const fileChange = fileChangeRequest(f.native, f.workspace);
      f.state.fileChanges = [{ path: join(f.workspace, "src/app.ts"), kind: { type: "add" }, diff: "+value\n" }];
      f.state.authorityFailAt = failAt;
      f.emit([fileChange]);
      const [unavailable] = await f.broker.list("room");
      assert.equal(unavailable!.reference, null);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM execution_approval_requests").get()!.n, 0);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM execution_approval_projections").get()!.n, 0);
    } finally { await f.close(); }
  }
});

test("host approval decisions serialize duplicates and conflicts to one native response", async () => {
  const f = await fixture();
  try {
    const [candidate] = await f.broker.list("room"); const selected = decision(candidate!);
    const results = await Promise.allSettled([f.broker.decide(selected), f.broker.decide(selected),
      f.broker.decide({ ...selected, decisionId: "conflicting", decision: "deny" })]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 2);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    assert.deepEqual(f.sends, ["once"]);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM execution_approval_decisions").get()!.n, 1);
  } finally { await f.close(); }
});

test("host and delegated selections share one request serializer and one native write", async () => {
  const f = await fixture();
  try {
    const fileChange = fileChangeRequest(f.native, f.workspace);
    f.state.fileChanges = [{ path: join(f.workspace, "src/app.ts"), kind: { type: "add" }, diff: "+value\n" }];
    f.emit([fileChange]);
    const [candidate] = await f.broker.list("room");
    assert.ok(candidate?.reference);
    const projection = await f.store.readExecutionApprovalProjection(candidate.reference);
    assert.ok(projection);
    const delegated: RecordedApprovalDecision = {
      agentId: candidate.reference.agentId,
      requestId: candidate.reference.requestId,
      requestVersion: candidate.reference.requestVersion,
      requestSha256: candidate.reference.requestSha256,
      decisionId: "delegate-decision",
      actorId: "delegate",
      decision: "allow_once",
      projectionSha256: projection.sha256,
    };
    const delegatedApply = f.broker.applyRecordedDecision(delegated, async (prepared) => {
      prepared.assertCurrent();
      return f.store.selectHostApproval({
        expected: prepared.expected,
        authority: prepared.approvalAuthority,
        decisionId: delegated.decisionId,
        actorId: delegated.actorId,
        decision: delegated.decision,
        projectionSha256: delegated.projectionSha256,
        atMs: now + 10,
      }, async (commit) => { prepared.assertCurrent(); await commit(); });
    });
    const hostApply = f.broker.decide(decision(candidate));
    const [delegateResult, hostResult] = await Promise.allSettled([delegatedApply, hostApply]);
    assert.equal(delegateResult.status, "fulfilled");
    assert.equal(hostResult.status, "rejected");
    assert.deepEqual(f.sends, ["once"]);
    const stored = await f.store.getExecutionApproval(candidate.reference);
    assert.equal(stored?.decision?.decisionId, delegated.decisionId);
    assert.ok(stored?.decision?.dispatchId);
  } finally { await f.close(); }
});

test("host approval rejects uncorrelated turns, stale presentations and replaced operational authority", async () => {
  const f = await fixture();
  try {
    f.state.correlation = false;
    assert.equal((await f.broker.list("room"))[0]!.reference, null);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM execution_approval_requests").get()!.n, 0);
    f.state.correlation = true; f.state.turnId = "other-turn";
    assert.equal((await f.broker.list("room"))[0]!.reference, null);
    f.state.turnId = "native-turn";
    const [candidate] = await f.broker.list("room"); const selected = decision(candidate!);
    for (const change of [{ projectionSha256: "a".repeat(64) }, { expected: { ...selected.expected, nativeRequestId: "1" } },
      { expected: { ...selected.expected, providerTurnId: "other" } }]) await assert.rejects(f.broker.decide({ ...selected, ...change }));
    f.state.owned = false; await assert.rejects(f.broker.decide(selected)); f.state.owned = true;
    f.db.exec("UPDATE runtime_deployments SET provider_process_identity='other-birth'");
    await assert.rejects(f.broker.decide(selected));
    f.db.exec("UPDATE runtime_deployments SET provider_process_identity='native-birth'");
    assert.equal((await f.broker.list("room"))[0]!.status, "pending");
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM execution_approval_decisions").get()!.n, 0);
    assert.deepEqual(f.sends, []);
  } finally { await f.close(); }
});

test("host approval dispatch uncertainty survives request disappearance and broker restart without resend", async () => {
  const f = await fixture();
  try {
    const [candidate] = await f.broker.list("room"); const selected = decision(candidate!);
    f.state.failAfter = true;
    assert.equal(await f.broker.decide(selected), "uncertain");
    f.emit([]);
    const [retained] = await f.broker.list("room");
    assert.equal(retained?.status, "uncertain"); assert.deepEqual(retained.reference, candidate!.reference);
    assert.doesNotMatch(retained.presentation.details, /PRIVATE-APPROVAL-CONTENT/);
    f.reinstall(); f.emit([]);
    assert.equal((await f.broker.list("room"))[0]!.status, "uncertain");
    assert.equal(await f.broker.decide(selected), "uncertain");
    assert.deepEqual(f.sends, ["once"]);
    assert.equal((await f.store.getExecutionApproval(selected.expected))!.request.state, "dispatching");
  } finally { await f.close(); }
});

test("host approval final synchronous native fence catches state changes after async dispatch admission", async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof fixture>>) => f.db.exec("UPDATE agent_launch_intents SET desired_state='paused'"),
    (f: Awaited<ReturnType<typeof fixture>>) => f.db.exec("UPDATE agent_configurations SET config_revision=2"),
    (f: Awaited<ReturnType<typeof fixture>>) => f.db.exec("UPDATE supervised_agent_inbox SET outcome='{}'"),
    (f: Awaited<ReturnType<typeof fixture>>) => { f.state.current = false; },
  ]) {
    const f = await fixture();
    try {
      const [candidate] = await f.broker.list("room"); const selected = decision(candidate!);
      f.state.afterBefore = async () => { await Promise.resolve(); mutate(f); };
      assert.equal(await f.broker.decide(selected), "uncertain");
      assert.deepEqual(f.order, ["decision_committed", "dispatch_committed"]);
      assert.deepEqual(f.sends, [], "native write cannot follow a stale earlier async validation");
      const record = await f.store.getExecutionApproval(selected.expected);
      assert.ok(record!.decision!.dispatchId, "committed intent is not removed or retried after final refusal");
    } finally { await f.close(); }
  }
  for (const changedTarget of [false, true]) {
    const f = await fixture("open-model");
    try {
      const [candidate] = await f.broker.list("room");
      f.state.afterBefore = () => {
        assert.equal(f.native.provider, "open-model");
        const target = structuredClone(f.native);
        if (changedTarget) target.native.metadata = { command: "different command" };
        f.emit([target, { provider: "open-model", native: { ...f.native.native, id: "unrelated-permission" } }]);
      };
      assert.equal(await f.broker.decide(decision(candidate!)), changedTarget ? "uncertain" : "resolved");
      assert.deepEqual(f.sends, changedTarget ? [] : ["once"], "only a changed target revokes the selected request");
    } finally { await f.close(); }
  }
});

test("host approval retains an unsent chosen decision for exact recovery without manufacturing another choice", async () => {
  for (const kind of ["command", "file_change"] as const) {
    const f = await fixture();
    try {
      const fileChange = fileChangeRequest(f.native, f.workspace);
      if (kind === "file_change") {
        f.state.fileChanges = [{ path: join(f.workspace, "src/app.ts"), kind: { type: "add" }, diff: "+value\n" }];
        f.emit([fileChange]);
      }
      const [candidate] = await f.broker.list("room"); const selected = decision(candidate!);
      f.state.failBefore = true;
      await assert.rejects(f.broker.decide(selected), /recorded but could not be sent/);
      assert.deepEqual(f.sends, []);
      assert.equal((await f.store.getExecutionApproval(selected.expected))!.decision!.dispatchId, null);
      f.reinstall();
      if (kind === "file_change") f.emit([fileChange]);
      const [retained] = await f.broker.list("room"); assert.equal(retained!.status, "decision_recorded");
      const { expected, ...recordedDecision } = selected;
      assert.deepEqual(retained!.reference, expected);
      assert.deepEqual(retained!.recordedDecision, recordedDecision);
      f.state.failBefore = false;
      assert.equal(await f.broker.decide(selected), "decision_sent"); assert.deepEqual(f.sends, ["once"]);
    } finally { await f.close(); }
  }
});

for (const scenario of ["command", "file_change", "changed_file", "changed_presentation", "oversized_presentation"] as const) {
  test(`host approval reaches the real Codex adapter through an offline native server: ${scenario}`, { timeout: 10_000 }, () => verifyNativeApproval(scenario));
}

async function verifyNativeApproval(scenario: "command" | "file_change" | "changed_file" | "changed_presentation" | "oversized_presentation") {
  const f = await fixture(); f.broker.close();
  const isFileChange = scenario !== "command";
  const changes = [{ path: join(f.workspace, "old.txt"), kind: { type: "update", move_path: join(f.workspace, "new.txt") }, diff: `@@ -1 +1 @@\n-old\n+${secret}` }];
  if (scenario === "oversized_presentation") {
    // The edits alone fit the adapter's bound; the complete host presentation,
    // including its native request, must also fit without truncation.
    changes[0]!.diff += "x".repeat(24 * 1024 - 50 - Buffer.byteLength(JSON.stringify(changes)));
  }
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const frames: Record<string, unknown>[] = []; const order: string[] = [];
  const streams: ProviderActionStreamEvent[] = []; const facts: NativeExecutionObservation[] = [];
  let rpc!: CodexRpcClient; let broker: HostApprovalBroker | undefined;
  let disposeStream: (() => void) | undefined; let disposeFacts: (() => void) | undefined;
  let selected: HostApprovalDecision | undefined;
  let receivedResponse!: (frame: Record<string, unknown>) => void;
  const responseFrame = new Promise<Record<string, unknown>>(resolve => { receivedResponse = resolve; });
  server.on("connection", socket => socket.on("message", raw => {
    const frame = JSON.parse(String(raw)) as Record<string, unknown>; frames.push(frame);
    if (!frame.method) { receivedResponse(frame); return; }
    if (!Object.hasOwn(frame, "id")) return;
    if (frame.method === "thread/turns/list") assert.deepEqual(frame.params,
      { threadId: "continuation", limit: 1, sortDirection: "desc", itemsView: "full" });
    const result = frame.method === "mcpServerStatus/list" ? { data: [{ name: "letagents" }] }
      : frame.method === "thread/read" ? { thread: { id: "continuation", status: { type: "active" },
        turns: isFileChange ? [] : [{ id: "native-turn", status: "inProgress", items: [] }] } }
      : frame.method === "thread/turns/list" ? { data: [{ id: "native-turn", status: "inProgress", itemsView: "full",
        items: [{ type: "fileChange", id: "item-1", status: "inProgress", changes }] }], nextCursor: null, backwardsCursor: null } : {};
    socket.send(JSON.stringify({ id: frame.id, result }));
  }));
  try {
    await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string", "local server must expose its assigned TCP port");
    // The local server lives in this actual process; no Codex process/model is launched.
    const connection = { kind: "codex_app_server" as const, url: `ws://127.0.0.1:${address.port}`, pid: process.pid,
      processIdentity: systemProcessIdentity.readBirthIdentity(process.pid).trim() };
    const entry = (await f.store.getEntry("agent"))!;
    await f.store.replaceEntry(1, { ...entry, provider_ref: { ...entry.provider_ref!, provider_connection: connection } });
    const adapter = new CodexProviderAdapter({ codexBin: "unused-offline-fixture", dependencies: {
      launchServer: () => assert.fail("approval attachment must not launch a provider"),
      signalProcess: () => assert.fail("approval payload must not signal a process"),
      observeProcessExit: () => new Promise(() => {}),
      createRpcClient: (url, notify) => {
        rpc = new CodexRpcClient(url, notify, 1_000);
        const request = rpc.request.bind(rpc); const respond = rpc.respond.bind(rpc);
        rpc.request = async (method, params, options) => {
          if (selected && (method === "thread/read" || method === "thread/turns/list")) {
            const row = f.db.prepare("SELECT dispatch_state, projection_sha256 FROM execution_approval_decisions").get();
            if (row) {
              assert.equal(row.projection_sha256, selected.projectionSha256);
              if (row.dispatch_state === "not_dispatched") order.push("decision_committed");
              else {
                assert.equal(row.dispatch_state, "dispatching");
                order.push("post_intent_inspection");
                if (scenario === "changed_file") changes[0]!.diff += "\n+changed after the host's decision";
              }
            }
          }
          return request(method, params, options);
        };
        rpc.respond = (native, result) => {
          const row = f.db.prepare("SELECT dispatch_state, dispatch_id FROM execution_approval_decisions").get()!;
          assert.equal(row.dispatch_state, "dispatching"); assert.ok(row.dispatch_id, "native write requires a durable dispatch identity");
          order.push("intent_committed"); respond(native, result); order.push("native_write");
        };
        return rpc;
      },
    } });
    const provider = new ProviderActionPortRouter({ codex: async () => adapter as unknown as NativeProviderAdapter });
    const handle = await provider.attach({ provider: "codex", workAttemptId: "workspace", providerContinuationId: "continuation", providerConnection: connection });
    assert.ok(handle && !("state" in handle), "actual adapter must attach the exact local process and continuation");
    disposeStream = await provider.onStream(handle, event => streams.push(event));
    disposeFacts = (await provider.onExecution(handle, event => facts.push(event))).dispose;
    assert.ok(facts.length > 0, "reattach establishes a nonempty typed lifecycle baseline");
    const lifecycleFacts = structuredClone(facts);
    broker = new HostApprovalBroker({ store: f.store, inbox: f.inbox, provider, currentHandle: () => handle,
      isCurrent: () => true, exactAuthority: async () => true, fenceCommit: commit => commit(), nowMs: () => now + 10 });
    broker.install("agent", handle, "generation");
    const pending = new Promise<void>(resolve => {
      const unsubscribe = rpc.onPendingRequestsChanged(() => { if (rpc.listPendingRequests().length) { unsubscribe(); resolve(); } });
    });
    server.clients.values().next().value!.send(JSON.stringify({ id: 71,
      method: isFileChange ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval",
      params: { threadId: "continuation", turnId: "native-turn", itemId: "item-1", startedAtMs: now,
        ...(isFileChange ? {} : { command: `printf '${secret}'` }), reason: "failed systemError is untrusted permission text" } }));
    await pending;
    const [candidate] = await broker.list("room");
    if (scenario === "oversized_presentation") {
      assert.equal(candidate!.status, "unavailable"); assert.equal(candidate!.reference, null);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM execution_approval_requests").get()!.n, 0);
      assert.equal(frames.some(frame => frame.id === 71 && !frame.method), false);
      return;
    }
    assert.ok(candidate?.reference, "native approval must match the operational checkpoint");
    assert.equal(candidate.reference.nativeRequestId, 71); assert.equal(candidate.reference.providerTurnId, "native-turn");
    assert.equal(candidate.reference.connectionId, rpc.currentConnectionId()); assert.equal(candidate.status, "pending");
    if (isFileChange) {
      assert.equal(candidate.presentation.title, "Change files");
      assert.deepEqual(JSON.parse(candidate.presentation.details).changes, changes);
      assert.equal(candidate.reference.requestSha256, hash({ request: rpc.listPendingRequests()[0], changes }));
    }
    selected = decision(candidate);
    if (scenario === "changed_presentation") {
      changes[0]!.diff += "\n+different before the host chooses";
      await assert.rejects(broker.decide(selected), /displayed approval request has changed/);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM execution_approval_decisions").get()!.n, 0);
      assert.equal(frames.some(frame => frame.id === 71 && !frame.method), false);
      return;
    }
    if (scenario === "changed_file") {
      assert.equal(await broker.decide(selected), "uncertain");
      assert.deepEqual(order, ["decision_committed", "post_intent_inspection"]);
    } else {
      assert.equal(await broker.decide(selected), "decision_sent");
      assert.deepEqual(await responseFrame, { id: 71, result: { decision: "accept" } });
      assert.deepEqual(order, ["decision_committed", ...(isFileChange ? ["post_intent_inspection"] : []), "intent_committed", "native_write"]);
    }
    assert.equal((await f.store.getExecutionApproval(selected.expected))!.decision!.dispatchState, "uncertain");
    assert.equal(await broker.decide(selected), "uncertain");
    assert.equal(frames.filter(frame => frame.id === 71 && !frame.method).length, scenario === "changed_file" ? 0 : 1);
    assert.equal(frames.some(frame => ["thread/start", "turn/start", "turn/interrupt"].includes(String(frame.method))), false);
    assert.equal(handle.observedState, "working");
    assert.deepEqual(facts, lifecycleFacts,
      "approval payloads and decisions never add to the reconstructed execution evidence");
    assert.equal(streams.some(event => event.method.includes("requestApproval") || providerStreamLifecycle(event) === "failed"), false,
      "raw permission RPC requests are not legacy lifecycle authority");
    assert.doesNotMatch(JSON.stringify(f.db.prepare("SELECT * FROM execution_approval_requests").all()), /PRIVATE-APPROVAL-CONTENT|systemError/);
  } finally {
    broker?.close(); disposeStream?.(); disposeFacts?.(); rpc?.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
  }
}
