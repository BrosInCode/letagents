import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WebSocketServer } from "ws";

import type { HostApprovalReference } from "../../shared/host-approvals.js";
import { HostApprovalBroker } from "../host-approval-broker.js";
import { DaemonAuthority } from "../daemon-authority.js";
import { DAEMON_STATE_SCHEMA_VERSION } from "../daemon-state-database.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
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
import type { NativeExecutionFact, NativeExecutionObservation } from "../../shared/execution-protocol.js";
import type { HostApprovalCandidate, HostApprovalDecision } from "../../shared/host-approvals.js";
import type { CodexPermissionFileChange, ProviderPermissionObservation, ProviderPermissionRequest } from "../../shared/provider-permissions.js";

const secret = "PRIVATE-APPROVAL-CONTENT";
const now = Date.parse("2026-08-31T00:00:00.000Z");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function fixture(providerId: "codex" | "open-model" | "claude-code" = "codex",
  overrides: Partial<Pick<ConstructorParameters<typeof HostApprovalBroker>[0], "exactAuthority" | "fenceCommit" | "hostActorId" | "onPermissionChanged">> = {}) {
  const root = await mkdtemp(join(tmpdir(), "letagents-approval-broker-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const path = join(root, "daemon-state.sqlite");
  const store = new ManifestStore(path);
  const inbox = new SupervisedAgentInboxStore(path, () => new Date(now).toISOString());
  const connection = providerId === "codex"
    ? { kind: "codex_app_server" as const, url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "native-birth" }
    : providerId === "claude-code" ? { kind: "claude_cli" as const, pid: 4311, processIdentity: "native-birth" }
    : { kind: "opencode_server" as const, url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "native-birth", serverAuthPath: "/private/native-auth" };
  const entry: DaemonManifestEntry = { id: "agent", room_id: "room", display_name: "GardenPoint", provider: providerId,
    model: null, charter: "Help", desired_state: "running", observed_state: "working", condition: "none",
    permission_profile_id: "ask_before_write", delivery_mode: "daemon_inbox", created_by: "owner", created_at: new Date(now).toISOString(),
    work_attempt_id: "workspace", provider_ref: { work_attempt_id: "workspace", execution_generation_id: "generation",
      provider_continuation_id: "continuation", provider_connection: connection } };
  if (overrides.hostActorId) {
    execFileSync("git", ["init", "-q", workspace]);
    execFileSync("git", ["-C", workspace, "-c", "user.name=QA", "-c", "user.email=qa@example.test", "commit", "--allow-empty", "-qm", "Fixture"]);
    execFileSync("git", ["-C", workspace, "remote", "add", "origin", "remote"]);
    entry.source_repo_path = workspace;
  }
  await store.write(0, [entry]);
  const db = new DatabaseSync(path); db.exec("PRAGMA foreign_keys=ON");
  db.prepare(`INSERT INTO work_attempts(work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,
    workspace_remote_url,workspace_resolved_revision,workspace_bare_path,state,created_at)
    VALUES('workspace','task','lease',1,?,'repo','remote','revision','/bare','active',?)`).run(workspace, entry.created_at);
  db.prepare("INSERT INTO work_attempt_executions VALUES('generation','workspace',?,'provider',1,NULL)").run(entry.created_at);
  const item = await inbox.enqueueInitialMessage({ agent_id: "agent", room_id: "room", source_message_id: "msg_1",
    source_message: { id: "msg_1", content: "Assess the project" }, activation: { kind: "deliver", reason: "direct_mention" } });
  await inbox.claimHead("agent");
  await inbox.checkpointTurnStarted(item.inbox_item_id, "native-turn", { work_attempt_id: "workspace",
    origin_execution_generation_id: "generation", provider_continuation_id: "continuation" });
  const handle: ProviderActionHandle = { workAttemptId: "workspace", pid: 4311, providerContinuationId: "continuation",
    providerConnection: connection, appliedConfigurationRevision: 1, observedState: "working" };
  const native: ProviderPermissionRequest = providerId === "codex"
    ? { provider: "codex", native: { id: 1, connectionId: "connection", method: "item/commandExecution/requestApproval",
      params: { threadId: "continuation", turnId: "native-turn", command: `printf '${secret}'`, reason: "\u001b[31m\u202eFake trusted label" } } }
    : providerId === "claude-code"
      ? { provider: "claude-code", native: { id: "permission", request: { subtype: "can_use_tool", tool_name: "Write", tool_use_id: "tool", input: { content: secret } } } }
    : { provider: "open-model", native: { id: "permission", sessionID: "continuation", permission: "bash", patterns: [secret],
      metadata: { command: secret }, always: [], tool: { messageID: "assistant-message", callID: "call" } } };
  const state = { current: true, owned: true, correlation: true, turnId: "native-turn", live: handle as ProviderActionHandle | undefined,
    fileChanges: null as CodexPermissionFileChange[] | null,
    authorityChecks: 0, authorityFailAt: null as number | null,
    failBefore: false, failAfter: false, beforeBefore: null as (() => void | Promise<void>) | null, afterBefore: null as (() => void | Promise<void>) | null,
    afterNativeWrite: null as (() => void | Promise<void>) | null };
  const sends: string[] = []; const order: string[] = [];
  let permissionChanges = 0;
  let receive: ((event: ProviderPermissionObservation) => void) | null = null;
  let signal: AbortSignal | null = null;
  let executionSequence = 0;
  const executionListeners = new Set<(event: NativeExecutionObservation) => void>();
  const provider = {
    onExecution: async (_handle: ProviderActionHandle, listener: (event: NativeExecutionObservation) => void) => {
      executionListeners.add(listener);
      return { sourceId: "test-source", position: () => ({ firstRetainedSequence: 1, latestSequence: executionSequence }),
        dispose: () => { executionListeners.delete(listener); } };
    },
    observePermissions: async (_handle: ProviderActionHandle, listener: (event: ProviderPermissionObservation) => void, abort: AbortSignal) => {
      receive = listener; signal = abort;
    },
    correlatePermissionTurn: async (_handle: ProviderActionHandle, request: ProviderPermissionRequest) => state.correlation
      ? { outcome: "correlated" as const, providerContinuationId: "continuation", providerTurnId: state.turnId,
          kind: request.provider === "codex" && request.native.method === "item/fileChange/requestApproval"
            ? "file_change" as const
            : request.provider === "codex" && request.native.method === "item/permissions/requestApproval"
              ? "network" as const : "command" as const,
          ...(state.fileChanges ? { fileChanges: state.fileChanges } : {}) }
      : { outcome: "correlation_unproven" as const },
    replyPermission: async (_handle: ProviderActionHandle, _request: ProviderPermissionRequest, reply: "once" | "reject",
      options: Parameters<NonNullable<ProviderActionPort["replyPermission"]>>[3]) => {
      assert.equal(db.prepare("SELECT dispatch_state FROM execution_approval_decisions ORDER BY rowid DESC LIMIT 1").get()!.dispatch_state, "not_dispatched");
      order.push("decision_committed");
      if (state.failBefore) throw new Error("native request inspection failed");
      await state.beforeBefore?.();
      await options.beforeNativeDispatch();
      assert.equal(db.prepare("SELECT dispatch_state FROM execution_approval_decisions ORDER BY rowid DESC LIMIT 1").get()!.dispatch_state, "dispatching");
      order.push("dispatch_committed");
      await state.afterBefore?.();
      options.assertNativeDispatch!();
      sends.push(reply); order.push("native_write");
      await state.afterNativeWrite?.();
      if (state.failAfter) throw new Error("native response lost");
      return providerId !== "open-model" ? { outcome: "sent_unacknowledged" as const, nativeScope: "request" as const }
        : { outcome: "native_processed" as const, nativeScope: reply === "reject" ? "session_pending" as const : "request" as const };
    },
  } as unknown as ProviderActionPort;
  const makeBroker = () => new HostApprovalBroker({ store, inbox, provider, currentHandle: () => state.live,
    isCurrent: () => state.current, exactAuthority: async () => {
      state.authorityChecks += 1;
      return state.owned && state.authorityChecks !== state.authorityFailAt;
    },
    fenceCommit: async commit => { if (!state.current) throw new Error("daemon generation changed"); await commit(); },
    onPermissionChanged: () => { permissionChanges += 1; }, nowMs: () => now + 10, ...overrides });
  let broker = makeBroker();
  const emit = (requests: ProviderPermissionRequest[] = [native]) => {
    assert.ok(receive, "broker must subscribe before the fixture emits"); assert.equal(signal?.aborted, false);
    receive!({ type: "snapshot", connectionId: "connection", requests });
  };
  broker.install("agent", handle, "generation"); emit();
  return { store, inbox, db, item, state, native, handle, workspace, root, path, sends, order, emit,
    execution(fact: NativeExecutionFact, overrides: Partial<NativeExecutionObservation> = {}) {
      const event: NativeExecutionObservation = { sourceId: "test-source", sequence: ++executionSequence,
        observedAtMs: now + 10, nativeProcessIdentity: "native-birth", nativeProcessPid: 4311, fact, ...overrides };
      for (const listener of executionListeners) listener(event);
    },
    closed(request: ProviderPermissionRequest = native) {
      if (request.provider === "claude-code") receive!({ type: "request_closed", request,
        providerContinuationId: "continuation", providerTurnId: state.turnId });
      else {
        assert.equal(request.provider, "codex");
        receive!({ type: "request_closed", request });
      }
    },
    observationFailure(type: "degraded" | "unavailable") { receive!({ type }); },
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

test("approval admission and worker credential writes preserve lock order", { timeout: 5_000 }, async () => {
  const authority = new DaemonAuthority({ assertCurrent: async () => {}, isHandoffScheduled: () => false,
    notifyStateChanged: () => {} });
  let bindings!: WorkerBindingStore;
  let interleave = true;
  let bindingWrite: Promise<unknown> | undefined;
  let requestedFence!: () => void;
  const needsFence = new Promise<void>(resolve => { requestedFence = resolve; });
  const f = await fixture("codex", {
    exactAuthority: async () => { await bindings.get("agent"); return true; },
    fenceCommit: commit => authority.fenceDaemonCommit(async () => {
      if (interleave) {
        interleave = false;
        bindingWrite = bindings.beginSupervisedWorkerSessionMint({ agent_id: "agent", room_id: "room", agent_instance_id: "instance" });
        await needsFence;
      }
      await commit();
    }),
  });
  bindings = new WorkerBindingStore(join(f.root, "workers.json"), commit => {
    requestedFence(); return authority.fenceDaemonCommit(commit);
  }, f.path);
  try {
    await bindings.list();
    const [candidate] = await f.broker.list("room");
    await bindingWrite;
    await bindings.list();
    assert.equal(candidate?.status, "pending");
    assert.deepEqual(f.sends, []);
  } finally { await bindings.close(); await f.close(); }
});

test("approval admission suppresses an actionable card if credentials change before commit", async () => {
  let owned = true;
  const f = await fixture("codex", {
    exactAuthority: async () => owned,
    fenceCommit: async commit => { owned = false; await commit(); },
  });
  try {
    const [candidate] = await f.broker.list("room");
    assert.equal(candidate?.status, "unavailable");
    assert.equal(candidate?.reference, null);
    assert.deepEqual(f.sends, []);
  } finally { await f.close(); }
});

test("request closure needs the dispatched native object and never acknowledges a decision", async () => {
  const f = await fixture();
  try {
    const [candidate] = await f.broker.list("room");
    f.closed();
    const selected = decision(candidate!);
    assert.equal(await f.broker.decide(selected), "decision_sent");
    f.closed({ ...f.native, native: { ...f.native.native } } as ProviderPermissionRequest);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.store.getExecutionApproval(selected.expected))!.request.closedAtMs, null);
    f.emit([]);
    f.closed();
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await f.store.getExecutionApproval(selected.expected))!.request.closedAtMs != null) break;
      await new Promise(resolve => setImmediate(resolve));
    }
    const stored = (await f.store.getExecutionApproval(selected.expected))!;
    assert.equal(stored.request.closedAtMs, now + 10);
    assert.equal(stored.request.state, "dispatching");
    assert.equal(stored.decision!.dispatchState, "uncertain");
    assert.equal(stored.decision!.resolvedAtMs, null);
    assert.deepEqual(await f.broker.list("room"), []);
    assert.equal(await f.broker.decide(selected), "request_closed");
    assert.deepEqual(f.sends, ["once"]);
    const reopened = new ManifestStore(f.path);
    try { assert.equal((await reopened.getExecutionApproval(selected.expected))!.request.closedAtMs, now + 10); }
    finally { await reopened.close(); }
    f.db.exec("DELETE FROM execution_approval_decisions");
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM execution_approval_request_closures").get()!.n, 0,
      "approval retention also retires its structural closure");
  } finally { await f.close(); }
});

test("v41 approval history upgrades without inventing a closure or changing a decision", async () => {
  const f = await fixture();
  try {
    const [candidate] = await f.broker.list("room");
    const selected = decision(candidate!);
    await f.broker.decide(selected);
    const before = f.db.prepare("SELECT * FROM execution_approval_decisions").all();
    await f.store.close();
    f.db.exec("DROP TABLE execution_approval_request_closures; PRAGMA user_version=41; UPDATE manifest_metadata SET schema_version=41");
    const upgraded = new ManifestStore(f.path);
    try {
      assert.equal((await upgraded.getExecutionApproval(selected.expected))!.request.closedAtMs, null);
      assert.deepEqual(f.db.prepare("SELECT * FROM execution_approval_decisions").all(), before);
      assert.equal(f.db.prepare("PRAGMA user_version").get()!.user_version, DAEMON_STATE_SCHEMA_VERSION);
    } finally { await upgraded.close(); }
    f.db.exec("DROP TABLE execution_approval_request_closures");
    const damaged = new ManifestStore(f.path);
    try { await assert.rejects(damaged.load(), /closure storage is missing or invalid/); }
    finally { await damaged.close(); }
  } finally { await f.close(); }
});

test("an unavailable approval observer is visible even before it discovers a request", async () => {
  const f = await fixture();
  try {
    f.emit([]);
    assert.deepEqual(await f.broker.list("room"), [], "an observed empty snapshot is healthy");
    for (const state of ["degraded", "unavailable"] as const) {
      f.observationFailure(state);
      const [unavailable] = await f.broker.list("room");
      assert.equal(unavailable?.status, "unavailable");
      assert.equal(unavailable.reference, null, "observation failure never grants decision authority");
      assert.equal(unavailable.presentation.agentId, "agent");
      assert.match(unavailable.detail!, /observe.*approval/i);
      assert.deepEqual(await f.broker.list("another-room"), []);
      f.emit([]);
      assert.deepEqual(await f.broker.list("room"), [], "a verified empty snapshot clears the observation failure");
    }
  } finally { await f.close(); }
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
  for (const provider of ["codex", "open-model", "claude-code"] as const) {
    const f = await fixture(provider);
    try {
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM execution_turns").get()!.n, 0);
      const [candidate] = await f.broker.list("room"); assert.ok(candidate?.reference, "operational turn must admit an approval without capture");
      assert.equal(candidate.status, "pending"); assert.equal(candidate.presentation.title, provider === "claude-code" ? "Run a tool" : "Run a command");
      assert.match(candidate.presentation.details, /PRIVATE-APPROVAL-CONTENT/);
      assert.equal(candidate.presentation.denyScope, provider !== "open-model" ? "request" : "session_pending");
      if (provider === "codex") {
        assert.match(candidate.presentation.details, /\\u001b/); assert.match(candidate.presentation.details, /\\u202e/);
        assert.doesNotMatch(candidate.presentation.details, /[\u001b\u202e]/);
      }
      assert.equal(f.db.prepare("SELECT state FROM execution_turns").get()!.state, "none");
      assert.equal(await f.broker.decide(decision(candidate, { decision: provider === "codex" ? "allow_once" : "deny" })), provider !== "open-model" ? "decision_sent" : "resolved");
      assert.deepEqual(f.order, ["decision_committed", "dispatch_committed", "native_write"]);
      assert.deepEqual(f.sends, [provider === "codex" ? "once" : "reject"]);
      const row = await f.store.getExecutionApproval(candidate.reference);
      assert.equal(row!.decision!.dispatchState, provider !== "open-model" ? "uncertain" : "acknowledged");
      for (const table of f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'execution_%'").all()) {
        assert.doesNotMatch(JSON.stringify(f.db.prepare(`SELECT * FROM ${table.name}`).all()), /PRIVATE-APPROVAL-CONTENT|Fake trusted label|native-auth/);
      }
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM execution_facts").get()!.n, 0);
    } finally { await f.close(); }
  }
});

test("Codex MCP approvals show the tool proposal and remain host-only with arguments out of durable storage", async () => {
  const f = await fixture();
  try {
    assert.equal(f.native.provider, "codex");
    const request: ProviderPermissionRequest = { provider: "codex", native: { ...f.native.native,
      method: "mcpServer/elicitation/request", params: { threadId: "continuation", turnId: "native-turn",
        serverName: "letagents", mode: "form", message: 'Allow tool "get_board"?',
        _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { room_id: secret } },
        requestedSchema: { type: "object", properties: {} } } } };
    f.emit([request]);
    const [candidate] = await f.broker.list("room"); assert.ok(candidate?.reference);
    assert.equal(candidate.presentation.title, "Run a tool");
    assert.equal(candidate.presentation.denyScope, "request");
    assert.match(candidate.presentation.details, /get_board/); assert.match(candidate.presentation.details, /PRIVATE-APPROVAL-CONTENT/);
    const row = await f.store.getExecutionApproval(candidate.reference);
    assert.equal(row!.request.delegatable, false); assert.equal(row!.request.kind, "command");
    assert.equal(await f.broker.decide(decision(candidate)), "decision_sent");
    assert.deepEqual(f.sends, ["once"]);
    for (const table of f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'execution_%'").all()) {
      assert.doesNotMatch(JSON.stringify(f.db.prepare(`SELECT * FROM ${table.name}`).all()), /PRIVATE-APPROVAL-CONTENT/);
    }
  } finally { await f.close(); }
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
      const admissions = await f.broker.admitDelegatable("agent");
      assert.equal(admissions.length, scenario === "safe" ? 1 : 0);
      if (scenario === "safe") {
        assert.equal(admissions[0]!.sourceMessageId, "msg_1");
        assert.equal(admissions[0]!.owned.inboxItemId, f.item.inbox_item_id);
        assert.equal(admissions[0]!.projection.requestSha256, admissions[0]!.approval.request.requestSha256);
      }
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

test("proactive admission skips stale peers but surfaces unexpected journal failure", async t => {
  const f = await fixture();
  try {
    const first = fileChangeRequest(f.native, f.workspace);
    assert.equal(first.provider, "codex");
    const second: ProviderPermissionRequest = { provider: "codex", native: { ...first.native, id: 2 } };
    f.state.fileChanges = [{ path: join(f.workspace, "src/app.ts"), kind: { type: "add" }, diff: "+value\n" }];
    f.state.authorityChecks = 0; f.state.authorityFailAt = 1;
    f.emit([first, second]);
    const admitted = await f.broker.admitDelegatable("agent");
    assert.equal(admitted.length, 1, "a stale request does not hide a safe peer");

    f.state.authorityFailAt = null;
    t.mock.method(f.store, "admitExecutionApprovalPlan", async () => { throw new Error("storage corrupt"); });
    await assert.rejects(f.broker.admitDelegatable("agent"), /storage corrupt/);
  } finally { await f.close(); }
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

for (const provider of ["codex", "claude-code"] as const) test(`${provider} host approval dispatch uncertainty survives request disappearance and broker restart without resend`, async () => {
  const f = await fixture(provider);
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

test("Claude successful tool result confirms its exact allowed request after dispatch", async () => {
  const f = await fixture("claude-code");
  const fact: NativeExecutionFact = { domain: "execution", kind: "completed", operation: "file_change",
    providerContinuationId: "continuation", providerTurnId: "native-turn", executionId: "tool",
    outcome: "succeeded", sideEffects: "possible" };
  try {
    const [candidate] = await f.broker.list("room");
    const selected = decision(candidate!);
    f.execution(fact); // An old result must not settle the later response.
    await f.broker.decide(selected);
    const uncertain = async () => {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal((await f.store.getExecutionApproval(selected.expected))!.request.state, "dispatching");
    };
    await uncertain();
    for (const changed of [{ executionId: "other" }, { providerTurnId: "other" },
      { providerContinuationId: "other" }, { operation: "command" as const }]) {
      f.execution({ ...fact, ...changed });
      await uncertain();
    }
    for (const changed of [{ sourceId: "other" }, { nativeProcessIdentity: "other-birth" },
      { nativeProcessPid: 1234 }, { sequence: 0 }]) {
      f.execution(fact, changed);
      await uncertain();
    }
    f.emit([]); // Disappearance alone is not acknowledgment.
    await uncertain();
    f.execution(fact);
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await f.store.getExecutionApproval(selected.expected))!.request.state === "resolved") break;
      await new Promise(resolve => setImmediate(resolve));
    }
    const record = (await f.store.getExecutionApproval(selected.expected))!;
    assert.equal(record.request.state, "resolved");
    assert.equal(record.decision!.dispatchState, "acknowledged");
    assert.deepEqual(await f.broker.list("room"), []);
    assert.equal(await f.broker.decide(selected), "resolved");
    assert.deepEqual(f.sends, ["once"], "confirmation never resends the response");
  } finally { await f.close(); }
});

test("Claude completion arriving inside native dispatch is reconciled after the journal is armed", async () => {
  const f = await fixture("claude-code");
  try {
    const [candidate] = await f.broker.list("room"); const selected = decision(candidate!);
    f.state.afterNativeWrite = () => f.execution({ domain: "execution", kind: "completed", operation: "file_change",
      providerContinuationId: "continuation", providerTurnId: "native-turn", executionId: "tool",
      outcome: "succeeded", sideEffects: "possible" });
    await f.broker.decide(selected);
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await f.store.getExecutionApproval(selected.expected))!.request.state === "resolved") break;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal((await f.store.getExecutionApproval(selected.expected))!.request.state, "resolved");
  } finally { await f.close(); }
});

test("Claude generic failure cannot confirm a decision, and a retired runtime cannot confirm success", async () => {
  for (const scenario of ["allow", "deny", "retired"] as const) {
    const f = await fixture("claude-code");
    try {
      const [candidate] = await f.broker.list("room");
      const selected = { ...decision(candidate!), decision: scenario === "deny" ? "deny" as const : "allow_once" as const };
      await f.broker.decide(selected);
      if (scenario === "retired") f.state.current = false;
      f.execution({ domain: "execution", kind: "completed", operation: "file_change",
        providerContinuationId: "continuation", providerTurnId: "native-turn", executionId: "tool",
        outcome: scenario === "retired" ? "succeeded" : "failed", sideEffects: "possible" });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal((await f.store.getExecutionApproval(selected.expected))!.request.state, "dispatching");
      f.emit([]);
      assert.equal(await f.broker.decide(selected), "uncertain");
      assert.deepEqual(f.sends, [scenario === "deny" ? "reject" : "once"]);
    } finally { await f.close(); }
  }
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

for (const scenario of ["command", "command_restored_before", "command_restored_pending", "command_applied", "command_denied", "generic_permission", "generic_permission_denied",
  "mcp_tool", "mcp_tool_denied", "file_change", "file_change_applied", "changed_file", "changed_presentation", "oversized_presentation"] as const) {
  test(`host approval reaches the real Codex adapter through an offline native server: ${scenario}`, { timeout: 10_000 }, () => verifyNativeApproval(scenario));
}

async function verifyNativeApproval(scenario: "command" | "command_restored_before" | "command_restored_pending" | "command_applied" | "command_denied" | "generic_permission" | "generic_permission_denied"
  | "mcp_tool" | "mcp_tool_denied" | "file_change" | "file_change_applied" | "changed_file" | "changed_presentation" | "oversized_presentation") {
  const f = await fixture(); f.broker.close();
  const isGeneric = scenario === "generic_permission" || scenario === "generic_permission_denied";
  const isMcp = scenario === "mcp_tool" || scenario === "mcp_tool_denied";
  const isFileChange = !isMcp && !scenario.startsWith("command") && !isGeneric;
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
    if (frame.method === "thread/resume") assert.deepEqual(frame.params,
      { threadId: "continuation", ...((frame.params as Record<string, unknown>).cwd ? { cwd: f.workspace } : {}) });
    const result = frame.method === "mcpServerStatus/list" ? { data: [{ name: "letagents" }] }
      : frame.method === "thread/resume" ? { thread: { id: "continuation" } }
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
    const restore = async () => {
      const repaired = await provider.repairContinuation(handle, { workAttemptId: "workspace",
        expectedProviderContinuationId: "continuation", cwd: f.workspace, launchPolicy: {} }, {
        checkpointReplacement: async () => assert.fail("restoring a conversation must not create a replacement"),
      });
      assert.equal(repaired.outcome, "rematerialized");
      assert.equal(repaired.handle, handle, "same-connection restoration preserves the installed handle and observers");
    };
    if (scenario === "command_restored_before") await restore();
    const pending = new Promise<void>(resolve => {
      const unsubscribe = rpc.onPendingRequestsChanged(() => { if (rpc.listPendingRequests().length) { unsubscribe(); resolve(); } });
    });
    server.clients.values().next().value!.send(JSON.stringify({ id: 71,
      method: isMcp ? "mcpServer/elicitation/request" : isFileChange ? "item/fileChange/requestApproval"
        : isGeneric ? "item/permissions/requestApproval" : "item/commandExecution/requestApproval",
      params: isMcp ? { threadId: "continuation", turnId: "native-turn", serverName: "letagents", mode: "form",
        message: 'Allow tool "get_board"?', requestedSchema: { type: "object", properties: {} },
        _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_params: { room_id: secret } } }
        : { threadId: "continuation", turnId: "native-turn", itemId: "item-1", startedAtMs: now,
        ...(isFileChange ? {} : isGeneric
          ? { cwd: f.workspace, permissions: { network: { enabled: true }, fileSystem: { read: [f.workspace] } } }
          : { command: `printf '${secret}'` }), reason: "failed systemError \u001b[31m\u202e is untrusted permission text" } }));
    await pending;
    if (scenario === "command_restored_pending") {
      const [before] = await broker.list("room");
      assert.equal(before?.status, "pending");
      await restore();
    }
    if (scenario === "command_applied") {
      server.clients.values().next().value!.send(JSON.stringify({ method: "item/started",
        params: { threadId: "continuation", turnId: "native-turn",
          item: { id: "item-1", type: "commandExecution", status: "inProgress", processId: "sandbox-attempt" } } }));
      await new Promise(resolve => setImmediate(resolve));
    }
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
    if (isMcp) {
      assert.equal(candidate.presentation.title, "Run a tool");
      assert.equal((await f.store.getExecutionApproval(candidate.reference))!.request.delegatable, false);
    }
    if (isGeneric) {
      assert.equal(candidate.presentation.title, "Grant for this turn");
      assert.match(candidate.presentation.details, /\\u001b/); assert.match(candidate.presentation.details, /\\u202e/);
      assert.doesNotMatch(candidate.presentation.details, /[\u001b\u202e]/);
      const stored = await f.store.getExecutionApproval(candidate.reference);
      assert.equal(stored!.request.kind, "network"); assert.equal(stored!.request.risk, "high");
      assert.equal(stored!.request.delegatable, false);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM execution_approval_projections").get()!.n, 0);
    }
    if (isFileChange) {
      assert.equal(candidate.presentation.title, "Change files");
      assert.deepEqual(JSON.parse(candidate.presentation.details).changes, changes);
      assert.equal(candidate.reference.requestSha256, hash({ request: rpc.listPendingRequests()[0], changes }));
    }
    selected = decision(candidate, scenario.endsWith("denied") ? { decision: "deny" } : {});
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
      const nativeDecision = scenario.endsWith("denied");
      assert.deepEqual(await responseFrame, { id: 71, result: isMcp
        ? { action: nativeDecision ? "decline" : "accept", content: nativeDecision ? null : {}, _meta: null }
        : isGeneric
        ? nativeDecision
          ? { permissions: {}, scope: "turn" }
          : { permissions: { network: { enabled: true }, fileSystem: { read: [f.workspace] } }, scope: "turn", strictAutoReview: true }
        : { decision: nativeDecision ? "decline" : "accept" } });
      assert.deepEqual(order, ["decision_committed", ...(isFileChange ? ["post_intent_inspection"] : []), "intent_committed", "native_write"]);
    }
    assert.equal((await f.store.getExecutionApproval(selected.expected))!.decision!.dispatchState, "uncertain");
    if (isMcp || isGeneric || scenario === "command_applied") {
      const socket = server.clients.values().next().value!;
      for (const params of [{ requestId: "71", threadId: "continuation" }, { requestId: 71, threadId: "other" }]) {
        socket.send(JSON.stringify({ method: "serverRequest/resolved", params }));
      }
      await new Promise(resolve => setImmediate(resolve));
      assert.equal((await f.store.getExecutionApproval(selected.expected))!.request.closedAtMs, null);
      socket.send(JSON.stringify({ method: "serverRequest/resolved", params: { requestId: 71, threadId: "continuation" } }));
      for (let attempt = 0; attempt < 20; attempt++) {
        if ((await f.store.getExecutionApproval(selected.expected))!.request.closedAtMs != null) break;
        await new Promise(resolve => setImmediate(resolve));
      }
      const closed = (await f.store.getExecutionApproval(selected.expected))!;
      assert.equal(closed.request.closedAtMs, now + 10);
      assert.equal(closed.decision!.dispatchState, "uncertain", "native closure does not identify the applied response");
      assert.equal(closed.decision!.resolvedAtMs, null);
      assert.deepEqual(await broker.list("room"), [], "a closed prompt is no longer actionable");
      assert.equal(await broker.decide(selected), "request_closed", "retry does not repeat the native response");
    }
    if (scenario === "command_applied") {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal((await f.store.getExecutionApproval(selected.expected))!.decision!.dispatchState, "uncertain",
        "same-item evidence observed before the native response cannot acknowledge a later decision");
      const socket = server.clients.values().next().value!;
      socket.send(JSON.stringify({ method: "item/completed", params: { threadId: "continuation", turnId: "native-turn",
        item: { id: "item-1", type: "fileChange", status: "completed" } } }));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal((await f.store.getExecutionApproval(selected.expected))!.decision!.dispatchState, "uncertain",
        "a same-key operation of another kind cannot acknowledge the decision");
      socket.send(JSON.stringify({ method: "item/started", params: { threadId: "continuation", turnId: "native-turn",
        item: { id: "unrelated-item", type: "commandExecution", status: "inProgress", processId: "native-process-other" } } }));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal((await f.store.getExecutionApproval(selected.expected))!.decision!.dispatchState, "uncertain",
        "an unrelated native execution cannot acknowledge the decision");
      socket.send(JSON.stringify({ method: "item/started", params: { threadId: "continuation", turnId: "native-turn",
        item: { id: "item-1", type: "commandExecution", status: "inProgress", processId: "native-process-1" } } }));
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((await f.store.getExecutionApproval(selected.expected))!.request.state === "resolved") break;
        await new Promise(resolve => setImmediate(resolve));
      }
      const resolved = (await f.store.getExecutionApproval(selected.expected))!;
      assert.equal(resolved.request.state, "resolved");
      assert.equal(resolved.decision!.dispatchState, "acknowledged");
      assert.deepEqual(await broker.list("room"), [], "native application removes the approval from the live host tray");
    } else if (scenario === "command_denied") {
      server.clients.values().next().value!.send(JSON.stringify({ method: "item/completed",
        params: { threadId: "continuation", turnId: "native-turn",
          item: { id: "item-1", type: "commandExecution", status: "declined" } } }));
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((await f.store.getExecutionApproval(selected.expected))!.request.state === "resolved") break;
        await new Promise(resolve => setImmediate(resolve));
      }
      const resolved = (await f.store.getExecutionApproval(selected.expected))!;
      assert.equal(resolved.request.state, "resolved");
      assert.equal(resolved.decision!.dispatchState, "acknowledged");
    } else if (scenario === "file_change_applied") {
      server.clients.values().next().value!.send(JSON.stringify({ method: "item/completed",
        params: { threadId: "continuation", turnId: "native-turn",
          item: { id: "item-1", type: "fileChange", status: "completed" } } }));
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((await f.store.getExecutionApproval(selected.expected))!.request.state === "resolved") break;
        await new Promise(resolve => setImmediate(resolve));
      }
      const resolved = (await f.store.getExecutionApproval(selected.expected))!;
      assert.equal(resolved.request.state, "resolved");
      assert.equal(resolved.decision!.dispatchState, "acknowledged");
    }
    if (!scenario.endsWith("applied") && scenario !== "command_denied" && !isMcp && !isGeneric) assert.equal(await broker.decide(selected), "uncertain");
    assert.equal(frames.filter(frame => frame.id === 71 && !frame.method).length, scenario === "changed_file" ? 0 : 1);
    assert.equal(frames.some(frame => ["thread/start", "turn/start", "turn/interrupt"].includes(String(frame.method))), false);
    assert.equal(handle.observedState, "working");
    if (scenario === "command_applied") {
      assert.equal(facts.length, lifecycleFacts.length + 4,
        "only the four native operation starts add execution evidence");
    } else if (scenario === "command_denied") {
      assert.equal(facts.length, lifecycleFacts.length + 1, "the exact denial adds one terminal execution fact");
    } else if (scenario === "file_change_applied") {
      assert.equal(facts.length, lifecycleFacts.length + 1, "the exact file-change completion adds one terminal execution fact");
    } else {
      assert.deepEqual(facts, lifecycleFacts,
        "approval payloads and decisions never add to the reconstructed execution evidence");
    }
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

async function savedRuleFixture(provider: "codex" | "claude-code" | "open-model" = "claude-code") {
  return fixture(provider, { hostActorId: () => "host-owner" });
}
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let n = 0; n < 200; n++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Expected approval transition was not observed");
}
function nextPermission(native: ProviderPermissionRequest, id: string): ProviderPermissionRequest {
  const next = structuredClone(native);
  (next.native as { id: string | number }).id = id;
  if (next.provider === "claude-code") next.native.request.tool_use_id = id;
  return next;
}

for (const provider of ["codex", "claude-code", "open-model"] as const) {
  test(`Always allow persists and responds to a later ${provider} tool request with no composer read`, async () => {
    const f = await savedRuleFixture(provider);
    try {
      const [candidate] = await f.broker.list("room");
      assert.ok(candidate!.presentation.alwaysAllow);
      await f.broker.decide({ ...decision(candidate!), decision: "allow_always" });
      const rules = await f.broker.listToolRules({ agentId: "agent" });
      assert.equal(rules.length, 1);
      assert.equal(rules[0]!.scope.agentId, "agent");
      f.reinstall();
      const next = nextPermission(f.native, "next-request");
      if (next.provider === "claude-code") next.native.request.input = { content: "Different arguments" };
      f.emit([next]);
      await until(() => f.sends.length === 2);
      assert.deepEqual(f.sends, ["once", "once"]);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM host_tool_rule_decisions").get()!.n, 2);
      await f.broker.revokeToolRule({ agentId: "agent", ruleId: rules[0]!.id, revision: rules[0]!.revision });
      f.emit([nextPermission(f.native, "after-revoke")]);
      const [manual] = await f.broker.list("room");
      assert.equal(manual!.status, "pending");
      await f.broker.decide({ ...decision(manual!), decisionId: "manual-after-revoke", decision: "deny" });
      assert.deepEqual(f.sends, ["once", "once", "reject"]);
    } finally { await f.close(); }
  });
}

for (const stage of ["before-intent", "before-write", "after-write"] as const) {
  test(`revocation ${stage} preserves either a usable prompt or sent uncertainty`, async () => {
    const f = await savedRuleFixture();
    try {
      const [candidate] = await f.broker.list("room");
      const selected = { ...decision(candidate!), decision: "allow_always" };
      const revoke = async () => {
        const [rule] = await f.broker.listToolRules({ agentId: "agent" });
        assert.ok(rule);
        await f.broker.revokeToolRule({ agentId: "agent", ruleId: rule.id, revision: rule.revision });
      };
      if (stage === "before-intent") f.state.beforeBefore = revoke;
      if (stage === "before-write") f.state.afterBefore = revoke;
      if (stage === "after-write") { f.state.afterNativeWrite = revoke; f.state.failAfter = true; }
      const result = await f.broker.decide(selected);
      f.state.beforeBefore = null; f.state.afterBefore = null; f.state.afterNativeWrite = null; f.state.failAfter = false;
      if (stage === "after-write") {
        assert.equal(result, "uncertain");
        assert.deepEqual(f.sends, ["once"]);
        assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM host_tool_rule_withdrawals").get()!.n, 0);
        f.reinstall();
        assert.equal((await f.broker.list("room"))[0]!.status, "uncertain");
        return;
      }
      assert.equal(result, "unavailable");
      assert.deepEqual(f.sends, []);
      f.reinstall();
      const [replacement] = await f.broker.list("room");
      assert.equal(replacement!.status, "pending");
      assert.equal(replacement!.reference!.requestVersion, candidate!.reference!.requestVersion + 1);
      await assert.rejects(f.broker.decide(selected), /changed|recorded|unavailable/i);
      await f.broker.decide({ ...decision(replacement!), decisionId: "manual-replacement", decision: "deny" });
      assert.deepEqual(f.sends, ["reject"]);
      const old = f.db.prepare("SELECT dispatch_state,application_certainty FROM execution_approval_decisions WHERE decision_id='decision'").get()!;
      assert.equal(old.dispatch_state, "lost"); assert.equal(old.application_certainty, "impossible");
    } finally { await f.close(); }
  });
}

test("saved permissions do not infer a Codex MCP tool from prose or silently follow another source project", async () => {
  const f = await savedRuleFixture("codex");
  try {
    const unknown = nextPermission(f.native, "unknown") as Extract<ProviderPermissionRequest, { provider: "codex" }>;
    unknown.native = { ...unknown.native, method: "mcpServer/elicitation/request", params: { serverName: "letagents", message: "Run Bash" } };
    f.emit([unknown]);
    assert.equal((await f.broker.list("room"))[0]!.presentation.alwaysAllow, undefined);
    f.emit();
    execFileSync("git", ["-C", f.workspace, "remote", "set-url", "origin", "another-project"]);
    assert.equal((await f.broker.list("room"))[0]!.presentation.alwaysAllow, undefined);
  } finally { await f.close(); }
});

test("identical active tool scopes share one revocable rule and cannot be revived by a creation replay", async () => {
  const f = await savedRuleFixture();
  try {
    f.emit([f.native, nextPermission(f.native, "second-create")]);
    const candidates = await f.broker.list("room");
    assert.equal(candidates.length, 2);
    f.broker.close(); // Test the two already-admitted selections without automatic matching races.
    const select = (candidate: HostApprovalCandidate, decisionId: string) => f.store.selectHostToolApproval({
      ...decision(candidate), decisionId, decision: "allow_once",
      authority: { inboxItemId: f.item.inbox_item_id, workAttemptId: "workspace", executionGenerationId: "generation",
        provider: "claude-code", providerConnection: f.handle.providerConnection as any, configurationRevision: 1 }, atMs: now + 10,
    }, { scope: candidate.presentation.alwaysAllow!, create: true }, async commit => commit());
    await select(candidates[0]!, "first-create");
    await select(candidates[1]!, "second-create");
    const rules = await f.broker.listToolRules({ agentId: "agent" });
    assert.equal(rules.length, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM host_tool_rule_decisions").get()!.n, 2);
    await f.broker.revokeToolRule({ agentId: "agent", ruleId: rules[0]!.id, revision: rules[0]!.revision });
    await assert.rejects(select(candidates[0]!, "first-create"), /revoked/);
    await assert.rejects(select(candidates[1]!, "second-create"), /revoked/);
    assert.equal((await f.broker.listToolRules({ agentId: "agent" })).length, 0);
  } finally { await f.close(); }
});

test("saved tool rules reject a different tool and ownership mutations without a fence", async () => {
  const f = await savedRuleFixture();
  try {
    const [candidate] = await f.broker.list("room");
    await f.broker.decide({ ...decision(candidate!), decision: "allow_always" });
    const other = nextPermission(f.native, "other-tool") as Extract<ProviderPermissionRequest, { provider: "claude-code" }>;
    other.native.request.tool_name = "Bash";
    f.emit([other]);
    const [manual] = await f.broker.list("room");
    assert.equal(manual!.status, "pending");
    assert.deepEqual(f.sends, ["once"]);
    const [rule] = await f.broker.listToolRules({ agentId: "agent" });
    await assert.rejects(f.store.revokeHostToolRule("host-owner", "agent", rule!.id, rule!.revision, now + 10, undefined as never), /commit fence/);
    await assert.rejects(f.store.selectHostToolApproval({} as never, {} as never, undefined as never), /commit fence/);
    assert.equal((await f.broker.listToolRules({ agentId: "agent" })).length, 1);
    assert.deepEqual(await f.store.listHostToolRules("another-host", "agent"), []);
    assert.deepEqual(await f.store.listHostToolRules("host-owner", "another-agent"), []);
    assert.equal(await f.store.findHostToolRule("host-owner", { ...rule!.scope, projectId: "b".repeat(64) }), null);
    assert.equal(await f.store.findHostToolRule("host-owner", { ...rule!.scope, policySha256: "c".repeat(64) }), null);
  } finally { await f.close(); }
});

test("a permission snapshot during rule-runner completion is not dropped", async () => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  let injected = false;
  f = await fixture("claude-code", { hostActorId: () => "host-owner", onPermissionChanged: () => {
    if (f?.sends.length === 2 && !injected) {
      injected = true;
      queueMicrotask(() => f.emit([nextPermission(f.native, "during-finally")]));
    }
  } });
  try {
    const [candidate] = await f.broker.list("room");
    await f.broker.decide({ ...decision(candidate!), decision: "allow_always" });
    f.emit([nextPermission(f.native, "automatic-second")]);
    await until(() => f.sends.length === 3);
    assert.equal(injected, true);
    assert.deepEqual(f.sends, ["once", "once", "once"]);
  } finally { await f.close(); }
});

test("withdrawal evidence is exact and follows decision retention", async () => {
  const f = await savedRuleFixture();
  try {
    const [candidate] = await f.broker.list("room");
    f.state.afterBefore = async () => {
      const [rule] = await f.broker.listToolRules({ agentId: "agent" });
      await f.broker.revokeToolRule({ agentId: "agent", ruleId: rule!.id, revision: rule!.revision });
    };
    await f.broker.decide({ ...decision(candidate!), decision: "allow_always" });
    f.broker.close();
    f.db.prepare("UPDATE host_tool_rule_withdrawals SET request_sha256=?").run("a".repeat(64));
    await assert.rejects(f.store.readLatestExecutionApproval(candidate!.reference!.requestId), /evidence is invalid/);
    f.db.prepare("UPDATE host_tool_rule_withdrawals SET request_sha256=?").run(candidate!.reference!.requestSha256);
    assert.equal((await f.store.readLatestExecutionApproval(candidate!.reference!.requestId))!.decision!.withdrawnBeforeSend, true);
    f.db.exec("DELETE FROM execution_approval_decisions");
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM host_tool_rule_withdrawals").get()!.n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM host_tool_rule_decisions").get()!.n, 0);
  } finally { await f.close(); }
});

for (const hadIntent of [false, true]) {
  test(`restart after a revoked unsent decision ${hadIntent ? 'preserves an uncertain dispatch intent' : 'restores the pending prompt without an intent'}`, async () => {
    const f = await savedRuleFixture();
    try {
      const [candidate] = await f.broker.list("room");
      if (hadIntent) f.state.afterBefore = () => { throw new Error("Interrupted before final write"); };
      else f.state.failBefore = true;
      const choosing = f.broker.decide({ ...decision(candidate!), decision: "allow_always" });
      if (hadIntent) assert.equal(await choosing, "uncertain");
      else await assert.rejects(choosing, /recorded but could not be sent/);
      f.state.failBefore = false; f.state.afterBefore = null;
      const [rule] = await f.broker.listToolRules({ agentId: "agent" });
      await f.broker.revokeToolRule({ agentId: "agent", ruleId: rule!.id, revision: rule!.revision });
      f.reinstall();
      const [replacement] = await f.broker.list("room");
      assert.deepEqual(f.sends, []);
      if (hadIntent) {
        assert.equal(replacement!.status, "uncertain");
        assert.equal(replacement!.reference!.requestVersion, 1);
        assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM host_tool_rule_withdrawals").get()!.n, 0);
      } else {
        assert.equal(replacement!.status, "pending");
        assert.equal(replacement!.reference!.requestVersion, 2);
        await f.broker.decide({ ...decision(replacement!), decisionId: "restart-manual", decision: "deny" });
        assert.deepEqual(f.sends, ["reject"]);
      }
    } finally { await f.close(); }
  });
}

test("revoking an automatically matched rule returns that exact native prompt to manual review", async () => {
  const f = await savedRuleFixture();
  try {
    const [candidate] = await f.broker.list("room");
    await f.broker.decide({ ...decision(candidate!), decision: "allow_always" });
    const [rule] = await f.broker.listToolRules({ agentId: "agent" });
    f.state.afterBefore = () => f.broker.revokeToolRule({ agentId: "agent", ruleId: rule!.id, revision: rule!.revision });
    const next = nextPermission(f.native, "revoked-auto");
    f.emit([next]);
    await until(() => Number(f.db.prepare("SELECT COUNT(*) AS n FROM host_tool_rule_withdrawals").get()!.n) === 1);
    f.state.afterBefore = null;
    const [manual] = await f.broker.list("room");
    assert.equal(manual!.status, "pending");
    assert.equal(manual!.reference!.nativeRequestId, "revoked-auto");
    assert.deepEqual(f.sends, ["once"]);
    await f.broker.decide({ ...decision(manual!), decisionId: "manual-after-auto", decision: "deny" });
    assert.deepEqual(f.sends, ["once", "reject"]);
  } finally { await f.close(); }
});

test("a saved command rule never covers Codex requests for extra access, stdin, or another environment", async () => {
  const f = await savedRuleFixture("codex");
  try {
    const [candidate] = await f.broker.list("room");
    await f.broker.decide({ ...decision(candidate!), decision: "allow_always" });
    for (const extra of [{ additionalPermissions: { network: { enabled: true } } },
      { additionalPermissions: { fileSystem: { write: ["/private"] } } },
      { networkApprovalContext: { host: "example.com" } }, { kind: "writeStdin" }, { environmentId: "remote-machine" }]) {
      const next = nextPermission(f.native, `extra-${Object.keys(extra)[0]}-${JSON.stringify(extra).length}`) as Extract<ProviderPermissionRequest, { provider: "codex" }>;
      next.native = { ...next.native, params: { ...(next.native.params as object), ...extra } };
      f.emit([next]);
      const [manual] = await f.broker.list("room");
      assert.equal(manual!.status, "pending");
      assert.equal(manual!.presentation.alwaysAllow, undefined);
      assert.deepEqual(f.sends, ["once"]);
    }
  } finally { await f.close(); }
});

async function waitForClosure(f: Awaited<ReturnType<typeof fixture>>, expected: HostApprovalReference) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const record = (await f.store.getExecutionApproval(expected))!;
    if (record.request.closedAtMs != null) return record;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail("exact closure was not persisted");
}

for (const phase of ["before_selection", "before_dispatch", "after_dispatch", "during_dispatch"] as const) {
  test(`Claude request closure at ${phase} is durable without claiming application`, async () => {
    const f = await fixture("claude-code");
    try {
      const [candidate] = await f.broker.list("room"); const selected = decision(candidate!);
      if (phase === "before_dispatch") f.state.beforeBefore = async () => {
        f.closed(); await waitForClosure(f, selected.expected);
      };
      else if (phase === "during_dispatch") f.state.afterNativeWrite = async () => {
        f.closed(); f.emit([]); await waitForClosure(f, selected.expected);
      };
      if (phase !== "before_selection") await f.broker.decide(selected);
      if (phase === "before_selection" || phase === "after_dispatch") { f.closed(); f.emit([]); }
      const record = await waitForClosure(f, selected.expected);
      assert.notEqual(record.decision?.dispatchState, "acknowledged");
      assert.equal(record.decision?.resolvedAtMs ?? null, null);
      assert.equal(await f.broker.decide(selected), "request_closed");
      assert.equal(f.sends.length, phase === "before_selection" || phase === "before_dispatch" ? 0 : 1);
      assert.deepEqual(await f.broker.list("room"), []);
      const reopened = new ManifestStore(f.path);
      try { assert.equal((await reopened.getExecutionApproval(selected.expected))!.request.closedAtMs, record.request.closedAtMs); }
      finally { await reopened.close(); }
    } finally { await f.close(); }
  });
}

test("Claude native closure can arrive while request admission returns", async () => {
  const f = await fixture("claude-code");
  try {
    const original = f.store.admitExecutionApprovalPlan.bind(f.store);
    f.store.admitExecutionApprovalPlan = async (...args) => {
      const admitted = await original(...args);
      f.closed(); f.emit([]);
      return admitted;
    };
    await f.broker.list("room");
    const [record] = await f.store.listExecutionApprovals("room");
    assert.ok(record);
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await f.store.readLatestExecutionApproval(record.request.requestId))!.request.closedAtMs != null) break;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.notEqual((await f.store.readLatestExecutionApproval(record.request.requestId))!.request.closedAtMs, null);
    assert.deepEqual(await f.broker.list("room"), []);
  } finally { await f.close(); }
});

test("Claude closure does not discard later exact success evidence", async () => {
  const f = await fixture("claude-code");
  try {
    const [candidate] = await f.broker.list("room"); const selected = decision(candidate!);
    f.state.afterNativeWrite = () => {
      f.closed(); f.emit([]);
      f.execution({ domain: "execution", kind: "completed", operation: "file_change",
        providerContinuationId: "continuation", providerTurnId: "native-turn", executionId: "tool",
        outcome: "succeeded", sideEffects: "possible" });
    };
    await f.broker.decide(selected);
    await waitForClosure(f, selected.expected);
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await f.store.getExecutionApproval(selected.expected))!.decision!.dispatchState === "acknowledged") break;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal((await f.store.getExecutionApproval(selected.expected))!.decision!.dispatchState, "acknowledged");
    assert.equal(f.sends.length, 1);
  } finally { await f.close(); }
});


test("v44 migration preserves Codex closure receipts and refuses a damaged v45 schema", async () => {
  const f = await fixture();
  try {
    const [candidate] = await f.broker.list("room"); const selected = decision(candidate!);
    await f.broker.decide(selected); f.closed();
    await waitForClosure(f, selected.expected);
    const before = f.db.prepare("SELECT * FROM execution_approval_request_closures").all();
    await f.store.close();
    const sql = String(f.db.prepare("SELECT sql FROM sqlite_master WHERE name='execution_approval_request_closures'").get()!.sql)
      .replace("decision_id TEXT REFERENCES", "decision_id TEXT NOT NULL REFERENCES")
      .replace("dispatch_id TEXT,", "dispatch_id TEXT NOT NULL,");
    f.db.exec(`CREATE TEMP TABLE saved_closures AS SELECT * FROM execution_approval_request_closures;
      DROP TABLE execution_approval_request_closures; ${sql};
      INSERT INTO execution_approval_request_closures SELECT * FROM saved_closures; DROP TABLE saved_closures;
      PRAGMA user_version=44; UPDATE manifest_metadata SET schema_version=44`);
    const upgraded = new ManifestStore(f.path);
    try {
      assert.equal((await upgraded.getExecutionApproval(selected.expected))!.request.closedAtMs, now + 10);
      assert.deepEqual(f.db.prepare("SELECT * FROM execution_approval_request_closures").all(), before);
      assert.equal(f.db.prepare("PRAGMA user_version").get()!.user_version, 45);
      assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { await upgraded.close(); }
    // A current database must not silently recreate even the old valid schema.
    f.db.exec(`DROP TABLE execution_approval_request_closures; ${sql}`);
    const damaged = new ManifestStore(f.path);
    try { await assert.rejects(damaged.load(), /closure storage is missing or invalid/); }
    finally { await damaged.close(); }
  } finally { await f.close(); }
});

for (const wrong of ["turn", "tool", "retired", "missing_snapshot"] as const) {
  test(`Claude ${wrong} evidence cannot close an admitted request`, async () => {
    const f = await fixture("claude-code");
    try {
      const [candidate] = await f.broker.list("room");
      if (wrong === "turn") f.state.turnId = "wrong-turn";
      if (wrong === "retired") f.state.current = false;
      if (wrong === "missing_snapshot") { f.emit([]); f.observationFailure("degraded"); }
      else {
        const native = structuredClone(f.native);
        if (wrong === "tool" && native.provider === "claude-code") native.native.request.tool_use_id = "wrong-tool";
        f.closed(native);
      }
      await new Promise(resolve => setImmediate(resolve));
      assert.equal((await f.store.getExecutionApproval(candidate!.reference!))!.request.closedAtMs, null);
    } finally { await f.close(); }
  });
}

for (const provider of ["claude-code", "codex"] as const) {
  for (const phase of ["requested", "selected", "dispatched"] as const) {
    test(`${provider} witnessed process death closes ${phase} approval without acknowledging or replaying`, async () => {
      const f = await fixture(provider);
      try {
        const [candidate] = await f.broker.list("room"); const selected = decision(candidate!);
        if (phase === "selected") f.state.failBefore = true;
        if (phase === "selected") await assert.rejects(f.broker.decide(selected), /recorded but could not be sent/);
        else if (phase === "dispatched") await f.broker.decide(selected);
        const before = (await f.store.getExecutionApproval(selected.expected))!;
        // This fixture never installs optional execution capture. Its operational
        // origin generation remains valid after recovery into a later generation.
        f.db.prepare("INSERT INTO work_attempt_executions VALUES('recovery-generation','workspace',?,'provider',2,?)")
          .run(new Date(now + 15).toISOString(), JSON.stringify({ ended_at: new Date(now + 20).toISOString(),
            provider_continuation_id: "continuation", native_runtime_death: {
              kind: provider === "codex" ? "codex_app_server" : "claude_cli", pid: 4311, processIdentity: "native-birth" } }));
        const reopened = new ManifestStore(f.path);
        try {
          await assert.rejects(reopened.settleWitnessedRuntimeApprovalClosures("agent", () => now + 30,
            async () => { throw new Error("ownership changed"); }), /ownership changed/);
          assert.equal((await reopened.getExecutionApproval(selected.expected))!.request.closedAtMs, null);
          assert.equal(await reopened.settleWitnessedRuntimeApprovalClosures("agent", () => now + 30, async commit => commit()), 1);
          const closed = (await reopened.getExecutionApproval(selected.expected))!;
          assert.deepEqual(closed, { ...before, request: { ...before.request, closedAtMs: now + 30 } });
          assert.equal(await reopened.settleWitnessedRuntimeApprovalClosures("agent", () => now + 40,
            async () => { throw new Error("no empty write expected"); }), 0);
          if (phase === "dispatched") {
            await reopened.recordExecutionApprovalOutcome({ expected: selected.expected,
              decisionId: closed.decision!.decisionId, dispatchId: closed.decision!.dispatchId!,
              evidence: "exact_native_execution", atMs: now + 40 }, async commit => commit());
            assert.equal((await reopened.getExecutionApproval(selected.expected))!.decision!.dispatchState, "acknowledged",
              "late exact execution evidence still counts; closure alone did not count");
          }
        } finally { await reopened.close(); }
        assert.equal(await f.broker.decide(selected), phase === "dispatched" ? "resolved" : "request_closed");
        assert.equal(f.sends.length, phase === "dispatched" ? 1 : 0);
      } finally { await f.close(); }
    });
  }
}

test("terminal cleanup refuses unmarked, foreign-continuation, wrong-birth and successor evidence", async () => {
  const f = await fixture("codex");
  try {
    const [candidate] = await f.broker.list("room");
    const expected = decision(candidate!).expected;
    const terminal = { ended_at: new Date(now + 20).toISOString(), provider_continuation_id: "continuation",
      native_runtime_death: { kind: "codex_app_server", pid: 4311, processIdentity: "native-birth" } };
    for (const evidence of [
      { ...terminal, native_runtime_death: undefined },
      { ...terminal, provider_continuation_id: "successor-continuation" },
      { ...terminal, native_runtime_death: { ...terminal.native_runtime_death, processIdentity: "successor-birth" } },
      { ...terminal, native_runtime_death: { ...terminal.native_runtime_death, pid: 9000 } },
      { ...terminal, native_runtime_death: { ...terminal.native_runtime_death, kind: "claude_cli" } },
    ]) {
      f.db.prepare("UPDATE work_attempt_executions SET terminal_json=? WHERE execution_generation_id='generation'").run(JSON.stringify(evidence));
      assert.equal(await f.store.settleWitnessedRuntimeApprovalClosures("agent", () => now + 30, async commit => commit()), 0);
      assert.equal((await f.store.getExecutionApproval(expected))!.request.closedAtMs, null);
    }
  } finally { await f.close(); }
});

test("runtime cleanup covers more than the presentation limit and samples time inside the commit fence", async () => {
  const f = await fixture("claude-code");
  try {
    const requests = Array.from({ length: 70 }, (_, index) => ({ ...f.native,
      native: { ...f.native.native, id: `permission-${index}` } }) as ProviderPermissionRequest);
    for (const request of requests) { f.emit([request]); await f.broker.list("room"); }
    const count = Number(f.db.prepare("SELECT count(*) AS n FROM execution_approval_requests").get()!.n);
    assert.ok(count >= 70);
    f.db.prepare("UPDATE work_attempt_executions SET terminal_json=? WHERE execution_generation_id='generation'")
      .run(JSON.stringify({ ended_at: new Date(now + 20).toISOString(), provider_continuation_id: "continuation",
        native_runtime_death: { kind: "claude_cli", pid: 4311, processIdentity: "native-birth" } }));
    let clock = now;
    assert.equal(await f.store.settleWitnessedRuntimeApprovalClosures("agent", () => clock,
      async commit => { clock = now + 50; await commit(); }), count);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM execution_approval_request_closures WHERE observed_at_ms=?").get(now + 50)!.n, count);
  } finally { await f.close(); }
});
