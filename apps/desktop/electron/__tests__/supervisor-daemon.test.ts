import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import {
  SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION,
  SUPERVISOR_DAEMON_PROTOCOL_VERSION,
  type DaemonHandoffDiagnostic,
  type DaemonProcessIdentity,
  mapAgentInspectorDetail,
  mapEntry,
  SupervisorDaemonClient,
  onSupervisorActivity,
  publishSupervisorActivity,
  supervisorStateWatchRetryDelay,
  supervisorDaemonSpawnEnvironment,
  supervisorDaemonClient,
} from "../main/supervisor-daemon.js";
import {
  readDesktopSupervisorGrantForAgent,
  replaceDesktopSupervisorGrantForAgent,
  revokeDesktopSupervisorGrantForEntryWithoutWorkerSession,
} from "../main/supervisor-grant.js";
import { apiUrl as configuredApiUrl } from "../main/paths.js";

const daemonScriptPath = join(dirname(fileURLToPath(import.meta.url)), "../../daemon/main.ts");
const daemonTypesPath = join(dirname(fileURLToPath(import.meta.url)), "../../daemon/types.ts");
const desktopPackagePath = join(dirname(fileURLToPath(import.meta.url)), "../../package.json");
const daemonClientPath = join(dirname(fileURLToPath(import.meta.url)), "../main/supervisor-daemon.ts");

function wireEntryWithCausalProjection(): Parameters<typeof mapEntry>[0] {
  return {
    id: "agent_1", room_id: "room_1", display_name: "Aster", provider: "codex", model: null, charter: "help",
    desired_state: "running", observed_state: "working", condition: "none", permission_profile_id: null,
    created_by: "user", created_at: "2026-01-01T00:00:00.000Z",
    room_agent_state: {
      connection: { state: "connected", observed_at: "2026-01-01T00:00:00.000Z", detail: null },
      ingress: { state: "observing", observed_at: "2026-01-01T00:00:00.000Z", detail: null },
      inbox: { state: "blocked", pending_count: 2, blocked_by_message_id: "msg_1", detail: null },
      turn: { state: "idle", inbox_item_id: null, source_message_id: null, provider_turn_id: null, detail: null },
      task: { state: "none", task_id: null, title: null },
    },
    delivery_receipts: [{
      inbox_item_id: "inbox_1", source_message_id: "msg_1", state: "blocked", attempt_count: 3,
      canonical_message_id: "msg_reply_1",
      reply_client_message_id: "supervised-room:agent_1:msg_1:reply:v1",
      provider_turn_id: null, blocked_by_message_id: null, error: "failed", updated_at: "2026-01-01T00:00:00.000Z",
      timeline: [{ phase: "blocked", observed_at: "2026-01-01T00:00:00.000Z", detail: "failed" }],
    }],
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "letagents-electron-supervisor-"));
  return { root, socketPath: join(root, "daemon.sock"), cleanup: () => rm(root, { recursive: true, force: true }) };
}

function fakeChild(): ChildProcess {
  const child = { once() { return child; }, unref() { return child; } };
  return child as unknown as ChildProcess;
}

function fakeDaemonProcessIdentity(
  overrides: Partial<Omit<DaemonProcessIdentity, "expectedScriptPath">> = {},
): Omit<DaemonProcessIdentity, "expectedScriptPath"> {
  return {
    pid: 77,
    kernelStartTime: "Thu Jan  1 00:00:00 2026",
    command: `${process.execPath} ${daemonScriptPath}`,
    state: "live",
    ...overrides,
  };
}

test("daemon client maps an ordered full-state subscription snapshot", async () => {
  const env = await fixture();
  const wire = await startWireDaemon(
    env.socketPath,
    SUPERVISOR_DAEMON_PROTOCOL_VERSION,
    19,
  );
  wire.entries.push(wireEntryWithCausalProjection());
  try {
    const client = new SupervisorDaemonClient({
      socketPath: env.socketPath,
      daemonScriptPath,
    });
    const snapshot = await client.watchState({
      afterDaemonGeneration: 19,
      afterSequence: 6,
      waitMs: 10,
    });
    assert.equal(snapshot.daemonGeneration, 19);
    assert.equal(snapshot.sequence, 7);
    assert.equal(snapshot.entries[0]?.id, "agent_1");
    assert.equal(snapshot.entries[0]?.roomAgentState?.ingress.state, "observing");
    assert.deepEqual(wire.requests.at(-1), {
      method: "manifest.watch_state",
      params: {
        after_daemon_generation: 19,
        after_sequence: 6,
        wait_ms: 10,
      },
    });
  } finally {
    await closeServer(wire.server, env.socketPath);
    await env.cleanup();
  }
});

test("state subscriptions observe an existing daemon without spawning one", async () => {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  let spawnCount = 0;
  const client = new SupervisorDaemonClient({
    socketPath: env.socketPath,
    daemonScriptPath,
    spawnDaemon: () => {
      spawnCount += 1;
      return fakeChild();
    },
  });
  try {
    assert.equal(await client.connectIfRunning(), null);
    assert.equal(spawnCount, 0, "a state observer must not become the daemon lifecycle owner");

    const wire = await startWireDaemon(
      env.socketPath,
      SUPERVISOR_DAEMON_PROTOCOL_VERSION,
      23,
    );
    try {
      assert.equal((await client.connectIfRunning())?.generation, 23);
      assert.equal(spawnCount, 0);
    } finally {
      await closeServer(wire.server, env.socketPath);
    }
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
    else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous;
    await env.cleanup();
  }
});

test("state-watch retry delay backs off exponentially and remains bounded", () => {
  assert.equal(supervisorStateWatchRetryDelay(1), 1_000);
  assert.equal(supervisorStateWatchRetryDelay(2), 2_000);
  assert.equal(supervisorStateWatchRetryDelay(5), 16_000);
  assert.equal(supervisorStateWatchRetryDelay(6), 30_000);
  assert.equal(supervisorStateWatchRetryDelay(100), 30_000);
});

async function startWireDaemon(
  socketPath: string,
  version: number,
  generation: number,
  onPrepare?: () => void,
  implementationVersion = SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION,
  controlTurnDelayMs = 0,
  unresponsiveAfterPrepare = false,
  agentLifecycleCapability = true,
  manifestListDelayMs = 0,
) {
  const entries: Array<Record<string, any>> = [];
  const legacyOwners: Array<Record<string, any>> = [];
  const requests: Array<{ method: string; params: Record<string, any> | undefined }> = [];
  let handoffPrepared = false;
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as { id: string; method: string; params?: Record<string, any> };
      requests.push({ method: request.method, params: request.params });
      if (unresponsiveAfterPrepare && handoffPrepared && (request.method === "daemon.negotiate" || request.method === "daemon.status")) return;
      let result: unknown;
      let responseDelayMs = 0;
      if (request.method === "daemon.negotiate" || request.method === "daemon.status") {
        result = { healthy: true, protocol_version: version, implementation_version: implementationVersion, capabilities: { room_delivery_retry: true, agent_inspector_detail_v1: true, agent_inspector_settings_v1: true, agent_room_move_v1: true, agent_lifecycle_v1: agentLifecycleCapability, agent_runtime_recovery_v1: true, agent_state_subscription_v1: true }, generation, pid: 77, started_at: "2026-01-01T00:00:00.000Z" };
      } else if (request.method === "daemon.prepare_handoff") {
        result = { accepted: true };
        handoffPrepared = true;
        setTimeout(() => onPrepare?.(), 5);
      } else if (request.method === "manifest.list") {
        result = entries;
        responseDelayMs = manifestListDelayMs;
      } else if (request.method === "manifest.watch_state") {
        result = { daemon_generation: generation, sequence: 7, entries };
      } else if (request.method === "manifest.put") {
        const next = { ...request.params!.entry, workplace_liveness: { state: "unknown", observed_at: null, detail: null }, native_liveness: { state: "unknown", observed_at: null, detail: null }, activity: [] };
        const existing = entries.find((candidate) => candidate.id === next.id);
        if (!existing) entries.push(next);
        result = existing ?? next;
      } else if (request.method === "manifest.set_desired_state") {
        const entry = entries.find((candidate) => candidate.id === request.params!.id)!;
        entry.desired_state = request.params!.desired_state;
        result = entry;
      } else if (request.method === "manifest.compare_and_set_desired_state") {
        const entry = entries.find((candidate) => candidate.id === request.params!.id)!;
        const applied = entry.desired_state === request.params!.expected_desired_state;
        if (applied) entry.desired_state = request.params!.desired_state;
        result = { applied, entry };
      } else if (request.method === "supervisor.recover_agent_runtime") {
        const entry = entries.find((candidate) => candidate.id === request.params!.entry_id)!;
        entry.observed_state = "starting";
        entry.condition = "none";
        entry.provider_ref = null;
        result = { outcome: "recovering", entry };
      } else if (request.method === "manifest.control_turn") {
        responseDelayMs = controlTurnDelayMs;
        result = {
          entryId: request.params!.id,
          workAttemptId: request.params!.work_attempt_id,
          executionGenerationId: request.params!.execution_generation_id,
          actionId: request.params!.action_id,
          capability: "native_interrupt",
          interrupted: true,
          resumed: Boolean(request.params!.correction),
          state: request.params!.correction ? "working" : "idle",
          duplicate: false,
          stages: ["delivered", "interrupting", "applied", "resumed"],
        };
      } else if (request.method === "supervisor.get_agent_inspector_detail") {
        result = { availability: "not_loaded", entry_id: request.params!.entry_id, room_id: request.params!.room_id, requested_source_message_id: request.params!.source_message_id, inbox_item_id: null, source_message: null, receipt: null, terminal: null, publication: null, timeline: [], items: [], history_boundary: null };
      } else if (request.method === "supervisor.get_agent_configuration") {
        result = { entry_id: request.params!.entry_id, daemon_generation: request.params!.daemon_generation, provider: "codex", model: null, reasoning_effort: null, charter: "help", permission_profile_id: null, supervised_permission_profiles: [{ id: "full_access", label: "Full access", description: "Trusted local access.", status: "available", risk: "high", detail: null, isDefault: true }], provider_launch_policy: {}, config_revision: 1, runtime_configuration_revision: 1 };
      } else if (request.method === "supervisor.update_agent_configuration") {
        result = { outcome: "updated", configuration: { entry_id: request.params!.entry_id, daemon_generation: request.params!.daemon_generation, provider: "codex", model: request.params!.configuration?.model ?? null, reasoning_effort: request.params!.configuration?.reasoning_effort ?? null, charter: request.params!.configuration?.charter ?? "help", permission_profile_id: request.params!.configuration?.permission_profile_id ?? null, supervised_permission_profiles: [{ id: "full_access", label: "Full access", description: "Trusted local access.", status: "available", risk: "high", detail: null, isDefault: true }], provider_launch_policy: {}, config_revision: Number(request.params!.expected_revision) + 1, runtime_configuration_revision: 1 } };
      } else if (request.method === "supervisor.purge_agent") {
        result = request.params!.grant_revoked_without_worker_session === true || typeof request.params!.revoked_agent_session_id === "string"
          ? { outcome: "purged" }
          : request.params!.entry_id === "agent_grant_only"
            ? { outcome: "revocation_required", operation_id: "purge:agent_grant_only", revocation_kind: "grant_only" }
            : { outcome: "revocation_required", operation_id: `purge:${request.params!.entry_id}`, revocation_kind: "worker_session", agent_session_id: "session_exact" };
      } else if (request.method === "supervisor.get_current_room_move" && request.params!.entry_id === "agent_none") {
        result = null;
      } else if (["supervisor.prepare_room_move", "supervisor.commit_room_move", "supervisor.get_room_move", "supervisor.get_current_room_move", "supervisor.acknowledge_room_move_source_revocation", "supervisor.rollback_room_move"].includes(request.method)) {
        result = { operation_id: request.params!.operation_id ?? `inspector-room-move:${request.params!.entry_id}:${request.params!.request_id}`, request_id: request.params!.request_id ? `inspector:${request.params!.request_id}` : "inspector:request_1", agent_id: request.params!.entry_id, source_room_id: "room_1", destination_room_id: "room_2", daemon_generation: request.params!.daemon_generation, work_attempt_id: "attempt_1", execution_generation_id: "execution_1", agent_session_id: "session_1", phase: request.method === "supervisor.prepare_room_move" ? "prepared" : "bootstrapping_destination_tail", remote_room_id: request.method === "supervisor.prepare_room_move" ? null : "room_2", destination_cursor: null, source_credentials_revoked: request.method !== "supervisor.prepare_room_move", error: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:01.000Z" };
      } else if (request.method === "lane.reserve_legacy") {
        const owner = {
          reservation_id: request.params!.reservation_id,
          room_id: request.params!.room_id,
          provider: request.params!.provider,
          owner_pid: request.params!.owner_pid,
          owner_process_identity: request.params!.owner_process_identity,
          state: "reserved",
          session_id: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        };
        legacyOwners.push(owner);
        result = owner;
      } else if (request.method === "lane.activate_legacy") {
        const owner = legacyOwners.find((candidate) => candidate.reservation_id === request.params!.reservation_id)!;
        owner.state = "active";
        owner.session_id = request.params!.session_id;
        result = owner;
      } else if (request.method === "lane.release_legacy") {
        const index = legacyOwners.findIndex((candidate) =>
          candidate.reservation_id === request.params!.reservation_id
          || candidate.session_id === request.params!.session_id
          || (candidate.room_id === request.params!.room_id && candidate.provider === request.params!.provider));
        if (index >= 0) legacyOwners.splice(index, 1);
        result = { released: index >= 0 };
      } else if (request.method === "attempt.read") {
        const entry = entries.find((candidate) => candidate.id === request.params!.id)!;
        result = { entry_id: entry.id, work_attempt_id: null, workspace_path: entry.workspace_path, last_terminal: null, restart_count: 0, activity: entry.activity };
      } else if (request.method === "manifest.append_activity") {
        const entry = entries.find((candidate) => candidate.id === request.params!.id)!;
        entry.activity.push(request.params!.event);
        result = entry;
      } else if (request.method === "supervisor.retry_room_delivery") {
        result = { accepted: true };
      } else if (request.method === "supervisor.install_host_grant") {
        result = { status: "installed" };
      } else if (request.method === "supervisor.install_open_model_credential") {
        result = { status: "installed" };
      } else {
        socket.end(`${JSON.stringify({ version, id: request.id, ok: false, error: "unsupported" })}\n`);
        return;
      }
      const response = `${JSON.stringify({ version, id: request.id, ok: true, result })}\n`;
      if (responseDelayMs) setTimeout(() => socket.end(response), responseDelayMs);
      else socket.end(response);
    });
  });
  await mkdir(dirname(socketPath), { recursive: true });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  return { server, entries, requests };
}

async function closeServer(server: Server | null, socketPath: string): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await unlink(socketPath).catch(() => undefined);
}

async function runReleasedSocketHandoffScenario(input: {
  inspectAfterPrepare: (context: { signals: Array<"SIGTERM" | "SIGKILL">; inspection: number }) => Omit<DaemonProcessIdentity, "expectedScriptPath"> | null | undefined;
  implementationVersion?: string;
}) {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  let oldServer: Server | null = null;
  let replacementServer: Server | null = null;
  let prepared = false;
  let inspection = 0;
  const signals: Array<"SIGTERM" | "SIGKILL"> = [];
  const diagnostics: DaemonHandoffDiagnostic[] = [];
  const old = await startWireDaemon(
    env.socketPath,
    SUPERVISOR_DAEMON_PROTOCOL_VERSION,
    41,
    () => {
      void closeServer(oldServer, env.socketPath).then(() => { prepared = true; });
    },
    input.implementationVersion ?? "2.0.25",
  );
  oldServer = old.server;
  try {
    const client = new SupervisorDaemonClient({
      socketPath: env.socketPath,
      daemonScriptPath,
      handoffTimeoutMs: 50,
      terminateTimeoutMs: 0,
      killTimeoutMs: 0,
      processPollIntervalMs: 1,
      inspectDaemonProcess: () => {
        if (!prepared) return fakeDaemonProcessIdentity();
        inspection += 1;
        return input.inspectAfterPrepare({ signals, inspection });
      },
      signalDaemon: (pid, signal) => {
        assert.equal(pid, 77);
        assert.ok(pid > 0, "daemon handoff signals only the positive daemon PID");
        signals.push(signal);
      },
      reportHandoffDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      spawnDaemon: () => {
        void startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 42)
          .then((wire) => { replacementServer = wire.server; });
        return fakeChild();
      },
    });
    const status = await client.ensureRunning();
    return { status, signals, diagnostics };
  } finally {
    await closeServer(replacementServer, env.socketPath);
    await closeServer(oldServer, env.socketPath);
    if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous;
    await env.cleanup();
  }
}

test("local supervisor activity subscribers receive only the canonical redacted event", async () => {
  const canary = "canary-not-a-real-emitter-secret-123456789";
  const originalAppend = supervisorDaemonClient.appendActivity;
  let sentToDaemon: unknown;
  let emitted: unknown;
  (supervisorDaemonClient as unknown as { appendActivity: (id: string, event: unknown) => Promise<unknown> }).appendActivity = async (_id, event) => {
    sentToDaemon = event;
    return {};
  };
  const unsubscribe = onSupervisorActivity((event) => { emitted = event; });
  try {
    await publishSupervisorActivity({
      entryId: "credential_emitter",
      provider: `provider Authorization: Bearer ${canary}`,
      kind: `kind clientSecret=${canary}`,
      method: `method Authorization: Basic ${canary}`,
      summary: `${"x".repeat(470)} Authorization: Bearer ${canary}`,
      status: "working",
      payload: { output: JSON.stringify({ clientSecret: canary }) },
    });
    assert.doesNotMatch(JSON.stringify(sentToDaemon), new RegExp(canary));
    assert.doesNotMatch(JSON.stringify(emitted), new RegExp(canary));
    assert.match(JSON.stringify(emitted), /REDACTED/i);
    assert.match((emitted as { event: { summary: string } }).event.summary, /Authorization: Bearer \[REDACTED\]/);
  } finally {
    unsubscribe();
    (supervisorDaemonClient as unknown as { appendActivity: typeof originalAppend }).appendActivity = originalAppend;
  }
});

test("causal manifest projection accepts a fully valid room state and receipt timeline", () => {
  const projected = mapEntry(wireEntryWithCausalProjection());
  assert.equal(projected.roomAgentState?.connection.state, "connected");
  assert.equal(projected.roomAgentState?.inbox.pendingCount, 2);
  assert.deepEqual(projected.deliveryReceipts, [{
    inboxItemId: "inbox_1", sourceMessageId: "msg_1", state: "blocked", attemptCount: 3,
    canonicalMessageId: "msg_reply_1",
    replyClientMessageId: "supervised-room:agent_1:msg_1:reply:v1",
    providerTurnId: null, blockedByMessageId: null, error: "failed", failureCode: null, updatedAt: "2026-01-01T00:00:00.000Z",
    timeline: [{ phase: "blocked", observedAt: "2026-01-01T00:00:00.000Z", detail: "failed" }],
  }]);
});

test("causal manifest projection synthesizes ingress only for an older daemon that omitted the axis", () => {
  const legacy = wireEntryWithCausalProjection();
  delete (legacy.room_agent_state as Record<string, unknown>).ingress;
  const projected = mapEntry(legacy);
  assert.equal(projected.roomAgentState?.connection.state, "connected");
  assert.deepEqual(projected.roomAgentState?.ingress, {
    state: "observing",
    observedAt: "2026-01-01T00:00:00.000Z",
    detail: null,
  });
});

test("causal manifest projection drops malformed nested state and malformed receipt rows without coercion", () => {
  const malformed = wireEntryWithCausalProjection() as unknown as {
    room_agent_state: unknown; delivery_receipts: unknown;
  };
  malformed.room_agent_state = {
    connection: { state: "connected", observed_at: 7, detail: null },
    inbox: { state: "blocked", pending_count: -1, blocked_by_message_id: null, detail: null },
    turn: { state: "responding", inbox_item_id: null, source_message_id: null, provider_turn_id: null, detail: null },
    task: { state: "none", task_id: null, title: null },
  };
  malformed.delivery_receipts = [
    { inbox_item_id: "", source_message_id: "msg_1", canonical_message_id: null, state: "blocked", attempt_count: 1, provider_turn_id: null, blocked_by_message_id: null, error: null, updated_at: "now", timeline: [] },
    { inbox_item_id: "inbox_2", source_message_id: "msg_2", canonical_message_id: null, state: "blocked", attempt_count: Number.NaN, provider_turn_id: null, blocked_by_message_id: null, error: null, updated_at: "now", timeline: [] },
    { inbox_item_id: "inbox_3", source_message_id: "msg_3", canonical_message_id: null, state: "blocked", attempt_count: 1, provider_turn_id: null, blocked_by_message_id: null, error: null, updated_at: "now", timeline: [{ phase: "invented", observed_at: "now", detail: null }] },
    { inbox_item_id: "inbox_4", source_message_id: "msg_4", canonical_message_id: "", state: "acknowledged", attempt_count: 1, provider_turn_id: null, blocked_by_message_id: null, error: null, updated_at: "now", timeline: [] },
    null,
  ];
  const projected = mapEntry(malformed as unknown as Parameters<typeof mapEntry>[0]);
  assert.equal(projected.roomAgentState, null);
  assert.deepEqual(projected.deliveryReceipts, []);
});

test("agent inspector detail mapper validates every bounded wire section", () => {
  const input = { entryId: "agent_1", roomId: "room_1", sourceMessageId: "msg_1" };
  const wire = {
    availability: "available", entry_id: "agent_1", room_id: "room_1", requested_source_message_id: "msg_1", inbox_item_id: "inbox_1",
    source_message: { id: "msg_1", room_id: "room_1", sender: "Ada", text: "ship it", created_at: "2026-01-01T00:00:00.000Z", reply_to: null, thread_root_id: "msg_1", activation: { decision: "activate" } },
    receipt: { state: "acknowledged", attempt_count: 1, provider_turn_id: "turn_1", outcome: { kind: "reply", text: "done", evidence: "transcript" }, last_error: null, blocked_by_inbox_item_id: null, next_attempt_at_ms: null },
    terminal: { outcome: "reply", normalized_text: "done", evidence_source: "transcript", observed_at: "2026-01-01T00:00:01.000Z" },
    publication: { client_message_id: "client_1", canonical_message_id: "msg_2", room_id: "room_1" },
    timeline: [{ phase: "published", observed_at: "2026-01-01T00:00:02.000Z", detail: "msg_2" }],
    items: [{ source_message_id: "msg_1", inbox_item_id: "inbox_1", state: "acknowledged", attempt_count: 1, updated_at: "2026-01-01T00:00:02.000Z", sender: "Ada", text_preview: "ship it", created_at: "2026-01-01T00:00:00.000Z", outcome: { kind: "reply", text: "done" }, provider_turn_id: "turn_1", last_error: null, canonical_message_id: "msg_2" }],
    history_boundary: { earliest_retained_observed_message_id: "msg_1", earliest_retained_inbox_message_id: "msg_1", earliest_retained_receipt_sequence: 1, pruned_before_message_id: null, pruned_at: null },
  };
  const mapped = mapAgentInspectorDetail(wire, input);
  assert.equal(mapped.requested_source_message_id, "msg_1");
  assert.equal(mapped.items[0]?.sender, "Ada");
  assert.equal(mapped.timeline[0]?.observedAt, "2026-01-01T00:00:02.000Z");
  assert.throws(() => mapAgentInspectorDetail({ ...wire, room_id: "room_2" }, input), /invalid or unfenced/);
  assert.throws(() => mapAgentInspectorDetail({ ...wire, requested_source_message_id: "msg_other" }, input), /invalid or unfenced/);
  assert.throws(() => mapAgentInspectorDetail({ ...wire, source_message: { ...wire.source_message, id: "msg_other" } }, input), /invalid or unfenced/);
  assert.throws(() => mapAgentInspectorDetail(wire, { entryId: "agent_1", roomId: "room_1", sourceMessageId: null }), /invalid or unfenced/);
  assert.doesNotThrow(() => mapAgentInspectorDetail({ ...wire, availability: "not_loaded", requested_source_message_id: null, inbox_item_id: null, source_message: null, receipt: null, terminal: null, publication: null, timeline: [] }, { entryId: "agent_1", roomId: "room_1", sourceMessageId: null }));
  assert.throws(() => mapAgentInspectorDetail({ ...wire, items: [{ ...wire.items[0], state: "invented" }] }, input), /invalid or unfenced/);
  assert.throws(() => mapAgentInspectorDetail({ ...wire, timeline: Array.from({ length: 101 }, () => wire.timeline[0]) }, input), /invalid or unfenced/);
  assert.throws(() => mapAgentInspectorDetail({ ...wire, history_boundary: { ...wire.history_boundary, earliest_retained_receipt_sequence: -1 } }, input), /invalid or unfenced/);
});

test("agent inspector detail is capability-negotiated and preserves its optional exact-source fence", async () => {
  const env = await fixture(); const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  const wire = await startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 36);
  try {
    const client = new SupervisorDaemonClient({ socketPath: env.socketPath, daemonScriptPath, spawnDaemon: () => { throw new Error("healthy daemon must be reused"); } });
    const detail = await client.getAgentInspectorDetail({ entryId: "agent_1", roomId: "room_1", sourceMessageId: null });
    assert.equal(detail.availability, "not_loaded");
    assert.deepEqual(wire.requests.find((request) => request.method === "supervisor.get_agent_inspector_detail")?.params, { entry_id: "agent_1", room_id: "room_1", source_message_id: null });
    await assert.rejects(() => client.getAgentInspectorDetail({ entryId: "", roomId: "room_1" }), /exact non-empty/);
  } finally { await closeServer(wire.server, env.socketPath); if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous; await env.cleanup(); }
});

test("Inspector settings and room-move RPCs preserve strict typed coordinates", async () => {
  const env = await fixture(); const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  const wire = await startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 39);
  try {
    const client = new SupervisorDaemonClient({ socketPath: env.socketPath, daemonScriptPath, spawnDaemon: () => { throw new Error("healthy daemon must be reused"); } });
    const configuration = await client.getAgentConfiguration("agent_1", 39);
    assert.equal(configuration.configRevision, 1);
    assert.equal(configuration.supervisedPermissionProfiles[0]?.id, "full_access");
    assert.equal(configuration.supervisedPermissionProfiles[0]?.status, "available");
    await client.updateAgentConfiguration({
      entryId: "agent_1", daemonGeneration: 39, expectedRevision: 1,
      // Cast deliberately simulates a compromised renderer attempting to
      // submit native flags through the public bridge.
      configuration: { model: null, reasoningEffort: null, charter: "help", permissionProfileId: "full_access", providerLaunchPolicy: { sandboxPolicy: "weakened" } } as never,
    });
    const prepared = await client.prepareRoomMove({ entryId: "agent_1", destinationRoomId: "room_2", requestId: "request_1", daemonGeneration: 39 });
    assert.equal(prepared.phase, "prepared");
    const committed = await client.commitRoomMove({ operationId: prepared.operationId, entryId: "agent_1", daemonGeneration: 39 });
    assert.equal(committed.phase, "bootstrapping_destination_tail");
    const acknowledged = await client.acknowledgeRoomMoveSourceRevocation({ operationId: prepared.operationId, entryId: "agent_1", daemonGeneration: 39, sourceAgentSessionId: "session_1" });
    assert.equal(acknowledged.sourceCredentialsRevoked, true);
    const current = await client.getCurrentRoomMove({ entryId: "agent_1", daemonGeneration: 39 });
    assert.equal(current?.entryId, "agent_1");
    assert.equal(await client.getCurrentRoomMove({ entryId: "agent_none", daemonGeneration: 39 }), null);
    await client.rollbackRoomMove({ operationId: prepared.operationId, entryId: "agent_1", daemonGeneration: 39, error: "owner API unavailable" });
    assert.deepEqual(wire.requests.find((request) => request.method === "supervisor.prepare_room_move")?.params, { entry_id: "agent_1", destination_room_id: "room_2", request_id: "request_1", daemon_generation: 39 });
    assert.deepEqual(wire.requests.find((request) => request.method === "supervisor.acknowledge_room_move_source_revocation")?.params, { operation_id: prepared.operationId, entry_id: "agent_1", source_agent_session_id: "session_1", daemon_generation: 39 });
    assert.deepEqual(wire.requests.find((request) => request.method === "supervisor.rollback_room_move")?.params, { operation_id: prepared.operationId, entry_id: "agent_1", error: "owner API unavailable", daemon_generation: 39 });
    assert.deepEqual(wire.requests.find((request) => request.method === "supervisor.get_current_room_move")?.params, { entry_id: "agent_1", daemon_generation: 39 });
    assert.deepEqual(wire.requests.find((request) => request.method === "supervisor.update_agent_configuration")?.params, {
      entry_id: "agent_1", daemon_generation: 39, expected_revision: 1,
      configuration: { model: null, reasoning_effort: null, charter: "help", permission_profile_id: "full_access" },
    }, "the renderer bridge must never forward native provider policy");
    await assert.rejects(() => client.prepareRoomMove({ entryId: "agent_1", destinationRoomId: "room_2", requestId: undefined as unknown as string, daemonGeneration: 39 }), /exact typed/);
    await assert.rejects(() => client.getAgentConfiguration("agent_1", "39" as unknown as number), /exact typed/);
  } finally { await closeServer(wire.server, env.socketPath); if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous; await env.cleanup(); }
});

test("agent lifecycle RPCs are negotiated before any mutation is sent", async () => {
  const env = await fixture(); const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  const wire = await startWireDaemon(
    env.socketPath,
    SUPERVISOR_DAEMON_PROTOCOL_VERSION,
    40,
    undefined,
    SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION,
    0,
    false,
    false,
  );
  try {
    const client = new SupervisorDaemonClient({ socketPath: env.socketPath, daemonScriptPath, spawnDaemon: () => { throw new Error("healthy daemon must be reused"); } });
    await assert.rejects(() => client.setDesiredState("agent_1", "stopped"), /too old for durable agent lifecycle/);
    await assert.rejects(() => client.retireAgent("agent_1", 40), /too old for durable agent lifecycle/);
    await assert.rejects(() => client.purgeAgent("agent_1", 40), /too old for durable agent lifecycle/);
    assert.equal(wire.requests.some((request) => ["manifest.set_desired_state", "supervisor.retire_agent", "supervisor.purge_agent"].includes(request.method)), false);
  } finally { await closeServer(wire.server, env.socketPath); if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous; await env.cleanup(); }
});

test("runtime recovery sends exact daemon authority and returns the durable replacement state", async () => {
  const env = await fixture(); const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  const wire = await startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 40);
  wire.entries.push({
    ...wireEntryWithCausalProjection(),
    id: "agent_dead",
    observed_state: "failed",
    condition: "coordination_blocked",
    provider_ref: {
      work_attempt_id: "attempt_1",
      provider_continuation_id: "session_dead",
      provider_connection: null,
      execution_generation_id: "execution_1",
    },
    workplace_liveness: { state: "unknown", observed_at: null, detail: null },
    native_liveness: { state: "terminal", observed_at: null, detail: "Provider stopped." },
    activity: [],
  });
  try {
    const client = new SupervisorDaemonClient({ socketPath: env.socketPath, daemonScriptPath, spawnDaemon: () => { throw new Error("healthy daemon must be reused"); } });
    const recovered = await client.recoverAgentRuntime("agent_dead");
    assert.equal(recovered.id, "agent_dead");
    assert.equal(recovered.observedState, "starting");
    assert.equal(recovered.providerContinuationId, null);
    assert.deepEqual(wire.requests.find((request) => request.method === "supervisor.recover_agent_runtime")?.params, {
      entry_id: "agent_dead",
      daemon_generation: 40,
    });
    await assert.rejects(() => client.recoverAgentRuntime(" agent_dead"), /exact/);
  } finally { await closeServer(wire.server, env.socketPath); if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous; await env.cleanup(); }
});

test("purge RPC preserves exact worker-session and grant-only acknowledgement modes", async () => {
  const env = await fixture(); const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  const wire = await startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 40);
  try {
    const client = new SupervisorDaemonClient({ socketPath: env.socketPath, daemonScriptPath, spawnDaemon: () => { throw new Error("healthy daemon must be reused"); } });
    assert.deepEqual(await client.purgeAgent("agent_exact", 40), {
      outcome: "revocation_required",
      operationId: "purge:agent_exact",
      revocationKind: "worker_session",
      agentSessionId: "session_exact",
    });
    assert.deepEqual(await client.purgeAgent("agent_grant_only", 40), {
      outcome: "revocation_required",
      operationId: "purge:agent_grant_only",
      revocationKind: "grant_only",
    });
    assert.deepEqual(await client.purgeAgent("agent_exact", 40, "session_exact", false), { outcome: "purged" });
    assert.deepEqual(await client.purgeAgent("agent_grant_only", 40, null, true), { outcome: "purged" });
    const purgeRequests = wire.requests.filter((request) => request.method === "supervisor.purge_agent");
    assert.deepEqual(purgeRequests.map((request) => request.params), [
      { entry_id: "agent_exact", daemon_generation: 40, revoked_agent_session_id: null, grant_revoked_without_worker_session: false },
      { entry_id: "agent_grant_only", daemon_generation: 40, revoked_agent_session_id: null, grant_revoked_without_worker_session: false },
      { entry_id: "agent_exact", daemon_generation: 40, revoked_agent_session_id: "session_exact", grant_revoked_without_worker_session: false },
      { entry_id: "agent_grant_only", daemon_generation: 40, revoked_agent_session_id: null, grant_revoked_without_worker_session: true },
    ]);
    await assert.rejects(() => client.purgeAgent("agent_exact", 40, "session_exact", true), /exact typed coordinates/);
  } finally { await closeServer(wire.server, env.socketPath); if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous; await env.cleanup(); }
});

test("production create durably proves no mint, grant-only purge survives restart, and its identity tombstone is permanent", async () => {
  const env = await fixture();
  const previousPlatformOverride = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  const previousGrantStore = process.env.LETAGENTS_SUPERVISOR_GRANT_STORE_PATH;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  process.env.LETAGENTS_SUPERVISOR_GRANT_STORE_PATH = join(env.root, "supervisor-grants.json");
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: env.socketPath,
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
  };
  const daemonModulePath = ["..", "..", "daemon", "main.js"].join("/");
  const { SupervisorDaemon: InProcessSupervisorDaemon } = await import(daemonModulePath) as {
    SupervisorDaemon: new (
      daemonPaths: typeof paths,
      platform: NodeJS.Platform,
    ) => { start(): Promise<void>; stop(): Promise<void> };
  };
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`keychain:${value}`),
    decryptString: (value: Buffer) => value.toString("utf8").replace("keychain:", ""),
  };
  let daemon = new InProcessSupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    const client = new SupervisorDaemonClient({
      socketPath: env.socketPath,
      daemonScriptPath,
      spawnDaemon: () => { throw new Error("the real in-process daemon must be reused"); },
    });
    const createInput = {
      creationRequestId: "production_never_minted",
      roomIdentifier: "room_production_never_minted",
      displayName: "Production never minted",
      providerId: "codex" as const,
      charter: "Remain paused until explicitly activated.",
      repoRootPath: env.root,
    };
    const created = await client.create(createInput);
    assert.equal(created.id, "supervised_production_never_minted");
    const createdDatabase = new DatabaseSync(paths.manifestPath);
    try {
      const mintState = createdDatabase.prepare("SELECT phase,agent_session_id FROM supervised_worker_mint_states WHERE agent_id=?")
        .get(created.id) as { phase: string; agent_session_id: string | null };
      assert.equal(mintState.phase, "never_minted");
      assert.equal(mintState.agent_session_id, null);
    } finally { createdDatabase.close(); }
    assert.equal((await client.setDesiredState(created.id, "stopped")).desiredState, "stopped");

    const agentKey = "owner/production-never-minted";
    await replaceDesktopSupervisorGrantForAgent({
      agentKey,
      metadata: {
        grantId: "grant_production_never_minted",
        hostId: "desktop_host",
        installationId: "installation_production_never_minted",
        allowedRoomIds: [created.roomId],
        allowedAgentKeys: [agentKey],
        generation: 1,
        expiresAt: "2026-08-01T00:00:00.000Z",
      },
      token: "lashg_production_never_minted",
      entryId: created.id,
    }, { storage });

    const generation = (await client.ensureRunning()).generation;
    assert.deepEqual(await client.purgeAgent(created.id, generation), {
      outcome: "revocation_required",
      operationId: `purge:${created.id}`,
      revocationKind: "grant_only",
    });
    const database = new DatabaseSync(paths.manifestPath);
    try {
      const purge = database.prepare("SELECT phase,worker_session_attestation,agent_session_id FROM agent_purge_operations WHERE operation_id=?")
        .get(`purge:${created.id}`) as { phase: string; worker_session_attestation: string; agent_session_id: string | null };
      assert.equal(purge.phase, "revoking_credentials");
      assert.equal(purge.worker_session_attestation, "none");
      assert.equal(purge.agent_session_id, null);
    } finally { database.close(); }

    const requests: string[] = [];
    await revokeDesktopSupervisorGrantForEntryWithoutWorkerSession(created.id, {
      storage,
      apiFetch: (async <T>(requestPath: string) => {
        requests.push(requestPath);
        return {} as T;
      }) as never,
    });
    assert.deepEqual(requests, ["/supervisor-host-grants/grant_production_never_minted"]);
    assert.equal(requests.some((requestPath) => requestPath.includes("/worker-sessions/") || requestPath.endsWith("/end")), false);
    assert.equal(await readDesktopSupervisorGrantForAgent(agentKey, { storage }), null);

    await daemon.stop();
    daemon = new InProcessSupervisorDaemon(paths, "darwin");
    await daemon.start();
    await revokeDesktopSupervisorGrantForEntryWithoutWorkerSession(created.id, {
      storage,
      apiFetch: (async () => { throw new Error("durable grant-only receipt must suppress a repeated remote revoke"); }) as never,
    });
    assert.deepEqual(requests, ["/supervisor-host-grants/grant_production_never_minted"]);
    const restartedGeneration = (await client.ensureRunning()).generation;
    assert.deepEqual(await client.purgeAgent(created.id, restartedGeneration, null, true), { outcome: "purged" });
    await assert.rejects(
      () => client.create(createInput),
      /permanently purged.*new creation request id/,
    );
    const tombstoneDatabase = new DatabaseSync(paths.manifestPath);
    try {
      assert.equal(
        (tombstoneDatabase.prepare("SELECT phase FROM agent_purge_operations WHERE operation_id=?")
          .get(`purge:${created.id}`) as { phase: string }).phase,
        "complete",
      );
      assert.equal(
        Number((tombstoneDatabase.prepare("SELECT COUNT(*) AS count FROM agent_identities WHERE agent_id=?")
          .get(created.id) as { count: number }).count),
        0,
      );
      assert.equal(
        Number((tombstoneDatabase.prepare("SELECT COUNT(*) AS count FROM supervised_worker_mint_states WHERE agent_id=?")
          .get(created.id) as { count: number }).count),
        0,
        "the permanent purge tombstone survives while all per-agent mint state is removed",
      );
    } finally { tombstoneDatabase.close(); }
    const distinct = await client.create({
      ...createInput,
      creationRequestId: "production_new_identity",
      displayName: "Production new identity",
    });
    assert.equal(distinct.id, "supervised_production_new_identity");
  } finally {
    await daemon.stop().catch(() => undefined);
    if (previousPlatformOverride === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
    else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previousPlatformOverride;
    if (previousGrantStore === undefined) delete process.env.LETAGENTS_SUPERVISOR_GRANT_STORE_PATH;
    else process.env.LETAGENTS_SUPERVISOR_GRANT_STORE_PATH = previousGrantStore;
    await env.cleanup();
  }
});

test("room delivery retry is capability-negotiated and carries the exact current daemon generation", async () => {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  const wire = await startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 37);
  try {
    const client = new SupervisorDaemonClient({ socketPath: env.socketPath, daemonScriptPath, spawnDaemon: () => { throw new Error("healthy daemon must be reused"); } });
    await client.retryRoomDelivery({
      entryId: "agent_1", roomId: "room_1", sourceMessageId: "msg_1", workAttemptId: "attempt_1",
      executionGenerationId: "execution_1", agentSessionId: "session_1",
    });
    assert.deepEqual(wire.requests.find((request) => request.method === "supervisor.retry_room_delivery")?.params, {
      entry_id: "agent_1", room_id: "room_1", source_message_id: "msg_1", work_attempt_id: "attempt_1",
      execution_generation_id: "execution_1", agent_session_id: "session_1", daemon_generation: 37,
    });
  } finally {
    await closeServer(wire.server, env.socketPath);
    if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous;
    await env.cleanup();
  }
});

test("daemon client emits one nonrecursive ready event per observed generation", async () => {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  const wire = await startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 38);
  try {
    const client = new SupervisorDaemonClient({ socketPath: env.socketPath, daemonScriptPath, spawnDaemon: () => { throw new Error("healthy daemon must be reused"); } });
    const observed: number[] = [];
    const unsubscribe = client.onGeneration((status) => observed.push(status.generation));
    await client.ensureRunning();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await client.ensureRunning();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    unsubscribe();
    assert.deepEqual(observed, [38]);
  } finally {
    await closeServer(wire.server, env.socketPath);
    if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous;
    await env.cleanup();
  }
});

test("host grant install carries renewal ownership and expiry metadata to the exact daemon generation", async () => {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  const wire = await startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 39);
  try {
    const client = new SupervisorDaemonClient({ socketPath: env.socketPath, daemonScriptPath, spawnDaemon: () => { throw new Error("healthy daemon must be reused"); } });
    assert.equal(await client.installHostGrant({
      entryId: "entry-1", roomId: "room-1", agentKey: "owner/agent", grantId: "grant-1",
      supervisorGrant: "secret-parent", grantGeneration: 4, daemonGeneration: 39,
      hostId: "host-1", installationId: "installation-1", expiresAt: "2026-07-22T12:00:00.000Z",
    }), "installed");
    assert.deepEqual(wire.requests.find((request) => request.method === "supervisor.install_host_grant")?.params, {
      entry_id: "entry-1", room_id: "room-1", agent_key: "owner/agent", grant_id: "grant-1",
      supervisor_grant: "secret-parent", grant_generation: 4,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2026-07-22T12:00:00.000Z",
      api_url: configuredApiUrl, daemon_generation: 39, credential_only: false,
    });
  } finally {
    await closeServer(wire.server, env.socketPath);
    if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous;
    await env.cleanup();
  }
});

test("Open Model credential handoff is fenced to one daemon generation", async () => {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  const wire = await startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 40);
  try {
    const client = new SupervisorDaemonClient({
      socketPath: env.socketPath,
      daemonScriptPath,
      spawnDaemon: () => { throw new Error("healthy daemon must be reused"); },
    });
    assert.equal(await client.installOpenModelCredential({
      entryId: "entry-open",
      apiKey: "provider-secret",
      baseUrl: "https://models.example.test/v1/",
      model: "open-model/test",
      daemonGeneration: 40,
    }), "installed");
    assert.deepEqual(wire.requests.find(
      (request) => request.method === "supervisor.install_open_model_credential",
    )?.params, {
      entry_id: "entry-open",
      api_key: "provider-secret",
      base_url: "https://models.example.test/v1/",
      model: "open-model/test",
      daemon_generation: 40,
    });
    assert.equal(await client.installOpenModelCredential({
      entryId: "entry-open",
      apiKey: "provider-secret",
      baseUrl: "https://models.example.test/v1",
      model: "open-model/test",
      daemonGeneration: 39,
    }), "stale");
    assert.equal(wire.requests.filter(
      (request) => request.method === "supervisor.install_open_model_credential",
    ).length, 1, "a stale caller never sends its provider key to the successor daemon");
  } finally {
    await closeServer(wire.server, env.socketPath);
    if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
    else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous;
    await env.cleanup();
  }
});

test("turn control keeps the client socket alive beyond the generic request timeout", async () => {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  const wire = await startWireDaemon(
    env.socketPath,
    SUPERVISOR_DAEMON_PROTOCOL_VERSION,
    3,
    undefined,
    SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION,
    50,
  );
  try {
    const client = new SupervisorDaemonClient({
      socketPath: env.socketPath,
      daemonScriptPath,
      requestTimeoutMs: 20,
      turnControlRequestTimeoutMs: 100,
      spawnDaemon: () => { throw new Error("healthy daemon must be reused"); },
    });
    const result = await client.controlTurn({
      entryId: "entry_exact",
      workAttemptId: "attempt_exact",
      executionGenerationId: "generation_exact",
      actionId: "action_exact",
      correction: "Use the corrected direction",
    });
    assert.equal(result.actionId, "action_exact");
    assert.deepEqual(result.stages, ["delivered", "interrupting", "applied", "resumed"]);
  } finally {
    await closeServer(wire.server, env.socketPath);
    if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous;
    await env.cleanup();
  }
});

test("manifest list allows a cold rich projection beyond the generic control timeout", async () => {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  const wire = await startWireDaemon(
    env.socketPath,
    SUPERVISOR_DAEMON_PROTOCOL_VERSION,
    3,
    undefined,
    SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION,
    0,
    false,
    true,
    50,
  );
  try {
    const client = new SupervisorDaemonClient({
      socketPath: env.socketPath,
      daemonScriptPath,
      requestTimeoutMs: 20,
      spawnDaemon: () => { throw new Error("healthy daemon must be reused"); },
    });
    assert.deepEqual(await client.list(), []);
  } finally {
    await closeServer(wire.server, env.socketPath);
    if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
    else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous;
    await env.cleanup();
  }
});

test("Electron client uses a healthy daemon and maps manifest/attempt data", async () => {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  const wire = await startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 3);
  try {
    const client = new SupervisorDaemonClient({ socketPath: env.socketPath, daemonScriptPath, spawnDaemon: () => { throw new Error("healthy daemon must be reused"); } });
    const status = await client.ensureRunning();
    assert.equal(status.generation, 3);
    const createInput = { creationRequestId: "request_alpha", roomIdentifier: "git-room:github.com:owner/repo", displayName: "Durable Codex", providerId: "codex" as const, charter: "Keep polling.", repoRootPath: "/tmp/work" };
    const created = await client.create(createInput);
    assert.deepEqual([created.desiredState, created.observedState, created.condition], ["paused", "absent", "none"]);
    assert.equal(created.deliveryMode, "daemon_inbox");
    assert.equal(wire.entries[0]?.last_worker_binding, null, "production creation durably attests that no worker session exists yet");
    const retried = await client.create(createInput);
    assert.equal(retried.id, created.id, "one Start request is idempotent across retries");
    const second = await client.create({ ...createInput, creationRequestId: "request_bravo", displayName: "Second durable Codex" });
    assert.notEqual(second.id, created.id, "a new Start request creates an independent same-provider agent");
    assert.equal(wire.entries.length, 2);
    const activityCanary = "canary-not-a-real-renderer-secret-123456789";
    wire.entries[0]!.activity = [{
      observed_at: "2026-01-01T00:00:01.000Z",
      sequence: 1,
      provider: "claude-code",
      kind: "tool_result",
      method: `tool Authorization: Bearer ${activityCanary}`,
      summary: `LETAGENTS_TOKEN=${activityCanary}`,
      status: "working",
      payload: { output: JSON.stringify({ LETAGENTS_TOKEN: activityCanary }) },
      payload_truncated: false,
      payload_redacted: false,
      durable_payload_ref: null,
    }];
    const rendererSafe = (await client.list(created.roomId)).find((candidate) => candidate.id === created.id)!;
    assert.doesNotMatch(JSON.stringify(rendererSafe.activity), new RegExp(activityCanary));
    assert.equal(rendererSafe.activity[0]?.payloadRedacted, true);
    Object.assign(wire.entries[0], {
      work_attempt_id: "attempt_alpha",
      provider_ref: {
        provider_continuation_id: "continuation_alpha",
        execution_generation_id: "generation_alpha",
        provider_connection: { kind: "codex_app_server", pid: 4242 },
      },
      worker_binding: {
        agent_session_id: "agent_session_rebound",
        work_attempt_id: "attempt_alpha",
        execution_generation_id: "generation_alpha",
        updated_at: "2026-07-15T18:00:00.000Z",
      },
      turn_control: {
        action_id: "action_persisted",
        work_attempt_id: "attempt_alpha",
        execution_generation_id: "generation_alpha",
        status: "completed",
        capability: "native_interrupt",
        interrupted: true,
        resumed: true,
        state: "working",
        stages: ["delivered", "interrupting", "applied", "resumed"],
        error: null,
        recorded_at: "2026-07-15T18:00:01.000Z",
        updated_at: "2026-07-15T18:00:02.000Z",
      },
    });
    const rebound = (await client.list(created.roomId)).find((entry) => entry.id === created.id)!;
    assert.equal(rebound.agentSessionId, "agent_session_rebound");
    assert.equal(rebound.agentSessionBindingState, "active");
    assert.equal(rebound.executionGenerationId, "generation_alpha");
    assert.equal(rebound.providerContinuationId, "continuation_alpha");
    assert.equal(rebound.providerPid, 4242);
    assert.equal(rebound.turnControl?.actionId, "action_persisted");
    assert.deepEqual(rebound.turnControl?.stages, ["delivered", "interrupting", "applied", "resumed"]);
    Object.assign(wire.entries[0], {
      worker_binding: null,
      last_worker_binding: {
        agent_session_id: "agent_session_rebound",
        work_attempt_id: "attempt_alpha",
        execution_generation_id: "generation_alpha",
        updated_at: "2026-07-15T18:00:00.000Z",
      },
    });
    const temporarilyUnbound = (await client.list(created.roomId)).find((entry) => entry.id === created.id)!;
    assert.equal(temporarilyUnbound.agentSessionId, "agent_session_rebound", "identity-only history keeps exact controls routed after live credentials unbind");
    assert.equal(temporarilyUnbound.agentSessionBindingState, "historical", "historical control identity never masquerades as an active room binding");
    await assert.rejects(
      () => client.assertLegacyStartAllowed(created.roomId, "codex"),
      /already owns the codex lane through the supervised engine/,
      "the paused transfer claim fences a concurrent legacy start before activation",
    );
    assert.equal((await client.setDesiredState(created.id, "running")).desiredState, "running");
    assert.equal(await client.compareAndSetDesiredState(created.id, "paused", "stopped"), null);
    assert.equal((await client.setDesiredState(second.id, "running")).desiredState, "running");
    assert.equal((await client.setDesiredState(created.id, "stopped")).desiredState, "stopped");
    const listed = await client.list(created.roomId);
    assert.equal(listed.find((entry) => entry.id === second.id)?.desiredState, "running", "stopping one same-provider agent does not affect its peer");
    assert.equal((await client.readAttempt(created.id)).workspacePath, null);
    const claude = await client.create({
      roomIdentifier: "git-room:github.com:owner/claude-repo",
      displayName: "Durable Claude",
      providerId: "claude-code",
      charter: "Keep polling.",
      repoRootPath: "/tmp/claude-work",
      launchPolicy: { permissionMode: "acceptEdits", model: "sonnet" },
    });
    assert.equal(claude.deliveryMode, "daemon_inbox");
    assert.deepEqual(
      wire.entries.find((candidate) => candidate.provider === "claude-code")?.provider_launch_policy,
      { permissionMode: "acceptEdits", model: "sonnet" },
    );
    const reservation = await client.reserveLegacyLane("room_legacy_client", "codex", "legacy_client");
    assert.equal(reservation.owner_pid, process.pid);
    assert.equal((await client.activateLegacyLane("legacy_client", "legacy_session_client")).state, "active");
    assert.equal(await client.releaseLegacyLane({ roomIdentifier: "room_legacy_client", provider: "codex" }), true);
  } finally {
    await closeServer(wire.server, env.socketPath);
    if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous;
    await env.cleanup();
  }
});

test("desktop and daemon implementation identities stay in lockstep", async () => {
  const daemonTypes = await readFile(daemonTypesPath, "utf8");
  const daemonIdentity = daemonTypes.match(/DAEMON_IMPLEMENTATION_VERSION\s*=\s*"([^"]+)"/)?.[1];
  assert.equal(daemonIdentity, SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION);
});

test("desktop dev daemon uses the exact rebuilt repo MCP and packaged launches ignore inherited overrides", () => {
  const sourceRoot = '/tmp/LetAgents source "quoted"';
  const inherited = {
    LETAGENTS_API_URL: "https://letagents.chat",
    LETAGENTS_DEV_MCP_SERVER_ENTRY: "/tmp/unrelated-cwd/stale-cache/server.js",
  };

  const packaged = supervisorDaemonSpawnEnvironment(inherited, sourceRoot);
  assert.equal(packaged.LETAGENTS_DEV_MCP_SERVER_ENTRY, undefined, "packaged launch keeps the installed MCP fallback");
  assert.equal(packaged.LETAGENTS_API_URL, inherited.LETAGENTS_API_URL, "unrelated auth/runtime environment is preserved");

  const development = supervisorDaemonSpawnEnvironment({
    ...inherited,
    LETAGENTS_DESKTOP_DEV_SERVER_URL: "http://127.0.0.1:5174",
  }, sourceRoot);
  assert.equal(
    development.LETAGENTS_DEV_MCP_SERVER_ENTRY,
    join(sourceRoot, "dist", "mcp", "server.js"),
    "dev launch derives the exact repo build instead of trusting inherited cwd or cache state",
  );
  assert.equal(development.ELECTRON_RUN_AS_NODE, "1");
});

test("desktop development watches daemon builds and rejects a stale replacement implementation", async () => {
  const desktopPackage = JSON.parse(await readFile(desktopPackagePath, "utf8")) as { scripts?: Record<string, string> };
  assert.match(desktopPackage.scripts?.dev ?? "", /npm:watch:daemon/);
  assert.match(desktopPackage.scripts?.["watch:daemon"] ?? "", /tsconfig\.daemon\.json --watch/);
  const clientSource = await readFile(daemonClientPath, "utf8");
  const healthCheck = clientSource.slice(
    clientSource.indexOf("private async waitForHealthy"),
    clientSource.indexOf("private captureRetiredDaemon"),
  );
  assert.match(healthCheck, /status\.implementationVersion !== SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION/);
  assert.match(healthCheck, /Rebuild the desktop daemon and try again/);
});

test("vN desktop performs negotiated handoff before spawning vN+1 daemon", async () => {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  let oldServer: Server | null = null;
  let replacementServer: Server | null = null;
  let spawns = 0;
  let retiredAlive = true;
  const old = await startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION - 1, 7, () => {
    retiredAlive = false;
    void closeServer(oldServer, env.socketPath);
  });
  oldServer = old.server;
  try {
    const client = new SupervisorDaemonClient({
      socketPath: env.socketPath,
      daemonScriptPath,
      inspectDaemonProcess: () => retiredAlive ? fakeDaemonProcessIdentity() : null,
      handoffTimeoutMs: 50,
      spawnDaemon: () => {
        spawns += 1;
        void startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 8).then((wire) => { replacementServer = wire.server; });
        return fakeChild();
      },
    });
    const status = await client.ensureRunning();
    assert.equal(spawns, 1);
    assert.equal(status.protocolVersion, SUPERVISOR_DAEMON_PROTOCOL_VERSION);
    assert.equal(status.generation, 8);
  } finally {
    await closeServer(replacementServer, env.socketPath);
    await closeServer(oldServer, env.socketPath);
    if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous;
    await env.cleanup();
  }
});

test("desktop replaces the prior implementation and accepts only the new exact implementation", async () => {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  let oldServer: Server | null = null;
  let replacementServer: Server | null = null;
  let handoffPrepared = false;
  let retiredAlive = true;
  let spawnedCwd: string | null = null;
  const stableCwd = join(env.root, "stable-daemon-cwd");
  const old = await startWireDaemon(
    env.socketPath,
    SUPERVISOR_DAEMON_PROTOCOL_VERSION,
    11,
    () => {
      handoffPrepared = true;
      retiredAlive = false;
      void closeServer(oldServer, env.socketPath);
    },
    "2.0.52",
  );
  oldServer = old.server;
  try {
    assert.notEqual("2.0.52", SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION);
    const client = new SupervisorDaemonClient({
      socketPath: env.socketPath,
      daemonScriptPath,
      daemonWorkingDirectory: stableCwd,
      inspectDaemonProcess: () => retiredAlive ? fakeDaemonProcessIdentity() : null,
      handoffTimeoutMs: 50,
      spawnDaemon: (_scriptPath, cwd) => {
        spawnedCwd = cwd;
        void startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 12)
          .then((wire) => { replacementServer = wire.server; });
        return fakeChild();
      },
    });
    const status = await client.ensureRunning();
    assert.equal(handoffPrepared, true, "implementation mismatch must prepare the running generation for handoff");
    assert.equal(status.generation, 12);
    assert.equal(status.implementationVersion, SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION);
    assert.equal(status.implementationVersion, "2.0.76");
    assert.equal(spawnedCwd, stableCwd);
    assert.equal((await stat(stableCwd)).isDirectory(), true);
  } finally {
    await closeServer(replacementServer, env.socketPath);
    await closeServer(oldServer, env.socketPath);
    if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous;
    await env.cleanup();
  }
});

test("desktop safely terminates a wedged negotiated daemon while preserving provider work", async () => {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  let oldServer: Server | null = null;
  let replacementServer: Server | null = null;
  let terminatedPid: number | null = null;
  let retiredAlive = true;
  const provider = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const old = await startWireDaemon(
    env.socketPath,
    SUPERVISOR_DAEMON_PROTOCOL_VERSION,
    21,
    undefined,
    "2.0.6-wedged",
  );
  oldServer = old.server;
  try {
    const client = new SupervisorDaemonClient({
      socketPath: env.socketPath,
      daemonScriptPath,
      handoffTimeoutMs: 50,
      terminateTimeoutMs: 50,
      killTimeoutMs: 25,
      processPollIntervalMs: 1,
      inspectDaemonProcess: () => retiredAlive ? fakeDaemonProcessIdentity() : null,
      terminateDaemon: (pid) => {
        terminatedPid = pid;
        retiredAlive = false;
        void closeServer(oldServer, env.socketPath);
      },
      spawnDaemon: () => {
        void startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 22)
          .then((wire) => { replacementServer = wire.server; });
        return fakeChild();
      },
    });
    const status = await client.ensureRunning();
    assert.equal(terminatedPid, 77, "only the re-negotiated exact daemon PID is terminated");
    assert.equal(status.generation, 22);
    assert.doesNotThrow(() => process.kill(provider.pid!, 0), "daemon recovery does not kill detached provider work");
  } finally {
    await closeServer(replacementServer, env.socketPath);
    await closeServer(oldServer, env.socketPath);
    provider.kill("SIGKILL");
    if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous;
    await env.cleanup();
  }
});

test("acknowledged but unresponsive socket still enters exact-PID bounded enforcement", async () => {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  let oldServer: Server | null = null;
  let replacementServer: Server | null = null;
  let retiredAlive = true;
  const signals: Array<"SIGTERM" | "SIGKILL"> = [];
  const old = await startWireDaemon(
    env.socketPath,
    SUPERVISOR_DAEMON_PROTOCOL_VERSION,
    31,
    undefined,
    "2.0.25",
    0,
    true,
  );
  oldServer = old.server;
  try {
    const client = new SupervisorDaemonClient({
      socketPath: env.socketPath,
      daemonScriptPath,
      handoffTimeoutMs: 0,
      terminateTimeoutMs: 100,
      killTimeoutMs: 25,
      processPollIntervalMs: 1,
      requestTimeoutMs: 10,
      inspectDaemonProcess: () => retiredAlive ? fakeDaemonProcessIdentity() : null,
      signalDaemon: (pid, signal) => {
        assert.equal(pid, 77);
        signals.push(signal);
        if (signal === "SIGTERM") {
          void closeServer(oldServer, env.socketPath).then(() => { retiredAlive = false; });
        }
      },
      spawnDaemon: () => {
        void startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 32)
          .then((wire) => { replacementServer = wire.server; });
        return fakeChild();
      },
    });
    const status = await client.ensureRunning();
    assert.deepEqual(signals, ["SIGTERM"], "the verified predecessor is retired even when its socket stops answering");
    assert.equal(status.generation, 32);
  } finally {
    await closeServer(replacementServer, env.socketPath);
    await closeServer(oldServer, env.socketPath);
    if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous;
    await env.cleanup();
  }
});

test("live socket plus unverifiable PID leaves the existing daemon serving", async () => {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  let prepared = false;
  let spawns = 0;
  const signals: NodeJS.Signals[] = [];
  const old = await startWireDaemon(
    env.socketPath,
    SUPERVISOR_DAEMON_PROTOCOL_VERSION,
    51,
    () => { prepared = true; },
    "2.0.25",
  );
  try {
    const client = new SupervisorDaemonClient({
      socketPath: env.socketPath,
      daemonScriptPath,
      handoffTimeoutMs: 10,
      processPollIntervalMs: 1,
      inspectDaemonProcess: () => prepared ? undefined : fakeDaemonProcessIdentity(),
      signalDaemon: (_pid, signal) => signals.push(signal),
      spawnDaemon: () => { spawns += 1; return fakeChild(); },
    });
    await assert.rejects(client.ensureRunning(), /still owns its socket.*unverifiable/i);
    assert.equal(spawns, 0, "a competing daemon is not spawned while authority is still live");
    assert.deepEqual(signals, [], "an unverifiable PID is never signalled");
    assert.equal(old.server.listening, true, "the existing daemon remains available after the aborted upgrade");
  } finally {
    await closeServer(old.server, env.socketPath);
    if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous;
    await env.cleanup();
  }
});

test("free socket plus unverifiable PID proceeds with a loud diagnostic", async () => {
  const result = await runReleasedSocketHandoffScenario({ inspectAfterPrepare: () => undefined });
  assert.equal(result.status.generation, 42);
  assert.deepEqual(result.signals, []);
  assert.equal(result.diagnostics.some((entry) => entry.outcome === "unverifiable" && entry.authorityReleased), true);
});

test("daemon signal guard refuses PID reuse before TERM", async () => {
  const result = await runReleasedSocketHandoffScenario({
    inspectAfterPrepare: () => fakeDaemonProcessIdentity({ kernelStartTime: "Thu Jan  1 00:00:01 2026" }),
  });
  assert.deepEqual(result.signals, []);
  assert.equal(result.diagnostics.some((entry) => entry.outcome === "changed" && /PID reuse/.test(entry.detail)), true);
});

test("daemon signal guard re-verifies PID reuse immediately before KILL", async () => {
  let postTermInspections = 0;
  const result = await runReleasedSocketHandoffScenario({
    inspectAfterPrepare: ({ signals }) => {
      if (signals.length === 0) return fakeDaemonProcessIdentity();
      postTermInspections += 1;
      if (postTermInspections === 1) return fakeDaemonProcessIdentity();
      return fakeDaemonProcessIdentity({ kernelStartTime: "Thu Jan  1 00:00:01 2026" });
    },
  });
  assert.deepEqual(result.signals, ["SIGTERM"], "SIGKILL is withheld after the PID birth identity changes");
  assert.equal(result.diagnostics.some((entry) => entry.outcome === "changed"), true);
});

test("daemon signal guard refuses a changed command", async () => {
  const result = await runReleasedSocketHandoffScenario({
    inspectAfterPrepare: () => fakeDaemonProcessIdentity({ command: `${process.execPath} /tmp/not-the-daemon.js` }),
  });
  assert.deepEqual(result.signals, []);
  assert.equal(result.diagnostics.some((entry) => entry.outcome === "changed" && /command changed/.test(entry.detail)), true);
});

test("zombie after SIGKILL does not block replacement after authority release", async () => {
  const result = await runReleasedSocketHandoffScenario({
    inspectAfterPrepare: ({ signals }) => signals.at(-1) === "SIGKILL"
      ? fakeDaemonProcessIdentity({ state: "zombie" })
      : fakeDaemonProcessIdentity(),
  });
  assert.deepEqual(result.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(result.status.generation, 42);
  assert.equal(result.diagnostics.some((entry) => entry.outcome === "zombie_after_sigkill"), true);
});

test("non-zombie SIGKILL survivor is diagnosed but cannot retain transferred authority", async () => {
  const result = await runReleasedSocketHandoffScenario({ inspectAfterPrepare: () => fakeDaemonProcessIdentity() });
  assert.deepEqual(result.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(result.status.generation, 42);
  assert.equal(result.diagnostics.some((entry) => entry.outcome === "non_zombie_survived_sigkill"), true);
});

test("replacement cannot report healthy without acquiring a newer singleton generation", async () => {
  const env = await fixture();
  const previous = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
  let oldServer: Server | null = null;
  let replacementServer: Server | null = null;
  let retiredAlive = true;
  const old = await startWireDaemon(
    env.socketPath,
    SUPERVISOR_DAEMON_PROTOCOL_VERSION,
    61,
    () => { void closeServer(oldServer, env.socketPath).then(() => { retiredAlive = false; }); },
    "2.0.25",
  );
  oldServer = old.server;
  try {
    const client = new SupervisorDaemonClient({
      socketPath: env.socketPath,
      daemonScriptPath,
      handoffTimeoutMs: 10,
      startTimeoutMs: 200,
      processPollIntervalMs: 1,
      inspectDaemonProcess: () => retiredAlive ? fakeDaemonProcessIdentity() : null,
      spawnDaemon: () => {
        void startWireDaemon(env.socketPath, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 61)
          .then((wire) => { replacementServer = wire.server; });
        return fakeChild();
      },
    });
    await assert.rejects(client.ensureRunning(), /did not acquire a newer singleton generation/i);
  } finally {
    await closeServer(replacementServer, env.socketPath);
    await closeServer(oldServer, env.socketPath);
    if (previous === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON; else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previous;
    await env.cleanup();
  }
});

test("every daemon termination signal is identity-guarded and positive-PID only", async () => {
  const source = await readFile(daemonClientPath, "utf8");
  const signalCalls = [...source.matchAll(/this\.signalDaemon\(([^;]+)\);/g)].map((match) => match[1]);
  assert.deepEqual(signalCalls, ["retired.pid, signal"], "all injected daemon signalling is centralized in the guarded helper");
  const helper = source.slice(
    source.indexOf("private guardedSignalRetiredDaemon"),
    source.indexOf("private async waitForRetiredProcessChange"),
  );
  assert.match(helper, /observeRetiredDaemon\(retired\)/);
  assert.match(helper, /retired\.pid <= 1/);
  assert.doesNotMatch(helper, /-retired\.pid|process\.kill\(-/);
});
