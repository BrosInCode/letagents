import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

import { AuditLog } from "../audit-log.js";
import { DaemonControlSocket } from "../control-socket.js";
import { CorruptAttemptStoreError, ImmutableExecutionError, WorkDurabilityStore } from "../durability-store.js";
import { ManifestConflictError, ManifestStore } from "../manifest-store.js";
import { isSupervisedQuietPollContinuation, isSupervisedWaitProviderEvent, resolveReadyReachedAt, SupervisorDaemon, SupervisorGrantRequestError, sameProcessBirthIdentity, supervisedWaitCursorFromProviderEvent, supervisedWaitEvidenceFromProviderEvent, workplaceLivenessStaleAfterMs } from "../main.js";
import { assertMacOS } from "../platform.js";
import { DaemonAlreadyRunningError, DaemonFenceLostError, DaemonSingleton } from "../singleton.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonManifestEntry, type DaemonManifestEntryView, type DaemonRequest } from "../types.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { createGitCommand, repositoryStorageKey, WorkspaceProvisioner } from "../workspace-provisioner.js";
import { acquireWorkspaceFence, withWorkspaceFence } from "../workspace-fence.js";
import { CRASH_LOOP_EXIT_LIMIT, decideReconciliation, restartBackoffMs, watchdogShouldEscalate } from "../reconciler-policy.js";
import { ProviderReconciler } from "../reconciler-runner.js";
import { advanceReconciliationState, recordReconciliationActionFailure } from "../reconciler-state.js";
import type { ProviderActionPort } from "../provider-action-port.js";
import { ProviderActionPortRouter, type NativeProviderAdapter } from "../provider-action-port-router.js";
import { launchLegacyWithOwnership } from "../../electron/main/supervisor-ownership.js";
import { defaultGetProcessIdentity } from "../../electron/main/agents/provider-evidence.js";

const execFileAsync = promisify(execFile);
const TEST_PROCESS_IDENTITY = execFileSync(
  "/bin/ps",
  ["-p", String(process.pid), "-o", "lstart=", "-o", "command="],
  { encoding: "utf8" },
).trim();

test("workplace reachability outlives the configured room long poll", () => {
  assert.equal(workplaceLivenessStaleAfterMs(""), 210_000);
  assert.equal(workplaceLivenessStaleAfterMs("999"), 210_000);
  assert.equal(workplaceLivenessStaleAfterMs("36000000"), 36_030_000);
  assert.equal(workplaceLivenessStaleAfterMs("36000000ms"), 36_030_000);
  assert.equal(workplaceLivenessStaleAfterMs("999999999"), 86_430_000);
  assert.equal(workplaceLivenessStaleAfterMs("invalid"), 210_000);
});

test("resolveReadyReachedAt stamps ready once, monotonically, and only when running + unblocked + live (task_84)", () => {
  const now = "2026-07-17T00:00:00.000Z";
  // A bind that clears the pre-bind coordination latch reaches ready.
  assert.equal(
    resolveReadyReachedAt({ desired_state: "running", observed_state: "recovering", condition: "coordination_blocked", ready_reached_at: null }, true, now),
    now,
  );
  // An idempotent bind of an already working/none entry is ready without clearing a latch.
  assert.equal(
    resolveReadyReachedAt({ desired_state: "running", observed_state: "working", condition: "none", ready_reached_at: null }, false, now),
    now,
  );
  // Already stamped → keeps the original timestamp (monotonic, set-once).
  assert.equal(
    resolveReadyReachedAt({ desired_state: "running", observed_state: "working", condition: "none", ready_reached_at: "2026-07-16T00:00:00.000Z" }, false, now),
    "2026-07-16T00:00:00.000Z",
  );
  // Not running, or still blocked → never stamped.
  assert.equal(
    resolveReadyReachedAt({ desired_state: "paused", observed_state: "working", condition: "none", ready_reached_at: null }, false, now),
    null,
  );
  assert.equal(
    resolveReadyReachedAt({ desired_state: "running", observed_state: "recovering", condition: "auth_blocked", ready_reached_at: null }, false, now),
    null,
  );
});

test("ready_reached_at survives a manifest round-trip, defaults absent, and a stop never clears it (task_84)", async () => {
  const env = await fixture();
  try {
    const store = new ManifestStore(join(env.root, "manifest.json"));
    // An old manifest without the field loads as absent (defaults null downstream).
    await store.write(0, [{ ...entry }]);
    assert.equal((await store.load()).entries[0]?.ready_reached_at, undefined);
    // A set-once stamp survives save → load (i.e. a daemon restart round-trip).
    await store.write(1, [{ ...entry, ready_reached_at: "2026-07-17T00:00:00.000Z" }]);
    assert.equal((await store.load()).entries[0]?.ready_reached_at, "2026-07-17T00:00:00.000Z");
    // A later stop (spread-preserving mutation) must not clear the stamp.
    const loaded = (await store.load()).entries[0]!;
    await store.write(2, [{ ...loaded, desired_state: "stopped", observed_state: "absent" }]);
    const after = (await store.load()).entries[0];
    assert.equal(after?.ready_reached_at, "2026-07-17T00:00:00.000Z");
    assert.equal(after?.desired_state, "stopped");
  } finally {
    await env.cleanup();
  }
});

test("desired-state compare-and-set cannot resurrect a concurrently stopped launch", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"),
    attemptsRoot: join(env.root, "attempt-data"),
    workspaceRoot: env.root,
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id: "resume_cas",
      desired_state: "paused",
      observed_state: "starting",
    } })).ok, true);
    const activated = (await daemonRequest(paths.socketPath, "manifest.compare_and_set_desired_state", {
      id: "resume_cas",
      expected_desired_state: "paused",
      desired_state: "running",
    })).result as { applied: boolean; entry: DaemonManifestEntry };
    assert.equal(activated.applied, true);
    assert.equal(activated.entry.desired_state, "running");
    const staleRollback = (await daemonRequest(paths.socketPath, "manifest.compare_and_set_desired_state", {
      id: "resume_cas",
      expected_desired_state: "paused",
      desired_state: "stopped",
    })).result as { applied: boolean; entry: DaemonManifestEntry };
    assert.equal(staleRollback.applied, false, "a losing resume cannot roll back another activation");
    assert.equal(staleRollback.entry.desired_state, "running");
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "resume_cas", desired_state: "stopped" });
    const staleActivation = (await daemonRequest(paths.socketPath, "manifest.compare_and_set_desired_state", {
      id: "resume_cas",
      expected_desired_state: "paused",
      desired_state: "running",
    })).result as { applied: boolean; entry: DaemonManifestEntry };
    assert.equal(staleActivation.applied, false, "a concurrent Stop wins over resume");
    assert.equal(staleActivation.entry.desired_state, "stopped");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("legacy lane owner liveness compares the stable process birth prefix, not the whole ps line", () => {
  // Repro of the supervised Start reserve->activate failure: Electron records the
  // owner identity as start-time only (defaultGetProcessIdentity = `ps -o lstart=`),
  // but the daemon previously read `lstart + command` and compared whole strings, so
  // a live owner never matched and its reservation was pruned before activate.
  const recorded = "Wed Jul 16 02:22:00 2026";
  // Same live process, read start-time-only, is the same birth identity -> stays live.
  assert.equal(sameProcessBirthIdentity("Wed Jul 16 02:22:00 2026", recorded), true);
  // ps column padding varies; the stable prefix normalizes whitespace.
  assert.equal(sameProcessBirthIdentity("Wed Jul 16  02:22:00 2026", recorded), true);
  // Pre-2.0.12 identities appended the mutable command; the stable prefix still
  // matches a start-time-only read (live-upgrade compatibility), both directions.
  assert.equal(sameProcessBirthIdentity(
    "Wed Jul 16 02:22:00 2026",
    "Wed Jul 16 02:22:00 2026 /Applications/LetAgents.app/Contents/MacOS/Electron",
  ), true);
  assert.equal(sameProcessBirthIdentity("Wed Jul 16 02:22:00 2026 node dist-daemon/main.js", recorded), true);
  // A different start time (PID reuse) is a different process and must read dead.
  assert.equal(sameProcessBirthIdentity("Wed Jul 16 09:00:00 2026", recorded), false);
});

test("a reserved legacy lane owner recorded with a start-time-only identity survives reserve->activate->release", async () => {
  // Product-sequence regression for the supervised Start reserve->activate failure.
  // Electron records the owner identity as start-time only (defaultGetProcessIdentity
  // = `ps -o lstart=`). This live test process is the owner, so liveness is real and
  // deterministic. Pre-fix, isProcessOwnerLive read `lstart + command` and compared
  // whole strings, so the start-time-only recorded identity never matched and
  // liveLegacyLaneOwners pruned the reservation before activate -> activate threw
  // "Unknown legacy lane reservation". The birth-prefix comparison keeps it live.
  // Verified to FAIL on ea06a21f and PASS on the fix.
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"),
    auditPath: join(env.root, "audit.jsonl"),
    workerBindingsPath: join(env.root, "worker-bindings.json"),
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    const ownerIdentity = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8" }).trim();
    assert.ok(ownerIdentity.length > 0);
    const reservationId = randomUUID();
    const reserve = await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: reservationId,
      room_id: "room_legacy",
      provider: "codex",
      owner_pid: process.pid,
      owner_process_identity: ownerIdentity,
    });
    assert.equal(reserve.ok, true);
    const activate = await daemonRequest(paths.socketPath, "lane.activate_legacy", {
      reservation_id: reservationId,
      session_id: "session_legacy",
    });
    assert.equal(activate.ok, true, `activate failed: ${activate.error ?? ""}`);
    const activeOwners = (await new ManifestStore(paths.manifestPath).load()).legacy_lane_owners ?? [];
    const active = activeOwners.find((candidate) => candidate.reservation_id === reservationId);
    assert.equal(active?.state, "active");
    assert.equal(active?.session_id, "session_legacy");

    // Full lifecycle: release must succeed and durably drop the owner so the fix
    // cannot silently break the release path.
    const release = await daemonRequest(paths.socketPath, "lane.release_legacy", { reservation_id: reservationId });
    assert.equal(release.ok, true, `release failed: ${release.error ?? ""}`);
    assert.equal((release.result as { released?: boolean }).released, true);
    const afterRelease = (await new ManifestStore(paths.manifestPath).load()).legacy_lane_owners ?? [];
    assert.equal(afterRelease.some((candidate) => candidate.reservation_id === reservationId), false);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("supervised native stream extracts only explicit LetAgents wait cursors", () => {
  const base = {
    workAttemptId: "attempt",
    providerContinuationId: "continuation",
    observedAt: new Date().toISOString(),
    sequence: 1,
    provider: "claude-code",
    kind: "text_delta",
    method: "assistant",
    payloadTruncated: false,
    payloadRedacted: false,
    durablePayloadRef: null,
  };
  assert.equal(supervisedWaitCursorFromProviderEvent({
    ...base,
    payload: {
      type: "assistant",
      message: { content: [{
        type: "tool_use",
        name: "mcp__letagents__wait_for_messages",
        input: { after_message_id: "msg_3064", agent_session_id: "agent_session_exact" },
      }] },
    },
  }), "msg_3064");
  assert.deepEqual(supervisedWaitEvidenceFromProviderEvent({
    ...base,
    payload: {
      type: "tool_use",
      name: "wait_for_messages",
      input: { after_message_id: "msg_3065", agent_session_id: "agent_session_exact" },
    },
  }), { roomCursor: "msg_3065", agentSessionId: "agent_session_exact" });
  assert.equal(supervisedWaitCursorFromProviderEvent({
    ...base,
    payload: { type: "tool_use", name: "wait_for_messages", input: { after_message_id: "msg_3065" } },
  }), null, "a cursor without exact worker-session evidence is unusable");
  assert.equal(supervisedWaitCursorFromProviderEvent({
    ...base,
    payload: { type: "assistant", message: { content: [{ type: "text", text: "wait_for_messages after msg_999" }] } },
  }), null, "free text cannot advance durable room progress");
  assert.equal(supervisedWaitCursorFromProviderEvent({
    ...base,
    payload: { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__other__wait_for_messages", input: { after_message_id: "not-a-message" } }] } },
  }), null, "malformed cursors are ignored");
});

test("supervised native stream classifies structured Claude and Codex room waits as quiet polling", () => {
  const base = {
    workAttemptId: "attempt",
    providerContinuationId: "continuation",
    observedAt: new Date().toISOString(),
    sequence: 1,
    provider: "claude-code" as const,
    kind: "tool_lifecycle" as const,
    method: "assistant",
    payloadTruncated: false,
    payloadRedacted: false,
    durablePayloadRef: null,
  };
  assert.equal(isSupervisedWaitProviderEvent({
    ...base,
    payload: { type: "tool_use", name: "mcp__letagents__wait_for_messages", input: {} },
  }), true);
  assert.equal(isSupervisedWaitProviderEvent({
    ...base,
    provider: "codex",
    method: "item/started",
    payload: { item: { type: "mcpToolCall", id: "wait_codex", server: "letagents", tool: "wait_for_messages", status: "inProgress" } },
  }), true);
  assert.equal(isSupervisedWaitProviderEvent({
    ...base,
    kind: "text_delta",
    payload: { type: "assistant", message: { content: [{ type: "text", text: "call wait_for_messages next" }] } },
  }), false, "free text cannot hide genuine user-facing work");
  assert.equal(isSupervisedWaitProviderEvent({
    ...base,
    provider: "codex",
    method: "item/started",
    payload: { item: { type: "mcpToolCall", id: "read_codex", server: "letagents", tool: "read_messages", status: "inProgress" } },
  }), false, "other room tools remain visible as real work");
});

test("supervised native stream keeps correlated empty wait results and handoffs quiet", () => {
  const claudeWait = {
    method: "assistant",
    payload: {
      type: "assistant",
      message: { content: [{
        type: "tool_use",
        id: "wait_claude",
        name: "mcp__letagents__wait_for_messages",
        input: { after_message_id: "msg_10", agent_session_id: "agent_session_exact" },
      }] },
    },
  };
  const claudeResult = (body: object, overrides: object = {}) => ({
    method: "user",
    payload: {
      type: "user",
      message: { content: [{
        type: "tool_result",
        tool_use_id: "wait_claude",
        content: [{ type: "text", text: JSON.stringify(body) }],
        ...overrides,
      }] },
    },
  });
  const emptyResult = claudeResult({ messages: [], room_id: "focus_37" });
  assert.equal(isSupervisedQuietPollContinuation(emptyResult, [claudeWait]), true);
  assert.equal(isSupervisedQuietPollContinuation(
    claudeResult({ messages: [], last_observed_message_id: "msg_11", skipped_message_count: 1 }),
    [claudeWait],
  ), true, "silent/skipped cursor progress remains an idle poll result");
  assert.equal(isSupervisedQuietPollContinuation(
    claudeResult({ messages: [{ id: "msg_11", text: "please act" }] }),
    [claudeWait],
  ), false, "an addressed result wakes the worker visibly");
  assert.equal(isSupervisedQuietPollContinuation(
    claudeResult({ messages: [] }, { is_error: true }),
    [claudeWait],
  ), false, "poll errors are never hidden as idle");
  assert.equal(isSupervisedQuietPollContinuation(
    { method: "assistant", payload: { type: "assistant", message: { content: [{ type: "thinking", thinking: "bounded provider thought" }] } } },
    [claudeWait, emptyResult],
  ), true, "the thinking-only beat before the immediate re-wait does not flash working");
  assert.equal(isSupervisedQuietPollContinuation(
    { method: "assistant", payload: { type: "assistant", message: { content: [{ type: "text", text: "Starting the requested review" }] } } },
    [claudeWait, emptyResult],
  ), false, "user-facing assistant work remains visible without free-text heuristics");

  const codexWait = {
    method: "item/started",
    payload: {
      item: { type: "mcpToolCall", id: "wait_codex", server: "letagents", tool: "wait_for_messages", status: "inProgress" },
      threadId: "thread_codex",
      turnId: "turn_codex",
    },
  };
  const codexProgress = {
    method: "item/mcpToolCall/progress",
    payload: { itemId: "wait_codex", message: "waiting", threadId: "thread_codex", turnId: "turn_codex" },
  };
  const codexResult = {
    method: "item/completed",
    payload: {
      item: {
        type: "mcpToolCall", id: "wait_codex", server: "letagents", tool: "wait_for_messages", status: "completed",
        result: { content: [{ type: "text", text: JSON.stringify({ messages: [], last_observed_message_id: "msg_12" }) }], structuredContent: null, _meta: null },
        error: null,
      },
      threadId: "thread_codex",
      turnId: "turn_codex",
    },
  };
  assert.equal(isSupervisedQuietPollContinuation(codexProgress, [codexWait]), true, "real Codex progress correlates by params.itemId");
  assert.equal(isSupervisedQuietPollContinuation(codexResult, [codexWait, codexProgress]), true, "real Codex completion correlates by params.item.id");
  assert.equal(isSupervisedQuietPollContinuation({
    method: "item/completed",
    payload: {
      item: {
        type: "mcpToolCall", id: "wait_codex", server: "letagents", tool: "wait_for_messages", status: "completed",
        result: { content: [], structuredContent: { messages: [{ id: "msg_13", text: "please act" }] }, _meta: null },
        error: null,
      },
    },
  }, [codexWait]), false, "an addressed real Codex completion remains visible work");
  assert.equal(isSupervisedQuietPollContinuation({
    method: "item/completed",
    payload: {
      item: {
        type: "mcpToolCall", id: "wait_codex", server: "letagents", tool: "wait_for_messages", status: "failed",
        result: null, error: { message: "poll failed" },
      },
    },
  }, [codexWait]), false, "a failed real Codex completion is never hidden");
  for (let index = 0; index < 10; index += 1) {
    assert.equal(isSupervisedQuietPollContinuation(emptyResult, [claudeWait]), true, `staggered idle agent ${index + 1} stays quiet`);
  }
});

async function fixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "letagents-daemon-"));
  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }); } };
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs); })]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function eventually(predicate: () => Promise<boolean>, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function fakeRecoveryClock(startMs = 10_000) {
  let nowMs = startMs;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const delays: number[] = [];
  const setTimer = ((callback: () => void, delay = 0) => {
    const id = nextId++;
    const handle = { id, unref() { return handle; } } as unknown as ReturnType<typeof setTimeout>;
    timers.set(id, { at: nowMs + Number(delay), callback });
    delays.push(Number(delay));
    return handle;
  }) as typeof setTimeout;
  const clearTimer = ((handle: ReturnType<typeof setTimeout>) => {
    const id = (handle as unknown as { id?: number }).id;
    if (id !== undefined) timers.delete(id);
  }) as typeof clearTimeout;
  return {
    clock: { nowMs: () => nowMs, setTimeout: setTimer, clearTimeout: clearTimer },
    delays,
    pending: () => timers.size,
    advance: async (deltaMs: number) => {
      nowMs += deltaMs;
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= nowMs).sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
      await Promise.resolve();
    },
  };
}

async function daemonRequest(socketPath: string, method: string, params?: unknown, version = DAEMON_PROTOCOL_VERSION): Promise<{ ok: boolean; result?: unknown; error?: string; version: number }> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath);
    let received = "";
    let settled = false;
    client.setEncoding("utf8");
    client.once("error", reject);
    client.once("close", () => {
      if (!settled) reject(new Error(`Daemon connection closed before '${method}' returned a response.`));
    });
    client.on("data", (chunk) => {
      received += chunk;
      if (!received.includes("\n")) return;
      settled = true;
      client.end();
      resolve(JSON.parse(received.slice(0, received.indexOf("\n"))));
    });
    client.on("connect", () => client.write(`${JSON.stringify({ version, id: "test", method, params })}\n`));
  });
}

function concurrentDaemonRequestBarrier(socketPath: string) {
  const clients = new Map<string, ReturnType<typeof createConnection>>();
  const requests = new Map<string, string>();
  const connected = new Set<string>();
  let released = false;

  const releaseWhenReady = () => {
    if (released || connected.size !== 2) return;
    released = true;
    for (const [label, client] of clients) client.write(requests.get(label)!);
  };

  return (label: string, method: string, params?: unknown): Promise<{ ok: boolean; result?: unknown; error?: string; version: number }> => {
    if (clients.has(label)) throw new Error(`Duplicate barrier label: ${label}`);
    const response = new Promise<{ ok: boolean; result?: unknown; error?: string; version: number }>((resolve, reject) => {
      const client = createConnection(socketPath);
      clients.set(label, client);
      requests.set(label, `${JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, id: `ordered_barrier_${label}`, method, params })}\n`);
      let received = "";
      client.setEncoding("utf8");
      client.once("error", reject);
      client.on("data", (chunk) => {
        received += chunk;
        if (!received.includes("\n")) return;
        client.end();
        resolve(JSON.parse(received.slice(0, received.indexOf("\n"))));
      });
      client.on("connect", () => {
        connected.add(label);
        releaseWhenReady();
      });
    });
    releaseWhenReady();
    return response;
  };
}

function orderedDaemonMutationBarrier(releaseOrder: readonly ["legacy", "supervised"] | readonly ["supervised", "legacy"]) {
  const arrived = new Set<"legacy" | "supervised">();
  const waiting = new Map<"legacy" | "supervised", () => void>();
  let released = false;
  return {
    arrived,
    gate: (request: DaemonRequest): Promise<void> => {
      const label = request.method === "lane.reserve_legacy"
        ? "legacy"
        : request.method === "manifest.put"
          ? "supervised"
          : null;
      if (!label) return Promise.resolve();
      if (arrived.has(label)) throw new Error(`Duplicate mutation barrier arrival: ${label}`);
      arrived.add(label);
      const blocked = new Promise<void>((resolve) => { waiting.set(label, resolve); });
      if (!released && arrived.size === 2) {
        released = true;
        waiting.get(releaseOrder[0])!();
        queueMicrotask(() => waiting.get(releaseOrder[1])!());
      }
      return blocked;
    },
  };
}

const TEST_OID = "a".repeat(40);
const TEST_SUPERVISOR = { supervisor_id: "test-daemon", supervisor_generation: 1 };
async function provisionedWorkspace(root: string, taskId = "task", workAttemptId = randomUUID()): Promise<{ path: string; id: string; bare: string }> {
  const bare = join(root, "repos", "repo.git");
  const path = join(root, "worktrees", "repo", workAttemptId);
  await mkdir(bare, { recursive: true });
  await mkdir(path, { recursive: true });
  await writeFile(join(path, ".letagents-work-attempt.json"), JSON.stringify({ version: 1, repo: "repo", work_attempt_id: workAttemptId, task_id: taskId, remote_url: "https://example.invalid/repo", resolved_revision: TEST_OID, bare_path: bare }));
  return { path, id: workAttemptId, bare };
}
async function committedSourceRepository(root: string, name: string): Promise<string> {
  const source = join(root, name);
  await mkdir(source);
  await execFileAsync("git", ["init", source]);
  await execFileAsync("git", ["-C", source, "config", "user.email", "daemon@example.invalid"]);
  await execFileAsync("git", ["-C", source, "config", "user.name", "Daemon Test"]);
  await writeFile(join(source, "README.md"), `${name}\n`);
  await execFileAsync("git", ["-C", source, "add", "README.md"]);
  await execFileAsync("git", ["-C", source, "commit", "-m", "fixture"]);
  await execFileAsync("git", ["-C", source, "remote", "add", "origin", source]);
  return source;
}
async function primeDaemonBareRepository(root: string, source: string): Promise<void> {
  const repos = join(root, "repos");
  await mkdir(repos, { recursive: true });
  await execFileAsync("git", ["clone", "--bare", source, join(repos, `${repositoryStorageKey(source)}.git`)]);
}
function fakeGit(root: string): (args: string[]) => Promise<string> {
  return async (args) => {
    if (args.includes("--git-common-dir")) return join(root, "repos", "repo.git");
    if (args.includes("remote") && args.includes("get-url")) return "https://example.invalid/repo.git";
    if (args.includes("--is-bare-repository")) return "true";
    if (args.includes("cat-file")) return "ok";
    if (args.includes("rev-parse")) return TEST_OID;
    return "";
  };
}

const entry: DaemonManifestEntry = {
  id: "agent_1", room_id: "room_1", display_name: "Agent", provider: "test", model: null, charter: "test",
  desired_state: "running", observed_state: "idle", condition: "none", permission_profile_id: null, created_by: "test", created_at: "2026-01-01T00:00:00.000Z",
};

test("daemon is visibly gated to macOS", () => {
  assert.throws(() => assertMacOS("linux"), /macOS only/);
});

test("failed room waits remain retryable for one healthy provider execution", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"),
    auditPath: join(env.root, "audit.jsonl"),
    workerBindingsPath: join(env.root, "worker-bindings.json"),
  };
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", {
      entry: { ...entry, id: "terminal_stream", provider: "codex", observed_state: "working" },
    })).ok, true);
    const handle = {
      workAttemptId: "attempt_exact",
      pid: 4100,
      providerContinuationId: "thread_exact",
      providerConnection: null,
      observedState: "failed" as const,
    };
    const internals = daemon as unknown as {
      liveHandles: Map<string, typeof handle>;
      handleProviderStream: (entryId: string, providerHandle: typeof handle, event: {
        workAttemptId: string; providerContinuationId: string; observedAt: string; sequence: number;
        provider: string; kind: string; method: string; payload: unknown; payloadTruncated: boolean;
        payloadRedacted: boolean; durablePayloadRef: null;
      }) => Promise<void>;
    };
    internals.liveHandles.set("terminal_stream", handle);
    const base = {
      workAttemptId: "attempt_exact",
      providerContinuationId: "thread_exact",
      observedAt: new Date().toISOString(),
      provider: "codex",
      payloadTruncated: false,
      payloadRedacted: false,
      durablePayloadRef: null,
    };
    await internals.handleProviderStream("terminal_stream", handle, {
      ...base,
      sequence: 1,
      kind: "item_lifecycle",
      method: "item/completed",
      payload: {
        item: {
          type: "mcpToolCall", id: "wait_codex_failed", server: "letagents", tool: "wait_for_messages",
          status: "failed", result: null, error: { message: "poll failed" },
        },
      },
    });
    let current = (await new ManifestStore(paths.manifestPath).load()).entries[0]!;
    assert.equal(current.observed_state, "idle");
    assert.equal(current.activity?.at(-1)?.status, "idle");

    await internals.handleProviderStream("terminal_stream", handle, {
      ...base,
      sequence: 2,
      kind: "text_delta",
      method: "item/agentMessage/delta",
      payload: { delta: "late evidence" },
    });
    current = (await new ManifestStore(paths.manifestPath).load()).entries[0]!;
    assert.equal(current.observed_state, "working", "the same healthy execution continues after a retryable wait failure");
    assert.equal(current.activity?.at(-1)?.status, "working");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("daemon keeps empty wait results idle across the real stream handler and restart", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"),
    auditPath: join(env.root, "audit.jsonl"),
  };
  const handle = {
    workAttemptId: "attempt_poll",
    pid: 4200,
    providerContinuationId: "claude_poll",
    providerConnection: null,
    observedState: "working" as const,
  };
  type StreamEvent = {
    workAttemptId: string; providerContinuationId: string; observedAt: string; sequence: number;
    provider: string; kind: string; method: string; payload: unknown; payloadTruncated: boolean;
    payloadRedacted: boolean; durablePayloadRef: null;
  };
  type StreamInternals = {
    liveHandles: Map<string, typeof handle>;
    liveBindingIdentities: Map<string, { executionGenerationId: undefined }>;
    handleProviderStream: (entryId: string, providerHandle: typeof handle, event: StreamEvent) => Promise<void>;
    publishNativeActivity: (entryId: string, method: string, status: "working" | "idle") => Promise<boolean>;
  };
  let sequence = 0;
  const event = (method: string, payload: unknown): StreamEvent => ({
    workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId,
    observedAt: new Date(Date.now() + sequence).toISOString(),
    sequence: ++sequence,
    provider: "claude-code",
    kind: "tool_lifecycle",
    method,
    payload,
    payloadTruncated: false,
    payloadRedacted: false,
    durablePayloadRef: null,
  });
  const codexEvent = (method: string, payload: unknown): StreamEvent => ({
    ...event(method, payload),
    provider: "codex",
  });
  const wait = (id: string) => event("assistant", {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "mcp__letagents__wait_for_messages", input: {} }] },
  });
  const result = (id: string, messages: unknown[]) => event("user", {
    type: "user",
    message: { content: [{
      type: "tool_result",
      tool_use_id: id,
      content: [{ type: "text", text: JSON.stringify({ messages, room_id: "focus_37" }) }],
    }] },
  });
  const install = (daemon: SupervisorDaemon, published: Array<"working" | "idle">): StreamInternals => {
    const internals = daemon as unknown as StreamInternals;
    internals.liveHandles.set("quiet_poll", handle);
    internals.liveBindingIdentities.set("quiet_poll", { executionGenerationId: undefined });
    internals.publishNativeActivity = async (_entryId, _method, status) => { published.push(status); return true; };
    return internals;
  };

  const first = new SupervisorDaemon(paths, "darwin");
  let second: SupervisorDaemon | null = null;
  try {
    await first.start();
    await daemonRequest(paths.socketPath, "manifest.put", {
      entry: { ...entry, id: "quiet_poll", room_id: "focus_37", provider: "claude-code", desired_state: "paused" },
    });
    const published: Array<"working" | "idle"> = [];
    const firstInternals = install(first, published);
    await firstInternals.handleProviderStream("quiet_poll", handle, wait("wait_1"));
    await firstInternals.handleProviderStream("quiet_poll", handle, result("wait_1", []));
    await firstInternals.handleProviderStream("quiet_poll", handle, event("assistant", {
      type: "assistant", message: { content: [{ type: "thinking", thinking: "provider-internal handoff" }] },
    }));
    assert.deepEqual(published, ["idle", "idle", "idle"], "empty Claude wait lifecycle never flips room presence to working");
    let projection = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(projection.observed_state, "idle");
    assert.deepEqual(projection.activity?.slice(-3).map((activity) => activity.status), ["idle", "idle", "idle"]);

    await firstInternals.handleProviderStream("quiet_poll", handle, wait("wait_2"));
    await firstInternals.handleProviderStream("quiet_poll", handle, result("wait_2", [{ id: "msg_12", text: "please review" }]));
    assert.equal(published.at(-1), "working", "a nonempty addressed wait result remains visible work");
    projection = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(projection.observed_state, "working");

    const codexStarted = codexEvent("item/started", {
      item: {
        type: "mcpToolCall", id: "wait_codex_real", server: "letagents", tool: "wait_for_messages",
        status: "inProgress", arguments: {}, appContext: null, pluginId: null, result: null, error: null, durationMs: null,
      },
      threadId: "thread_codex",
      turnId: "turn_codex",
      startedAtMs: Date.now(),
    });
    const codexProgress = codexEvent("item/mcpToolCall/progress", {
      itemId: "wait_codex_real", message: "waiting", threadId: "thread_codex", turnId: "turn_codex",
    });
    const codexCompleted = codexEvent("item/completed", {
      item: {
        type: "mcpToolCall", id: "wait_codex_real", server: "letagents", tool: "wait_for_messages",
        status: "completed", arguments: {}, appContext: null, pluginId: null,
        result: {
          content: [{ type: "text", text: JSON.stringify({ messages: [], last_observed_message_id: "msg_13", skipped_message_count: 1 }) }],
          structuredContent: null,
          _meta: null,
        },
        error: null,
        durationMs: 30_000,
      },
      threadId: "thread_codex",
      turnId: "turn_codex",
      completedAtMs: Date.now(),
    });
    await firstInternals.handleProviderStream("quiet_poll", handle, codexStarted);
    await firstInternals.handleProviderStream("quiet_poll", handle, codexProgress);
    await firstInternals.handleProviderStream("quiet_poll", handle, codexCompleted);
    assert.deepEqual(published.slice(-3), ["idle", "idle", "idle"], "real Codex start, progress, and empty/silent completion stay idle");
    projection = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.deepEqual(projection.activity?.slice(-3).map((activity) => activity.status), ["idle", "idle", "idle"]);

    const addressedStarted = codexEvent("item/started", {
      item: {
        type: "mcpToolCall", id: "wait_codex_addressed", server: "letagents", tool: "wait_for_messages",
        status: "inProgress", arguments: {}, appContext: null, pluginId: null, result: null, error: null, durationMs: null,
      },
    });
    const addressedCompleted = codexEvent("item/completed", {
      item: {
        type: "mcpToolCall", id: "wait_codex_addressed", server: "letagents", tool: "wait_for_messages",
        status: "completed", arguments: {}, appContext: null, pluginId: null,
        result: { content: [], structuredContent: { messages: [{ id: "msg_14", text: "please act" }] }, _meta: null },
        error: null,
        durationMs: 1,
      },
    });
    await firstInternals.handleProviderStream("quiet_poll", handle, addressedStarted);
    await firstInternals.handleProviderStream("quiet_poll", handle, addressedCompleted);
    assert.deepEqual(published.slice(-2), ["idle", "working"], "a real addressed Codex completion wakes the work indicator");
    projection = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(projection.observed_state, "working");
    assert.equal(projection.activity?.at(-1)?.status, "working");

    await firstInternals.handleProviderStream("quiet_poll", handle, wait("wait_restart"));
    await first.stop();
    second = new SupervisorDaemon(paths, "darwin");
    await second.start();
    const afterRestart: Array<"working" | "idle"> = [];
    const secondInternals = install(second, afterRestart);
    await secondInternals.handleProviderStream("quiet_poll", handle, result("wait_restart", []));
    assert.deepEqual(afterRestart, ["idle"], "persisted wait correlation survives a daemon restart mid-poll");
    projection = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(projection.observed_state, "idle");
  } finally {
    await second?.stop();
    await first.stop();
    await env.cleanup();
  }
});

test("daemon restart without Electron credential delivery retains inbox work and projects a safe waiting state", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.sqlite"), attemptsRoot: join(env.root, "attempt-data"),
    workspaceRoot: env.root, workerBindingsPath: join(env.root, "worker-bindings.json"),
  };
  const id = "credentialless_restart";
  const workAttemptId = "attempt-credentialless";
  const executionGenerationId = "generation-credentialless";
  const credential = "memory-only-restart-credential";
  const first = new SupervisorDaemon(paths, "darwin");
  let second: SupervisorDaemon | null = null;
  try {
    await first.start();
    const firstInternals = first as unknown as {
      putManifestEntry(entry: Record<string, unknown>): Promise<void>;
      workerBindings: WorkerBindingStore;
      supervisedInbox: import("../supervised-agent-inbox-store.js").SupervisedAgentInboxStore;
    };
    await firstInternals.putManifestEntry({
      ...entry,
      id,
      room_id: "focus_restart",
      provider: "codex",
      delivery_mode: "daemon_inbox",
      observed_state: "working",
      work_attempt_id: workAttemptId,
      provider_ref: {
        work_attempt_id: workAttemptId,
        provider_continuation_id: "thread-credentialless",
        provider_connection: { kind: "codex_app_server", url: "ws://127.0.0.1:65534", pid: 44661, processIdentity: "fixture:44661" },
        execution_generation_id: executionGenerationId,
      },
    });
    await firstInternals.workerBindings.bind({
      entry_id: id,
      room_id: "focus_restart",
      work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId,
      agent_session_id: "agent_session_restart",
      agent_session_token: credential,
      api_url: "https://letagents.test",
    });
    await firstInternals.supervisedInbox.ingestPoll({
      agent_id: id,
      room_id: "focus_restart",
      last_observed_message_id: "42",
      messages: [
        { source_message_id: "41", source_message: { id: "41", text: "queued before restart" }, activation: { decision: "activate" } },
        { source_message_id: "42", source_message: { id: "42", text: "also queued" }, activation: { decision: "activate" } },
      ],
    });
    const before = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0]!;
    assert.equal(before.room_agent_state?.inbox.state, "queued");
    assert.equal(before.room_agent_state?.inbox.pending_count, 2);
    await first.stop();

    second = new SupervisorDaemon(paths, "darwin");
    await second.start();
    const status = await daemonRequest(paths.socketPath, "daemon.status");
    assert.equal(status.ok, true, status.error);
    const after = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0]!;
    assert.equal(after.room_agent_state?.inbox.state, "waiting_for_desktop_credentials");
    assert.equal(after.room_agent_state?.inbox.pending_count, 2, "restart preserves both durable FIFO items");
    assert.deepEqual(after.delivery_receipts?.map((receipt) => [receipt.source_message_id, receipt.state]), [
      ["41", "pending"],
      ["42", "pending"],
    ]);
    assert.equal(after.room_agent_state?.turn.state, "idle", "missing credentials cannot invent an active provider turn");
    const secondInternals = second as unknown as { workerBindings: WorkerBindingStore };
    const persistedBinding = await secondInternals.workerBindings.get(id);
    assert.ok(persistedBinding, "public exact binding metadata survives restart");
    assert.equal(await secondInternals.workerBindings.credentialFor(persistedBinding), null,
      "the successor cannot recover the retired daemon's memory-only bearer");
    const raw = await readFile(paths.manifestPath);
    assert.equal(raw.includes(Buffer.from(credential)), false, "the missing bearer was never serialized beside the retained inbox");
  } finally {
    await second?.stop().catch(() => undefined);
    await first.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("direct manifest convergence shares the per-entry reconciliation lane", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "serialized_direct_convergence");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "serialized_direct_convergence", leaseId: "serialized_direct_convergence", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  let spawnCount = 0;
  const handle = { workAttemptId: attempt.work_attempt_id, pid: 4201, providerContinuationId: "serialized-continuation", observedState: "working" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawnCount += 1; return handle; },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { spawnCount += 1; return handle; },
    poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }),
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  let releaseTick!: () => void;
  let tickEntered!: () => void;
  const tickStarted = new Promise<void>((resolve) => { tickEntered = resolve; });
  const tickHold = new Promise<void>((resolve) => { releaseTick = resolve; });
  try {
    await daemon.start();
    const internals = daemon as unknown as { serializeEntryTick: <T>(entryId: string, operation: () => Promise<T>) => Promise<T> };
    const heldTick = internals.serializeEntryTick("serialized_direct_convergence", async () => { tickEntered(); await tickHold; });
    await tickStarted;
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "serialized_direct_convergence", provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } })).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(spawnCount, 0, "manifest convergence cannot pass an in-flight reconciliation tick");
    releaseTick();
    await heldTick;
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "serialized provider launch");
    assert.equal(spawnCount, 1);
  } finally {
    releaseTick?.();
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("daemon host-grant bind failure retains the exact spawned provider for a later credential retry", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "host_grant_bind_retry");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "host_grant_bind_retry", leaseId: "host_grant_bind_retry", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  const handle = { workAttemptId: attempt.work_attempt_id, pid: 7711, providerContinuationId: "host-grant-continuation", observedState: "working" as const };
  let spawns = 0;
  let stops = 0;
  const mintCalls: Array<{ grantGeneration: number; agentInstanceId: string }> = [];
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawns += 1; return handle; }, attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("must not resume a fresh host-grant provider"); }, poke: async () => {},
    stop: async () => { stops += 1; return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }; },
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const grants = {
    createWorkerSession: async (input: { grantGeneration: number; agentInstanceId: string }) => {
      mintCalls.push(input);
      return { sessionId: "session-host", bearer: "host-bearer-secret", bearerId: "bearer-host", expiresAt: "2030-01-01T00:00:00.000Z" };
    },
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, grants);
  try {
    await daemon.start();
    const internals = daemon as unknown as { workerBindings: WorkerBindingStore; publishNativeActivity: () => Promise<boolean> };
    const originalBind = internals.workerBindings.bind.bind(internals.workerBindings);
    internals.publishNativeActivity = async () => true;
    internals.workerBindings.bind = async () => { throw new Error("simulated binding write failure"); };
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "host_grant_bind_retry", provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(spawns, 0, "daemon_inbox Codex cannot spawn without the desktop grant");
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const install = { entry_id: "host_grant_bind_retry", room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-1", supervisor_grant: "host-grant-secret", grant_generation: 7, api_url: "http://127.0.0.1:3000", host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z", daemon_generation: generation };
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", install)).ok, true);
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.condition === "coordination_blocked", "post-spawn binding failure");
    assert.equal(spawns, 1);
    assert.equal(stops, 0, "credential failure must never stop the spawned provider");
    const beforeRetry = await daemonRequest(paths.socketPath, "attempt.read", { id: "host_grant_bind_retry" });
    assert.equal((beforeRetry.result as { execution_generations: Array<{ terminal: unknown }> }).execution_generations[0]?.terminal, null);
    internals.workerBindings.bind = originalBind;
    const retryInstall = await daemonRequest(paths.socketPath, "supervisor.install_host_grant", install);
    assert.equal(retryInstall.ok, true, retryInstall.error);
    await eventually(async () => Boolean(await internals.workerBindings.get("host_grant_bind_retry")), "host worker binding retry");
    assert.equal(spawns, 1, "retry rebinds the exact provider rather than spawning a replacement");
    assert.equal(mintCalls.every((call) => call.grantGeneration === 7 && call.agentInstanceId === "daemon:host_grant_bind_retry"), true);
    const raw = await readFile(paths.manifestPath);
    assert.equal(raw.includes(Buffer.from("host-grant-secret")), false);
    assert.equal(raw.includes(Buffer.from("host-bearer-secret")), false);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("handoff during delayed host-grant mint creates no generation and the successor launches once", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "delayed_host_grant_handoff");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "delayed_host_grant_handoff", leaseId: "delayed_host_grant_handoff", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  let spawns = 0;
  const handle = { workAttemptId: attempt.work_attempt_id, pid: 8812, providerContinuationId: "successor-host-grant-continuation", observedState: "working" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawns += 1; return handle; }, attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("pre-spawn recovery must launch one fresh provider"); }, poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }),
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  let mintEntered!: () => void;
  const mintStarted = new Promise<void>((resolve) => { mintEntered = resolve; });
  let releaseMint!: () => void;
  const mintGate = new Promise<void>((resolve) => { releaseMint = resolve; });
  const first = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    createWorkerSession: async () => {
      mintEntered();
      await mintGate;
      return { sessionId: "retired-session", bearer: "retired-bearer", bearerId: "retired-bearer-id", expiresAt: null };
    },
  });
  let second: SupervisorDaemon | null = null;
  try {
    await first.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "delayed_host_grant_handoff", provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    const firstGeneration = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: "delayed_host_grant_handoff", room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-delayed",
      supervisor_grant: "first-grant", grant_generation: 1, api_url: "https://letagents.example", daemon_generation: firstGeneration,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    await mintStarted;
    const beforeHandoff = (await daemonRequest(paths.socketPath, "attempt.read", { id: "delayed_host_grant_handoff" })).result as { execution_generations: unknown[] };
    assert.equal(beforeHandoff.execution_generations.length, 0, "remote mint cannot expose an unowned durable generation");
    const handoff = first.waitForHandoff();
    assert.equal((await daemonRequest(paths.socketPath, "daemon.prepare_handoff")).ok, true);
    await within(handoff, "delayed mint daemon handoff", 1_000);

    second = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, {}, {
      poll: async () => ({ messages: [] }), publish: async () => {},
    }, {
      createWorkerSession: async () => ({ sessionId: "successor-session", bearer: "successor-bearer", bearerId: "successor-bearer-id", expiresAt: null }),
    });
    await second.start();
    (second as unknown as { publishNativeActivity: () => Promise<boolean> }).publishNativeActivity = async () => true;
    const secondGeneration = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: "delayed_host_grant_handoff", room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-delayed",
      supervisor_grant: "second-grant", grant_generation: 2, api_url: "https://letagents.example", daemon_generation: secondGeneration,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0];
      return spawns === 1 && current?.provider_ref?.provider_continuation_id === handle.providerContinuationId;
    }, "successor launch after retired pre-generation mint");
    const recovered = (await daemonRequest(paths.socketPath, "attempt.read", { id: "delayed_host_grant_handoff" })).result as { execution_generations: Array<{ terminal: unknown }> };
    assert.equal(recovered.execution_generations.length, 1);
    assert.equal(recovered.execution_generations[0]?.terminal, null);
    assert.equal(spawns, 1, "successor creates the only provider generation");
    releaseMint();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const afterLateMint = (await daemonRequest(paths.socketPath, "attempt.read", { id: "delayed_host_grant_handoff" })).result as { execution_generations: unknown[] };
    assert.equal(afterLateMint.execution_generations.length, 1);
    assert.equal(spawns, 1, "late retired mint completion cannot create a generation or provider");
  } finally {
    releaseMint?.();
    await second?.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("pause fences a launch waiting on host-grant mint before any generation or provider exists", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "pause_during_host_grant_mint");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "pause_during_host_grant_mint", leaseId: "pause_during_host_grant_mint", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  let mintEntered!: () => void;
  const mintStarted = new Promise<void>((resolve) => { mintEntered = resolve; });
  let releaseMint!: () => void;
  const mintGate = new Promise<void>((resolve) => { releaseMint = resolve; });
  let spawns = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawns += 1; throw new Error("paused launch must not dispatch"); },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("paused launch must not resume"); }, poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    createWorkerSession: async () => {
      mintEntered();
      await mintGate;
      return { sessionId: "paused-session", bearer: "paused-bearer", bearerId: "paused-bearer-id", expiresAt: null };
    },
  });
  try {
    await daemon.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "pause_during_host_grant_mint", provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: "pause_during_host_grant_mint", room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-pause",
      supervisor_grant: "pause-grant", grant_generation: 1, api_url: "https://letagents.example", daemon_generation: generation,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    await mintStarted;
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "pause_during_host_grant_mint", desired_state: "paused",
    })).ok, true);
    releaseMint();
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "paused", "paused delayed grant launch");
    const result = (await daemonRequest(paths.socketPath, "attempt.read", { id: "pause_during_host_grant_mint" })).result as { execution_generations: unknown[] };
    assert.equal(result.execution_generations.length, 0);
    assert.equal(spawns, 0);
  } finally {
    releaseMint?.();
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("stop fences a launch waiting on provider capabilities before generation creation", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "stop_during_capabilities");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "stop_during_capabilities", leaseId: "stop_during_capabilities", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  let capabilitiesEntered!: () => void;
  const capabilitiesStarted = new Promise<void>((resolve) => { capabilitiesEntered = resolve; });
  let releaseCapabilities!: () => void;
  const capabilitiesGate = new Promise<void>((resolve) => { releaseCapabilities = resolve; });
  let spawns = 0;
  const port: ProviderActionPort = {
    capabilities: async () => {
      capabilitiesEntered();
      await capabilitiesGate;
      return { resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true };
    },
    spawn: async () => { spawns += 1; throw new Error("stopped launch must not dispatch"); },
    attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("stopped launch must not resume"); }, poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  try {
    await daemon.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "stop_during_capabilities", provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    await capabilitiesStarted;
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "stop_during_capabilities", desired_state: "stopped",
    })).ok, true);
    releaseCapabilities();
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "stopped", "stopped delayed capabilities launch");
    const result = (await daemonRequest(paths.socketPath, "attempt.read", { id: "stop_during_capabilities" })).result as { execution_generations: unknown[] };
    assert.equal(result.execution_generations.length, 0);
    assert.equal(spawns, 0);
  } finally {
    releaseCapabilities?.();
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("stop during grant mint and pause during capabilities both fence before provider dispatch", async () => {
  const runCase = async (boundary: "mint" | "capabilities", desiredState: "paused" | "stopped") => {
    const env = await fixture();
    const id = `${desiredState}_during_${boundary}`;
    const paths = {
      lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
      manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
      attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
    };
    const workspace = await provisionedWorkspace(env.root, id);
    const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
    const attempt = await durability.createAttempt({ taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
    await durability.close();
    let boundaryEntered!: () => void;
    const boundaryStarted = new Promise<void>((resolve) => { boundaryEntered = resolve; });
    let releaseBoundary!: () => void;
    const boundaryGate = new Promise<void>((resolve) => { releaseBoundary = resolve; });
    let spawns = 0;
    const port: ProviderActionPort = {
      capabilities: async () => {
        if (boundary === "capabilities") { boundaryEntered(); await boundaryGate; }
        return { resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true };
      },
      spawn: async () => { spawns += 1; throw new Error("fenced delayed launch must not dispatch"); },
      attach: async () => null, attachAction: async () => ({ state: "absent" }),
      resume: async () => { throw new Error("fenced delayed launch must not resume"); }, poke: async () => {},
      stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
      onExit: async () => () => {}, onStream: async () => () => {},
    };
    const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, {}, {
      poll: async () => ({ messages: [] }), publish: async () => {},
    }, {
      createWorkerSession: async () => {
        if (boundary === "mint") { boundaryEntered(); await boundaryGate; }
        return { sessionId: `${id}-session`, bearer: `${id}-bearer`, bearerId: `${id}-bearer-id`, expiresAt: null };
      },
    });
    try {
      await daemon.start();
      await daemonRequest(paths.socketPath, "manifest.put", { entry: {
        ...entry, id, provider: boundary === "mint" ? "codex" : "claude-code",
        delivery_mode: boundary === "mint" ? "daemon_inbox" : "mcp_polling", observed_state: "absent",
        workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
      } });
      if (boundary === "mint") {
        const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
        assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
          entry_id: id, room_id: entry.room_id, agent_key: "owner/agent", grant_id: `grant-${id}`,
          supervisor_grant: `${id}-grant`, grant_generation: 1, api_url: "https://letagents.example", daemon_generation: generation,
          host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
        })).ok, true);
      }
      await boundaryStarted;
      assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id, desired_state: desiredState })).ok, true);
      releaseBoundary();
      await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === desiredState, `${desiredState} ${boundary} fence`);
      const result = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: unknown[] };
      assert.equal(result.execution_generations.length, 0);
      assert.equal(spawns, 0);
    } finally {
      releaseBoundary?.();
      await daemon.stop().catch(() => undefined);
      await env.cleanup();
    }
  };
  await runCase("mint", "stopped");
  await runCase("capabilities", "paused");
});

test("pause arriving during provider dispatch persists and fences the exact returned handle", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "pause_during_dispatch");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "pause_during_dispatch", leaseId: "pause_during_dispatch", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  let spawnEntered!: () => void;
  const spawnStarted = new Promise<void>((resolve) => { spawnEntered = resolve; });
  let releaseSpawn!: () => void;
  const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
  const returnedHandle = { workAttemptId: attempt.work_attempt_id, pid: 44551, providerContinuationId: "pause-dispatch-continuation", observedState: "working" as const };
  const stoppedHandles: typeof returnedHandle[] = [];
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawnEntered(); await spawnGate; return returnedHandle; },
    attach: async () => { throw new Error("dispatch fencing must not infer the returned handle via attach"); },
    attachAction: async () => { throw new Error("dispatch fencing must not inspect attachAction"); },
    resume: async () => { throw new Error("fresh dispatch must not resume"); }, poke: async () => {},
    stop: async (handle) => {
      stoppedHandles.push(handle as typeof returnedHandle);
      return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId };
    },
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  try {
    await daemon.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "pause_during_dispatch", provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    await spawnStarted;
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "pause_during_dispatch", desired_state: "paused",
    })).ok, true);
    releaseSpawn();
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "paused", "paused dispatch fence");
    const manifest = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(manifest.provider_ref?.provider_continuation_id, returnedHandle.providerContinuationId, "the exact returned identity is durable before fencing");
    assert.deepEqual(stoppedHandles, [returnedHandle]);
    const result = (await daemonRequest(paths.socketPath, "attempt.read", { id: "pause_during_dispatch" })).result as { execution_generations: Array<{ terminal: { terminal_cause: string } | null }> };
    assert.equal(result.execution_generations.length, 1);
    assert.equal(result.execution_generations[0]?.terminal?.terminal_cause, "stopped");
  } finally {
    releaseSpawn?.();
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("handoff during provider dispatch persists the exact handle for successor attach without signaling it", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "handoff_during_dispatch");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "handoff_during_dispatch", leaseId: "handoff_during_dispatch", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  let spawnEntered!: () => void;
  const spawnStarted = new Promise<void>((resolve) => { spawnEntered = resolve; });
  let releaseSpawn!: () => void;
  const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
  const returnedHandle = { workAttemptId: attempt.work_attempt_id, pid: 55441, providerContinuationId: "handoff-dispatch-continuation", observedState: "working" as const };
  let spawns = 0;
  let attaches = 0;
  let stops = 0;
  let exitRegistrations = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawns += 1; spawnEntered(); await spawnGate; return returnedHandle; },
    attach: async (ref) => {
      attaches += 1;
      assert.equal(ref.providerContinuationId, returnedHandle.providerContinuationId);
      return returnedHandle;
    },
    attachAction: async () => { throw new Error("handoff successor uses the durable provider ref, not action inference"); },
    resume: async () => { throw new Error("successor must attach instead of resume/spawn"); }, poke: async () => {},
    stop: async () => { stops += 1; return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: returnedHandle.providerContinuationId }; },
    onExit: async () => { exitRegistrations += 1; return () => {}; }, onStream: async () => () => {},
  };
  const first = new SupervisorDaemon(paths, "darwin", port, true);
  let second: SupervisorDaemon | null = null;
  try {
    await first.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "handoff_during_dispatch", provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    await spawnStarted;
    const handoff = first.waitForHandoff();
    const prepare = daemonRequest(paths.socketPath, "daemon.prepare_handoff");
    let handoffFinished = false;
    void handoff.then(() => { handoffFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(handoffFinished, false, "handoff holds stores only after native dispatch has begun");
    releaseSpawn();
    assert.equal((await prepare).ok, true);
    await within(handoff, "dispatch persistence handoff", 1_000);
    assert.equal(stops, 0, "handoff preserves the provider process");
    assert.equal(exitRegistrations, 0, "the retiring daemon registers no callbacks on the returned handle");

    second = new SupervisorDaemon(paths, "darwin", port, true);
    await second.start();
    await eventually(async () => attaches === 1
      && (second as unknown as { liveHandles: Map<string, typeof returnedHandle> }).liveHandles.get("handoff_during_dispatch") === returnedHandle,
    "successor exact provider attach");
    const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.equal(current.provider_ref?.provider_continuation_id, returnedHandle.providerContinuationId);
    const live = (second as unknown as { liveHandles: Map<string, typeof returnedHandle> }).liveHandles.get("handoff_during_dispatch");
    assert.equal(live?.pid, returnedHandle.pid);
    assert.equal(live?.providerContinuationId, returnedHandle.providerContinuationId);
    const result = (await daemonRequest(paths.socketPath, "attempt.read", { id: "handoff_during_dispatch" })).result as { execution_generations: Array<{ execution_generation_id: string; terminal: unknown }> };
    assert.equal(result.execution_generations.length, 1);
    assert.equal(result.execution_generations[0]?.execution_generation_id, current.provider_ref?.execution_generation_id);
    assert.equal(result.execution_generations[0]?.terminal, null);
    assert.equal(spawns, 1);
    assert.equal(stops, 0);
  } finally {
    releaseSpawn?.();
    await second?.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("handoff winning the normal post-dispatch commit falls back to exact retirement persistence", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const id = "handoff_during_provider_commit";
  const workspace = await provisionedWorkspace(env.root, id);
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  const returnedHandle = { workAttemptId: attempt.work_attempt_id, pid: 55442, providerContinuationId: "handoff-commit-continuation", observedState: "working" as const };
  let commitEntered!: () => void;
  const commitStarted = new Promise<void>((resolve) => { commitEntered = resolve; });
  let releaseCommit!: () => void;
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  let gated = false;
  let providerRefReplaceCalls = 0;
  let handoffRequested = false;
  let retirementConflictInjected = false;
  let spawns = 0;
  let attaches = 0;
  let stops = 0;
  let exitRegistrations = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawns += 1; return returnedHandle; },
    attach: async (ref) => { attaches += 1; assert.equal(ref.providerContinuationId, returnedHandle.providerContinuationId); return returnedHandle; },
    attachAction: async () => { throw new Error("successor must use exact durable provider ref"); },
    resume: async () => { throw new Error("successor must attach"); }, poke: async () => {},
    stop: async () => { stops += 1; return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: returnedHandle.providerContinuationId }; },
    onExit: async () => { exitRegistrations += 1; return () => {}; }, onStream: async () => () => {},
  };
  const first = new SupervisorDaemon(paths, "darwin", port, true);
  let second: SupervisorDaemon | null = null;
  try {
    await first.start();
    const store = (first as unknown as { store: ManifestStore }).store;
    const originalReplace = store.replaceEntry.bind(store);
    store.replaceEntry = async (expected, updated, fence) => {
      const providerRefWrite = updated.provider_ref?.provider_continuation_id === returnedHandle.providerContinuationId;
      if (providerRefWrite) providerRefReplaceCalls += 1;
      if (!gated && providerRefWrite) {
        gated = true;
        commitEntered();
        await commitGate;
      }
      if (providerRefReplaceCalls >= 2 && handoffRequested && !retirementConflictInjected && providerRefWrite) {
        retirementConflictInjected = true;
        const admitted = await store.getEntry(id);
        assert(admitted);
        await originalReplace(expected, { ...admitted, charter: `${admitted.charter} admitted-before-handoff` }, async (commit) => commit());
        throw new ManifestConflictError("injected admitted mutation advanced the manifest generation");
      }
      return originalReplace(expected, updated, fence);
    };
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id, provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    await commitStarted;
    const handoff = first.waitForHandoff();
    handoffRequested = true;
    const prepare = daemonRequest(paths.socketPath, "daemon.prepare_handoff");
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseCommit();
    assert.equal((await prepare).ok, true);
    await within(handoff, "commit-boundary retirement persistence", 1_000);
    assert.equal(stops, 0);
    assert.equal(exitRegistrations, 0, "retiring daemon installs no callbacks after fallback persistence");

    second = new SupervisorDaemon(paths, "darwin", port, true);
    await second.start();
    await eventually(async () => attaches === 1, "successor attach after normal commit lost to handoff");
    const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    const result = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: Array<{ execution_generation_id: string; terminal: unknown }> };
    assert.equal(current.provider_ref?.provider_continuation_id, returnedHandle.providerContinuationId);
    assert.match(current.charter, /admitted-before-handoff/);
    assert.equal(result.execution_generations.length, 1);
    assert.equal(result.execution_generations[0]?.execution_generation_id, current.provider_ref?.execution_generation_id);
    assert.equal(result.execution_generations[0]?.terminal, null);
    assert.equal(spawns, 1);
    assert.equal(stops, 0);
  } finally {
    releaseCommit?.();
    await second?.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("pause and stop at the normal post-dispatch commit fence the exact returned handle", async () => {
  const runCase = async (desiredState: "paused" | "stopped") => {
    const env = await fixture();
    const id = `${desiredState}_during_provider_commit`;
    const paths = {
      lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
      manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
      attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
    };
    const workspace = await provisionedWorkspace(env.root, id);
    const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
    const attempt = await durability.createAttempt({ taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
    await durability.close();
    const returnedHandle = { workAttemptId: attempt.work_attempt_id, pid: desiredState === "paused" ? 55443 : 55444, providerContinuationId: `${id}-continuation`, observedState: "working" as const };
    let commitEntered!: () => void;
    const commitStarted = new Promise<void>((resolve) => { commitEntered = resolve; });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    let gated = false;
    const stopped: typeof returnedHandle[] = [];
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
      spawn: async () => returnedHandle, attach: async () => { throw new Error("control fence uses the returned handle directly"); },
      attachAction: async () => { throw new Error("control fence never infers the action"); }, resume: async () => { throw new Error("fresh launch"); }, poke: async () => {},
      stop: async (handle) => { stopped.push(handle as typeof returnedHandle); return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }; },
      onExit: async () => () => {}, onStream: async () => () => {},
    };
    const daemon = new SupervisorDaemon(paths, "darwin", port, true);
    try {
      await daemon.start();
      const store = (daemon as unknown as { store: ManifestStore }).store;
      const originalReplace = store.replaceEntry.bind(store);
      store.replaceEntry = async (expected, updated, fence) => {
        if (!gated && updated.provider_ref?.provider_continuation_id === returnedHandle.providerContinuationId) {
          gated = true;
          commitEntered();
          await commitGate;
        }
        return originalReplace(expected, updated, fence);
      };
      await daemonRequest(paths.socketPath, "manifest.put", { entry: {
        ...entry, id, provider: "claude-code", observed_state: "absent",
        workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
      } });
      await commitStarted;
      const control = daemonRequest(paths.socketPath, "manifest.set_desired_state", { id, desired_state: desiredState });
      await new Promise((resolve) => setTimeout(resolve, 10));
      releaseCommit();
      assert.equal((await control).ok, true);
      await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === desiredState, `${desiredState} commit fence`);
      assert.deepEqual(stopped, [returnedHandle]);
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      const result = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: Array<{ terminal: unknown }> };
      assert.equal(current.provider_ref?.provider_continuation_id, returnedHandle.providerContinuationId);
      assert.equal(result.execution_generations.length, 1);
      assert.notEqual(result.execution_generations[0]?.terminal, null);
    } finally {
      releaseCommit?.();
      await daemon.stop().catch(() => undefined);
      await env.cleanup();
    }
  };
  await runCase("paused");
  await runCase("stopped");
});

test("fatal returned-handle journal and stop failure rejects handoff before acknowledgement without unhandled rejection", async () => {
  const env = await fixture();
  const id = "fatal_unjournaled_dispatch";
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, id);
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  const returnedHandle = { workAttemptId: attempt.work_attempt_id, pid: 55446, providerContinuationId: "fatal-unjournaled-continuation", observedState: "working" as const };
  let stopEntered!: () => void;
  const stopStarted = new Promise<void>((resolve) => { stopEntered = resolve; });
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => returnedHandle, attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("fresh launch"); }, poke: async () => {},
    stop: async () => { stopEntered(); throw new Error("injected exact-stop failure"); },
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  try {
    await daemon.start();
    const store = (daemon as unknown as { store: ManifestStore }).store;
    const originalReplace = store.replaceEntry.bind(store);
    store.replaceEntry = async (expected, updated, fence) => {
      if (updated.provider_ref?.provider_continuation_id === returnedHandle.providerContinuationId) {
        throw new Error("injected provider journal failure");
      }
      return originalReplace(expected, updated, fence);
    };
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id, provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    await stopStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    const prepare = await daemonRequest(paths.socketPath, "daemon.prepare_handoff");
    assert.equal(prepare.ok, false);
    assert.match(prepare.error ?? "", /exact-stop failure|journaled or exactly fenced/i);
    const status = await daemonRequest(paths.socketPath, "daemon.status");
    assert.equal(status.ok, true, "failed preflight retains socket and singleton authority");
    assert.equal(((status.result as { generation: number }).generation > 0), true);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("pause during post-install worker bind fences the exact provider before delivery starts", async () => {
  const env = await fixture();
  const id = "pause_during_post_install_bind";
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, id);
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  const returnedHandle = { workAttemptId: attempt.work_attempt_id, pid: 55445, providerContinuationId: "pause-bind-continuation", observedState: "working" as const };
  let bindEntered!: () => void;
  const bindStarted = new Promise<void>((resolve) => { bindEntered = resolve; });
  let releaseBind!: () => void;
  const bindGate = new Promise<void>((resolve) => { releaseBind = resolve; });
  const stopped: typeof returnedHandle[] = [];
  let deliveryStarts = 0;
  let nativePublications = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => returnedHandle, attach: async () => { throw new Error("bind control fence uses the returned handle"); },
    attachAction: async () => { throw new Error("bind control fence never infers the action"); }, resume: async () => { throw new Error("fresh launch"); }, poke: async () => {},
    stop: async (handle) => { stopped.push(handle as typeof returnedHandle); return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }; },
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, {}, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    createWorkerSession: async () => ({ sessionId: "pause-bind-session", bearer: "pause-bind-bearer", bearerId: "pause-bind-bearer-id", expiresAt: null }),
  });
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      workerBindings: WorkerBindingStore;
      publishNativeActivity: () => Promise<boolean>;
      startSupervisedDelivery: (entryId: string) => Promise<void>;
    };
    const originalBind = internals.workerBindings.bind.bind(internals.workerBindings);
    internals.workerBindings.bind = async (input) => {
      bindEntered();
      await bindGate;
      return originalBind(input);
    };
    internals.publishNativeActivity = async () => { nativePublications += 1; return true; };
    internals.startSupervisedDelivery = async () => { deliveryStarts += 1; };
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id, provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: id, room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-pause-bind",
      supervisor_grant: "pause-bind-parent", grant_generation: 1, api_url: "https://letagents.example", daemon_generation: generation,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    await bindStarted;
    const pause = daemonRequest(paths.socketPath, "manifest.set_desired_state", { id, desired_state: "paused" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseBind();
    assert.equal((await pause).ok, true);
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "paused", "post-bind pause fence");
    assert.deepEqual(stopped, [returnedHandle]);
    assert.equal(deliveryStarts, 0);
    assert.equal(nativePublications, 0);
    const result = (await daemonRequest(paths.socketPath, "attempt.read", { id })).result as { execution_generations: Array<{ terminal: unknown }> };
    assert.equal(result.execution_generations.length, 1);
    assert.notEqual(result.execution_generations[0]?.terminal, null);
  } finally {
    releaseBind?.();
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("a live daemon rotates an expiring host worker bearer without reinstalling the grant or restarting the provider", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "host_grant_expiry_rotation");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "host_grant_expiry_rotation", leaseId: "host_grant_expiry_rotation", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  let clock = Date.parse("2026-07-21T12:00:00.000Z");
  let spawns = 0;
  let mintCalls = 0;
  const handle = { workAttemptId: attempt.work_attempt_id, pid: 9914, providerContinuationId: "rotating-host-grant-continuation", observedState: "working" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawns += 1; return handle; }, attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("bearer rotation must retain the live provider"); }, poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }),
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 10, undefined, { nowMs: () => clock }, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    createWorkerSession: async () => {
      mintCalls += 1;
      return mintCalls === 1
        ? { sessionId: "rotating-session", bearer: "first-rotating-bearer", bearerId: "first-rotating-bearer-id", expiresAt: new Date(clock + 120_000).toISOString() }
        : { sessionId: "rotating-session", bearer: "second-rotating-bearer", bearerId: "second-rotating-bearer-id", expiresAt: new Date(clock + 3_600_000).toISOString() };
    },
  });
  try {
    await daemon.start();
    const internals = daemon as unknown as { workerBindings: WorkerBindingStore; publishNativeActivity: () => Promise<boolean> };
    internals.publishNativeActivity = async () => true;
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "host_grant_expiry_rotation", provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    const daemonGeneration = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: "host_grant_expiry_rotation", room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-rotation",
      supervisor_grant: "rotation-grant", grant_generation: 1, api_url: "https://letagents.example", daemon_generation: daemonGeneration,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
    })).ok, true);
    let firstBinding: Awaited<ReturnType<WorkerBindingStore["get"]>> = null;
    await eventually(async () => {
      firstBinding = await internals.workerBindings.get("host_grant_expiry_rotation");
      return firstBinding?.credential_ref === "first-rotating-bearer-id";
    }, "initial host worker bearer binding");
    assert(firstBinding);
    assert.equal(await internals.workerBindings.credentialFor(firstBinding), "first-rotating-bearer");

    clock += 61_000;
    await eventually(async () => {
      const current = await internals.workerBindings.get("host_grant_expiry_rotation");
      return mintCalls === 2 && current?.credential_ref === "second-rotating-bearer-id";
    }, "automatic host worker bearer rotation");
    const rotated = await internals.workerBindings.get("host_grant_expiry_rotation");
    assert(rotated);
    assert.equal(await internals.workerBindings.credentialFor(rotated), "second-rotating-bearer");
    const credentialVault = (internals.workerBindings as unknown as { credentials: Map<string, unknown> }).credentials;
    assert.equal(credentialVault.has("first-rotating-bearer-id"), false, "the replaced bearer is revoked from the in-memory vault");
    assert.equal(spawns, 1, "bearer rotation must not restart the provider");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("host grant renewal retries transient failures, rotates the bearer in place, and rejects stale Electron rollback", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "host_grant_renewal_retry");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "host_grant_renewal_retry", leaseId: "host_grant_renewal_retry", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  await durability.close();
  let clock = Date.parse("2026-07-21T12:00:00.000Z");
  let spawns = 0;
  let stops = 0;
  let renewalCalls = 0;
  let mintCalls = 0;
  const handle = { workAttemptId: attempt.work_attempt_id, pid: 9915, providerContinuationId: "renewing-host-grant-continuation", observedState: "working" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawns += 1; return handle; }, attach: async () => null, attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("grant renewal must retain the exact provider"); }, poke: async () => {},
    stop: async () => { stops += 1; return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }; },
    onExit: async () => () => {}, onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 10, undefined, { nowMs: () => clock }, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    renewHostGrant: async (input) => {
      renewalCalls += 1;
      if (renewalCalls === 1) throw new Error("temporary renewal transport failure");
      return {
        grantId: input.grantId, supervisorGrant: "renewed-parent-secret",
        grantGeneration: input.grantGeneration, expiresAt: new Date(clock + 24 * 60 * 60_000).toISOString(),
      };
    },
    createWorkerSession: async () => {
      mintCalls += 1;
      if (mintCalls === 2) throw new Error("temporary child-session transport failure");
      return mintCalls === 1
        ? { sessionId: "renewal-session", bearer: "pre-renewal-bearer", bearerId: "pre-renewal-bearer-id", expiresAt: new Date(clock + 30_000).toISOString() }
        : { sessionId: "renewal-session", bearer: "renewed-worker-bearer", bearerId: "renewed-worker-bearer-id", expiresAt: new Date(clock + 3_600_000).toISOString() };
    },
  });
  try {
    await daemon.start();
    const internals = daemon as unknown as {
      workerBindings: WorkerBindingStore;
      hostGrants: Map<string, { supervisorGrant: string; expiresAt: string }>;
      publishNativeActivity: () => Promise<boolean>;
    };
    internals.publishNativeActivity = async () => true;
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "host_grant_renewal_retry", provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } });
    const daemonGeneration = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const staleInstall = {
      entry_id: "host_grant_renewal_retry", room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-renewal",
      supervisor_grant: "pre-renewal-parent-secret", grant_generation: 1, api_url: "https://letagents.example", daemon_generation: daemonGeneration,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: new Date(clock + 30 * 60_000).toISOString(),
    };
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", staleInstall)).ok, true);
    await eventually(async () => {
      const binding = await internals.workerBindings.get("host_grant_renewal_retry");
      return renewalCalls >= 2 && mintCalls >= 3 && binding?.credential_ref === "renewed-worker-bearer-id";
    }, "parent renewal and transient child-session retry");
    const beforeStale = internals.hostGrants.get("host_grant_renewal_retry")!;
    assert.equal(beforeStale.supervisorGrant, "renewed-parent-secret");
    const renewedExpiry = beforeStale.expiresAt;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", staleInstall)).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterStale = internals.hostGrants.get("host_grant_renewal_retry")!;
    assert.equal(afterStale.supervisorGrant, "renewed-parent-secret");
    assert.equal(afterStale.expiresAt, renewedExpiry);
    const binding = await internals.workerBindings.get("host_grant_renewal_retry");
    assert(binding);
    assert.equal(await internals.workerBindings.credentialFor(binding), "renewed-worker-bearer");
    const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
    assert.notEqual(current.condition, "auth_blocked", "transient renewal failures preserve still-valid authority");
    const result = (await daemonRequest(paths.socketPath, "attempt.read", { id: "host_grant_renewal_retry" })).result as { execution_generations: Array<{ terminal: unknown }> };
    assert.equal(result.execution_generations.length, 1);
    assert.equal(result.execution_generations[0]?.terminal, null);
    assert.equal(spawns, 1);
    assert.equal(stops, 0);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("expired and definitively rejected host grants become auth-blocked without stopping the provider", async () => {
  const runCase = async (rejection: "expired" | 401 | 403 | 409) => {
    const env = await fixture();
    const id = `host_grant_block_${rejection}`;
    const paths = {
      lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
      manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
      attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
    };
    const workspace = await provisionedWorkspace(env.root, id);
    const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
    const attempt = await durability.createAttempt({ taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
    await durability.close();
    let clock = Date.parse("2026-07-21T12:00:00.000Z");
    let stops = 0;
    let renewals = 0;
    const handle = { workAttemptId: attempt.work_attempt_id, pid: 9970 + (typeof rejection === "number" ? rejection : 0), providerContinuationId: `${id}-continuation`, observedState: "working" as const };
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
      spawn: async () => handle, attach: async () => null, attachAction: async () => ({ state: "absent" }),
      resume: async () => { throw new Error("authority failure must retain the provider"); }, poke: async () => {},
      stop: async () => { stops += 1; return { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }; },
      onExit: async () => () => {}, onStream: async () => () => {},
    };
    const daemon = new SupervisorDaemon(paths, "darwin", port, true, 10, undefined, { nowMs: () => clock }, {
      poll: async () => ({ messages: [] }), publish: async () => {},
    }, {
      renewHostGrant: async () => {
        renewals += 1;
        if (typeof rejection === "number") throw new SupervisorGrantRequestError(rejection, "injected renewal");
        throw new Error("expired grant must not be renewed");
      },
      createWorkerSession: async () => ({
        sessionId: `${id}-session`, bearer: `${id}-bearer`, bearerId: `${id}-bearer-id`,
        expiresAt: new Date(clock + 24 * 60 * 60_000).toISOString(),
      }),
    });
    try {
      await daemon.start();
      const internals = daemon as unknown as {
        liveHandles: Map<string, typeof handle>;
        hostGrants: Map<string, unknown>;
        publishNativeActivity: () => Promise<boolean>;
      };
      internals.publishNativeActivity = async () => true;
      await daemonRequest(paths.socketPath, "manifest.put", { entry: {
        ...entry, id, provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
        workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
      } });
      const daemonGeneration = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
      assert.equal((await daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
        entry_id: id, room_id: entry.room_id, agent_key: "owner/agent", grant_id: `grant-${id}`,
        supervisor_grant: `${id}-parent`, grant_generation: 1, api_url: "https://letagents.example", daemon_generation: daemonGeneration,
        host_id: "host-1", installation_id: "installation-1", grant_expires_at: new Date(clock + 2 * 60 * 60_000).toISOString(),
      })).ok, true);
      await eventually(async () => internals.liveHandles.get(id) === handle, `${id} initial provider`);
      clock += rejection === "expired" ? 2 * 60 * 60_000 + 1 : 61 * 60_000;
      await eventually(async () => {
        const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0];
        return current?.condition === "auth_blocked" && current.observed_state === "recovering";
      }, `${id} auth block`);
      assert.equal(internals.liveHandles.get(id), handle, "authority loss preserves the exact provider handle");
      assert.equal(internals.hostGrants.has(id), false, "rejected plaintext parent authority is removed from memory");
      assert.equal(stops, 0);
      assert.equal(rejection === "expired" ? renewals === 0 : renewals >= 1, true);
    } finally {
      await daemon.stop().catch(() => undefined);
      await env.cleanup();
    }
  };
  await runCase("expired");
  await runCase(401);
  await runCase(403);
  await runCase(409);
});

test("an unattached live durable generation blocks a duplicate provider start", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "unattached_live_generation");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR);
  const attempt = await durability.createAttempt({ taskId: "unattached_live_generation", leaseId: "unattached_live_generation", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  const execution = await durability.startGeneration(attempt.work_attempt_id, "daemon-provider", 1);
  let spawnCount = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawnCount += 1; throw new Error("must not mint a duplicate generation"); },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { spawnCount += 1; throw new Error("must not mint a duplicate generation"); },
    poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "live-continuation" }),
    onExit: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "unattached_live_generation", provider: "claude-code", observed_state: "recovering",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
      provider_ref: {
        work_attempt_id: attempt.work_attempt_id,
        provider_continuation_id: "live-continuation",
        provider_connection: null,
        execution_generation_id: execution.execution_generation_id,
      },
    } })).ok, true);
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return current.condition === "coordination_blocked" && /remains live/.test(current.last_error ?? "");
    }, "ambiguous live generation hold");
    assert.equal(spawnCount, 0);
    const detail = (await daemonRequest(paths.socketPath, "attempt.read", { id: "unattached_live_generation" })).result as { execution_generations: Array<{ terminal: unknown }> };
    assert.equal(detail.execution_generations.length, 1);
    assert.equal(detail.execution_generations[0]?.terminal, null);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("a failed provider launch terminalizes its generation and releases the shared workspace fence", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "failed_launch_cleanup");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "failed_launch_cleanup", leaseId: "failed_launch_cleanup", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  let launchCount = 0;
  const recovered = { workAttemptId: attempt.work_attempt_id, pid: 4202, providerContinuationId: "recovered-continuation", observedState: "working" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { launchCount += 1; if (launchCount === 1) throw new Error("injected launch failure"); return recovered; },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => recovered,
    poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: recovered.providerContinuationId }),
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "failed_launch_cleanup", provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } })).ok, true);
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return current.condition === "coordination_blocked" && /injected launch failure/.test(current.last_error ?? "");
    }, "failed launch persistence");
    const detail = (await daemonRequest(paths.socketPath, "attempt.read", { id: "failed_launch_cleanup" })).result as { execution_generations: Array<{ terminal: unknown }> };
    assert.ok(detail.execution_generations[0]?.terminal, "failed launch generation is durably terminal");
    const fenceDirectory = join(env.root, "worktrees", "repo", ".letagents-supervisor-workspace.fences");
    assert.equal((await readdir(fenceDirectory)).some((name) => name.startsWith("shared-")), false, "failed launch releases retained workspace authority");

    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "failed_launch_cleanup", desired_state: "running" })).ok, true);
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "provider retry without daemon restart");
    assert.equal(launchCount, 2);
    assert.equal((await readdir(fenceDirectory)).filter((name) => name.startsWith("shared-")).length, 1, "successful retry reacquires one shared fence");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("a provider handle returned already terminal is fenced and resumes under a successor generation", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"),
    auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"),
    attemptsRoot: join(env.root, "attempt-data"),
    workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "returned_terminal");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({
    taskId: "returned_terminal",
    leaseId: "returned_terminal",
    leaseEpoch: 0,
    workspacePath: workspace.path,
    workAttemptId: workspace.id,
  });
  const failedHandle = {
    workAttemptId: attempt.work_attempt_id,
    pid: 4101,
    providerContinuationId: "claude-continuation",
    observedState: "failed" as const,
  };
  const recoveredHandle = {
    ...failedHandle,
    pid: 4102,
    observedState: "working" as const,
  };
  let stopCount = 0;
  let resumeCount = 0;
  const streamListeners = new Map<object, (event: any) => void>();
  const exitListeners = new Map<object, (terminal: {
    endedAt: string; exitCode: number | null; signal: string | null;
    terminalCause: "stopped"; providerContinuationId: string;
  }) => void>();
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => failedHandle,
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { resumeCount += 1; return recoveredHandle; },
    poke: async () => {},
    stop: async (handle) => {
      stopCount += 1;
      const terminal = {
        endedAt: new Date().toISOString(),
        exitCode: 1,
        signal: null,
        terminalCause: "stopped" as const,
        providerContinuationId: "claude-continuation",
      };
      queueMicrotask(() => exitListeners.get(handle as object)?.(terminal));
      return terminal;
    },
    onExit: async (handle, listener) => {
      exitListeners.set(handle as object, listener);
      return () => exitListeners.delete(handle as object);
    },
    onStream: async (handle, listener) => {
      streamListeners.set(handle as object, listener);
      if (handle === failedHandle) {
        listener({
          workAttemptId: attempt.work_attempt_id,
          providerContinuationId: "claude-continuation",
          observedAt: new Date().toISOString(),
          sequence: 1,
          provider: "claude-code",
          kind: "error",
          method: "result/error_during_execution",
          payload: { type: "result", subtype: "error_during_execution", is_error: true },
          payloadTruncated: false,
          payloadRedacted: false,
          durablePayloadRef: null,
        });
      }
      return () => streamListeners.delete(handle as object);
    },
  };
  const recovery = fakeRecoveryClock();
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, recovery.clock);
  try {
    await daemon.start();
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id: "returned_terminal",
      provider: "claude-code",
      observed_state: "absent",
      workspace_path: attempt.workspace_path,
      work_attempt_id: attempt.work_attempt_id,
    } });
    assert.equal(put.ok, true, put.error);
    await eventually(async () => stopCount === 1 && recovery.pending() === 1, "terminal fence and recovery timer");
    assert.equal(resumeCount, 0);
    await recovery.advance(999);
    await Promise.resolve();
    assert.equal(resumeCount, 0, "generation 2 cannot start before the persisted backoff");
    await recovery.advance(1);
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return current.observed_state === "working"
        && current.provider_ref?.execution_generation_id !== undefined;
    }, "already-terminal launch recovery");
    assert.equal(stopCount, 1, "returned-state and just-installed stream paths share one idempotent terminal fence");
    assert.equal(resumeCount, 1, "the listener boundary race mints exactly one bounded successor");
    const detail = (await daemonRequest(paths.socketPath, "attempt.read", { id: "returned_terminal" })).result as {
      execution_generations: Array<{ terminal: unknown }>;
    };
    assert.ok(detail.execution_generations[0]?.terminal, "the returned-terminal generation is durably terminal");
    assert.equal(detail.execution_generations[1]?.terminal, null, "only the successor generation remains live");

    streamListeners.get(recoveredHandle as object)?.({
      workAttemptId: attempt.work_attempt_id,
      providerContinuationId: "claude-continuation",
      observedAt: new Date().toISOString(),
      sequence: 2,
      provider: "claude-code",
      kind: "error",
      method: "result/error_during_execution",
      payload: { type: "result", subtype: "error_during_execution", is_error: true },
      payloadTruncated: false,
      payloadRedacted: false,
      durablePayloadRef: null,
    });
    await eventually(async () => recovery.pending() === 1, "second terminal recovery timer");
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "returned_terminal", desired_state: "stopped" });
    assert.equal(recovery.pending(), 0, "manual Stop cancels the pending recovery timer");
    await recovery.advance(60_000);
    await Promise.resolve();
    assert.equal(resumeCount, 1, "a cancelled recovery timer cannot mint another successor");
  } finally {
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "returned_terminal", desired_state: "stopped" }).catch(() => undefined);
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("direct terminal recovery increases delay and quarantines before a sixth generation", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "bounded_terminal_loop");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "bounded_terminal_loop", leaseId: "bounded_terminal_loop", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  let launchCount = 0;
  const exitListeners = new Map<object, (terminal: any) => void>();
  const failedHandle = () => ({ workAttemptId: attempt.work_attempt_id, pid: 4200 + launchCount, providerContinuationId: "bounded-continuation", observedState: "failed" as const });
  const launch = () => { launchCount += 1; return failedHandle(); };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => launch(),
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => launch(),
    poke: async () => {},
    stop: async (handle) => {
      const terminal = { endedAt: new Date().toISOString(), exitCode: 1, signal: null, terminalCause: "stopped" as const, providerContinuationId: "bounded-continuation" };
      queueMicrotask(() => exitListeners.get(handle as object)?.(terminal));
      return terminal;
    },
    onExit: async (handle, listener) => { exitListeners.set(handle as object, listener); return () => exitListeners.delete(handle as object); },
    onStream: async () => () => {},
  };
  const recovery = fakeRecoveryClock();
  const daemon = new SupervisorDaemon(paths, "darwin", port, true, 15_000, undefined, recovery.clock);
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "bounded_terminal_loop", provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } })).ok, true);
    for (const [index, delay] of [1_000, 2_000, 4_000, 8_000].entries()) {
      await eventually(async () => launchCount === index + 1 && recovery.pending() === 1, `recovery timer ${index + 1}`);
      assert.equal(recovery.delays.at(-1), delay);
      await recovery.advance(delay - 1);
      await Promise.resolve();
      assert.equal(launchCount, index + 1);
      await recovery.advance(1);
    }
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return current.condition === "quarantined";
    }, "fifth terminal quarantine");
    assert.equal(launchCount, CRASH_LOOP_EXIT_LIMIT, "the threshold prevents generation 6");
    assert.equal(recovery.pending(), 0, "quarantine leaves no recovery timer");
    const detail = (await daemonRequest(paths.socketPath, "attempt.read", { id: "bounded_terminal_loop" })).result as { execution_generations: unknown[] };
    assert.equal(detail.execution_generations.length, CRASH_LOOP_EXIT_LIMIT);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("a terminal handle discovered during daemon reattach is fenced and resumes once", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const workspace = await provisionedWorkspace(env.root, "reattached_terminal");
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: "reattached_terminal", leaseId: "reattached_terminal", leaseEpoch: 0, workspacePath: workspace.path, workAttemptId: workspace.id });
  const liveHandle = { workAttemptId: attempt.work_attempt_id, pid: 4301, providerContinuationId: "reattach-continuation", observedState: "working" as const };
  const terminalHandle = { ...liveHandle, observedState: "idle" as const };
  const successorHandle = { ...liveHandle, pid: 4302 };
  const firstPort: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => liveHandle,
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("first daemon starts fresh"); },
    poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "reattach-continuation" }),
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const recovery = fakeRecoveryClock();
  const first = new SupervisorDaemon(paths, "darwin", firstPort, true, 15_000, undefined, recovery.clock);
  let second: SupervisorDaemon | null = null;
  let stopCount = 0;
  let resumeCount = 0;
  const exitListeners = new Map<object, (terminal: any) => void>();
  try {
    await first.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "reattached_terminal", provider: "claude-code", observed_state: "absent",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } })).ok, true);
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "first daemon provider start");
    await first.stop();

    const secondPort: ProviderActionPort = {
      ...firstPort,
      spawn: async () => { throw new Error("reattach recovery must preserve the continuation"); },
      attach: async () => terminalHandle,
      resume: async () => { resumeCount += 1; return successorHandle; },
      stop: async (handle) => {
        stopCount += 1;
        const terminal = { endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped" as const, providerContinuationId: "reattach-continuation" };
        queueMicrotask(() => exitListeners.get(handle as object)?.(terminal));
        return terminal;
      },
      onExit: async (handle, listener) => { exitListeners.set(handle as object, listener); return () => exitListeners.delete(handle as object); },
    };
    second = new SupervisorDaemon(paths, "darwin", secondPort, true, 15_000, undefined, recovery.clock);
    await second.start();
    await eventually(async () => stopCount === 1 && recovery.pending() === 1, "terminal reattach fence");
    assert.equal(resumeCount, 0);
    await recovery.advance(1_000);
    await eventually(async () => ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working", "reattached successor");
    assert.equal(stopCount, 1);
    assert.equal(resumeCount, 1);
    const detail = (await daemonRequest(paths.socketPath, "attempt.read", { id: "reattached_terminal" })).result as { execution_generations: Array<{ terminal: unknown }> };
    assert.ok(detail.execution_generations[0]?.terminal);
    assert.equal(detail.execution_generations[1]?.terminal, null);
  } finally {
    await second?.stop().catch(() => undefined);
    await first.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("direct provider convergence quarantines persisted crash loops without another spawn", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
  };
  let spawnCount = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { spawnCount += 1; throw new Error("quarantined entry must not spawn"); },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { spawnCount += 1; throw new Error("quarantined entry must not resume"); },
    poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
    onExit: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  try {
    await daemon.start();
    const now = Date.now();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id: "persisted_crash_loop",
      observed_state: "failed",
      reconciliation: {
        exit_timestamps_ms: Array.from({ length: CRASH_LOOP_EXIT_LIMIT }, (_, index) => now - index),
        consecutive_action_failures: CRASH_LOOP_EXIT_LIMIT,
        last_observed_state: "failed",
        next_restart_at_ms: now + 60_000,
        completed_action_ids: [],
        last_action_sequence: 0,
        pending_action: null,
      },
    } })).ok, true);
    await eventually(async () => {
      const current = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return current.condition === "quarantined";
    }, "persisted crash-loop quarantine");
    assert.equal(spawnCount, 0);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("reconciler policy uses the addressed-message watchdog rather than turn duration", () => {
  const base = {
    desiredState: "running" as const, observedState: "working" as const, condition: "none" as const,
    capabilities: { resume: true, midTurnInjection: true }, nowMs: 10_000, lastPollAtMs: 0,
    addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, exitsInWindow: 0,
  };
  assert.equal(watchdogShouldEscalate({ ...base, addressedMessagesWaiting: 0, pokeIgnored: true }, 1_000), false, "long work with an empty inbox is never touched");
  assert.equal(watchdogShouldEscalate({ ...base, lastPollAtMs: 9_999, addressedMessagesWaiting: 1, pokeIgnored: true }, 1_000), false, "quiet but polling is never touched");
  assert.equal(decideReconciliation({ ...base, addressedMessagesWaiting: 1 }, 1_000).action, "poke");
  assert.equal(watchdogShouldEscalate({ ...base, addressedMessagesWaiting: 1, pokeIgnored: true }, 1_000), true);
  assert.equal(decideReconciliation({ ...base, addressedMessagesWaiting: 1, pokeIgnored: true }, 1_000).action, "restart_with_resume");
});

test("reconciler policy fences recovery, gates resume, quarantines crash loops, and backs off", () => {
  const base = {
    desiredState: "running" as const, observedState: "failed" as const, condition: "none" as const,
    capabilities: { resume: true, midTurnInjection: false }, nowMs: 0, lastPollAtMs: null,
    addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: true, fencedRebindProven: false, exitsInWindow: 0,
  };
  assert.deepEqual(decideReconciliation(base, 1_000), {
    action: "hold_coordination", observedState: "recovering", condition: "coordination_blocked", reason: "active lease requires fenced rebind before restart",
  });
  assert.equal(decideReconciliation({ ...base, fencedRebindProven: true }, 1_000).action, "restart_with_resume");
  assert.equal(decideReconciliation({ ...base, activeLease: false, capabilities: { resume: false, midTurnInjection: false } }, 1_000).action, "restart_fresh");
  assert.equal(decideReconciliation({ ...base, exitsInWindow: CRASH_LOOP_EXIT_LIMIT }, 1_000).action, "quarantine");
  assert.equal(restartBackoffMs(1), 1_000);
  assert.equal(restartBackoffMs(20), 5 * 60 * 1_000);
  assert.equal(decideReconciliation({ ...base, activeLease: false, nextRestartAtMs: 1_001, nowMs: 1_000 }, 1_000).action, "wait");
});

test("reconciliation bookkeeping keeps rolling exits independent from action backoff", () => {
  const first = advanceReconciliationState(undefined, "failed", 1_000);
  assert.deepEqual(first.exit_timestamps_ms, [1_000]);
  assert.equal(first.consecutive_action_failures, 1);
  assert.deepEqual(advanceReconciliationState(first, "failed", 1_500), first, "a polling tick cannot manufacture another exit");
  const recovered = advanceReconciliationState(first, "recovering", 2_000);
  assert.deepEqual(recovered.exit_timestamps_ms, [1_000]);
  assert.deepEqual(advanceReconciliationState(recovered, "working", 2_500).exit_timestamps_ms, [1_000], "healthy work never erases exit history");
  const later = advanceReconciliationState({ ...first, last_observed_state: "recovering" }, "failed", 2_000);
  assert.deepEqual(later.exit_timestamps_ms, [1_000, 2_000]);
  const expired = advanceReconciliationState({ ...later, last_observed_state: "recovering" }, "failed", 2_000 + 10 * 60 * 1_000 + 1);
  assert.deepEqual(expired.exit_timestamps_ms, [2_000 + 10 * 60 * 1_000 + 1]);
  const actionFailure = recordReconciliationActionFailure(first, "generation-2", 2_000);
  assert.equal(actionFailure.consecutive_action_failures, 2);
  assert.equal(recordReconciliationActionFailure(actionFailure, "generation-2", 3_000), actionFailure, "retried action is idempotent");
  const afterAnotherAction = recordReconciliationActionFailure(actionFailure, "generation-3", 4_000);
  assert.equal(recordReconciliationActionFailure(afterAnotherAction, "generation-2", 5_000), afterAnotherAction, "non-adjacent replay is rejected");
});

test("reconciler executes only fenced, capability-negotiated port actions", async () => {
  const calls: string[] = [];
  const handle = { workAttemptId: "attempt", pid: 1, providerContinuationId: "thread", observedState: "failed" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: true, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false }),
    spawn: async () => { calls.push("spawn"); return handle; }, attach: async () => null,
    resume: async () => { calls.push("resume"); return handle; }, poke: async () => { calls.push("poke"); },
    stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "thread" }), onExit: async () => () => {},
  };
  const runner = new ProviderReconciler(port);
  const base = { workAttemptId: "attempt", desiredState: "running" as const, observedState: "failed" as const, condition: "none" as const, nowMs: 1_000, lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, exitsInWindow: 0, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle, resumeFrom: { workAttemptId: "attempt", providerContinuationId: "thread" } };
  assert.equal((await runner.reconcile({ ...base, activeLease: true, fencedRebindProven: false }, 100)).decision.action, "hold_coordination");
  assert.deepEqual(calls, []);
  assert.equal((await runner.reconcile({ ...base, activeLease: false, fencedRebindProven: false }, 100)).decision.action, "restart_with_resume");
  assert.deepEqual(calls, ["resume"]);
  const missing = await runner.reconcile({ ...base, activeLease: false, fencedRebindProven: false, resumeFrom: null }, 100);
  assert.equal(missing.decision.action, "hold_coordination");
  assert.equal(missing.disposition, "held");
});

test("reconciler dispatches fresh, poke, and stop safely and reports port faults", async () => {
  const calls: string[] = [];
  const handle = { workAttemptId: "attempt", pid: 1, providerContinuationId: "thread", observedState: "working" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: true, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false }),
    spawn: async () => { calls.push("spawn"); return handle; }, attach: async () => null,
    resume: async () => { calls.push("resume"); return handle; }, poke: async () => { calls.push("poke"); },
    stop: async () => { calls.push("stop"); return { endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "thread" }; }, onExit: async () => () => {},
  };
  const runner = new ProviderReconciler(port);
  const base = { workAttemptId: "attempt", desiredState: "running" as const, observedState: "failed" as const, condition: "none" as const, nowMs: 10_000, lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, exitsInWindow: 0, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle, resumeFrom: null };
  assert.equal((await runner.reconcile(base, 100)).decision.action, "restart_fresh");
  assert.deepEqual(calls, ["spawn"]);
  const poke = await runner.reconcile({ ...base, observedState: "working", lastPollAtMs: 0, addressedMessagesWaiting: 1 }, 100);
  assert.equal(poke.decision.action, "poke");
  const stop = await runner.reconcile({ ...base, desiredState: "stopped", observedState: "working" }, 100);
  assert.equal(stop.decision.action, "stop");
  assert.deepEqual(calls, ["spawn", "poke", "stop"]);
  assert.equal((await runner.reconcile({ ...base, observedState: "working", lastPollAtMs: 0, addressedMessagesWaiting: 1, handle: null }, 100)).disposition, "held");
  assert.equal((await runner.reconcile({ ...base, desiredState: "stopped", observedState: "working", handle: null }, 100)).disposition, "held");
  for (const unsafe of [
    { desiredState: "stopped" as const },
    { condition: "quarantined" as const },
    { activeLease: true, fencedRebindProven: true },
  ]) {
    const before = calls.length;
    const held = await runner.reconcile({ ...base, forcedAction: "restart_fresh", ...unsafe }, 100);
    assert.equal(held.disposition, "held", "a durable pending restart must revalidate current stop/quarantine/lease gates");
    assert.equal(calls.length, before, "an unsafe durable restart is never dispatched");
  }
  const beforePoke = calls.length;
  const pendingPoke = await runner.reconcile({ ...base, observedState: "working", lastPollAtMs: 0, addressedMessagesWaiting: 1, activeLease: true, fencedRebindProven: true, forcedAction: "poke" }, 100);
  assert.equal(pendingPoke.disposition, "executed", "an active lease does not block a safe durable poke");
  assert.equal(calls.length, beforePoke + 1);
  const broken = new ProviderReconciler({ ...port, spawn: async () => { throw new Error("child failed"); } });
  const result = await broken.reconcile(base, 100);
  assert.equal(result.disposition, "failed");
  assert.match(result.decision.reason, /child failed/);
});

test("an exact resume method failure downgrades capabilities and the next reconcile starts fresh", async () => {
  const calls: string[] = [];
  let resumeSupported = true;
  const handle = { workAttemptId: "attempt", pid: 1, providerContinuationId: "thread", observedState: "failed" as const };
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: resumeSupported, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async () => { calls.push("spawn"); return handle; },
    attach: async () => null,
    resume: async () => {
      calls.push("resume");
      resumeSupported = false;
      throw new Error("Codex app-server does not support thread/resume; bounded recovery must start a fresh generation.");
    },
    poke: async () => {},
    stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "thread" }),
    onExit: async () => () => {},
  };
  const runner = new ProviderReconciler(port);
  const input = {
    workAttemptId: "attempt",
    desiredState: "running" as const,
    observedState: "failed" as const,
    condition: "none" as const,
    nowMs: 1_000,
    lastPollAtMs: null,
    addressedMessagesWaiting: 0,
    pokeIgnored: false,
    exitsInWindow: 0,
    activeLease: false,
    fencedRebindProven: false,
    spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} },
    handle,
    resumeFrom: { workAttemptId: "attempt", providerContinuationId: "thread" },
  };

  const failedResume = await runner.reconcile(input, 100);
  assert.equal(failedResume.disposition, "failed");
  assert.match(failedResume.decision.reason, /bounded recovery must start a fresh generation/);
  const freshRetry = await runner.reconcile(input, 100);
  assert.equal(freshRetry.decision.action, "restart_fresh");
  assert.equal(freshRetry.disposition, "executed");
  assert.deepEqual(calls, ["resume", "spawn"]);
});

test("supervisor convergence persists the retry deadline before it can restart", async () => {
  const env = await fixture();
  try {
    const manifestPath = join(env.root, "manifest.json");
    const store = new ManifestStore(manifestPath);
    await store.write(0, [{ ...entry, observed_state: "failed" }]);
    const calls: string[] = [];
    const handle = { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "starting" as const };
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => { calls.push("spawn"); return handle; }, attach: async () => null, resume: async () => handle,
      poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }), onExit: async () => () => {},
    };
    const daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const daemonStore = (daemon as unknown as { store: ManifestStore }).store;
    (daemonStore as unknown as { write: () => never }).write = () => { throw new Error("reconcile must not call the full manifest write path"); };
    (daemonStore as unknown as { replaceEntries: () => never }).replaceEntries = () => { throw new Error("reconcile must not replace all entries"); };
    const input = { workAttemptId: "attempt", reconciliationActionId: "generation-1", reconciliationActionSequence: 1, nowMs: 1_000, lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null };
    assert.equal((await daemon.reconcile(entry.id, input, 100)).decision.action, "wait");
    assert.deepEqual(calls, []);
    assert.equal((await store.load()).entries[0]?.reconciliation?.next_restart_at_ms, 2_000);
    assert.equal((await daemon.reconcile(entry.id, { ...input, nowMs: 2_000 }, 100)).decision.action, "restart_fresh");
    assert.deepEqual(calls, ["spawn"]);
    await daemon.stop();
  } finally { await env.cleanup(); }
});

test("five terminal exit edges across reload quarantine even with intermediate work", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  let reloaded: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") };
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "working" }]);
    let spawnCalls = 0;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => { spawnCalls += 1; throw new Error("should not restart"); }, attach: async () => null,
      resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }), onExit: async () => () => {},
    };
    const base = { workAttemptId: "attempt", lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null };
    daemon = new SupervisorDaemon(paths, "darwin", port);
    await daemon.start();
    for (let index = 0; index < 5; index += 1) {
      await daemon.transition(entry.id, "failed", "none", `terminal-exit-${index}`, "provider");
      await daemon.transition(entry.id, "working", "none", `recovered-${index}`, "provider");
    }
    await daemon.stop();
    reloaded = new SupervisorDaemon(paths, "darwin", port);
    await reloaded.start();
    const quarantined = await reloaded.reconcile(entry.id, { ...base, reconciliationActionId: "generation-5", reconciliationActionSequence: 5, nowMs: Date.now() }, 100);
    assert.equal(quarantined.decision.action, "quarantine");
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.condition, "quarantined");
    assert.equal(spawnCalls, 0, "quarantine blocks another provider launch");
    await reloaded.stop();
  } finally { await reloaded?.stop().catch(() => undefined); await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("reconciliation journals intent before provider dispatch and attaches it after reload", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  let reloaded: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") };
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "failed", reconciliation: { exit_timestamps_ms: [0], consecutive_action_failures: 1, last_observed_state: "failed", next_restart_at_ms: 0, completed_action_ids: [], last_action_sequence: 0, pending_action: null } }]);
    let releaseSpawn!: () => void;
    let signalSpawn!: () => void;
    const spawned = new Promise<void>((resolve) => { signalSpawn = resolve; });
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => { signalSpawn(); await new Promise<void>((resolve) => { releaseSpawn = resolve; }); return { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "starting" }; }, attach: async () => null,
      resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }), onExit: async () => () => {},
    };
    const input = { workAttemptId: "attempt", reconciliationActionId: "generation-2", reconciliationActionSequence: 2, nowMs: 2_000, lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null };
    daemon = new SupervisorDaemon(paths, "darwin", port);
    await daemon.start();
    const running = daemon.reconcile(entry.id, input, 100);
    await spawned;
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation?.pending_action?.id, "generation-2");
    releaseSpawn();
    await running;
    await daemon.stop();
    const reloadedPort: ProviderActionPort = { ...port, spawn: async () => { throw new Error("must not respawn a pending action"); }, attachAction: async (id) => id === "orphan" ? { state: "attached", handle: { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "starting" } } : { state: "absent" } };
    const stored = await new ManifestStore(manifestPath).load();
    await new ManifestStore(manifestPath).write(stored.generation, stored.entries.map((candidate) => candidate.id === entry.id ? { ...candidate, reconciliation: { ...candidate.reconciliation!, pending_action: { id: "orphan", sequence: 3, kind: "restart_fresh", recorded_at_ms: 3_000 } } } : candidate));
    reloaded = new SupervisorDaemon(paths, "darwin", reloadedPort);
    await reloaded.start();
    assert.equal((await reloaded.reconcile(entry.id, { ...input, reconciliationActionId: "generation-3", reconciliationActionSequence: 3, nowMs: 3_001 }, 100)).disposition, "held");
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation?.pending_action, null);
    await reloaded.stop();
  } finally { await reloaded?.stop().catch(() => undefined); await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("an absent pending intent redispatches its exact durable identity and kind, while ambiguity blocks", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "failed", reconciliation: { exit_timestamps_ms: [], consecutive_action_failures: 0, last_observed_state: "failed", next_restart_at_ms: 0, completed_action_ids: [], last_action_sequence: 7, pending_action: { id: "durable-restart", sequence: 7, kind: "restart_fresh", recorded_at_ms: 1 } } }]);
    const requests: Array<{ actionId?: string }> = [];
    let attachment: "absent" | "ambiguous" = "absent";
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async (request) => { requests.push({ actionId: request.actionId }); return { workAttemptId: "attempt", pid: 2, providerContinuationId: null, observedState: "starting" }; },
      attach: async () => null,
      attachAction: async () => attachment === "absent" ? { state: "absent" } : { state: "ambiguous", reason: "provider lookup timed out" },
      resume: async () => { throw new Error("the durable restart_fresh kind must not become resume"); },
      poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }), onExit: async () => () => {},
    };
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const input = { workAttemptId: "attempt", reconciliationActionId: "newer-tick", reconciliationActionSequence: 8, nowMs: 2_000, lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: { workAttemptId: "attempt", providerContinuationId: "thread" } };
    assert.equal((await daemon.reconcile(entry.id, input, 100)).decision.action, "restart_fresh");
    assert.deepEqual(requests, [{ actionId: "durable-restart" }]);
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation?.last_action_sequence, 7, "redispatch never decrements the monotonic sequence");

    const stored = await new ManifestStore(manifestPath).load();
    await daemon.stop();
    daemon = null;
    await new ManifestStore(manifestPath).write(stored.generation, stored.entries.map((candidate) => candidate.id === entry.id ? { ...candidate, reconciliation: { ...candidate.reconciliation!, pending_action: { id: "ambiguous-intent", sequence: 9, kind: "restart_fresh", recorded_at_ms: 3 } } } : candidate));
    attachment = "ambiguous";
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const held = await daemon.reconcile(entry.id, { ...input, reconciliationActionId: "later-tick", reconciliationActionSequence: 10, nowMs: 3_000 }, 100);
    assert.equal(held.disposition, "held");
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.condition, "coordination_blocked");
    assert.equal(requests.length, 1, "ambiguous attachment may never redispatch");
    await daemon.stop();
  } finally { await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("global manifest mutation serialization preserves concurrent different-entry transitions", async () => {
  const env = await fixture();
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [entry, { ...entry, id: "agent_2" }]);
    const daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin");
    await daemon.start();
    await Promise.all([daemon.transition("agent_1", "failed", "none", "exit", "test"), daemon.transition("agent_2", "failed", "none", "exit", "test")]);
    assert.deepEqual((await new ManifestStore(manifestPath).load()).entries.map((candidate) => candidate.observed_state), ["failed", "failed"]);
    await daemon.stop();
  } finally { await env.cleanup(); }
});

test("scheduled convergence records provider exits and durable escalation notices", async () => {
  const env = await fixture();
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "working" }]);
    let onExit: ((terminal: { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "exited" | "killed" | "stopped" | "crashed" | "protocol_error"; providerContinuationId: string | null }) => void) | null = null;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }), spawn: async () => { throw new Error("unreachable"); }, attach: async () => null, resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
      onExit: async (_handle, listener) => { onExit = listener; return () => { onExit = null; }; },
    };
    const daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const stop = await daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "working" }, () => ({ workAttemptId: "attempt", reconciliationActionId: "generation-1", reconciliationActionSequence: 1, nowMs: Date.now(), lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null }), 100, 60_000);
    onExit?.({ endedAt: "now", exitCode: 1, signal: null, terminalCause: "crashed", providerContinuationId: null });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.observed_state, "failed");
    await daemon.transition(entry.id, "failed", "quarantined", "five exits in window", "reconciler");
    const notices = (await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation_notices ?? [];
    assert.deepEqual(notices.map((notice) => notice.kind), ["quarantine_death"]);
    assert.equal(notices[0]?.terminal?.terminal_cause, "crashed", "quarantine escalation carries immutable terminal evidence");
    await daemon.transition(entry.id, "recovering", "coordination_blocked", "active lease needs rebind", "reconciler");
    assert.deepEqual(((await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation_notices ?? []).map((notice) => notice.kind), ["quarantine_death", "coordination_escalation"]);
    await stop();
    await daemon.stop();
  } finally { await env.cleanup(); }
});

test("scheduled convergence atomically replaces exit subscriptions and preserves stop/quarantine terminals", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "failed", reconciliation: { exit_timestamps_ms: [], consecutive_action_failures: 0, last_observed_state: "failed", next_restart_at_ms: 0, completed_action_ids: [], last_action_sequence: 0, pending_action: null } }]);
    const listeners = new Map<number, (terminal: { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "exited" | "killed" | "stopped" | "crashed" | "protocol_error"; providerContinuationId: string | null }) => void>();
    let subscriptions = 0;
    const poked: Array<number | null> = [];
    const replacement = { workAttemptId: "attempt", pid: 2, providerContinuationId: null, observedState: "starting" as const };
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: true, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => replacement, attach: async () => null, attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unreachable"); }, poke: async (handle) => { poked.push(handle.pid); }, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
      onExit: async (handle, listener) => { subscriptions += 1; listeners.set(handle.pid ?? -1, listener); return () => { listeners.delete(handle.pid ?? -1); }; },
    };
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    let sequence = 0;
    const input = () => { sequence += 1; return { workAttemptId: "attempt", reconciliationActionId: `generation-${sequence}`, reconciliationActionSequence: sequence, nowMs: Date.now(), lastPollAtMs: 0, addressedMessagesWaiting: 1, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "failed" as const }, resumeFrom: null }; };
    const [stop, sameStop] = await Promise.all([
      daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "failed" }, input, 100, 5),
      daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "failed" }, input, 100, 5),
    ]);
    assert.equal(subscriptions, 2, "one initial listener is atomically replaced by the spawned child listener");
    assert.equal(listeners.has(1), false, "the superseded child listener is removed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(poked.every((pid) => pid === 2) && poked.length > 0, "later scheduler ticks target the installed replacement, not input's stale handle");
    await stop(); await sameStop();

    await daemon.transition(entry.id, "working", "quarantined", "already quarantined", "test");
    await daemon.observeProviderExit(entry.id, { endedAt: "late", exitCode: 9, signal: "SIGKILL", terminalCause: "killed", providerContinuationId: null });
    const late = (await new ManifestStore(manifestPath).load()).entries[0]!;
    assert.equal(late.condition, "quarantined");
    assert.equal(late.reconciliation_notices?.at(-1)?.terminal?.terminal_cause, "killed");
    await daemon.stop();
  } finally { await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("a slow old replacement registration cannot overwrite a newer child listener", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "failed", reconciliation: { exit_timestamps_ms: [], consecutive_action_failures: 0, last_observed_state: "failed", next_restart_at_ms: 0, completed_action_ids: [], last_action_sequence: 0, pending_action: null } }]);
    const listeners = new Map<number, (terminal: { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "exited" | "killed" | "stopped" | "crashed" | "protocol_error"; providerContinuationId: string | null }) => void>();
    let releaseSecondRegistration!: () => void;
    const secondRegistration = new Promise<void>((resolve) => { releaseSecondRegistration = resolve; });
    let signalSecondRegistration!: () => void;
    const waitingForSecondRegistration = new Promise<void>((resolve) => { signalSecondRegistration = resolve; });
    let spawnCount = 0;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => { spawnCount += 1; return { workAttemptId: "attempt", pid: 2, providerContinuationId: null, observedState: "starting" }; },
      attach: async () => null, attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
      onExit: async (handle, listener) => {
        if (handle.pid === 2) { signalSecondRegistration(); await secondRegistration; }
        listeners.set(handle.pid ?? -1, listener);
        return () => { listeners.delete(handle.pid ?? -1); };
      },
    };
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    let sequence = 0;
    const input = () => { sequence += 1; return { workAttemptId: "attempt", reconciliationActionId: `g-${sequence}`, reconciliationActionSequence: sequence, nowMs: Date.now() + 10_000, lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null }; };
    const scheduled = daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "failed" }, input, 100, 60_000);
    await within(waitingForSecondRegistration, "the blocked second listener registration");
    listeners.get(1)?.({ endedAt: "early", exitCode: 1, signal: null, terminalCause: "crashed", providerContinuationId: null });
    releaseSecondRegistration();
    const stop = await within(scheduled, "the first scheduled convergence");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(spawnCount, 1, "a superseded child terminal cannot launch a second replacement");
    assert.deepEqual([...listeners.keys()], [2], "the promoted replacement is the only subscribed child");
    await eventually(async () => ((await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation_notices ?? []).some((notice) => notice.cause.includes("stale terminal from superseded")), "durable stale-terminal evidence");
    await stop(); await daemon.stop();
  } finally { await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("a replacement child terminal callback enters durable convergence", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "failed", reconciliation: { exit_timestamps_ms: [], consecutive_action_failures: 0, last_observed_state: "failed", next_restart_at_ms: 0, completed_action_ids: [], last_action_sequence: 0, pending_action: null } }]);
    let replacementExit: ((terminal: { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "exited" | "killed" | "stopped" | "crashed" | "protocol_error"; providerContinuationId: string | null }) => void) | null = null;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => ({ workAttemptId: "attempt", pid: 2, providerContinuationId: null, observedState: "starting" }), attach: async () => null, attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
      onExit: async (handle, listener) => { if (handle.pid === 2) replacementExit = listener; return () => {}; },
    };
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const stop = await daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "failed" }, () => ({ workAttemptId: "attempt", reconciliationActionId: "g-1", reconciliationActionSequence: 1, nowMs: Date.now(), lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null }), 100, 60_000);
    assert.ok(replacementExit, "the spawned child replaces the initial exit listener");
    replacementExit?.({ endedAt: "later", exitCode: 1, signal: null, terminalCause: "crashed", providerContinuationId: null });
    await eventually(async () => (await new ManifestStore(manifestPath).load()).entries[0]?.observed_state === "failed", "replacement terminal persistence");
    await stop(); await daemon.stop();
  } finally { await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("a transient replacement listener failure retries the promoted child without a second spawn", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, observed_state: "failed", reconciliation: { exit_timestamps_ms: [], consecutive_action_failures: 0, last_observed_state: "failed", next_restart_at_ms: 0, completed_action_ids: [], last_action_sequence: 0, pending_action: null } }]);
    let spawnCount = 0;
    let failReplacementListener = true;
    let replacementExit: ((terminal: { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "exited" | "killed" | "stopped" | "crashed" | "protocol_error"; providerContinuationId: string | null }) => void) | null = null;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }),
      spawn: async () => { spawnCount += 1; return { workAttemptId: "attempt", pid: 2, providerContinuationId: null, observedState: "starting" }; }, attach: async () => null, attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
      onExit: async (handle, listener) => { if (handle.pid === 2 && failReplacementListener) { failReplacementListener = false; throw new Error("transient replacement listener failure"); } if (handle.pid === 2) replacementExit = listener; return () => {}; },
    };
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const stop = await daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "failed" }, () => ({ workAttemptId: "attempt", reconciliationActionId: "g-1", reconciliationActionSequence: 1, nowMs: Date.now(), lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null }), 100, 5);
    await eventually(async () => replacementExit !== null, "replacement listener retry");
    assert.equal(spawnCount, 1);
    replacementExit?.({ endedAt: "later", exitCode: 1, signal: null, terminalCause: "crashed", providerContinuationId: null });
    await eventually(async () => (await new ManifestStore(manifestPath).load()).entries[0]?.reconciliation?.last_terminal?.ended_at === "later", "replacement exit after listener retry");
    assert.equal(spawnCount, 1);
    await stop(); await daemon.stop();
  } finally { await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("desired stopped turns every terminal into a clean stopped observation and scheduler setup faults persist", async () => {
  const env = await fixture();
  let daemon: SupervisorDaemon | null = null;
  try {
    const manifestPath = join(env.root, "manifest.json");
    await new ManifestStore(manifestPath).write(0, [{ ...entry, desired_state: "stopped", observed_state: "stopping" }]);
    let failSubscribe = true;
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: false, permissionPromptBridging: false, survivesRestart: false }), spawn: async () => { throw new Error("unreachable"); }, attach: async () => null, attachAction: async () => ({ state: "absent" }), resume: async () => { throw new Error("unreachable"); }, poke: async () => {}, stop: async () => ({ endedAt: "now", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: null }),
      onExit: async () => { if (failSubscribe) throw new Error("listener bridge unavailable"); return () => {}; },
    };
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    await daemon.observeProviderExit(entry.id, { endedAt: "now", exitCode: 0, signal: null, terminalCause: "exited", providerContinuationId: null });
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.observed_state, "stopped");
    await assert.rejects(() => daemon!.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "stopped" }, () => ({ workAttemptId: "attempt", reconciliationActionId: "g", reconciliationActionSequence: 1, nowMs: Date.now(), lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null }), 100, 60_000), /listener bridge unavailable/);
    assert.equal((await new ManifestStore(manifestPath).load()).entries[0]?.condition, "coordination_blocked");
    failSubscribe = false;
    let unsubscribedAfterTickFailure = false;
    const tickFailurePort = { ...port, onExit: async () => () => { unsubscribedAfterTickFailure = true; } };
    await daemon.stop();
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", tickFailurePort);
    await daemon.start();
    await assert.rejects(() => daemon!.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "stopped" }, () => { throw new Error("initial tick input failed"); }, 100, 60_000), /initial tick input failed/);
    assert.equal(unsubscribedAfterTickFailure, true, "a post-subscribe initial tick failure removes the listener");
    await daemon.stop();
    daemon = new SupervisorDaemon({ lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath, auditPath: join(env.root, "audit.jsonl") }, "darwin", port);
    await daemon.start();
    const stop = await daemon.scheduleConvergence(entry.id, { workAttemptId: "attempt", pid: 1, providerContinuationId: null, observedState: "stopped" }, () => ({ workAttemptId: "attempt", reconciliationActionId: "g2", reconciliationActionSequence: 2, nowMs: Date.now(), lastPollAtMs: null, addressedMessagesWaiting: 0, pokeIgnored: false, activeLease: false, fencedRebindProven: false, spawn: { workAttemptId: "attempt", roomId: "room", cwd: "/tmp/work", launchPolicy: {} }, handle: null, resumeFrom: null }), 100, 60_000);
    await stop(); await daemon.stop();
  } finally { await daemon?.stop().catch(() => undefined); await env.cleanup(); }
});

test("an intentional stop-turn terminal remains idle without restarting the running lane", async () => {
  const env = await fixture();
  const manifestPath = join(env.root, "manifest.json");
  const executionGenerationId = "stop-turn-generation";
  const stoppedTurnEntry: DaemonManifestEntry = {
    ...entry,
    desired_state: "running",
    observed_state: "working",
    work_attempt_id: "stop-turn-attempt",
    provider_ref: {
      work_attempt_id: "stop-turn-attempt",
      provider_continuation_id: "stop-turn-continuation",
      execution_generation_id: executionGenerationId,
      provider_connection: null,
    },
    turn_control: {
      action_id: "stop-turn-action",
      work_attempt_id: "stop-turn-attempt",
      execution_generation_id: executionGenerationId,
      has_correction: false,
      status: "completed",
      capability: "native_interrupt",
      interrupted: true,
      resumed: false,
      state: "idle",
      stages: ["delivered", "interrupting", "applied"],
      error: null,
      recorded_at: "2026-07-17T06:59:17.996Z",
      updated_at: "2026-07-17T06:59:18.205Z",
    },
  };
  await new ManifestStore(manifestPath).write(0, [stoppedTurnEntry]);
  const daemon = new SupervisorDaemon({
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath,
    auditPath: join(env.root, "audit.jsonl"),
  }, "darwin");
  try {
    await daemon.start();
    await daemon.observeProviderExit(stoppedTurnEntry.id, {
      endedAt: "2026-07-17T06:59:18.205Z",
      exitCode: 0,
      signal: null,
      terminalCause: "stopped",
      providerContinuationId: "stop-turn-continuation",
    }, "daemon-provider", executionGenerationId);
    const current = (await new ManifestStore(manifestPath).load()).entries[0]!;
    assert.equal(current.desired_state, "running");
    assert.equal(current.observed_state, "idle");
    assert.equal(current.condition, "none");
    assert.equal(current.last_error, null);
    assert.equal(current.provider_ref?.execution_generation_id, executionGenerationId);
    assert.equal(current.turn_control?.action_id, "stop-turn-action");
    assert.equal(current.reconciliation?.last_terminal?.terminal_cause, "stopped");
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("simulated flock reacquires the persistent lock inode after release", async () => {
  const env = await fixture();
  const lock = join(env.root, "daemon.lock");
  const first = new DaemonSingleton(lock, "darwin");
  const second = new DaemonSingleton(lock, "darwin");
  try {
    assert.equal(await first.acquire(), 1);
    await assert.rejects(() => second.acquire(), DaemonAlreadyRunningError);
    await first.release();
    assert.equal((await stat(lock)).isFile(), true);
    assert.equal(await second.acquire(), 2);
  } finally {
    await second.release();
    await first.release();
    await env.cleanup();
  }
});

test("singleton fences a second daemon and detects a newer generation", async () => {
  const env = await fixture();
  try {
    const lock = join(env.root, "daemon.lock");
    const first = new DaemonSingleton(lock, "darwin");
    assert.equal(await first.acquire(), 1);
    await assert.rejects(() => new DaemonSingleton(lock, "darwin").acquire(), DaemonAlreadyRunningError);
    await writeFile(`${lock}.generation`, "2\n");
    await assert.rejects(() => first.assertCurrent(), DaemonFenceLostError);
    await first.release();
    assert.equal((await stat(lock)).isFile(), true, "persistent inode prevents post-release unlink races");
    await writeFile(`${lock}.generation`, "partial");
    const second = new DaemonSingleton(join(env.root, "second.lock"), "darwin");
    await second.acquire();
    await writeFile(`${join(env.root, "second.lock")}.generation`, "partial");
    await assert.rejects(() => second.assertCurrent(), /malformed/);
    await second.release();
  } finally { await env.cleanup(); }
});

test("manifest SQLite writes use generation CAS across concurrent callers", async () => {
  const env = await fixture();
  try {
    const path = join(env.root, "manifest.json");
    const store = new ManifestStore(path);
    const saved = await store.write(0, [entry]);
    assert.equal(saved.generation, 1);
    await assert.rejects(() => store.write(0, []), ManifestConflictError);
    const concurrent = await Promise.allSettled([store.write(1, [{ ...entry, id: "left" }]), store.write(1, [{ ...entry, id: "right" }])]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((result) => result.status === "rejected" && result.reason instanceof ManifestConflictError).length, 1);
    assert.equal((await store.load()).generation, 2);
    await store.close();
  } finally { await env.cleanup(); }
});

test("audit transitions append and rotate instead of truncating", async () => {
  const env = await fixture();
  try {
    const path = join(env.root, "audit.jsonl");
    const log = new AuditLog(path, 1);
    await log.append({ at: "2026-01-01T00:00:00.000Z", entry_id: "agent", from: "idle", to: "recovering", cause: "test", actor: "test", generation: 1 });
    const canary = "canary-not-a-real-audit-secret-123456789";
    await log.append({ at: "2026-01-01T00:00:01.000Z", entry_id: "agent", from: "recovering", to: "idle", cause: `Authorization: Bearer ${canary}`, actor: "test", generation: 2 });
    const names = await readdir(env.root);
    assert.ok(names.some((name) => name.startsWith("audit.jsonl.") && name.endsWith(".archive")));
    assert.match(await readFile(path, "utf8"), /"generation":2/);
    assert.doesNotMatch(await readFile(path, "utf8"), new RegExp(canary));
    assert.match(await readFile(path, "utf8"), /REDACTED/);
  } finally { await env.cleanup(); }
});

test("control socket rejects protocol mismatch explicitly", async () => {
  const env = await fixture();
  try {
    const socketPath = join(env.root, "daemon.sock");
    const socket = new DaemonControlSocket(socketPath, () => ({ healthy: true }));
    await chmod(env.root, 0o755);
    await socket.start();
    assert.equal((await stat(env.root)).mode & 0o777, 0o700);
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    const response = await new Promise<string>((resolve, reject) => {
      const client = createConnection(socketPath);
      let received = "";
      client.setEncoding("utf8");
      client.once("error", reject);
      client.on("data", (chunk) => { received += chunk; if (received.includes("\n")) { client.end(); resolve(received); } });
      client.on("connect", () => client.write(JSON.stringify({ version: DAEMON_PROTOCOL_VERSION + 1, id: "bad", method: "manifest.list" }) + "\n"));
    });
    assert.match(response, /Protocol version mismatch/);
    await socket.stop();
  } finally { await env.cleanup(); }
});

test("cross-version negotiation is allowed before a generation handoff", async () => {
  const env = await fixture();
  try {
    const socketPath = join(env.root, "daemon.sock");
    const socket = new DaemonControlSocket(socketPath, (request) => request.method === "daemon.negotiate"
      ? { healthy: true, protocol_version: DAEMON_PROTOCOL_VERSION, generation: 9 }
      : { ok: true });
    await socket.start();
    const response = await daemonRequest(socketPath, "daemon.negotiate", undefined, DAEMON_PROTOCOL_VERSION + 1);
    assert.equal(response.ok, true);
    assert.equal((response.result as { generation: number }).generation, 9);
    await socket.stop();
  } finally { await env.cleanup(); }
});

test("version handoff releases authority without waiting for wedged callbacks and preserves provider work", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"),
    auditPath: join(env.root, "audit.jsonl"),
  };
  const first = new SupervisorDaemon(paths, "darwin");
  let second: SupervisorDaemon | null = null;
  const provider = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await first.start();
    const never = new Promise<void>(() => {});
    const internals = first as unknown as {
      convergenceRequests: Map<string, Promise<void>>;
      providerCallbacks: Set<Promise<void>>;
      scheduledConvergence: Map<string, Promise<{ dispose: () => Promise<void> }>>;
    };
    internals.convergenceRequests.set("wedged", never);
    internals.providerCallbacks.add(never);
    internals.scheduledConvergence.set("wedged", new Promise(() => {}));

    const handoff = first.waitForHandoff();
    const prepared = await daemonRequest(paths.socketPath, "daemon.prepare_handoff");
    assert.equal(prepared.ok, true);
    await within(handoff, "handoff completion after authority cleanup", 1_000);
    second = new SupervisorDaemon(paths, "darwin");
    await within((async () => {
      while (true) {
        try { await second!.start(); return; }
        catch (error) {
          if (!(error instanceof DaemonAlreadyRunningError)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    })(), "replacement daemon authority after handoff", 1_000);
    assert.doesNotThrow(() => process.kill(provider.pid!, 0), "handoff detaches daemon observers without killing provider work");
  } finally {
    await second?.stop();
    provider.kill("SIGKILL");
    await env.cleanup();
  }
});

test("handoff observer cleanup failures still release socket, singleton, and SQLite authority", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
  };
  const first = new SupervisorDaemon(paths, "darwin");
  let second: SupervisorDaemon | null = null;
  try {
    await first.start();
    (first as unknown as { liveDisposers: Map<string, Array<() => void>> }).liveDisposers
      .set("throws", [() => { throw new Error("injected observer disposal failure"); }]);
    const handoff = first.waitForHandoff();
    assert.equal((await daemonRequest(paths.socketPath, "daemon.prepare_handoff")).ok, true);
    await assert.rejects(within(handoff, "failed handoff completion", 1_000), /handoff cleanup did not complete cleanly/i);

    second = new SupervisorDaemon(paths, "darwin");
    await within(second.start(), "replacement authority after failed observer cleanup", 1_000);
    assert.equal(((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation, 2);
  } finally {
    await second?.stop();
    await env.cleanup();
  }
});

test("the daemon entrypoint exits after a completed handoff instead of retaining ref-counted handles", async () => {
  const env = await fixture();
  const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "daemon/main.ts")], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: env.root },
    stdio: "ignore",
  });
  try {
    const socketPath = join(env.root, ".letagents", "daemon.sock");
    await within((async () => {
      while (true) {
        try {
          const status = await daemonRequest(socketPath, "daemon.status");
          if (status.ok) return;
        } catch {
          // The entrypoint is still acquiring its singleton and SQLite state.
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })(), "daemon entrypoint startup", 2_000);
    assert.equal((await daemonRequest(socketPath, "daemon.prepare_handoff")).ok, true);
    const exited = await within(new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }), "daemon entrypoint exit after handoff", 2_000);
    assert.deepEqual(exited, { code: 0, signal: null });
  } finally {
    child.kill("SIGKILL");
    await env.cleanup();
  }
});

test("SIGTERM after authority release uses default process-only termination and preserves detached providers", async () => {
  const env = await fixture();
  const mainPath = join(process.cwd(), "daemon/main.ts");
  const singletonPath = join(process.cwd(), "daemon/singleton.ts");
  const script = `
    import { spawn } from "node:child_process";
    const [{ SupervisorDaemon }, { defaultDaemonPaths }] = await Promise.all([
      import(${JSON.stringify(mainPath)}),
      import(${JSON.stringify(singletonPath)}),
    ]);
    const provider = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    provider.unref();
    const daemon = new SupervisorDaemon(defaultDaemonPaths(), "darwin");
    await daemon.start();
    process.send({ type: "ready", providerPid: provider.pid });
    await daemon.waitForHandoff();
    process.send({ type: "authority_released", providerPid: provider.pid });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: env.root },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let providerPid: number | null = null;
  const waitForMessage = (type: string) => within(new Promise<Record<string, unknown>>((resolve) => {
    const listener = (message: unknown) => {
      if ((message as { type?: string })?.type !== type) return;
      child.off("message", listener);
      resolve(message as Record<string, unknown>);
    };
    child.on("message", listener);
  }), `child message ${type}`, 2_000);
  try {
    const ready = await waitForMessage("ready");
    providerPid = Number(ready.providerPid);
    const socketPath = join(env.root, ".letagents", "daemon.sock");
    assert.equal((await daemonRequest(socketPath, "daemon.prepare_handoff")).ok, true);
    await waitForMessage("authority_released");
    await assert.rejects(daemonRequest(socketPath, "daemon.status"));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    child.kill("SIGTERM");
    assert.deepEqual(await within(exited, "SIGTERM exit after authority release", 1_000), { code: null, signal: "SIGTERM" });
    assert.doesNotThrow(() => process.kill(providerPid!, 0), "daemon SIGTERM does not initiate provider cleanup");
  } finally {
    child.kill("SIGKILL");
    if (providerPid && Number.isSafeInteger(providerPid)) {
      try { process.kill(providerPid, "SIGKILL"); } catch { /* already gone */ }
    }
    await env.cleanup();
  }
});

test("prepare_handoff fences a mutation admitted before an asynchronous request barrier", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
  };
  let releaseMutation!: () => void;
  const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
  let mutationReached!: () => void;
  const reachedMutation = new Promise<void>((resolve) => { mutationReached = resolve; });
  const daemon = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, async (request) => {
    if (request.method !== "manifest.put") return;
    mutationReached();
    await mutationGate;
  });
  try {
    await daemon.start();
    const lateMutation = daemonRequest(paths.socketPath, "manifest.put", {
      entry: { ...entry, id: "admitted_before_handoff" },
    });
    await reachedMutation;
    const handoff = daemon.waitForHandoff();
    assert.equal((await daemonRequest(paths.socketPath, "daemon.prepare_handoff")).ok, true);
    releaseMutation();
    const rejected = await lateMutation;
    assert.equal(rejected.ok, false);
    assert.match(rejected.error ?? "", /handoff has fenced new daemon mutations/i);
    await within(handoff, "barrier-fenced handoff", 1_000);

    const reopened = new ManifestStore(paths.manifestPath);
    try {
      assert.equal((await reopened.load()).entries.some((candidate) => candidate.id === "admitted_before_handoff"), false);
    } finally {
      await reopened.close();
    }
  } finally {
    releaseMutation();
    await env.cleanup();
  }
});

test("a host-grant install queued before handoff cannot retain plaintext or report installed after retirement", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
  };
  let installAdmitted!: () => void;
  const admitted = new Promise<void>((resolve) => { installAdmitted = resolve; });
  let mintCalls = 0;
  const daemon = new SupervisorDaemon(paths, "darwin", undefined, false, 15_000, async (request) => {
    if (request.method === "supervisor.install_host_grant") installAdmitted();
  }, {}, {
    poll: async () => ({ messages: [] }), publish: async () => {},
  }, {
    createWorkerSession: async () => {
      mintCalls += 1;
      return { sessionId: "must-not-mint", bearer: "must-not-retain", bearerId: "must-not-record", expiresAt: null };
    },
  });
  let releaseTick!: () => void;
  const tickGate = new Promise<void>((resolve) => { releaseTick = resolve; });
  let tickEntered!: () => void;
  const tickStarted = new Promise<void>((resolve) => { tickEntered = resolve; });
  try {
    await daemon.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "queued_host_grant", provider: "codex", delivery_mode: "daemon_inbox", observed_state: "absent",
    } });
    const generation = ((await daemonRequest(paths.socketPath, "daemon.status")).result as { generation: number }).generation;
    const internals = daemon as unknown as {
      serializeEntryTick: <T>(entryId: string, operation: () => Promise<T>) => Promise<T>;
      hostGrants: Map<string, unknown>;
    };
    const heldTick = internals.serializeEntryTick("queued_host_grant", async () => { tickEntered(); await tickGate; });
    await tickStarted;
    const queuedInstall = daemonRequest(paths.socketPath, "supervisor.install_host_grant", {
      entry_id: "queued_host_grant", room_id: entry.room_id, agent_key: "owner/agent", grant_id: "grant-queued",
      supervisor_grant: "queued-plaintext-grant", grant_generation: 3, api_url: "https://letagents.example",
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: "2099-01-01T00:00:00.000Z",
      daemon_generation: generation,
    });
    await admitted;
    const handoff = daemon.waitForHandoff();
    assert.equal((await daemonRequest(paths.socketPath, "daemon.prepare_handoff")).ok, true);
    releaseTick();
    await heldTick;
    const rejected = await queuedInstall;
    assert.equal(rejected.ok, true);
    assert.deepEqual(rejected.result, { status: "stale" });
    assert.equal(mintCalls, 0, "a retired daemon cannot mint a worker session");
    assert.equal(internals.hostGrants.size, 0, "a retired daemon retains no plaintext grant");
    await within(handoff, "queued host-grant handoff", 1_000);
  } finally {
    releaseTick?.();
    await env.cleanup();
  }
});

test("handoff destroys open control sockets and fences a mutation paused before commit", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"),
    socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "manifest.json"),
    auditPath: join(env.root, "audit.jsonl"),
    workerBindingsPath: join(env.root, "worker-bindings.json"),
  };
  const first = new SupervisorDaemon(paths, "darwin");
  let second: SupervisorDaemon | null = null;
  let releaseCommit!: () => void;
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  let reachedCommit!: () => void;
  const commitReached = new Promise<void>((resolve) => { reachedCommit = resolve; });
  let releaseBindingCommit!: () => void;
  const bindingCommitGate = new Promise<void>((resolve) => { releaseBindingCommit = resolve; });
  let reachedBindingCommit!: () => void;
  const bindingCommitReached = new Promise<void>((resolve) => { reachedBindingCommit = resolve; });
  let heldSocket: ReturnType<typeof createConnection> | null = null;
  try {
    await first.start();
    const store = (first as unknown as { store: ManifestStore }).store;
    const originalWrite = store.write.bind(store);
    store.write = (expected, entries, owners, commitFence) => originalWrite(expected, entries, owners, async (commit) => {
      reachedCommit();
      await commitGate;
      if (commitFence) await commitFence(commit);
      else await commit();
    });
    const lateMutation = daemonRequest(paths.socketPath, "manifest.put", {
      entry: { ...entry, id: "must_not_commit_after_handoff" },
    }).catch(() => null);
    const bindingStore = (first as unknown as { workerBindings: WorkerBindingStore }).workerBindings;
    const rawBindingStore = bindingStore as unknown as { write: (value: unknown) => Promise<void> };
    const originalBindingWrite = rawBindingStore.write.bind(rawBindingStore);
    rawBindingStore.write = async (value) => {
      reachedBindingCommit();
      await bindingCommitGate;
      await originalBindingWrite(value);
    };
    const lateBinding = bindingStore.bind({
      entry_id: "binding_race", room_id: "focus_37", work_attempt_id: "attempt_old",
      execution_generation_id: "execution_old", agent_session_id: "session_old",
      agent_session_token: "old-secret", api_url: "https://letagents.chat",
    }).catch(() => null);
    await Promise.all([commitReached, bindingCommitReached]);

    heldSocket = createConnection(paths.socketPath);
    await new Promise<void>((resolve, reject) => {
      heldSocket!.once("connect", resolve);
      heldSocket!.once("error", reject);
    });
    const heldClosed = new Promise<void>((resolve) => heldSocket!.once("close", () => resolve()));
    assert.equal((await daemonRequest(paths.socketPath, "daemon.prepare_handoff")).ok, true);
    second = new SupervisorDaemon(paths, "darwin");
    await within((async () => {
      while (true) {
        try { await second!.start(); return; }
        catch (error) {
          if (!(error instanceof DaemonAlreadyRunningError)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    })(), "replacement daemon while an old control socket is open", 1_000);
    await within(heldClosed, "old control connection destruction", 1_000);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "binding_race", room_id: "focus_37", observed_state: "working", work_attempt_id: "attempt_old",
      provider_ref: {
        work_attempt_id: "attempt_old", provider_continuation_id: "continuation_successor",
        provider_connection: null, execution_generation_id: "execution_old",
      },
    } })).ok, true);
    const replacementBindings = (second as unknown as { workerBindings: WorkerBindingStore }).workerBindings;
    const predecessorBinding = await replacementBindings.bind({
      entry_id: "binding_race", room_id: "focus_37", work_attempt_id: "attempt_old",
      execution_generation_id: "execution_old", agent_session_id: "session_old",
      agent_session_token: "old-secret", api_url: "https://letagents.chat",
    });
    const staleHandle = {
      workAttemptId: "attempt_old", pid: null, providerContinuationId: "continuation_old",
      providerConnection: null, observedState: "working" as const,
    };
    const successorHandle = { ...staleHandle, providerContinuationId: "continuation_successor" };
    let releaseTerminalLoad!: () => void;
    const terminalLoadGate = new Promise<void>((resolve) => { releaseTerminalLoad = resolve; });
    let reachedTerminalLoad!: () => void;
    const terminalLoadReached = new Promise<void>((resolve) => { reachedTerminalLoad = resolve; });
    const replacementInternals = second as unknown as {
      liveHandles: Map<string, typeof staleHandle>;
      liveBindingIdentities: Map<string, { agentSessionId: string; executionGenerationId: string; updatedAt: string }>;
      store: ManifestStore;
      durability: {
        getAttempt: (id: string) => Promise<{ execution_generations: Array<{ execution_generation_id: string; terminal: unknown; actor: string; generation: number }> }>;
        recordTerminal: (workAttemptId: string, executionGenerationId: string, terminal: unknown) => Promise<void>;
      };
      handleProviderTerminal: (entryId: string, handle: typeof staleHandle, executionGenerationId: string, binding: { agentSessionId: string; executionGenerationId: string; updatedAt: string }, terminal: { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "stopped"; providerContinuationId: string }) => Promise<void>;
    };
    replacementInternals.liveHandles.set("binding_race", staleHandle);
    const predecessorIdentity = {
      agentSessionId: predecessorBinding.agent_session_id,
      executionGenerationId: predecessorBinding.execution_generation_id,
      updatedAt: predecessorBinding.updated_at,
    };
    replacementInternals.liveBindingIdentities.set("binding_race", predecessorIdentity);
    const fakeExecutions = [
      { execution_generation_id: "execution_old", terminal: null as unknown, actor: "old-worker", generation: 1 },
      { execution_generation_id: "execution_successor", terminal: null as unknown, actor: "successor-worker", generation: 2 },
    ];
    replacementInternals.durability.getAttempt = async () => ({ execution_generations: fakeExecutions });
    replacementInternals.durability.recordTerminal = async (_workAttemptId, executionGenerationId, terminal) => {
      const execution = fakeExecutions.find((candidate) => candidate.execution_generation_id === executionGenerationId)!;
      execution.terminal = terminal;
    };
    const originalReplacementLoad = replacementInternals.store.load.bind(replacementInternals.store);
    let gateNextLoad = true;
    replacementInternals.store.load = async () => {
      if (gateNextLoad) {
        gateNextLoad = false;
        reachedTerminalLoad();
        await terminalLoadGate;
      }
      return originalReplacementLoad();
    };
    const staleTerminal = replacementInternals.handleProviderTerminal("binding_race", staleHandle, "execution_old", predecessorIdentity, {
      endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "continuation_old",
    });
    await terminalLoadReached;
    const successorBinding = await replacementBindings.bind({
      entry_id: "binding_race", room_id: "focus_37", work_attempt_id: "attempt_new",
      execution_generation_id: "execution_old", agent_session_id: "session_new",
      agent_session_token: "new-secret", api_url: "https://letagents.chat",
    });
    replacementInternals.liveHandles.set("binding_race", successorHandle);
    replacementInternals.liveBindingIdentities.set("binding_race", {
      agentSessionId: successorBinding.agent_session_id,
      executionGenerationId: successorBinding.execution_generation_id,
      updatedAt: successorBinding.updated_at,
    });
    releaseTerminalLoad();
    await staleTerminal;
    const afterStaleTerminal = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])
      .find((candidate) => candidate.id === "binding_race")!;
    assert.equal(afterStaleTerminal.observed_state, "working", "a stale terminal callback cannot transition the successor manifest entry");
    assert.equal(afterStaleTerminal.provider_ref?.provider_continuation_id, "continuation_successor");
    assert.equal(replacementInternals.liveHandles.get("binding_race"), successorHandle, "the successor provider handle remains live");
    assert.equal(fakeExecutions[0]!.terminal, null, "the stale callback cannot terminalize the shared execution after its handle was replaced");
    assert.equal(fakeExecutions[1]!.terminal, null, "the successor execution remains live");

    releaseCommit();
    releaseBindingCommit();
    await Promise.all([lateMutation, lateBinding]);
    const listed = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    assert.equal(listed.some((candidate) => candidate.id === "must_not_commit_after_handoff"), false);
    assert.doesNotMatch(await readFile(paths.auditPath, "utf8").catch(() => ""), /must_not_commit_after_handoff/);
    assert.equal((await replacementBindings.get("binding_race"))?.agent_session_id, "session_new", "a stale bind cannot overwrite its successor generation");
  } finally {
    releaseCommit();
    releaseBindingCommit();
    heldSocket?.destroy();
    await second?.stop();
    await env.cleanup();
  }
});

test("daemon control surface persists three-axis state, dual-axis liveness, and bounded activity", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    const status = await daemonRequest(paths.socketPath, "daemon.status");
    assert.equal(status.ok, true);
    assert.equal((status.result as { generation: number }).generation, 1);
    const put = await daemonRequest(paths.socketPath, "manifest.put", { entry: { ...entry, workspace_path: "/tmp/work" } });
    assert.equal(put.ok, true);
    const listed = await daemonRequest(paths.socketPath, "manifest.list");
    const saved = (listed.result as DaemonManifestEntry[])[0];
    assert.equal(saved.desired_state, "running");
    assert.equal(saved.workplace_liveness?.state, "unknown");
    assert.equal(saved.native_liveness?.state, "unknown");
    const paused = await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: entry.id, desired_state: "paused" });
    assert.equal((paused.result as DaemonManifestEntry).desired_state, "paused");
    const event = { observed_at: "2026-01-01T00:00:01.000Z", sequence: 1, provider: "codex", kind: "turn_lifecycle", method: "turn/started", summary: "Working on the task", status: "working", payload: {}, payload_truncated: false, payload_redacted: true, durable_payload_ref: null };
    const active = await daemonRequest(paths.socketPath, "manifest.append_activity", { id: entry.id, event });
    assert.equal((active.result as DaemonManifestEntry).observed_state, "working");
    assert.equal((active.result as DaemonManifestEntry).native_liveness?.state, "active");
    await daemonRequest(paths.socketPath, "manifest.update_workplace_liveness", { id: entry.id, state: "reachable", detail: "heartbeat", observed_at: "2026-01-01T00:00:01.000Z" });
    const stale = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0];
    assert.equal(stale.workplace_liveness?.state, "stale");
    assert.equal(stale.native_liveness?.state, "stale");
    assert.equal(stale.observed_state, "working", "stale axes are a probe/suspect signal, never manufactured death");
    assert.equal(stale.condition, "none");
    const detail = await daemonRequest(paths.socketPath, "attempt.read", { id: entry.id });
    assert.equal((detail.result as { workspace_path: string | null }).workspace_path, null, "attempt.read never launders a manifest placeholder into durability authority");
    assert.equal((detail.result as { activity: unknown[] }).activity.length, 1);
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("daemon ingress redacts provider credentials before manifest, DTO, and audit persistence", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const canary = "canary-not-a-real-credential-123456789";
  const workerBearer = `lasb_${"A".repeat(43)}`;
  const hostGrant = `lashg_${"b".repeat(43)}`;
  try {
    await daemon.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: { ...entry, id: "credential_firewall" } });
    const response = await daemonRequest(paths.socketPath, "manifest.append_activity", {
      id: "credential_firewall",
      event: {
        observed_at: "2026-01-01T00:00:01.000Z",
        sequence: 1,
        provider: "claude-code",
        kind: "tool_result",
        method: `tool/result Authorization: Bearer ${canary}`,
        summary: `LETAGENTS_TOKEN=${canary}`,
        status: "working",
        payload: {
          nested: [{ LETAGENTS_TOKEN: canary }, { api_key: canary }, { clientSecret: canary, dbPassword: canary, privateKey: canary, setCookie: canary }],
          json: JSON.stringify({ LETAGENTS_TOKEN: canary }),
          header: `Authorization: Bearer ${canary}`,
          basic: `Authorization: Basic ${canary}`,
          arbitraryAuthorization: `Authorization: ${canary}`,
          stringifiedHeaders: JSON.stringify({ bearer: `Authorization: Bearer ${canary}`, basic: `Authorization: Basic ${canary}`, arbitrary: `Authorization: ${canary}` }),
          stringifiedCamelCase: JSON.stringify({ clientSecret: canary, dbPassword: canary, privateKey: canary, setCookie: canary }),
          standaloneOwnedTokens: `worker=${workerBearer} host=${hostGrant}`,
          stringifiedOwnedTokens: JSON.stringify({ message: `${workerBearer} ${hostGrant}` }),
        },
        payload_truncated: false,
        payload_redacted: false,
        durable_payload_ref: `Authorization: Bearer ${canary}`,
      },
    });
    assert.equal(response.ok, true, response.error);
    const dto = response.result as DaemonManifestEntry;
    assert.equal(dto.activity?.[0]?.payload_redacted, true);
    assert.doesNotMatch(JSON.stringify(dto), new RegExp(canary));
    assert.doesNotMatch(JSON.stringify(dto), new RegExp(workerBearer));
    assert.doesNotMatch(JSON.stringify(dto), new RegExp(hostGrant));
    const inspection = new ManifestStore(paths.manifestPath);
    const persistedActivity = JSON.stringify(await inspection.load());
    await inspection.close();
    assert.doesNotMatch(persistedActivity, new RegExp(canary));
    assert.doesNotMatch(persistedActivity, new RegExp(workerBearer));
    assert.doesNotMatch(persistedActivity, new RegExp(hostGrant));

    await daemon.transition("credential_firewall", "failed", "coordination_blocked", `Authorization: Bearer ${canary}`, `LETAGENTS_TOKEN=${canary}`, {
      exit_timestamps_ms: [],
      consecutive_action_failures: 0,
      last_observed_state: "failed",
      next_restart_at_ms: null,
      completed_action_ids: [],
      last_action_sequence: 0,
      pending_action: null,
      last_terminal: {
        ended_at: "2026-01-01T00:00:02.000Z",
        exit_code: 1,
        signal: null,
        stdio_archive_ref: `LETAGENTS_TOKEN=${canary}`,
        stdio_tail: `Authorization: Bearer ${canary}`,
        terminal_cause: `OPENAI_API_KEY=${canary}`,
        actor: `LETAGENTS_TOKEN=${canary}`,
        generation: 1,
        provider_continuation_id: `Authorization: Bearer ${canary}`,
      },
    });
    const postTransitionInspection = new ManifestStore(paths.manifestPath);
    const persisted = JSON.stringify(await postTransitionInspection.load());
    await postTransitionInspection.close();
    assert.doesNotMatch(persisted, new RegExp(canary));
    assert.match(persisted, /REDACTED/);
    assert.doesNotMatch(await readFile(paths.auditPath, "utf8"), new RegExp(canary));
    assert.match(await readFile(paths.auditPath, "utf8"), /REDACTED/);
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("concurrent Claude Code creation ids on one lane yield one durable owner", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  let daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    const candidate = (id: string): DaemonManifestEntry => ({
      ...entry,
      id,
      room_id: "focus_37",
      provider: "claude-code",
      desired_state: "paused",
      observed_state: "paused",
    });
    const results = await Promise.all([
      daemonRequest(paths.socketPath, "manifest.put", { entry: candidate("owner_a") }),
      daemonRequest(paths.socketPath, "manifest.put", { entry: candidate("owner_b") }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok).length, 1);
    assert.match(results.find((result) => !result.ok)?.error ?? "", /already owned by supervised entry/);
    let manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    assert.equal(manifest.length, 1);
    const winner = manifest[0]!.id;
    const loser = winner === "owner_a" ? "owner_b" : "owner_a";

    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: winner, desired_state: "running",
    })).ok, true);

    const retry = await daemonRequest(paths.socketPath, "manifest.put", { entry: candidate(winner) });
    assert.equal(retry.ok, true);
    assert.equal((retry.result as DaemonManifestEntry).desired_state, "running", "a stale creation retry cannot rewind lifecycle state");
    const conflictingRetry = await daemonRequest(paths.socketPath, "manifest.put", {
      entry: { ...candidate(winner), charter: "different agent" },
    });
    assert.equal(conflictingRetry.ok, false);
    assert.match(conflictingRetry.error ?? "", /already bound to different agent parameters/);

    await daemon.stop();
    daemon = new SupervisorDaemon(paths, "darwin");
    await daemon.start();
    manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    assert.equal(manifest.filter((candidate) => candidate.id === winner).length, 1, "daemon restart preserves exactly one durable request owner");
    assert.equal(manifest.find((candidate) => candidate.id === winner)?.desired_state, "running");
    const blockedLegacy = await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: "legacy_blocked_by_any_supervised", room_id: "focus_37", provider: "claude-code", owner_pid: process.pid, owner_process_identity: TEST_PROCESS_IDENTITY,
    });
    assert.equal(blockedLegacy.ok, false, "any active supervised agent keeps the legacy provider engine fenced out");
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: winner, desired_state: "stopped",
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", {
      entry: candidate(loser),
    })).ok, false, "stop intent alone cannot release a provider lane before observed stop");
    await daemon.stop();
    const stoppedWinner = await new ManifestStore(paths.manifestPath).load();
    await new ManifestStore(paths.manifestPath).write(stoppedWinner.generation, stoppedWinner.entries.map((item) => (
      item.id === winner ? { ...item, observed_state: "stopped" as const } : item
    )));
    daemon = new SupervisorDaemon(paths, "darwin");
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", {
      entry: candidate(loser),
    })).ok, true, "the losing creation id can claim the lane after the prior owner is observably stopped");
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: loser, desired_state: "running",
    })).ok, true);
    const blockedPredecessorRestart = await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: winner, desired_state: "running",
    });
    assert.equal(blockedPredecessorRestart.ok, false, "a stopped predecessor cannot reactivate after a successor claims the lane");
    assert.match(blockedPredecessorRestart.error ?? "", /already owned by supervised entry/);
    assert.equal((await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: "legacy_after_all_supervised_stop", room_id: "focus_37", provider: "claude-code", owner_pid: process.pid, owner_process_identity: TEST_PROCESS_IDENTITY,
    })).ok, false, "the successor supervised owner fences legacy starts");
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: loser, desired_state: "stopped",
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: "legacy_after_all_supervised_stop", room_id: "focus_37", provider: "claude-code", owner_pid: process.pid, owner_process_identity: TEST_PROCESS_IDENTITY,
    })).ok, false, "legacy remains fenced until the supervised provider is observably stopped");
    await daemon.stop();
    const stoppedLoser = await new ManifestStore(paths.manifestPath).load();
    await new ManifestStore(paths.manifestPath).write(stoppedLoser.generation, stoppedLoser.entries.map((item) => (
      item.id === loser ? { ...item, observed_state: "stopped" as const } : item
    )));
    daemon = new SupervisorDaemon(paths, "darwin");
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: "legacy_after_all_supervised_stop", room_id: "focus_37", provider: "claude-code", owner_pid: process.pid, owner_process_identity: TEST_PROCESS_IDENTITY,
    })).ok, true, "legacy migration is available only after every supervised owner stops");
    assert.equal((await daemonRequest(paths.socketPath, "lane.release_legacy", {
      reservation_id: "legacy_after_all_supervised_stop",
    })).ok, true);
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("distinct supervised Codex entries coexist in one room without weakening legacy fencing", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  let daemon = new SupervisorDaemon(paths, "darwin");
  const candidate = (id: string): DaemonManifestEntry => ({
    ...entry,
    id,
    room_id: "codex_roundtable",
    provider: "codex",
    desired_state: "paused",
    observed_state: "paused",
  });
  try {
    await daemon.start();
    const [firstCreate, secondCreate] = await Promise.all([
      daemonRequest(paths.socketPath, "manifest.put", { entry: candidate("codex_alpha") }),
      daemonRequest(paths.socketPath, "manifest.put", { entry: candidate("codex_bravo") }),
    ]);
    assert.equal(firstCreate.ok, true);
    assert.equal(secondCreate.ok, true);
    assert.equal(((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[]).length, 2);

    const firstResume = await daemonRequest(paths.socketPath, "manifest.compare_and_set_desired_state", {
      id: "codex_alpha", expected_desired_state: "paused", desired_state: "running",
    });
    assert.equal((firstResume.result as { applied: boolean }).applied, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "codex_bravo", desired_state: "running",
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "codex_alpha", desired_state: "paused",
    })).ok, true);
    const resumedAgain = await daemonRequest(paths.socketPath, "manifest.compare_and_set_desired_state", {
      id: "codex_alpha", expected_desired_state: "paused", desired_state: "running",
    });
    assert.equal((resumedAgain.result as { applied: boolean }).applied, true);

    const retried = await daemonRequest(paths.socketPath, "manifest.put", { entry: candidate("codex_alpha") });
    assert.equal(retried.ok, true);
    assert.equal((retried.result as DaemonManifestEntry).desired_state, "running", "same entry retries remain idempotent and never rewind its lifecycle");

    await daemon.stop();
    daemon = new SupervisorDaemon(paths, "darwin");
    await daemon.start();
    const afterRestart = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    assert.equal(afterRestart.filter((item) => item.room_id === "codex_roundtable" && item.provider === "codex").length, 2);
    assert.ok(afterRestart.every((item) => item.desired_state === "running"), "restart preserves multiple Codex owners instead of quarantining them");

    const blockedLegacy = await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: "legacy_codex_roundtable", room_id: "codex_roundtable", provider: "codex", owner_pid: process.pid, owner_process_identity: TEST_PROCESS_IDENTITY,
    });
    assert.equal(blockedLegacy.ok, false, "any live supervised Codex entry continues to fence the legacy Electron runtime");
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("two Codex room agents keep independent provider executions across stop, resume, and daemon handoff", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const sources = await Promise.all([
    committedSourceRepository(env.root, "multi-codex-alpha-source"),
    committedSourceRepository(env.root, "multi-codex-bravo-source"),
  ]);
  // Prime only the shared immutable clone. Each agent must still ask the
  // daemon to derive and provision its own work attempt from source_repo_path.
  await Promise.all(sources.map((source) => primeDaemonBareRepository(env.root, source)));
  const identities = [
    { entryId: "codex_runtime_alpha" },
    { entryId: "codex_runtime_bravo" },
  ] as const;

  type RuntimeState = "starting" | "working" | "idle" | "stopping" | "stopped" | "failed";
  type Runtime = {
    workAttemptId: string;
    pid: number;
    continuation: string;
    state: RuntimeState;
    exitListeners: Set<(terminal: {
      endedAt: string; exitCode: number | null; signal: string | null;
      terminalCause: "stopped"; providerContinuationId: string;
    }) => void>;
  };
  const runtimes = new Map<string, Runtime>();
  type ProviderIdentityTuple = [workAttemptId: string, continuation: string, url: string, pid: number, processIdentity: string];
  const spawnRequests: Array<[entryId: string, workAttemptId: string]> = [];
  const attachRequests: ProviderIdentityTuple[] = [];
  const resumeRequests: Array<[entryId: string, workAttemptId: string, continuation: string]> = [];
  const stopRequests: string[] = [];
  let nextPid = 6100;
  const nativeHandle = (runtime: Runtime) => ({
    workAttemptId: runtime.workAttemptId,
    pid: runtime.pid,
    providerContinuationId: runtime.continuation,
    providerConnection: {
      kind: "codex_app_server" as const,
      url: `ws://127.0.0.1:${runtime.pid}`,
      pid: runtime.pid,
      processIdentity: `fake-codex:${runtime.pid}`,
    },
    observedState: () => runtime.state,
  });
  const connectionFor = (runtime: Runtime) => nativeHandle(runtime).providerConnection;
  const identityTuple = (runtime: Runtime): ProviderIdentityTuple => {
    const connection = connectionFor(runtime);
    return [runtime.workAttemptId, runtime.continuation, connection.url, connection.pid, connection.processIdentity];
  };
  const adapter: NativeProviderAdapter = {
    capabilities: () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async (request) => {
      spawnRequests.push([request.supervisorEntryId ?? "missing-entry", request.workAttemptId]);
      const runtime: Runtime = {
        workAttemptId: request.workAttemptId,
        pid: ++nextPid,
        continuation: `thread_${request.supervisorEntryId}`,
        state: "working",
        exitListeners: new Set(),
      };
      runtimes.set(runtime.workAttemptId, runtime);
      return nativeHandle(runtime);
    },
    attach: async (ref) => {
      const runtime = runtimes.get(ref.workAttemptId);
      const connection = ref.providerConnection;
      attachRequests.push([
        ref.workAttemptId,
        ref.providerContinuationId,
        connection?.kind === "codex_app_server" ? connection.url : "missing-url",
        connection?.pid ?? -1,
        connection?.processIdentity ?? "missing-process-identity",
      ]);
      const expected = runtime ? connectionFor(runtime) : null;
      if (
        !runtime
        || runtime.state === "stopped"
        || runtime.continuation !== ref.providerContinuationId
        || connection?.kind !== "codex_app_server"
        || connection.url !== expected?.url
        || connection.pid !== expected.pid
        || connection.processIdentity !== expected.processIdentity
      ) return null;
      return nativeHandle(runtime);
    },
    resume: async (ref, request) => {
      resumeRequests.push([request.supervisorEntryId ?? "missing-entry", request.workAttemptId, ref.providerContinuationId]);
      const runtime: Runtime = {
        workAttemptId: request.workAttemptId,
        pid: ++nextPid,
        continuation: ref.providerContinuationId,
        state: "working",
        exitListeners: new Set(),
      };
      runtimes.set(runtime.workAttemptId, runtime);
      return nativeHandle(runtime);
    },
    poke: async () => {},
    controlTurn: async () => ({ capability: "native_interrupt", interrupted: true, resumed: true, state: "working" }),
    stop: async (handle) => {
      stopRequests.push(handle.workAttemptId);
      const runtime = runtimes.get(handle.workAttemptId)!;
      runtime.state = "stopped";
      const terminal = {
        endedAt: new Date().toISOString(), exitCode: 0, signal: null,
        terminalCause: "stopped" as const, providerContinuationId: runtime.continuation,
      };
      queueMicrotask(() => {
        for (const listener of [...runtime.exitListeners]) listener(terminal);
      });
      return terminal;
    },
    onExit: (handle, listener) => {
      const listeners = runtimes.get(handle.workAttemptId)!.exitListeners;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    onStream: () => () => {},
  };
  const router = () => new ProviderActionPortRouter({ codex: async () => adapter });
  let activeRouter = router();
  let daemon = new SupervisorDaemon(paths, "darwin", activeRouter, true);
  try {
    await daemon.start();
    const entries = identities.map(({ entryId }, index): DaemonManifestEntry => ({
      ...entry,
      id: entryId,
      room_id: "codex_runtime_roundtable",
      provider: "codex",
      desired_state: "paused",
      observed_state: "paused",
      source_repo_path: sources[index],
      workspace_path: null,
      work_attempt_id: null,
    }));
    const created = await Promise.all(entries.map((candidate) =>
      daemonRequest(paths.socketPath, "manifest.put", { entry: candidate })));
    assert.ok(created.every((result) => result.ok));

    const activated = await Promise.all(entries.map((candidate) =>
      daemonRequest(paths.socketPath, "manifest.compare_and_set_desired_state", {
        id: candidate.id, expected_desired_state: "paused", desired_state: "running",
      })));
    assert.ok(activated.every((result) => result.ok && (result.result as { applied: boolean }).applied));
    try {
      await eventually(async () => {
        const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
        return manifest.length === 2 && manifest.every((candidate) => candidate.observed_state === "working");
      }, "both Codex provider executions", 5_000);
    } catch (error) {
      const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result;
      throw new Error(`${(error as Error).message}: ${JSON.stringify(manifest)}`);
    }

    const beforeRestart = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    const alphaBefore = beforeRestart.find((candidate) => candidate.id === identities[0].entryId)!;
    const bravoBefore = beforeRestart.find((candidate) => candidate.id === identities[1].entryId)!;
    assert.equal(spawnRequests.length, 2);
    assert.deepEqual(
      [...spawnRequests].sort(([left], [right]) => left.localeCompare(right)),
      [
        [identities[0].entryId, alphaBefore.work_attempt_id],
        [identities[1].entryId, bravoBefore.work_attempt_id],
      ],
    );
    assert.equal(alphaBefore.source_repo_path, sources[0]);
    assert.equal(bravoBefore.source_repo_path, sources[1]);
    assert.ok(alphaBefore.workspace_path?.startsWith(join(env.root, "worktrees")));
    assert.ok(bravoBefore.workspace_path?.startsWith(join(env.root, "worktrees")));
    assert.notEqual(alphaBefore.workspace_path, bravoBefore.workspace_path);
    assert.notEqual(alphaBefore.work_attempt_id, bravoBefore.work_attempt_id);
    assert.notEqual(alphaBefore.provider_ref?.execution_generation_id, bravoBefore.provider_ref?.execution_generation_id);
    assert.notEqual(alphaBefore.provider_ref?.provider_continuation_id, bravoBefore.provider_ref?.provider_continuation_id);
    assert.notEqual(alphaBefore.provider_ref?.provider_connection?.pid, bravoBefore.provider_ref?.provider_connection?.pid);

    const alphaConnection = alphaBefore.provider_ref?.provider_connection;
    const bravoConnection = bravoBefore.provider_ref?.provider_connection;
    assert.equal(alphaConnection?.kind, "codex_app_server");
    assert.equal(bravoConnection?.kind, "codex_app_server");
    const crossWire = await activeRouter.attach({
      workAttemptId: alphaBefore.work_attempt_id!,
      providerContinuationId: alphaBefore.provider_ref!.provider_continuation_id,
      provider: "codex",
      providerConnection: bravoConnection,
    });
    assert.equal(crossWire, null, "matching attempt and continuation cannot attach through another agent's provider connection");
    assert.equal(attachRequests.length, 0, "the production router rejects a cross-wired ref before the adapter can attach it");

    const handoff = daemon.waitForHandoff();
    assert.equal((await daemonRequest(paths.socketPath, "daemon.prepare_handoff")).ok, true);
    await within(handoff, "multi-agent daemon handoff", 1_000);
    activeRouter = router();
    daemon = new SupervisorDaemon(paths, "darwin", activeRouter, true);
    await daemon.start();
    await eventually(async () => {
      const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
      return manifest.length === 2
        && manifest.every((candidate) => candidate.observed_state === "working")
        && attachRequests.length === 2;
    }, "independent Codex provider reattachment", 5_000);
    assert.equal(attachRequests.length, 2);
    assert.deepEqual(
      [...attachRequests].sort(([left], [right]) => left.localeCompare(right)),
      [
        identityTuple(runtimes.get(alphaBefore.work_attempt_id!)!),
        identityTuple(runtimes.get(bravoBefore.work_attempt_id!)!),
      ].sort(([left], [right]) => left.localeCompare(right)),
    );
    const afterRestart = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    for (const prior of beforeRestart) {
      const reattached = afterRestart.find((candidate) => candidate.id === prior.id)!;
      assert.equal(reattached.work_attempt_id, prior.work_attempt_id);
      assert.equal(reattached.provider_ref?.execution_generation_id, prior.provider_ref?.execution_generation_id);
      assert.equal(reattached.provider_ref?.provider_continuation_id, prior.provider_ref?.provider_continuation_id);
      assert.equal(reattached.provider_ref?.provider_connection?.pid, prior.provider_ref?.provider_connection?.pid);
    }
    type AttemptDetail = {
      work_attempt_id: string;
      execution_generations: Array<{ execution_generation_id: string; terminal: unknown }>;
    };
    const attemptDetail = async (entryId: string) =>
      (await daemonRequest(paths.socketPath, "attempt.read", { id: entryId })).result as AttemptDetail;
    const alphaAfterRestartAttempt = await attemptDetail(alphaBefore.id);
    const bravoAfterRestartAttempt = await attemptDetail(bravoBefore.id);
    for (const [manifestEntry, detail] of [
      [alphaBefore, alphaAfterRestartAttempt],
      [bravoBefore, bravoAfterRestartAttempt],
    ] as const) {
      assert.equal(detail.work_attempt_id, manifestEntry.work_attempt_id);
      assert.equal(detail.execution_generations.length, 1);
      assert.equal(detail.execution_generations[0]?.execution_generation_id, manifestEntry.provider_ref?.execution_generation_id);
      assert.equal(detail.execution_generations[0]?.terminal, null);
    }

    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: identities[0].entryId, desired_state: "paused",
    })).ok, true);
    await eventually(async () => {
      const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
      return manifest.find((candidate) => candidate.id === identities[0].entryId)?.observed_state === "paused";
    }, "independent Codex pause", 5_000);
    const bravoWhileAlphaPaused = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])
      .find((candidate) => candidate.id === identities[1].entryId)!;
    assert.equal(bravoWhileAlphaPaused.observed_state, "working");
    assert.equal(bravoWhileAlphaPaused.provider_ref?.execution_generation_id, bravoBefore.provider_ref?.execution_generation_id);
    assert.equal(runtimes.get(bravoBefore.work_attempt_id!)?.state, "working");
    assert.deepEqual(stopRequests, [alphaBefore.work_attempt_id]);

    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: identities[0].entryId, desired_state: "running",
    })).ok, true);
    await eventually(async () => {
      const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
      return manifest.find((candidate) => candidate.id === identities[0].entryId)?.observed_state === "working";
    }, "independent Codex resume", 5_000);
    const afterResume = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    const alphaAfter = afterResume.find((candidate) => candidate.id === identities[0].entryId)!;
    const bravoAfter = afterResume.find((candidate) => candidate.id === identities[1].entryId)!;
    assert.equal(resumeRequests.length, 1);
    assert.deepEqual(resumeRequests, [[
      identities[0].entryId,
      alphaBefore.work_attempt_id,
      alphaBefore.provider_ref!.provider_continuation_id,
    ]]);
    assert.equal(alphaAfter.work_attempt_id, alphaBefore.work_attempt_id);
    assert.notEqual(alphaAfter.provider_ref?.execution_generation_id, alphaBefore.provider_ref?.execution_generation_id);
    assert.notEqual(alphaAfter.provider_ref?.provider_connection?.pid, alphaBefore.provider_ref?.provider_connection?.pid);
    assert.equal(bravoAfter.provider_ref?.execution_generation_id, bravoBefore.provider_ref?.execution_generation_id);
    assert.equal(bravoAfter.provider_ref?.provider_connection?.pid, bravoBefore.provider_ref?.provider_connection?.pid);
    const alphaAfterResumeAttempt = await attemptDetail(alphaAfter.id);
    const bravoAfterAlphaResumeAttempt = await attemptDetail(bravoAfter.id);
    assert.equal(alphaAfterResumeAttempt.execution_generations.length, 2);
    assert.notEqual(alphaAfter.provider_ref?.execution_generation_id, alphaBefore.provider_ref?.execution_generation_id);
    assert.ok(alphaAfterResumeAttempt.execution_generations.find((generation) =>
      generation.execution_generation_id === alphaBefore.provider_ref?.execution_generation_id)?.terminal);
    assert.equal(alphaAfterResumeAttempt.execution_generations.find((generation) =>
      generation.execution_generation_id === alphaAfter.provider_ref?.execution_generation_id)?.terminal, null);
    assert.deepEqual(bravoAfterAlphaResumeAttempt.execution_generations, bravoAfterRestartAttempt.execution_generations);
    assert.equal(bravoAfterAlphaResumeAttempt.execution_generations.length, 1);
    assert.equal(bravoAfterAlphaResumeAttempt.execution_generations[0]?.execution_generation_id, bravoBefore.provider_ref?.execution_generation_id);
    assert.equal(bravoAfterAlphaResumeAttempt.execution_generations[0]?.terminal, null);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("two supervised Codex claims wait together behind one legacy Codex owner", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const sources = await Promise.all([
    committedSourceRepository(env.root, "legacy-handoff-alpha-source"),
    committedSourceRepository(env.root, "legacy-handoff-bravo-source"),
  ]);
  await Promise.all(sources.map((source) => primeDaemonBareRepository(env.root, source)));
  const spawned: Array<[entryId: string, workAttemptId: string]> = [];
  let nextPid = 7100;
  const adapter: NativeProviderAdapter = {
    capabilities: () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async (request) => {
      spawned.push([request.supervisorEntryId ?? "missing-entry", request.workAttemptId]);
      const pid = ++nextPid;
      return {
        workAttemptId: request.workAttemptId,
        pid,
        providerContinuationId: `thread_${request.supervisorEntryId}`,
        providerConnection: { kind: "codex_app_server", url: `ws://127.0.0.1:${pid}`, pid, processIdentity: `fake-codex:${pid}` },
        observedState: () => "working",
      };
    },
    attach: async () => null,
    resume: async () => { throw new Error("legacy release activates fresh Codex agents"); },
    poke: async () => {},
    controlTurn: async () => ({ capability: "native_interrupt", interrupted: true, resumed: true, state: "working" }),
    stop: async (handle) => ({
      endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId,
    }),
    onExit: () => () => {},
    onStream: () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", new ProviderActionPortRouter({ codex: async () => adapter }), true);
  const candidate = (id: string): DaemonManifestEntry => ({
    ...entry,
    id,
    room_id: "codex_legacy_handoff",
    provider: "codex",
    desired_state: "paused",
    observed_state: "paused",
    source_repo_path: id.endsWith("alpha") ? sources[0] : sources[1],
    workspace_path: null,
    work_attempt_id: null,
  });
  try {
    await daemon.start();
    assert.equal((await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: "legacy_codex_owner", room_id: "codex_legacy_handoff", provider: "codex",
      owner_pid: process.pid, owner_process_identity: TEST_PROCESS_IDENTITY,
    })).ok, true);
    const created = await Promise.all(["codex_waiting_alpha", "codex_waiting_bravo"].map((id) =>
      daemonRequest(paths.socketPath, "manifest.put", { entry: candidate(id) })));
    assert.ok(created.every((result) => result.ok), "both paused supervised claims may be saved during legacy teardown");

    const blocked = await Promise.all(["codex_waiting_alpha", "codex_waiting_bravo"].map((id) =>
      daemonRequest(paths.socketPath, "manifest.compare_and_set_desired_state", {
        id, expected_desired_state: "paused", desired_state: "running",
      })));
    assert.ok(blocked.every((result) => !result.ok && /legacy reservation/.test(result.error ?? "")));
    assert.equal((await daemonRequest(paths.socketPath, "lane.release_legacy", { reservation_id: "legacy_codex_owner" })).ok, true);

    const activated = await Promise.all(["codex_waiting_alpha", "codex_waiting_bravo"].map((id) =>
      daemonRequest(paths.socketPath, "manifest.compare_and_set_desired_state", {
        id, expected_desired_state: "paused", desired_state: "running",
      })));
    assert.ok(activated.every((result) => result.ok && (result.result as { applied: boolean }).applied));
    await eventually(async () => {
      const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
      return manifest.length === 2 && manifest.every((item) => item.desired_state === "running" && item.observed_state === "working");
    }, "both Codex providers after legacy release", 5_000);
    const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    const alpha = manifest.find((item) => item.id === "codex_waiting_alpha")!;
    const bravo = manifest.find((item) => item.id === "codex_waiting_bravo")!;
    assert.equal(spawned.length, 2);
    assert.deepEqual([...spawned].sort(([left], [right]) => left.localeCompare(right)), [
      [alpha.id, alpha.work_attempt_id],
      [bravo.id, bravo.work_attempt_id],
    ]);
    assert.notEqual(alpha.work_attempt_id, bravo.work_attempt_id);
    assert.notEqual(alpha.provider_ref?.execution_generation_id, bravo.provider_ref?.execution_generation_id);
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("daemon restart quarantines duplicate Claude Code lane owners from older manifests", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  const duplicate = (id: string): DaemonManifestEntry => ({
    ...entry,
    id,
    room_id: "room_upgrade_duplicate",
    provider: "claude-code",
    desired_state: "running",
    observed_state: "working",
  });
  await new ManifestStore(paths.manifestPath).write(0, [duplicate("old_owner_a"), duplicate("old_owner_b")]);
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    assert.equal(manifest.length, 2);
    assert.ok(manifest.every((item) => item.desired_state === "stopped"));
    assert.ok(manifest.every((item) => item.last_error?.includes("multiple supervised agents")));
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", {
      entry: { ...duplicate("replacement"), desired_state: "paused", observed_state: "paused" },
    })).ok, false, "quarantined owners keep the lane fenced until each provider is observably stopped");
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("a concurrent Claude Code creation race mints one provider generation", async () => {
  const env = await fixture();
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
  };
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
  const creationIds = ["race_generation_a", "race_generation_b"] as const;
  const workspaces = await Promise.all(creationIds.map((creationId) => provisionedWorkspace(env.root, creationId)));
  const attempts = await Promise.all(workspaces.map((workspace, index) => durability.createAttempt({
    taskId: creationIds[index]!,
    leaseId: creationIds[index]!,
    leaseEpoch: 0,
    workspacePath: workspace.path,
    workAttemptId: workspace.id,
  })));
  let spawnCount = 0;
  const port: ProviderActionPort = {
    capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async (request) => {
      spawnCount += 1;
      return { workAttemptId: request.workAttemptId, pid: 4400, providerContinuationId: "race-generation-continuation", observedState: "working" as const };
    },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("a fresh winning owner must spawn"); },
    poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "race-generation-continuation" }),
    onExit: async () => () => {},
    onStream: async () => () => {},
  };
  const daemon = new SupervisorDaemon(paths, "darwin", port, true);
  const candidate = (index: number): DaemonManifestEntry => ({
    ...entry,
    id: creationIds[index]!,
    room_id: "room_generation_race",
    provider: "claude-code",
    desired_state: "paused",
    observed_state: "paused",
    workspace_path: attempts[index]!.workspace_path,
    work_attempt_id: attempts[index]!.work_attempt_id,
  });
  try {
    await daemon.start();
    const results = await Promise.all([
      daemonRequest(paths.socketPath, "manifest.put", { entry: candidate(0) }),
      daemonRequest(paths.socketPath, "manifest.put", { entry: candidate(1) }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    const owners = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
    assert.equal(owners.length, 1);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: owners[0]!.id,
      desired_state: "running",
    })).ok, true);
    await eventually(async () => spawnCount === 1, "single winning supervised generation");

    const durable = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
    const persisted = await durable.getAttempt(owners[0]!.work_attempt_id!);
    assert.equal(persisted.execution_generations.length, 1);
    assert.equal(persisted.execution_generations.filter((generation) => generation.terminal === null).length, 1);
  } finally {
    await daemon.stop().catch(() => undefined);
    await env.cleanup();
  }
});

test("legacy and supervised lanes share one durable linearization point in both flip directions", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  const daemon = new SupervisorDaemon(paths, "darwin");
  const candidate = (id: string, roomId: string): DaemonManifestEntry => ({
    ...entry,
    id,
    room_id: roomId,
    provider: "codex",
    desired_state: "paused",
    observed_state: "paused",
  });
  try {
    await daemon.start();

    // Legacy wins the first linearization point. A paused transfer claim may
    // be recorded, but it cannot activate/spawn until the legacy owner exits.
    assert.equal((await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: "legacy_first", room_id: "room_legacy_first", provider: "codex", owner_pid: process.pid, owner_process_identity: TEST_PROCESS_IDENTITY,
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", {
      entry: candidate("supervised_pending", "room_legacy_first"),
    })).ok, true);
    const blockedActivation = await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "supervised_pending", desired_state: "running",
    });
    assert.equal(blockedActivation.ok, false);
    assert.match(blockedActivation.error ?? "", /legacy reservation/);
    assert.equal((await daemonRequest(paths.socketPath, "lane.activate_legacy", {
      reservation_id: "legacy_first", session_id: "legacy_session_first",
    })).ok, true);

    // After the confirmed legacy stop/release, the pending supervised claim
    // is the only engine allowed to activate.
    assert.equal((await daemonRequest(paths.socketPath, "lane.release_legacy", {
      session_id: "legacy_session_first",
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "supervised_pending", desired_state: "running",
    })).ok, true);

    // Supervised wins the opposite direction before a legacy spawn. The
    // legacy reservation fails, so its caller cannot enter runtime.start.
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", {
      entry: candidate("supervised_first", "room_supervised_first"),
    })).ok, true);
    const blockedLegacy = await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: "legacy_loser", room_id: "room_supervised_first", provider: "codex", owner_pid: process.pid, owner_process_identity: TEST_PROCESS_IDENTITY,
    });
    assert.equal(blockedLegacy.ok, false);
    assert.match(blockedLegacy.error ?? "", /supervised entry/);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "supervised_first", desired_state: "running",
    })).ok, true);

    // Barrier edge: the legacy runtime became visible before its reservation
    // was bound to a session. Supervised teardown releases by lane, so the
    // pending supervised claim activates and the late legacy bind is fenced.
    assert.equal((await daemonRequest(paths.socketPath, "lane.reserve_legacy", {
      reservation_id: "legacy_mid_spawn", room_id: "room_mid_spawn", provider: "codex", owner_pid: process.pid, owner_process_identity: TEST_PROCESS_IDENTITY,
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.put", {
      entry: candidate("supervised_mid_spawn", "room_mid_spawn"),
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "lane.release_legacy", {
      room_id: "room_mid_spawn", provider: "codex",
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "manifest.set_desired_state", {
      id: "supervised_mid_spawn", desired_state: "running",
    })).ok, true);
    const lateLegacyBind = await daemonRequest(paths.socketPath, "lane.activate_legacy", {
      reservation_id: "legacy_mid_spawn", session_id: "legacy_session_late",
    });
    assert.equal(lateLegacyBind.ok, false);
    assert.match(lateLegacyBind.error ?? "", /Unknown legacy lane reservation/);

    const durable = await new ManifestStore(paths.manifestPath).load();
    assert.deepEqual(durable.legacy_lane_owners ?? [], []);
    assert.equal(durable.entries.filter((owner) => owner.desired_state === "running").length, 3);
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("public-socket barrier races observe exactly one real mixed-engine product-path callback in both winner directions", async () => {
  for (const releaseOrder of [["legacy", "supervised"], ["supervised", "legacy"]] as const) {
    const env = await fixture();
    const paths = {
      lockPath: join(env.root, "daemon.lock"),
      socketPath: join(env.root, "daemon.sock"),
      manifestPath: join(env.root, "daemon-state.sqlite"),
      auditPath: join(env.root, "audit.jsonl"),
      attemptsPath: join(env.root, "attempts.json"),
      attemptsRoot: join(env.root, "attempt-data"),
      workspaceRoot: env.root,
    };
    const roomId = `room_product_race_${releaseOrder[0]}`;
    const supervisedId = `supervised_product_race_${releaseOrder[0]}`;
    const reservationId = `legacy_product_race_${releaseOrder[0]}`;
    const workspace = await provisionedWorkspace(env.root, supervisedId);
    const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees"));
    const attempt = await durability.createAttempt({
      taskId: supervisedId,
      leaseId: supervisedId,
      leaseEpoch: 0,
      workspacePath: workspace.path,
      workAttemptId: workspace.id,
    });
    let legacyStarts = 0;
    let supervisedSpawns = 0;
    let supervisedStreamDeliveries = 0;
    const handle = {
      workAttemptId: attempt.work_attempt_id,
      pid: 42,
      providerContinuationId: `continuation_${releaseOrder[0]}`,
      observedState: "working" as const,
    };
    const port: ProviderActionPort = {
      capabilities: async () => ({ resume: false, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
      spawn: async (request) => {
        supervisedSpawns += 1;
        assert.equal(request.workAttemptId, attempt.work_attempt_id);
        return handle;
      },
      attach: async () => null,
      attachAction: async () => ({ state: "absent" }),
      resume: async () => { throw new Error("fresh mixed-engine race must not resume"); },
      poke: async () => {},
      stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: handle.providerContinuationId }),
      onExit: async () => () => {},
      onStream: async (_providerHandle, listener) => {
        queueMicrotask(() => {
          supervisedStreamDeliveries += 1;
          listener({
            workAttemptId: attempt.work_attempt_id,
            providerContinuationId: handle.providerContinuationId,
            observedAt: new Date().toISOString(),
            sequence: 1,
            provider: "codex",
            kind: "turn_lifecycle",
            method: "turn/product-path-delivery",
            payload: { releaseOrder },
            payloadTruncated: false,
            payloadRedacted: false,
            durablePayloadRef: null,
          });
        });
        return () => {};
      },
    };
    const mutationBarrier = orderedDaemonMutationBarrier(releaseOrder);
    const daemon = new SupervisorDaemon(paths, "darwin", port, true, 60_000, mutationBarrier.gate);
    try {
      await daemon.start();
      const barrierRequest = concurrentDaemonRequestBarrier(paths.socketPath);
      const legacy = launchLegacyWithOwnership({
        reserve: async () => {
          const result = await barrierRequest("legacy", "lane.reserve_legacy", {
            reservation_id: reservationId,
            room_id: roomId,
            provider: "codex",
            owner_pid: process.pid,
            owner_process_identity: TEST_PROCESS_IDENTITY,
          });
          if (!result.ok) throw new Error(result.error);
        },
        start: async () => {
          legacyStarts += 1;
          return { sessionId: `legacy_session_${releaseOrder[0]}` };
        },
        activate: async (started) => {
          const result = await daemonRequest(paths.socketPath, "lane.activate_legacy", {
            reservation_id: reservationId,
            session_id: started.sessionId,
          });
          if (!result.ok) throw new Error(result.error);
        },
        stop: async () => { legacyStarts -= 1; },
        release: async () => {
          await daemonRequest(paths.socketPath, "lane.release_legacy", { reservation_id: reservationId });
        },
      });
      const supervised = barrierRequest("supervised", "manifest.put", {
        entry: {
          ...entry,
          id: supervisedId,
          room_id: roomId,
          provider: "codex",
          desired_state: "running",
          observed_state: "absent",
          workspace_path: attempt.workspace_path,
          work_attempt_id: attempt.work_attempt_id,
        },
      });
      const [legacyResult, supervisedResult] = await Promise.allSettled([legacy, supervised]);
      assert.deepEqual([...mutationBarrier.arrived].sort(), ["legacy", "supervised"], "both public claim frames reach the daemon before either mutation is released");

      if (releaseOrder[0] === "legacy") {
        assert.equal(legacyResult.status, "fulfilled");
        assert.equal(supervisedResult.status, "fulfilled");
        assert.equal(supervisedResult.value.ok, false);
        assert.match(supervisedResult.value.error ?? "", /legacy reservation/);
      } else {
        assert.equal(supervisedResult.status, "fulfilled");
        assert.equal(supervisedResult.value.ok, true, supervisedResult.value.error);
        assert.equal(legacyResult.status, "rejected");
        assert.match(String(legacyResult.reason), /supervised entry/);
        await eventually(async () => supervisedSpawns === 1 && supervisedStreamDeliveries === 1, "supervised spawn and stream delivery callbacks");
        await eventually(async () => {
          const manifest = (await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[];
          return manifest.find((candidate) => candidate.id === supervisedId)?.activity?.some((event) => event.method === "turn/product-path-delivery") === true;
        }, "supervised stream delivery persisted through the daemon product path");
      }

      const expected = releaseOrder[0] === "legacy" ? [1, 0] : [0, 1];
      assert.deepEqual([legacyStarts, supervisedSpawns], expected, "real legacy start and ProviderActionPort.spawn callbacks have exactly one winner");
      assert.equal(supervisedStreamDeliveries, expected[1], "only the supervised winner installs and receives its provider stream delivery");
    } finally {
      await daemon.stop();
      await env.cleanup();
    }
  }
});

test("daemon start deterministically removes crash-orphaned reserved legacy lanes", async () => {
  const env = await fixture();
  const paths = { lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"), manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") };
  await new ManifestStore(paths.manifestPath).write(0, [], [{
    reservation_id: "orphaned_reservation",
    room_id: "room_orphaned",
    provider: "codex",
    owner_pid: 2_147_483_647,
    owner_process_identity: "orphaned-process-identity",
    state: "reserved",
    session_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  }]);
  const daemon = new SupervisorDaemon(paths, "darwin");
  try {
    await daemon.start();
    assert.deepEqual((await new ManifestStore(paths.manifestPath).load()).legacy_lane_owners ?? [], []);
    const claim = await daemonRequest(paths.socketPath, "manifest.put", {
      entry: { ...entry, id: "supervised_after_orphan", room_id: "room_orphaned", provider: "codex", desired_state: "paused" },
    });
    assert.equal(claim.ok, true, claim.error);
  } finally {
    await daemon.stop();
    await env.cleanup();
  }
});

test("restart fences a title-mutated orphan, durably closes its generation, and resumes one successor", async () => {
  const env = await fixture();
  const source = join(env.root, "source");
  await mkdir(source);
  await execFileAsync("git", ["init", source]);
  await execFileAsync("git", ["-C", source, "config", "user.email", "daemon@example.invalid"]);
  await execFileAsync("git", ["-C", source, "config", "user.name", "Daemon Test"]);
  await writeFile(join(source, "README.md"), "durable\n");
  await execFileAsync("git", ["-C", source, "add", "README.md"]);
  await execFileAsync("git", ["-C", source, "commit", "-m", "fixture"]);
  await execFileAsync("git", ["-C", source, "remote", "add", "origin", source]);
  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
    workerBindingsPath: join(env.root, "worker-bindings.json"),
  };
  const continuation = "claude-session-durable";
  let activeChild: ChildProcess | null = null;
  let originalPid: number | null = null;
  let recordedBirthIdentity: string | null = null;
  let workAttemptId = "";
  let fencedBeforeTerminalEvidence = false;
  let resumeCount = 0;

  const launch = async (mutateTitle: boolean) => {
    const script = mutateTitle
      ? "setTimeout(() => { process.title = 'claude'; }, 50); setInterval(() => {}, 1000)"
      : "setInterval(() => {}, 1000)";
    activeChild = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    await eventually(async () => typeof defaultGetProcessIdentity(activeChild!.pid!) === "string", "provider birth identity");
    return activeChild;
  };
  const publicHandle = () => ({
    workAttemptId,
    pid: activeChild?.pid ?? null,
    providerContinuationId: continuation,
    providerConnection: {
      kind: "claude_cli" as const,
      pid: activeChild?.pid ?? null,
      processIdentity: defaultGetProcessIdentity(activeChild!.pid!) ?? null,
    },
    observedState: "working" as const,
  });
  const firstPort: ProviderActionPort = {
    capabilities: async () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: false }),
    spawn: async (request) => {
      workAttemptId = request.workAttemptId;
      await launch(true);
      originalPid = activeChild!.pid!;
      recordedBirthIdentity = defaultGetProcessIdentity(originalPid);
      return publicHandle();
    },
    attach: async () => null,
    attachAction: async () => ({ state: "absent" }),
    resume: async () => { throw new Error("first daemon must not resume"); },
    poke: async () => {},
    stop: async () => ({ endedAt: new Date().toISOString(), exitCode: 0, signal: "SIGTERM", terminalCause: "stopped", providerContinuationId: continuation }),
    onExit: async () => () => {},
  };
  const secondPort: ProviderActionPort = {
    capabilities: firstPort.capabilities,
    spawn: async () => { throw new Error("durable Claude continuation must resume, not spawn"); },
    attach: async (ref) => {
      assert.equal(ref.providerContinuationId, continuation);
      assert.equal(ref.providerConnection?.processIdentity, recordedBirthIdentity);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(defaultGetProcessIdentity(originalPid!), recordedBirthIdentity, "process title mutation cannot change birth identity");
      const exited = new Promise<void>((resolve) => activeChild!.once("exit", () => resolve()));
      activeChild!.kill("SIGTERM");
      await exited;
      assert.equal(defaultGetProcessIdentity(originalPid!), null, "old writer is gone before terminal evidence crosses the adapter boundary");
      fencedBeforeTerminalEvidence = true;
      return {
        state: "terminal",
        terminal: { endedAt: new Date().toISOString(), exitCode: null, signal: "SIGTERM", terminalCause: "stopped", providerContinuationId: continuation },
      };
    },
    attachAction: async () => ({ state: "absent" }),
    resume: async (ref) => {
      assert.equal(fencedBeforeTerminalEvidence, true);
      assert.equal(ref.providerContinuationId, continuation);
      const persisted = await new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(env.root, "worktrees")).getAttempt(ref.workAttemptId);
      assert.notEqual(persisted.execution_generations[0]!.terminal, null, "old generation is durable terminal before successor launch");
      resumeCount += 1;
      await launch(false);
      return publicHandle();
    },
    poke: async () => {},
    stop: firstPort.stop,
    onExit: async () => () => {},
  };

  const first = new SupervisorDaemon(paths, "darwin", firstPort, true);
  let second: SupervisorDaemon | null = null;
  try {
    await first.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry,
      id: "supervised_claude_fence",
      room_id: "focus_37",
      provider: "claude-code",
      observed_state: "absent",
      source_repo_path: source,
      workspace_path: null,
      work_attempt_id: null,
      provider_launch_policy: { permissionMode: "acceptEdits" },
    } });
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working"), "first Claude generation");
    const original = ((await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_claude_fence" })).result as { execution_generations: Array<{ execution_generation_id: string }> });
    assert.equal(original.execution_generations.length, 1);
    const originalGenerationId = original.execution_generations[0]!.execution_generation_id;

    await first.stop();
    second = new SupervisorDaemon(paths, "darwin", secondPort, true);
    await second.start();
    await eventually(async () => {
      const manifest = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return manifest.observed_state === "working" && manifest.provider_ref?.execution_generation_id !== originalGenerationId;
    }, "bounded successor resume", 8_000);
    const recovered = (await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_claude_fence" })).result as {
      execution_generations: Array<{ terminal: { terminal_cause: string } | null }>;
    };
    assert.equal(fencedBeforeTerminalEvidence, true);
    assert.equal(recovered.execution_generations.length, 2, "recovery mints exactly one successor generation");
    assert.equal(recovered.execution_generations[0]!.terminal?.terminal_cause, "stopped");
    assert.equal(recovered.execution_generations[1]!.terminal, null);
    assert.equal(resumeCount, 1);
  } finally {
    await first.stop().catch(() => undefined);
    await second?.stop().catch(() => undefined);
    if (activeChild?.pid) {
      try { activeChild.kill("SIGKILL"); } catch {}
    }
    await env.cleanup();
  }
});

test("generation handoff reattaches the same provider and publishes its supervised native stream to the exact worker endpoint", async () => {
  const env = await fixture();
  const nativeRequests: Array<{ headers: import("node:http").IncomingHttpHeaders; body: any }> = [];
  let rejectNativeActivity = false;
  let nativeRequestsInFlight = 0;
  let maxNativeRequestsInFlight = 0;
  const nativeServer = createHttpServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { raw += chunk; });
    request.on("end", async () => {
      nativeRequestsInFlight += 1;
      maxNativeRequestsInFlight = Math.max(maxNativeRequestsInFlight, nativeRequestsInFlight);
      const body = JSON.parse(raw);
      nativeRequests.push({ headers: request.headers, body });
      if (body.method === "turn/same-millisecond-a") await new Promise((resolve) => setTimeout(resolve, 30));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ accepted: !rejectNativeActivity, presence: { status: "working" }, lease_heartbeats: rejectNativeActivity ? [] : [{ id: "lease_exact", epoch: 7 }] }));
      nativeRequestsInFlight -= 1;
    });
  });
  await new Promise<void>((resolve, reject) => { nativeServer.once("error", reject); nativeServer.listen(0, "127.0.0.1", resolve); });
  const nativeAddress = nativeServer.address() as AddressInfo;
  const apiUrl = `http://127.0.0.1:${nativeAddress.port}`;
  const source = join(env.root, "source");
  await mkdir(source);
  await execFileAsync("git", ["init", source]);
  await execFileAsync("git", ["-C", source, "config", "user.email", "daemon@example.invalid"]);
  await execFileAsync("git", ["-C", source, "config", "user.name", "Daemon Test"]);
  await writeFile(join(source, "README.md"), "durable\n");
  await execFileAsync("git", ["-C", source, "add", "README.md"]);
  await execFileAsync("git", ["-C", source, "commit", "-m", "fixture"]);
  await execFileAsync("git", ["-C", source, "remote", "add", "origin", source]);

  const paths = {
    lockPath: join(env.root, "daemon.lock"), socketPath: join(env.root, "daemon.sock"),
    manifestPath: join(env.root, "daemon-state.sqlite"), auditPath: join(env.root, "audit.jsonl"),
    attemptsPath: join(env.root, "attempts.json"), attemptsRoot: join(env.root, "attempt-data"), workspaceRoot: env.root,
    workerBindingsPath: join(env.root, "worker-bindings.json"),
  };
  let child: ChildProcess | null = null;
  let continuation = "thread-durable";
  let sequence = 0;
  let resumeCount = 0;
  let resumeSupported = true;
  const resumeRequests: Array<Parameters<ProviderActionPort["resume"]>[1]> = [];
  const streamListeners = new Set<(event: any) => void>();
  const exitListeners = new Set<(terminal: any) => void>();
  const handle = () => ({
    workAttemptId: "", pid: child?.pid ?? null, providerContinuationId: continuation,
    providerConnection: { kind: "codex_app_server" as const, url: "ws://127.0.0.1:65534", pid: child?.pid ?? null, processIdentity: `fixture:${child?.pid}` },
    observedState: "working" as const,
  });
  let workAttemptId = "";
  const launchChild = () => {
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    child.once("exit", (code, signal) => {
      for (const listener of exitListeners) listener({ endedAt: new Date().toISOString(), exitCode: code, signal, terminalCause: "stopped", providerContinuationId: continuation });
    });
  };
  const port = (): ProviderActionPort => ({
    capabilities: async () => ({ resume: resumeSupported, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true }),
    spawn: async (request) => {
      workAttemptId = request.workAttemptId;
      launchChild();
      return { ...handle(), workAttemptId };
    },
    attach: async (ref) => child?.pid && ref.providerContinuationId === continuation
      ? { ...handle(), workAttemptId: ref.workAttemptId }
      : null,
    attachAction: async () => ({ state: "absent" }),
    resume: async (ref, request) => {
      resumeCount += 1;
      resumeRequests.push(request);
      workAttemptId = ref.workAttemptId;
      launchChild();
      return { ...handle(), workAttemptId };
    },
    poke: async () => {},
    stop: async () => new Promise((resolveStop) => {
      const terminal = { endedAt: new Date().toISOString(), exitCode: 0, signal: "SIGTERM", terminalCause: "stopped" as const, providerContinuationId: continuation };
      child?.once("exit", () => resolveStop(terminal));
      child?.kill("SIGTERM");
    }),
    onExit: async (_providerHandle, listener) => { exitListeners.add(listener); return () => exitListeners.delete(listener); },
    onStream: async (_providerHandle, listener) => { streamListeners.add(listener); return () => streamListeners.delete(listener); },
  });

  const first = new SupervisorDaemon(paths, "darwin", port(), true);
  let second: SupervisorDaemon | null = null;
  let third: SupervisorDaemon | null = null;
  try {
    await first.start();
    await daemonRequest(paths.socketPath, "manifest.put", { entry: {
      ...entry, id: "supervised_handoff", room_id: "focus_37", provider: "codex", observed_state: "absent",
      source_repo_path: source, workspace_path: null, work_attempt_id: null,
      provider_launch_policy: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
    } });
    try {
      await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working"), "daemon-owned provider start", 8_000);
    } catch (error) {
      const state = (await daemonRequest(paths.socketPath, "manifest.list")).result;
      throw new Error(`${(error as Error).message}: ${JSON.stringify(state)}`);
    }
    const before = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0])!;
    const originalPid = before.provider_ref?.provider_connection?.pid;
    const executionGenerationId = before.provider_ref?.execution_generation_id;
    assert.equal(originalPid, child?.pid);
    const bound = await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff",
      room_id: "focus_37",
      work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId,
      agent_session_id: "agent_session_exact",
      agent_session_token: "session-secret",
      api_url: apiUrl,
    });
    assert.equal(bound.ok, true, bound.error);
    const boundProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(boundProjection.worker_binding?.agent_session_id, "agent_session_exact");
    assert.equal(boundProjection.worker_binding?.work_attempt_id, workAttemptId);
    assert.equal(boundProjection.worker_binding?.execution_generation_id, executionGenerationId);
    assert.equal(boundProjection.last_worker_binding?.agent_session_id, "agent_session_exact");
    assert.equal(boundProjection.workplace_liveness?.state, "reachable", "fresh exact binding marks the MCP workplace reachable");
    assert.doesNotMatch(JSON.stringify(boundProjection), /session-secret|api_url/, "renderer projection never exposes worker authority");
    await daemonRequest(paths.socketPath, "manifest.update_workplace_liveness", {
      id: "supervised_handoff",
      state: "reachable",
      detail: "original bind timestamp",
      observed_at: "2026-01-01T00:00:00.000Z",
    });
    const heartbeatProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(heartbeatProjection.workplace_liveness?.state, "reachable", "fresh exact wait authority outranks the old manifest bind timestamp");
    assert.equal(heartbeatProjection.workplace_liveness?.observed_at, heartbeatProjection.worker_binding?.updated_at);
    await eventually(async () => nativeRequests.some((request) => request.body.method === "native_harness.bound"), "initial daemon worker binding activity");
    const manifestAfterFirstBind = await new ManifestStore(paths.manifestPath).load();
    const workplaceObservedAtAfterFirstBind = manifestAfterFirstBind.entries
      .find((candidate) => candidate.id === "supervised_handoff")?.workplace_liveness?.observed_at;
    const repeatedBind = await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff",
      room_id: "focus_37",
      work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId,
      agent_session_id: "agent_session_exact",
      agent_session_token: "session-secret",
      api_url: apiUrl,
    });
    assert.equal(repeatedBind.ok, true, repeatedBind.error);
    const manifestAfterRepeatedBind = await new ManifestStore(paths.manifestPath).load();
    assert.equal(
      manifestAfterRepeatedBind.generation,
      manifestAfterFirstBind.generation,
      "an unchanged exact binding performs no full manifest commit",
    );
    assert.equal(
      manifestAfterRepeatedBind.entries.find((candidate) => candidate.id === "supervised_handoff")?.workplace_liveness?.observed_at,
      workplaceObservedAtAfterFirstBind,
      "an unchanged exact binding does not refresh manifest liveness or request another manifest write",
    );
    const emitCompatWaitCursor = (roomCursor: string, agentSessionId: string | null = "agent_session_exact") => {
      for (const listener of streamListeners) listener({
        workAttemptId,
        providerContinuationId: continuation,
        observedAt: new Date().toISOString(),
        sequence: ++sequence,
        provider: "claude-code",
        kind: "text_delta",
        method: "assistant",
        payload: {
          type: "assistant",
          message: { content: [{
            type: "tool_use",
            name: "mcp__letagents__wait_for_messages",
            input: {
              after_message_id: roomCursor,
              ...(agentSessionId ? { agent_session_id: agentSessionId } : {}),
            },
          }] },
        },
        payloadTruncated: false,
        payloadRedacted: false,
        durablePayloadRef: null,
      });
    };
    emitCompatWaitCursor("msg_2818");
    await eventually(async () => (await new WorkerBindingStore(paths.workerBindingsPath, undefined, paths.manifestPath).get("supervised_handoff"))?.room_cursor === "msg_2818", "published-runtime native wait cursor checkpoint");
    const pollingProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0])!;
    assert.equal(pollingProjection.observed_state, "idle", "Claude room polling is reachable but not projected as active work");
    assert.equal(pollingProjection.activity?.at(-1)?.status, "idle");
    await eventually(async () => {
      const attempt = (await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { checkpoints: Array<{ room_cursor: string | null }> };
      return attempt.checkpoints.at(-1)?.room_cursor === "msg_2818";
    }, "published-runtime durable wait cursor checkpoint");
    const nativeCursorAttempt = (await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { checkpoints: Array<{ room_cursor: string | null }> };
    assert.equal(nativeCursorAttempt.checkpoints.at(-1)?.room_cursor, "msg_2818");
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.checkpoint_worker_cursor", {
      entry_id: "supervised_handoff", work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId, agent_session_id: "agent_session_exact",
      room_cursor: "msg_2820",
    })).ok, true);
    const regressiveFormalCursor = await daemonRequest(paths.socketPath, "supervisor.checkpoint_worker_cursor", {
      entry_id: "supervised_handoff", work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId, agent_session_id: "agent_session_exact",
      room_cursor: "msg_2819",
    });
    assert.equal(regressiveFormalCursor.ok, true);
    assert.equal((regressiveFormalCursor.result as { room_cursor: string }).room_cursor, "msg_2820",
      "out-of-order formal acknowledgements report and preserve the newest durable cursor");
    emitCompatWaitCursor("msg_2819");
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.activity?.length === 2), "delayed compatibility cursor evidence");
    const formalCursorWins = await new WorkerBindingStore(paths.workerBindingsPath, undefined, paths.manifestPath).get("supervised_handoff");
    assert.equal(formalCursorWins?.room_cursor, "msg_2820", "delayed compatibility evidence cannot regress the formal response cursor");
    const formalCursorAttempt = (await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { checkpoints: Array<{ room_cursor: string | null }> };
    assert.equal(formalCursorAttempt.checkpoints.at(-1)?.room_cursor, "msg_2820", "durable attempt progress follows the same serialized no-regression order");
    for (const listener of streamListeners) listener({ workAttemptId, providerContinuationId: continuation, observedAt: new Date().toISOString(), sequence: ++sequence, provider: "codex", kind: "tool_lifecycle", method: "item/toolCall/started", payload: { tool: "test" }, payloadTruncated: false, payloadRedacted: false, durablePayloadRef: null });
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.activity?.length === 3), "first native stream event after cursor evidence");
    await eventually(async () => nativeRequests.some((request) => request.body.method === "item/toolCall/started"), "daemon-supervised stream HTTP publication");
    const workingProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0])!;
    assert.equal(workingProjection.observed_state, "working", "real Codex tool work restores the active projection");
    const diagnosticProjection = workingProjection as DaemonManifestEntryView;
    assert.deepEqual(diagnosticProjection.delivery_receipts, [], "raw provider notifications remain diagnostics, not room deliveries");
    assert.equal(diagnosticProjection.room_agent_state?.turn.state, "idle", "diagnostic provider work cannot invent an inbox turn");
    assert.equal(diagnosticProjection.native_liveness?.state, "active", "the native presence axis still truthfully reflects provider work");
    const published = nativeRequests.find((request) => request.body.method === "item/toolCall/started")!;
    assert.equal(published.headers.authorization, undefined, "daemon never persists or sends owner/optional bearer authority");
    assert.equal(published.body.agent_session_id, "agent_session_exact");
    assert.equal(published.body.agent_session_token, "session-secret");
    assert.equal(published.body.status, "working");
    assert.equal(typeof published.body.sequence, "number");
    assert.ok(published.body.sequence > 0);
    assert.equal((await stat(paths.manifestPath)).mode & 0o777, 0o600);
    await assert.rejects(() => readFile(paths.workerBindingsPath, "utf8"), { code: "ENOENT" });
    assert.doesNotMatch(JSON.stringify((await daemonRequest(paths.socketPath, "manifest.list")).result), /session-secret/);
    const nativeCanary = "canary-not-a-real-native-secret-123456789";
    const nativeInternals = first as unknown as { publishNativeActivity: (entryId: string, method: string, status: "working" | "idle") => Promise<boolean> };
    await nativeInternals.publishNativeActivity("supervised_handoff", `tool Authorization: Bearer ${nativeCanary}`, "working");
    const canaryPublication = nativeRequests.at(-1)!;
    assert.doesNotMatch(JSON.stringify(canaryPublication.body), new RegExp(nativeCanary));
    assert.match(canaryPublication.body.method, /REDACTED/);

    const sameObservedAt = new Date().toISOString();
    for (const [method, eventObservedAt] of [
      ["turn/same-millisecond-a", sameObservedAt],
      ["turn/same-millisecond-b", sameObservedAt],
      ["turn/reordered-older", new Date(Date.parse(sameObservedAt) - 60_000).toISOString()],
    ] as const) {
      for (const listener of streamListeners) listener({ workAttemptId, providerContinuationId: continuation, observedAt: eventObservedAt, sequence: ++sequence, provider: "codex", kind: "turn_lifecycle", method, payload: {}, payloadTruncated: false, payloadRedacted: false, durablePayloadRef: null });
    }
    await eventually(async () => nativeRequests.filter((request) => /same-millisecond|reordered-older/.test(request.body.method)).length === 3, "same-ms and reordered native publications");
    const orderedPublications = ["item/toolCall/started", "turn/same-millisecond-a", "turn/same-millisecond-b", "turn/reordered-older"]
      .map((method) => nativeRequests.find((request) => request.body.method === method)!.body);
    for (let index = 1; index < orderedPublications.length; index += 1) {
      assert.ok(orderedPublications[index]!.sequence > orderedPublications[index - 1]!.sequence);
      assert.ok(Date.parse(orderedPublications[index]!.observed_at) > Date.parse(orderedPublications[index - 1]!.observed_at));
    }
    assert.equal(maxNativeRequestsInFlight, 1, "the durable publication mutex remains held through fetch completion");
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.activity?.length === 6), "serialized local native events");

    await first.stop();
    assert.doesNotThrow(() => process.kill(originalPid!, 0), "provider survives daemon handoff");
    second = new SupervisorDaemon(paths, "darwin", port(), true);
    await second.start();
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "working"), "replacement daemon attach");
    await eventually(async () => streamListeners.size === 1, "replacement native stream subscription");
    await daemonRequest(paths.socketPath, "manifest.update_workplace_liveness", {
      id: "supervised_handoff",
      state: "unknown",
      detail: "replacement daemon awaiting exact persisted bind",
      observed_at: new Date().toISOString(),
    });
    const replacementDaemonGeneration = Number(((await daemonRequest(paths.socketPath, "daemon.negotiate")).result as { generation: number }).generation);
    const retiredCredential = await daemonRequest(paths.socketPath, "supervisor.borrow_worker_credential", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_exact",
      work_attempt_id: workAttemptId, execution_generation_id: executionGenerationId,
      daemon_generation: replacementDaemonGeneration, api_url: apiUrl,
    });
    assert.deepEqual(retiredCredential.result, { status: "deferred" },
      "the replacement retains the exact public route but cannot borrow the retired daemon's credential");
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_exact",
      work_attempt_id: workAttemptId, execution_generation_id: executionGenerationId,
      agent_session_token: "session-secret", api_url: apiUrl,
    })).ok, true);
    const after = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0])!;
    assert.equal(after.provider_ref?.provider_connection?.pid, originalPid);
    assert.equal(after.provider_ref?.provider_continuation_id, continuation);
    assert.equal(after.work_attempt_id, workAttemptId);
    assert.equal(after.provider_ref?.execution_generation_id, executionGenerationId,
      "handoff reattaches the same live execution generation instead of minting a replacement");
    assert.equal((after as DaemonManifestEntryView).worker_binding?.agent_session_id, "agent_session_exact", "daemon handoff preserves the public exact-session projection");
    assert.equal(after.workplace_liveness?.state, "reachable", "idempotent persisted bind restores workplace reachability after daemon replacement");
    sequence = 0; // A freshly attached adapter has a fresh local counter.
    for (const listener of streamListeners) listener({ workAttemptId, providerContinuationId: continuation, observedAt: new Date().toISOString(), sequence: ++sequence, provider: "codex", kind: "item_lifecycle", method: "item/completed", payload: {}, payloadTruncated: false, payloadRedacted: false, durablePayloadRef: null });
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.activity?.length === 7), "reattached stream event");
    await eventually(async () => nativeRequests.some((request) => request.body.method === "item/completed"), "replacement daemon native stream publication");
    assert.equal(after.activity?.at(-1)?.sequence, 6);
    const withReattachedStream = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0])!;
    assert.equal(withReattachedStream.activity?.at(-1)?.sequence, 7, "daemon preserves global activity ordering across adapter counter reset");
    assert.equal(withReattachedStream.observed_state, "idle", "a completion notification truthfully returns native presence to idle");
    assert.equal(withReattachedStream.native_liveness?.state, "idle");
    assert.deepEqual((withReattachedStream as DaemonManifestEntryView).delivery_receipts, [],
      "provider completion diagnostics cannot fabricate a delivery receipt after handoff");
    const firstPublished = nativeRequests.find((request) => request.body.method === "item/toolCall/started")!;
    const reattachedPublished = nativeRequests.find((request) => request.body.method === "item/completed")!;
    assert.ok(reattachedPublished.body.sequence > firstPublished.body.sequence, "durable publisher sequence survives daemon generation handoff");

    rejectNativeActivity = true;
    for (const listener of streamListeners) listener({ workAttemptId, providerContinuationId: continuation, observedAt: new Date().toISOString(), sequence: ++sequence, provider: "codex", kind: "turn_lifecycle", method: "turn/rejected-for-successor", payload: {}, payloadTruncated: false, payloadRedacted: false, durablePayloadRef: null });
    await eventually(async () => nativeRequests.some((request) => request.body.method === "turn/rejected-for-successor"), "successor fence rejection");
    await eventually(async () => (await new WorkerBindingStore(paths.workerBindingsPath, undefined, paths.manifestPath).get("supervised_handoff")) === null, "stale worker binding removal");
    const requestsAfterFence = nativeRequests.length;
    for (const listener of streamListeners) listener({ workAttemptId, providerContinuationId: continuation, observedAt: new Date().toISOString(), sequence: ++sequence, provider: "codex", kind: "turn_lifecycle", method: "turn/must-not-publish-after-fence", payload: {}, payloadTruncated: false, payloadRedacted: false, durablePayloadRef: null });
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.activity?.length === 9), "local post-fence stream evidence");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(nativeRequests.length, requestsAfterFence, "successor rejection fences later native publications");

    const generationsBeforeBindingRecovery = ((await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { execution_generations: unknown[] }).execution_generations.length;
    const recoveryInternals = second as unknown as {
      transition: (entryId: string, observed: "recovering", condition: "coordination_blocked", cause: string, actor: string) => Promise<void>;
    };
    await recoveryInternals.transition("supervised_handoff", "recovering", "coordination_blocked", "lost current worker binding during exact-generation recovery", "test-recovery");
    const latchedProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(latchedProjection.worker_binding, null);
    assert.equal(latchedProjection.last_worker_binding?.agent_session_id, "agent_session_exact");
    assert.equal(latchedProjection.condition, "coordination_blocked");
    assert.equal(latchedProjection.reconciliation?.pending_action, null);

    rejectNativeActivity = false;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_exact",
      work_attempt_id: workAttemptId, execution_generation_id: executionGenerationId,
      agent_session_token: "session-secret", api_url: apiUrl,
    })).ok, true);
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.checkpoint_worker_cursor", {
      entry_id: "supervised_handoff", work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId, agent_session_id: "agent_session_exact",
      room_cursor: "msg_2822",
    })).ok, true);
    const recoveredProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(recoveredProjection.observed_state, "working");
    assert.equal(recoveredProjection.condition, "none", "exact worker rebind clears the coordination latch");
    assert.equal(recoveredProjection.last_error, null);
    assert.equal(recoveredProjection.worker_binding?.agent_session_id, "agent_session_exact");
    assert.equal(recoveredProjection.worker_binding?.execution_generation_id, executionGenerationId);
    assert.equal(recoveredProjection.last_worker_binding?.agent_session_id, "agent_session_exact");
    const generationsAfterBindingRecovery = ((await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { execution_generations: unknown[] }).execution_generations.length;
    assert.equal(generationsAfterBindingRecovery, generationsBeforeBindingRecovery, "binding recovery cannot mint a duplicate execution generation");
    assert.equal(resumeCount, 0, "binding recovery reuses the same worker before a later intentional pause/resume");
    const checkpointsBeforeNoop = ((await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { checkpoints: unknown[] }).checkpoints.length;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.checkpoint_worker_cursor", {
      entry_id: "supervised_handoff", work_attempt_id: workAttemptId,
      execution_generation_id: executionGenerationId, agent_session_id: "agent_session_exact",
      room_cursor: "msg_2822",
    })).ok, true);
    const checkpointsAfterNoop = ((await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { checkpoints: unknown[] }).checkpoints.length;
    assert.equal(checkpointsAfterNoop, checkpointsBeforeNoop, "an unchanged poll cursor appends no durability checkpoint");
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "supervised_handoff", desired_state: "paused" });
    await eventually(async () => !child?.pid || (() => { try { process.kill(child.pid!, 0); return false; } catch { return true; } })(), "daemon stop authority");
    await eventually(async () => (await new WorkerBindingStore(paths.workerBindingsPath, undefined, paths.manifestPath).get("supervised_handoff"))?.agent_session_id === "agent_session_exact", "paused attempt retains exact private worker continuity");
    const stoppedProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(stoppedProjection.worker_binding, null, "paused terminal generation is not projected as live worker authority");
    assert.equal(stoppedProjection.last_worker_binding?.agent_session_id, "agent_session_exact", "pause preserves the non-secret exact control route");
    await eventually(async () => {
      const stopped = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return stopped.observed_state === "paused" && stopped.condition === "none";
    }, "intentional pause remains unblocked after the terminal callback");

    const stoppedPid = child?.pid;
    const stoppedGenerationId = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0])!.provider_ref!.execution_generation_id;
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "supervised_handoff", desired_state: "running" });
    await eventually(async () => {
      const resumed = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return resumed.observed_state === "recovering" && resumed.condition === "coordination_blocked" && resumed.provider_ref?.execution_generation_id !== stoppedGenerationId;
    }, "intentional stop resumes under a successor awaiting exact wait proof");
    const awaitingWait = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(awaitingWait.id, "supervised_handoff");
    assert.equal(awaitingWait.work_attempt_id, workAttemptId, "resume preserves the durable work attempt");
    assert.equal(awaitingWait.provider_ref?.provider_continuation_id, continuation, "resume preserves provider continuation identity");
    assert.notEqual(awaitingWait.provider_ref?.provider_connection?.pid, stoppedPid, "resume installs the replacement provider process");
    assert.equal(awaitingWait.worker_binding, null, "predecessor authority is not projected onto an unproven successor");
    assert.equal(resumeCount, 1);
    assert.deepEqual(resumeRequests[0]?.supervisorWorkerSession, {
      agentSessionId: "agent_session_exact",
      roomCursor: "msg_2822",
    }, "resume receives the exact prior worker identity and cursor without its secret");
    assert.doesNotMatch(JSON.stringify(resumeRequests[0]), /session-secret/, "provider request never receives worker session authority");
    const resumedGenerationId = awaitingWait.provider_ref!.execution_generation_id;
    const predecessorBeforeProof = await new WorkerBindingStore(paths.workerBindingsPath).get("supervised_handoff");
    assert.equal(predecessorBeforeProof?.execution_generation_id, stoppedGenerationId, "private credential remains on its terminal predecessor before verification");
    const stagingInternals = second as unknown as {
      stageWorkerBindingAfterResume: (
        manifestEntry: DaemonManifestEntry,
        binding: NonNullable<typeof predecessorBeforeProof>,
        successorExecutionGenerationId: string,
        providerHandle: ReturnType<typeof handle>,
      ) => Promise<void>;
    };
    await assert.rejects(stagingInternals.stageWorkerBindingAfterResume(
      {
        ...awaitingWait,
        provider_ref: { ...awaitingWait.provider_ref!, provider_continuation_id: "thread-changed" },
      },
      predecessorBeforeProof!,
      resumedGenerationId,
      { ...handle(), workAttemptId, providerContinuationId: "thread-changed" },
    ), /different provider continuation/, "restart reconstruction cannot carry a credential across a changed provider continuation");
    await second.stop();
    second = new SupervisorDaemon(paths, "darwin", port(), true);
    await second.start();
    await eventually(async () => {
      const reattached = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0]!;
      return reattached.provider_ref?.execution_generation_id === resumedGenerationId
        && ["recovering", "working"].includes(reattached.observed_state)
        && reattached.condition === "coordination_blocked"
        && reattached.worker_binding === null
        && streamListeners.size === 1
        && (second as unknown as { pendingResumeBindings: Map<string, unknown> }).pendingResumeBindings.has("supervised_handoff");
    }, "daemon restart reconstructs the staged successor before its first wait", 8_000);
    assert.equal(resumeCount, 1, "staging reconstruction attaches the single live successor without another resume");
    assert.equal((await new WorkerBindingStore(paths.workerBindingsPath).get("supervised_handoff"))?.execution_generation_id, stoppedGenerationId, "restart-window reconstruction preserves predecessor authority until proof");
    const activityBeforeInvalidWaits = awaitingWait.activity?.length ?? 0;
    emitCompatWaitCursor("msg_2823", "agent_session_peer");
    emitCompatWaitCursor("msg_2823", null);
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.activity?.length ?? 0) >= activityBeforeInvalidWaits + 2, "invalid successor wait evidence persisted without authority");
    const afterInvalidWaits = await new WorkerBindingStore(paths.workerBindingsPath).get("supervised_handoff");
    assert.equal(afterInvalidWaits?.execution_generation_id, stoppedGenerationId, "mismatched or missing wait identity cannot roll the predecessor credential");
    assert.equal(afterInvalidWaits?.room_cursor, "msg_2822", "mismatched or missing wait identity cannot advance the cursor");
    assert.equal((((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!.condition, "coordination_blocked");

    // A fresh daemon never recovers a secret from SQLite. A terminal
    // predecessor is not a valid credential route, even while the resumed
    // provider is waiting for room delivery to be re-established.
    const daemonGeneration = Number(((await daemonRequest(paths.socketPath, "daemon.negotiate")).result as { generation: number }).generation);
    const installed = await daemonRequest(paths.socketPath, "supervisor.install_worker_credential", {
      entry_id: "supervised_handoff", room_id: "focus_37", work_attempt_id: workAttemptId,
      execution_generation_id: stoppedGenerationId, agent_session_id: "agent_session_exact",
      agent_session_token: "session-secret", daemon_generation: daemonGeneration,
    });
    assert.equal((installed.result as { status: string }).status, "stale");
    const oldBorrow = await daemonRequest(paths.socketPath, "supervisor.borrow_worker_credential", {
      entry_id: "supervised_handoff", room_id: "focus_37", work_attempt_id: workAttemptId,
      execution_generation_id: stoppedGenerationId, agent_session_id: "agent_session_exact", daemon_generation: daemonGeneration, api_url: apiUrl,
    });
    assert.equal((oldBorrow.result as { status: string }).status, "stale", "terminal predecessor cannot borrow while the successor is recovering");

    // The replacement must establish the active successor route first. Only
    // then can Electron's exact-generation delivery be installed/borrowed.
    const successorBind = await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_exact",
      work_attempt_id: workAttemptId, execution_generation_id: resumedGenerationId,
      agent_session_token: "session-secret", api_url: apiUrl,
    });
    assert.equal(successorBind.ok, true, successorBind.error);
    const successorInstall = await daemonRequest(paths.socketPath, "supervisor.install_worker_credential", {
      entry_id: "supervised_handoff", room_id: "focus_37", work_attempt_id: workAttemptId,
      execution_generation_id: resumedGenerationId, agent_session_id: "agent_session_exact",
      agent_session_token: "desktop-delivered-successor-secret", daemon_generation: daemonGeneration,
    });
    assert.equal((successorInstall.result as { status: string }).status, "installed");
    const successorBorrow = await daemonRequest(paths.socketPath, "supervisor.borrow_worker_credential", {
      entry_id: "supervised_handoff", room_id: "focus_37", work_attempt_id: workAttemptId,
      execution_generation_id: resumedGenerationId, agent_session_id: "agent_session_exact", daemon_generation: daemonGeneration, api_url: apiUrl,
    });
    assert.deepEqual(successorBorrow.result, { status: "available", credential: "desktop-delivered-successor-secret" });
    const crossOriginBorrow = await daemonRequest(paths.socketPath, "supervisor.borrow_worker_credential", {
      entry_id: "supervised_handoff", room_id: "focus_37", work_attempt_id: workAttemptId,
      execution_generation_id: resumedGenerationId, agent_session_id: "agent_session_exact", daemon_generation: daemonGeneration,
      api_url: "https://attacker.invalid",
    });
    assert.deepEqual(crossOriginBorrow.result, { status: "stale" }, "credential borrowing is bound to the registered API origin");
    const rebound = await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_exact",
      work_attempt_id: workAttemptId, execution_generation_id: resumedGenerationId,
      agent_session_token: "session-secret", api_url: apiUrl,
    });
    assert.equal(rebound.ok, true, rebound.error);
    const reboundProjection = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!;
    assert.equal(reboundProjection.worker_binding?.agent_session_id, "agent_session_exact", "the successor execution restores the same worker binding");
    assert.equal(reboundProjection.last_worker_binding?.agent_session_id, "agent_session_exact", "the durable exact control route remains unchanged");
    assert.equal(reboundProjection.worker_binding?.execution_generation_id, resumedGenerationId);
    assert.doesNotMatch(JSON.stringify(reboundProjection), /session-secret/);
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.checkpoint_worker_cursor", {
      entry_id: "supervised_handoff", work_attempt_id: workAttemptId,
      execution_generation_id: resumedGenerationId, agent_session_id: "agent_session_exact",
      room_cursor: "msg_2824",
    })).ok, true);
    for (const listener of streamListeners) listener({
      workAttemptId,
      providerContinuationId: continuation,
      observedAt: new Date().toISOString(),
      sequence: ++sequence,
      provider: "claude-code",
      kind: "error",
      method: "result/error_during_execution",
      payload: { type: "result", subtype: "error_during_execution", is_error: true },
      payloadTruncated: false,
      payloadRedacted: false,
      durablePayloadRef: null,
    });
    await eventually(async () => {
      const recovered = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return recovered.observed_state === "recovering"
        && recovered.condition === "coordination_blocked"
        && recovered.provider_ref?.execution_generation_id !== resumedGenerationId;
    }, "terminal provider turn enters a bounded resume generation awaiting wait proof");
    const recoveredAwaitingWait = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0])!;
    const recoveredGenerationId = recoveredAwaitingWait.provider_ref!.execution_generation_id;
    assert.equal(resumeCount, 2);
    assert.deepEqual(resumeRequests[1]?.supervisorWorkerSession, {
      agentSessionId: "agent_session_exact",
      roomCursor: "msg_2824",
    });
    assert.equal((await new WorkerBindingStore(paths.workerBindingsPath).get("supervised_handoff"))?.execution_generation_id, resumedGenerationId);
    emitCompatWaitCursor("msg_2825");
    await eventually(async () => {
      const recovered = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0]!;
      return recovered.observed_state === "working"
        && recovered.condition === "none"
        && recovered.worker_binding?.execution_generation_id === recoveredGenerationId;
    }, "terminal-turn successor exact wait restores coordination");
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_exact",
      work_attempt_id: workAttemptId, execution_generation_id: recoveredGenerationId,
      agent_session_token: "session-secret", api_url: apiUrl,
    })).ok, true, "the recovered generation rebinds the same exact worker session");
    const staleBind = await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_stale",
      work_attempt_id: workAttemptId, execution_generation_id: stoppedGenerationId,
      agent_session_token: "stale-secret", api_url: apiUrl,
    });
    assert.equal(staleBind.ok, false, "a terminal predecessor generation cannot bind a worker session");
    assert.match(staleBind.error ?? "", /terminal|active supervised manifest entry/);
    const wrongAttemptBind = await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", agent_session_id: "agent_session_unrelated",
      work_attempt_id: randomUUID(), execution_generation_id: recoveredGenerationId,
      agent_session_token: "unrelated-secret", api_url: apiUrl,
    });
    assert.equal(wrongAttemptBind.ok, false, "another work attempt cannot bind through a copied stable context");
    assert.match(wrongAttemptBind.error ?? "", /work attempt/);
    const resumedAttempt = (await daemonRequest(paths.socketPath, "attempt.read", { id: "supervised_handoff" })).result as { restart_count: number; execution_generations: Array<{ terminal: unknown }> };
    assert.equal(resumedAttempt.restart_count, 2);
    assert.ok(resumedAttempt.execution_generations[0]?.terminal, "the predecessor terminal remains immutable after resume");
    assert.ok(resumedAttempt.execution_generations[1]?.terminal, "the native terminal-turn generation is durably terminal");
    assert.equal(resumedAttempt.execution_generations[2]?.terminal, null, "the recovered successor is the only live generation");

    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "supervised_handoff", desired_state: "stopped" });
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "stopped"), "second intentional stop");
    await second.stop();
    second = null;
    third = new SupervisorDaemon(paths, "darwin", port(), true);
    await third.start();
    await eventually(async () => {
      const stopped = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return stopped.observed_state === "stopped" && stopped.condition === "none";
    }, "replacement daemon keeps a terminal generation stopped without stale attachment");
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "supervised_handoff", desired_state: "running" });
    await eventually(async () => {
      const resumedAfterHandoff = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return resumedAfterHandoff.observed_state === "recovering" && resumedAfterHandoff.condition === "coordination_blocked";
    }, "replacement daemon resumes the stopped work attempt awaiting wait proof");
    const retainedAfterHandoff = await new WorkerBindingStore(paths.workerBindingsPath).get("supervised_handoff");
    assert.ok(retainedAfterHandoff);
    const thirdGeneration = Number(((await daemonRequest(paths.socketPath, "daemon.negotiate")).result as { generation: number }).generation);
    const retiredInstall = await daemonRequest(paths.socketPath, "supervisor.install_worker_credential", {
      entry_id: "supervised_handoff", room_id: "focus_37", work_attempt_id: workAttemptId,
      execution_generation_id: retainedAfterHandoff.execution_generation_id, agent_session_id: "agent_session_exact",
      agent_session_token: "session-secret", daemon_generation: thirdGeneration,
    });
    assert.equal((retiredInstall.result as { status: string }).status, "stale");
    const activeAfterHandoff = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!.provider_ref!.execution_generation_id;
    assert.equal((await daemonRequest(paths.socketPath, "supervisor.bind_worker_session", {
      entry_id: "supervised_handoff", room_id: "focus_37", work_attempt_id: workAttemptId,
      execution_generation_id: activeAfterHandoff, agent_session_id: "agent_session_exact",
      agent_session_token: "session-secret", api_url: apiUrl,
    })).ok, true);
    const thirdInstall = await daemonRequest(paths.socketPath, "supervisor.install_worker_credential", {
      entry_id: "supervised_handoff", room_id: "focus_37", work_attempt_id: workAttemptId,
      execution_generation_id: activeAfterHandoff, agent_session_id: "agent_session_exact",
      agent_session_token: "desktop-delivered-after-handoff", daemon_generation: thirdGeneration,
    });
    assert.equal((thirdInstall.result as { status: string }).status, "installed");
    emitCompatWaitCursor("msg_2826");
    await eventually(async () => {
      const resumedAfterHandoff = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]!;
      return resumedAfterHandoff.observed_state === "working" && resumedAfterHandoff.condition === "none";
    }, "replacement daemon exact wait restores the stopped work attempt");
    assert.equal(resumeCount, 3);

    const exactGenerationBeforeFreshStart = (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0])!.provider_ref!.execution_generation_id;
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "supervised_handoff", desired_state: "stopped" });
    await eventually(async () => (((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntry[])[0]?.observed_state === "stopped"), "fresh-start negative terminal predecessor");
    resumeSupported = false;
    await daemonRequest(paths.socketPath, "manifest.set_desired_state", { id: "supervised_handoff", desired_state: "running" });
    await eventually(async () => {
      const fresh = ((await daemonRequest(paths.socketPath, "manifest.list")).result as DaemonManifestEntryView[])[0]!;
      return fresh.provider_ref?.execution_generation_id !== exactGenerationBeforeFreshStart
        && fresh.observed_state === "recovering"
        && fresh.condition === "coordination_blocked"
        && fresh.worker_binding === null;
    }, "fresh spawn with a terminal predecessor credential fails closed awaiting formal bind");
    assert.equal(resumeCount, 3, "fresh-spawn negative does not masquerade as native resume");
    assert.equal((third as unknown as { pendingResumeBindings: Map<string, unknown> }).pendingResumeBindings.has("supervised_handoff"), false, "fresh spawn cannot enter compatibility rollover");
    assert.equal((await new WorkerBindingStore(paths.workerBindingsPath).get("supervised_handoff"))?.execution_generation_id, exactGenerationBeforeFreshStart, "fresh spawn preserves terminal predecessor authority without rolling it");
  } finally {
    await third?.stop().catch(() => undefined);
    await second?.stop().catch(() => undefined);
    await first.stop().catch(() => undefined);
    if (child?.pid) { try { process.kill(child.pid, "SIGKILL"); } catch { /* already stopped */ } }
    await new Promise<void>((resolve) => nativeServer.close(() => resolve()));
    await env.cleanup();
  }
});

test("fence loss fatally stops the control endpoint", async () => {
  const env = await fixture();
  try {
    const lockPath = join(env.root, "fatal.lock");
    const socketPath = join(env.root, "fatal.sock");
    const daemon = new SupervisorDaemon({ lockPath, socketPath, manifestPath: join(env.root, "manifest.json"), auditPath: join(env.root, "audit.jsonl") }, "darwin");
    await daemon.start();
    await writeFile(`${lockPath}.generation`, "2\n");
    await new Promise<void>((resolve, reject) => {
      const client = createConnection(socketPath); client.once("error", reject);
      client.on("connect", () => client.write(JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, method: "manifest.list" }) + "\n"));
      client.on("close", () => resolve());
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(() => new Promise<void>((resolve, reject) => {
      const client = createConnection(socketPath); client.once("connect", () => resolve()); client.once("error", reject);
    }));
    await daemon.stop();
  } finally { await env.cleanup(); }
});

test("control socket bounds an oversized JSON-lines frame", async () => {
  const env = await fixture();
  try {
    const socketPath = join(env.root, "bounded.sock");
    const socket = new DaemonControlSocket(socketPath, () => ({ ok: true }), undefined, 16);
    await socket.start();
    await new Promise<void>((resolve, reject) => {
      const client = createConnection(socketPath); client.once("error", reject);
      client.on("connect", () => client.write("x".repeat(17)));
      client.on("close", () => resolve());
    });
    await socket.stop();
  } finally { await env.cleanup(); }
});

test("work attempts survive generations and lease rebinds while terminal payloads stay immutable", async () => {
  const env = await fixture();
  let tick = 0;
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), () => `2026-01-01T00:00:0${tick++}.000Z`, join(env.root, "worktrees"), undefined, undefined, undefined, TEST_SUPERVISOR);
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease-1", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    await store.checkpoint(attempt.work_attempt_id, { room_cursor: "msg_12", provider_continuation_id: "provider-1" });
    const historyGuard = new DatabaseSync(join(env.root, "daemon-state.sqlite"));
    historyGuard.exec(`
      CREATE TRIGGER forbid_checkpoint_rewrite BEFORE DELETE ON work_attempt_checkpoints BEGIN SELECT RAISE(ABORT, 'checkpoint history rewritten'); END;
      CREATE TRIGGER forbid_epoch_rewrite BEFORE DELETE ON work_attempt_lease_epochs BEGIN SELECT RAISE(ABORT, 'epoch history rewritten'); END;
      CREATE TRIGGER forbid_execution_rewrite BEFORE DELETE ON work_attempt_executions BEGIN SELECT RAISE(ABORT, 'execution history rewritten'); END;
    `);
    historyGuard.close();
    const execution = await store.startGeneration(attempt.work_attempt_id, "daemon", 1);
    const terminal = { ended_at: "2026-01-01T00:00:09.000Z", exit_code: 137, signal: "SIGKILL", stdio_archive_ref: "stdio.log.1.archive", stdio_tail: "last line", terminal_cause: "crash", actor: "daemon", generation: 1, provider_continuation_id: "provider-1" };
    const storedTerminal = await store.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, { ...terminal, stdio_tail: "x".repeat(20) }, 8);
    assert.equal(storedTerminal.terminal?.stdio_tail, "x".repeat(8));
    await assert.rejects(() => store.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, terminal), ImmutableExecutionError);
    await store.rebindAttempt(attempt.work_attempt_id, "lease-2", 2);
    await store.checkpoint(attempt.work_attempt_id, { room_cursor: "msg_13", provider_continuation_id: "provider-2" });
    const resumed = await store.startGeneration(attempt.work_attempt_id, "daemon", 2);
    assert.equal((await store.getAttempt(attempt.work_attempt_id)).workspace_path, workspace.path);
    assert.equal((await store.getAttempt(attempt.work_attempt_id)).epoch_history.length, 2);
    assert.equal(resumed.generation, 2);
    const terminalCanary = "canary-not-a-real-terminal-secret-123456789";
    const resumedTerminal = await store.recordTerminal(attempt.work_attempt_id, resumed.execution_generation_id, { ended_at: "2026-01-01T00:00:10.000Z", exit_code: 0, signal: null, stdio_archive_ref: `LETAGENTS_TOKEN=${terminalCanary}`, stdio_tail: `Authorization: Bearer ${terminalCanary}`, terminal_cause: `OPENAI_API_KEY=${terminalCanary}`, actor: "daemon", generation: 2, provider_continuation_id: null });
    assert.doesNotMatch(JSON.stringify(resumedTerminal.terminal), new RegExp(terminalCanary));
    assert.doesNotMatch(JSON.stringify(await store.getAttempt(attempt.work_attempt_id)), new RegExp(terminalCanary));
    assert.match(JSON.stringify(resumedTerminal.terminal), /REDACTED/);
    const releaseHistoryGuard = new DatabaseSync(join(env.root, "daemon-state.sqlite"));
    releaseHistoryGuard.exec("DROP TRIGGER forbid_checkpoint_rewrite; DROP TRIGGER forbid_epoch_rewrite; DROP TRIGGER forbid_execution_rewrite");
    releaseHistoryGuard.close();
    await store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "reviewed", postmortemDiff: "diff --git a/a b/a" });
    await assert.rejects(() => store.rebindAttempt(attempt.work_attempt_id, "lease-3", 3), ImmutableExecutionError);
  } finally { await env.cleanup(); }
});

test("independent SQLite connections cannot start two live generations for one attempt", async () => {
  const env = await fixture();
  try {
    const path = join(env.root, "attempts.json");
    const root = join(env.root, "attempt-data");
    const workspace = await provisionedWorkspace(env.root);
    const first = new WorkDurabilityStore(path, root, undefined, join(env.root, "worktrees"), undefined, undefined, undefined, { supervisor_id: "race-a", supervisor_generation: 1 });
    const second = new WorkDurabilityStore(path, root, undefined, join(env.root, "worktrees"), undefined, undefined, undefined, { supervisor_id: "race-b", supervisor_generation: 1 });
    const attempt = await first.createAttempt({ taskId: "task", leaseId: "race", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    const results = await Promise.allSettled([
      first.startGeneration(attempt.work_attempt_id, "daemon", 1),
      second.startGeneration(attempt.work_attempt_id, "daemon", 1),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await first.getAttempt(attempt.work_attempt_id)).execution_generations.filter((item) => item.terminal === null).length, 1);
    await first.close();
    await second.close();
  } finally { await env.cleanup(); }
});

test("stdio rotates append-only and GC protects active, ambiguous, quarantined, and unreviewed attempts", async () => {
  const env = await fixture();
  let tick = 0;
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), () => `2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`, join(env.root, "worktrees"), undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const create = async () => {
      const workspace = await provisionedWorkspace(env.root);
      const attempt = await store.createAttempt({ taskId: "task", leaseId: `lease-${tick}`, leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
      return attempt;
    };
    const first = await create(); const second = await create(); const latest = await create(); const protectedAttempt = await create();
    await store.concludeAttempt(first.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "first" });
    await store.concludeAttempt(second.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "second" });
    await store.concludeAttempt(latest.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "latest" });
    await store.markState(protectedAttempt.work_attempt_id, "quarantined");
    const log = await store.appendStdio(first.work_attempt_id, "x".repeat(8), 8);
    await store.appendStdio(first.work_attempt_id, "next", 8);
    const stdioCanary = "canary-not-a-real-stdio-secret-123456789";
    const credentialLog = await store.appendStdio(protectedAttempt.work_attempt_id, "Authorization: Bearer ", 1_024);
    await store.appendStdio(protectedAttempt.work_attempt_id, stdioCanary, 1_024);
    assert.doesNotMatch(await readFile(credentialLog, "utf8"), new RegExp(stdioCanary));
    assert.match(await readFile(credentialLog, "utf8"), /REDACTED/);
    assert.ok((await readdir(dirname(log))).some((name) => name.includes("stdio.log.") && name.endsWith(".archive")));
    const removed = await store.garbageCollect(1);
    assert.deepEqual(new Set(removed), new Set([first.work_attempt_id, second.work_attempt_id]));
    await assert.rejects(() => stat(first.workspace_path));
    assert.equal((await stat(latest.workspace_path)).isDirectory(), true);
    assert.equal((await stat(protectedAttempt.workspace_path)).isDirectory(), true);
  } finally { await env.cleanup(); }
});

test("workspace provisioner uses daemon-owned clones, reuses attempts, and rejects dev-checkout escapes", async () => {
  const env = await fixture();
  try {
    const commands: string[][] = [];
    let rejectMarkerlessRecovery = false;
    const provisioner = new WorkspaceProvisioner(env.root, async (args) => {
      commands.push(args);
      if (args.includes("worktree") && args.includes("add")) { rejectMarkerlessRecovery = false; await mkdir(args.at(-2)!, { recursive: true }); }
      else if (args[0] === "clone") await mkdir(args.at(-1)!, { recursive: true });
      if (args.includes("--is-bare-repository")) return "true";
      if (args.includes("remote") && args.includes("get-url")) return "https://example.invalid/repo.git";
      if (args.includes("cat-file")) return "ok";
      if (args.includes("rev-parse")) {
        if (args.includes("--git-common-dir")) return rejectMarkerlessRecovery ? join(env.root, "repos", "wrong.git") : join(env.root, "repos", "repo.git");
        return TEST_OID;
      }
      return "";
    });
    assert.throws(() => provisioner.workspacePath("../dev", "attempt"), /Unsafe repository/);
    assert.throws(() => provisioner.workspacePath(".", "attempt"), /Unsafe repository/);
    const workAttemptId = randomUUID();
    const first = await provisioner.provision({ repo: "repo", workAttemptId, taskId: "task", remoteUrl: "https://example.invalid/repo.git", revision: "abc" });
    const second = await provisioner.provision({ repo: "repo", workAttemptId, taskId: "task", remoteUrl: "https://example.invalid/repo.git", revision: "moved-branch" });
    assert.equal(first.reused, false); assert.equal(second.reused, true); assert.ok(commands.length > 2);
    const refresh = commands.findIndex((args) => args.includes("fetch"));
    const resolution = commands.findIndex((args) => args.includes("abc^{commit}"));
    assert.ok(refresh >= 0 && refresh < resolution, "the verified origin is refreshed before revision resolution");
    assert.equal(commands[refresh]![1], await realpath(join(env.root, "repos", "repo.git")));
    assert.deepEqual(commands[refresh], [
      "--git-dir", await realpath(join(env.root, "repos", "repo.git")),
      "fetch", "--prune", "--no-tags", "origin",
      "+refs/heads/*:refs/letagents/remotes/origin/*",
      "+refs/tags/*:refs/letagents/tags/*",
    ]);
    assert.match(first.path, new RegExp(`worktrees/repo/${workAttemptId}$`));
    assert.ok(commands[0]!.includes("--bare"));
    await rm(join(first.path, ".letagents-work-attempt.json"));
    const recovered = await provisioner.provision({ repo: "repo", workAttemptId, taskId: "task", remoteUrl: "https://example.invalid/repo.git", revision: "abc" });
    assert.equal(recovered.reused, true, "an add-before-marker crash is recoverable");
    await rm(join(first.path, ".letagents-work-attempt.json"));
    rejectMarkerlessRecovery = true;
    const reprovisioned = await provisioner.provision({ repo: "repo", workAttemptId, taskId: "task", remoteUrl: "https://example.invalid/repo.git", revision: "abc" });
    assert.equal(reprovisioned.reused, false, "an unprovable markerless partial is quarantined and reprovisioned");
    const remove = commands.findIndex((args) => args.includes("worktree") && args.includes("remove") && args.includes(first.path));
    const replacementAdd = commands.findIndex((args, index) => index > remove && args.includes("worktree") && args.includes("add") && args.includes(first.path));
    assert.ok(remove >= 0 && replacementAdd > remove, "the exact stale worktree registration is removed before re-adding");
    await assert.rejects(() => provisioner.provision({ repo: "repo", workAttemptId: randomUUID(), taskId: "task", remoteUrl: "https://token@example.invalid/repo.git", revision: "abc" }), /userinfo/);
    await assert.rejects(() => provisioner.provision({ repo: "repo", workAttemptId: randomUUID(), taskId: "task", remoteUrl: "https://evil.invalid/repo.git", revision: "abc" }), /identity/);
    await rm(first.path, { recursive: true });
    const outside = join(env.root, "outside"); await mkdir(outside);
    await symlink(outside, first.path);
    await assert.rejects(() => provisioner.provision({ repo: "repo", workAttemptId, taskId: "task", remoteUrl: "https://example.invalid/repo.git", revision: "abc" }), /symlink/);
  } finally { await env.cleanup(); }
});

test("repository storage keys preserve full project identity across same-basename remotes", () => {
  const first = repositoryStorageKey("https://git.example.invalid/owner-a/shared-project.git");
  const equivalent = repositoryStorageKey("https://git.example.invalid/owner-a/shared-project.git/");
  const second = repositoryStorageKey("https://git.example.invalid/owner-b/shared-project.git");
  assert.equal(first, equivalent);
  assert.notEqual(first, second);
  assert.notEqual(repositoryStorageKey("file:///tmp/shared-project.git"), repositoryStorageKey("file:///tmp/shared-project"));
  assert.notEqual(repositoryStorageKey("./shared-project.git"), repositoryStorageKey("./shared-project"));
  assert.equal(repositoryStorageKey("git@github.com:owner-a/shared-project.git"), repositoryStorageKey("git@github.com:owner-a/shared-project"));
  assert.match(first, /^shared-project-[0-9a-f]{16}$/);
  assert.match(second, /^shared-project-[0-9a-f]{16}$/);
});

test("filesystem remotes that differ by a literal .git suffix remain isolated during local revision import", async () => {
  const env = await fixture();
  try {
    const remoteWithSuffix = join(env.root, "same.git");
    const remoteWithoutSuffix = join(env.root, "same");
    const sourceWithSuffix = join(env.root, "source-with-suffix");
    const sourceWithoutSuffix = join(env.root, "source-without-suffix");
    const daemonRoot = join(env.root, "daemon");
    await execFileAsync("git", ["init", "--bare", remoteWithSuffix]);
    await execFileAsync("git", ["init", "--bare", remoteWithoutSuffix]);

    const initializeSource = async (source: string, remote: string, content: string) => {
      await execFileAsync("git", ["init", source]);
      await execFileAsync("git", ["-C", source, "config", "user.email", "daemon@example.invalid"]);
      await execFileAsync("git", ["-C", source, "config", "user.name", "Daemon Test"]);
      await writeFile(join(source, "README.md"), content);
      await execFileAsync("git", ["-C", source, "add", "README.md"]);
      await execFileAsync("git", ["-C", source, "commit", "-m", "initial"]);
      await execFileAsync("git", ["-C", source, "remote", "add", "origin", remote]);
      await execFileAsync("git", ["-C", source, "push", "origin", "HEAD:refs/heads/main"]);
    };
    await initializeSource(sourceWithSuffix, remoteWithSuffix, "suffix remote\n");
    await initializeSource(sourceWithoutSuffix, remoteWithoutSuffix, "plain remote\n");
    await writeFile(join(sourceWithoutSuffix, "README.md"), "plain remote local only\n");
    await execFileAsync("git", ["-C", sourceWithoutSuffix, "add", "README.md"]);
    await execFileAsync("git", ["-C", sourceWithoutSuffix, "commit", "-m", "local only"]);

    const firstKey = repositoryStorageKey(remoteWithSuffix);
    const secondKey = repositoryStorageKey(remoteWithoutSuffix);
    assert.notEqual(firstKey, secondKey, "literal filesystem paths must not inherit hosted-remote .git equivalence");
    const firstRevision = (await execFileAsync("git", ["-C", sourceWithSuffix, "rev-parse", "HEAD"])).stdout.trim();
    const secondRevision = (await execFileAsync("git", ["-C", sourceWithoutSuffix, "rev-parse", "HEAD"])).stdout.trim();
    const provisioner = new WorkspaceProvisioner(daemonRoot, createGitCommand(daemonRoot));
    await provisioner.provision({
      repo: firstKey,
      workAttemptId: randomUUID(),
      taskId: "suffix_remote",
      remoteUrl: remoteWithSuffix,
      revision: firstRevision,
      sourceRepoPath: sourceWithSuffix,
    });
    await assert.rejects(
      () => provisioner.provision({
        repo: firstKey,
        workAttemptId: randomUUID(),
        taskId: "cross_wired_source",
        remoteUrl: remoteWithSuffix,
        revision: secondRevision,
        sourceRepoPath: sourceWithoutSuffix,
      }),
      /Local source repository remote identity does not match/,
    );
    const second = await provisioner.provision({
      repo: secondKey,
      workAttemptId: randomUUID(),
      taskId: "plain_remote",
      remoteUrl: remoteWithoutSuffix,
      revision: secondRevision,
      sourceRepoPath: sourceWithoutSuffix,
    });
    assert.equal((await execFileAsync("git", ["-C", second.path, "rev-parse", "HEAD"])).stdout.trim(), secondRevision);
    assert.notEqual(
      join(daemonRoot, "repos", `${firstKey}.git`),
      join(daemonRoot, "repos", `${secondKey}.git`),
    );
  } finally { await env.cleanup(); }
});

test("workspace provisioner refreshes an existing bare clone before resolving a new source revision", async () => {
  const env = await fixture();
  try {
    const remote = join(env.root, "origin.git");
    const source = join(env.root, "source");
    const daemonRoot = join(env.root, "daemon");
    await execFileAsync("git", ["init", "--bare", remote]);
    await execFileAsync("git", ["init", source]);
    await execFileAsync("git", ["-C", source, "config", "user.email", "daemon@example.invalid"]);
    await execFileAsync("git", ["-C", source, "config", "user.name", "Daemon Test"]);
    await writeFile(join(source, "README.md"), "first\n");
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "first"]);
    await execFileAsync("git", ["-C", source, "branch", "-M", "main"]);
    await execFileAsync("git", ["-C", source, "remote", "add", "origin", remote]);
    await execFileAsync("git", ["-C", source, "push", "-u", "origin", "main"]);
    await execFileAsync("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
    const firstRevision = (await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();

    const provisioner = new WorkspaceProvisioner(daemonRoot, createGitCommand(daemonRoot));
    const first = await provisioner.provision({
      repo: "repo",
      workAttemptId: randomUUID(),
      taskId: "task_first",
      remoteUrl: remote,
      revision: firstRevision,
    });
    assert.equal((await execFileAsync("git", ["-C", first.path, "rev-parse", "HEAD"])).stdout.trim(), firstRevision);

    await writeFile(join(source, "README.md"), "second\n");
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "second"]);
    const secondRevision = (await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
    await execFileAsync("git", ["-C", source, "push", "origin", "HEAD:refs/heads/fresh-after-clone"]);

    const second = await provisioner.provision({
      repo: "repo",
      workAttemptId: randomUUID(),
      taskId: "task_second",
      remoteUrl: remote,
      revision: secondRevision,
    });
    assert.equal((await execFileAsync("git", ["-C", second.path, "rev-parse", "HEAD"])).stdout.trim(), secondRevision);
    assert.equal(
      (await execFileAsync("git", ["--git-dir", join(daemonRoot, "repos", "repo.git"), "rev-parse", "refs/letagents/remotes/origin/fresh-after-clone"])).stdout.trim(),
      secondRevision,
    );

    await writeFile(join(source, "README.md"), "local only\n");
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "local only"]);
    const localOnlyRevision = (await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
    await assert.rejects(
      () => execFileAsync("git", ["--git-dir", remote, "cat-file", "-e", `${localOnlyRevision}^{commit}`]),
      "the remote must not contain the unpushed source commit",
    );
    const localAttemptId = randomUUID();
    const localOnly = await provisioner.provision({
      repo: "repo",
      workAttemptId: localAttemptId,
      taskId: "task_local_only",
      remoteUrl: remote,
      revision: localOnlyRevision,
      sourceRepoPath: source,
    });
    assert.equal((await execFileAsync("git", ["-C", localOnly.path, "rev-parse", "HEAD"])).stdout.trim(), localOnlyRevision);
    assert.equal(
      (await execFileAsync("git", ["--git-dir", join(daemonRoot, "repos", "repo.git"), "rev-parse", `refs/letagents/sources/${localAttemptId}^{commit}`])).stdout.trim(),
      localOnlyRevision,
      "the daemon retains the exact local commit under an attempt-scoped private ref",
    );

    await execFileAsync("git", ["-C", source, "checkout", "--detach", secondRevision]);
    await writeFile(join(source, "README.md"), "tag only\n");
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "tag only"]);
    await execFileAsync("git", ["-C", source, "tag", "release-only"]);
    const tagOnlyRevision = (await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
    await execFileAsync("git", ["-C", source, "push", "origin", "refs/tags/release-only"]);

    const tagged = await provisioner.provision({
      repo: "repo",
      workAttemptId: randomUUID(),
      taskId: "task_tag_only",
      remoteUrl: remote,
      revision: tagOnlyRevision,
    });
    assert.equal((await execFileAsync("git", ["-C", tagged.path, "rev-parse", "HEAD"])).stdout.trim(), tagOnlyRevision);
    assert.equal(
      (await execFileAsync("git", ["--git-dir", join(daemonRoot, "repos", "repo.git"), "rev-parse", "refs/letagents/tags/release-only^{commit}"])).stdout.trim(),
      tagOnlyRevision,
    );
  } finally { await env.cleanup(); }
});

test("workspace provisioning survives deletion of the daemon's inherited launch cwd", async () => {
  const env = await fixture();
  try {
    const source = join(env.root, "source");
    const launchCwd = join(env.root, "ephemeral-launch-cwd");
    const daemonRoot = join(env.root, "stable-daemon-root");
    await mkdir(source);
    await mkdir(launchCwd);
    await mkdir(daemonRoot);
    await execFileAsync("git", ["init", source]);
    await execFileAsync("git", ["-C", source, "config", "user.email", "daemon@example.invalid"]);
    await execFileAsync("git", ["-C", source, "config", "user.name", "Daemon Test"]);
    await writeFile(join(source, "README.md"), "stable cwd\n");
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "fixture"]);

    const moduleUrl = new URL("../workspace-provisioner.ts", import.meta.url).href;
    const tsxImport = import.meta.resolve("tsx");
    const workAttemptId = randomUUID();
    const script = [
      `import { rm } from "node:fs/promises";`,
      `import { createGitCommand, WorkspaceProvisioner } from ${JSON.stringify(moduleUrl)};`,
      `const git = createGitCommand(${JSON.stringify(daemonRoot)});`,
      `process.chdir(${JSON.stringify(launchCwd)});`,
      `await rm(${JSON.stringify(launchCwd)}, { recursive: true });`,
      `const provisioner = new WorkspaceProvisioner(${JSON.stringify(daemonRoot)}, git);`,
      `const result = await provisioner.provision(${JSON.stringify({
        repo: "repo",
        workAttemptId,
        taskId: "task_deleted_cwd",
        remoteUrl: source,
        revision: "HEAD",
      })});`,
      `process.stdout.write(JSON.stringify({ path: result.path, reused: result.reused }));`,
    ].join("\n");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", tsxImport, "--input-type=module", "-e", script],
      { cwd: launchCwd, maxBuffer: 8 * 1024 * 1024 },
    );
    const result = JSON.parse(stdout) as { path: string; reused: boolean };
    assert.equal(result.reused, false);
    assert.equal(result.path, join(daemonRoot, "worktrees", "repo", workAttemptId));
    assert.equal((await stat(result.path)).isDirectory(), true);
  } finally {
    await env.cleanup();
  }
});

test("durability store validates destructive identities, serializes GC, and quarantines tampering", async () => {
  const env = await fixture();
  let releaseGc!: () => void;
  let reserved!: () => void;
  const gcReserved = new Promise<void>((resolve) => { reserved = resolve; });
  const gcRelease = new Promise<void>((resolve) => { releaseGc = resolve; });
  try {
    const path = join(env.root, "attempts.json");
    const store = new WorkDurabilityStore(path, join(env.root, "attempt-data"), () => "2026-01-01T00:00:00.000Z", join(env.root, "worktrees"), async () => { reserved(); await gcRelease; }, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    await store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "diff" });
    await assert.rejects(() => store.appendStdio("../../outside", "nope"), /UUID/);
    const collecting = store.garbageCollect(0);
    await gcReserved;
    await assert.rejects(() => store.markState(attempt.work_attempt_id, "quarantined"), /GC reservation/);
    releaseGc();
    assert.deepEqual(await collecting, [attempt.work_attempt_id]);

    const protectedWorkspace = await provisionedWorkspace(env.root);
    const protectedAttempt = await store.createAttempt({ taskId: "task", leaseId: "lease-2", leaseEpoch: 2, workspacePath: protectedWorkspace.path, workAttemptId: protectedWorkspace.id });
    await store.concludeAttempt(protectedAttempt.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "diff" });
    await writeFile(path, "{\"version\":2,\"attempts\":[],\"checksum\":\"tampered\"}");
    const recovered = new WorkDurabilityStore(path, join(env.root, "attempt-data"), () => "2026-01-01T00:00:01.000Z", join(env.root, "worktrees"));
    await assert.rejects(() => recovered.garbageCollect(0), CorruptAttemptStoreError);
    assert.equal((await stat(protectedWorkspace.path)).isDirectory(), true);
    assert.ok((await readdir(env.root)).some((name) => name.startsWith("attempts.json.corrupt.")));

    const legacyWorkspace = await provisionedWorkspace(env.root);
    const legacyDatabase = join(env.root, "legacy-state.sqlite");
    const legacyStore = new WorkDurabilityStore(join(env.root, "legacy-attempts.json"), join(env.root, "attempt-data"), () => "2026-01-01T00:00:02.000Z", join(env.root, "worktrees"), undefined, undefined, undefined, TEST_SUPERVISOR, undefined, legacyDatabase);
    const legacyAttempt = await legacyStore.createAttempt({ taskId: "task", leaseId: "lease-3", leaseEpoch: 3, workspacePath: legacyWorkspace.path, workAttemptId: legacyWorkspace.id });
    await legacyStore.concludeAttempt(legacyAttempt.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "diff" });
    const legacySnapshot = await legacyStore.getAttempt(legacyAttempt.work_attempt_id);
    await legacyStore.close();
    await rm(legacyDatabase, { force: true });
    await rm(`${legacyDatabase}-wal`, { force: true });
    await rm(`${legacyDatabase}-shm`, { force: true });
    await writeFile(join(env.root, "legacy-attempts.json"), JSON.stringify({ version: 1, attempts: [legacySnapshot] }));
    assert.equal((await (new WorkDurabilityStore(join(env.root, "legacy-attempts.json"), join(env.root, "attempt-data"), () => "2026-01-01T00:00:03.000Z", join(env.root, "worktrees"), undefined, undefined, undefined, undefined, undefined, legacyDatabase)).getAttempt(legacyAttempt.work_attempt_id)).state, "unreviewed");
  } finally { await env.cleanup(); }
});

test("execution identities prohibit parallel, duplicate, and laundered terminal generations", async () => {
  const env = await fixture();
  try {
    const workspace = await provisionedWorkspace(env.root);
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), () => "2026-01-01T00:00:00.000Z", join(env.root, "worktrees"), undefined, undefined, undefined, TEST_SUPERVISOR);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    const first = await store.startGeneration(attempt.work_attempt_id, "starter", 1);
    await assert.rejects(() => store.startGeneration(attempt.work_attempt_id, "starter", 2), /one execution generation/);
    await assert.rejects(() => store.recordTerminal(attempt.work_attempt_id, first.execution_generation_id, { ended_at: "2025-01-01T00:00:00.000Z", exit_code: 1, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "", actor: "other", generation: 1, provider_continuation_id: null }), /runtime schema|identity/);
    await assert.rejects(() => store.recordTerminal(attempt.work_attempt_id, first.execution_generation_id, { ended_at: "2026-01-01T00:00:01.000Z", exit_code: 1.5, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "crash", actor: "starter", generation: 1, provider_continuation_id: null }), /runtime schema/);
    assert.equal((await store.getAttempt(attempt.work_attempt_id)).execution_generations[0]?.terminal, null, "invalid runtime input must never poison the persisted authority record");
    await store.recordTerminal(attempt.work_attempt_id, first.execution_generation_id, { ended_at: "2026-01-01T00:00:01.000Z", exit_code: 1, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "crash", actor: "starter", generation: 1, provider_continuation_id: null });
    await assert.rejects(() => store.startGeneration(attempt.work_attempt_id, "starter", 1), /strictly monotonic/);
  } finally { await env.cleanup(); }
});

test("execution fencing fails closed without an injected P1a supervisor identity", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"));
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    await assert.rejects(() => store.startGeneration(attempt.work_attempt_id, "daemon", 1), /P1a supervisor identity/);
  } finally { await env.cleanup(); }
});

test("postmortem capture failure releases the retained execution fence", async () => {
  const env = await fixture();
  try {
    const git = async (args: string[]) => {
      if (args.includes("status")) throw new Error("injected postmortem failure");
      return fakeGit(env.root)(args);
    };
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, git, undefined, TEST_SUPERVISOR);
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    const execution = await store.startGeneration(attempt.work_attempt_id, "daemon", 1);
    await store.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, { ended_at: "2027-01-01T00:00:01.000Z", exit_code: 0, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "done", actor: "daemon", generation: 1, provider_continuation_id: null });
    await assert.rejects(() => store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done" }), /postmortem failure/);
    const fenceDir = join(env.root, "worktrees", "repo", ".letagents-supervisor-workspace.fences");
    assert.equal((await readdir(fenceDir)).some((name) => name.startsWith("shared-")), false);
  } finally { await env.cleanup(); }
});

test("live generations block every conclusion before Git capture", async () => {
  const env = await fixture();
  let gitCalls = 0;
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, async (args) => { gitCalls += 1; return fakeGit(env.root)(args); }, undefined, TEST_SUPERVISOR);
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    await store.startGeneration(attempt.work_attempt_id, "daemon", 1);
    await assert.rejects(() => store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done" }), /terminal attestation/);
    await assert.rejects(() => store.concludeAttempt(attempt.work_attempt_id, { state: "abandoned", cause: "stopped" }), /terminal attestation/);
    assert.equal(gitCalls, 0);
  } finally { await env.cleanup(); }
});

test("attempt creation requires a final provisioned marker and enforces unique exact worktree layout", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"));
    const id = randomUUID();
    const unmarked = join(env.root, "worktrees", "repo", id); await mkdir(unmarked, { recursive: true });
    await assert.rejects(() => store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: unmarked, workAttemptId: id }), /marker/);
    const first = await provisionedWorkspace(env.root);
    await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: first.path, workAttemptId: first.id });
    await assert.rejects(() => store.createAttempt({ taskId: "task", leaseId: "lease-2", leaseEpoch: 2, workspacePath: first.path, workAttemptId: first.id }), /already exists/);
    const duplicatePath = await provisionedWorkspace(env.root, "task", randomUUID());
    await assert.rejects(() => store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: duplicatePath.path, workAttemptId: first.id }), /marker/);
    const sibling = join(env.root, "worktrees", "repo", "not-the-attempt"); await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, ".letagents-work-attempt.json"), JSON.stringify({ version: 1, repo: "repo", work_attempt_id: id, task_id: "task", remote_url: "https://example.invalid/repo", resolved_revision: TEST_OID, bare_path: join(env.root, "repos", "repo.git") }));
    await assert.rejects(() => store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: sibling, workAttemptId: id }), /exact daemon worktree layout/);
  } finally { await env.cleanup(); }
});

test("GC replays every pending tombstone and refuses a Git identity mismatch", async () => {
  const env = await fixture();
  let release!: () => void;
  let reserved!: () => void;
  const entered = new Promise<void>((resolve) => { reserved = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  try {
    const path = join(env.root, "attempts.json");
    const workspace = await provisionedWorkspace(env.root);
    const first = new WorkDurabilityStore(path, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), async () => { reserved(); await blocked; }, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const attempt = await first.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    await first.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    assert.match(await readFile(join(env.root, "attempt-data", attempt.work_attempt_id, "postmortem.diff"), "utf8"), /status --porcelain/);
    const collecting = first.garbageCollect(0); await entered;
    const recovery = new WorkDurabilityStore(path, join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root));
    assert.deepEqual(await recovery.garbageCollect(99), [attempt.work_attempt_id], "pending GC must not be hidden behind retention");
    release(); await collecting;

    const mismatch = await provisionedWorkspace(env.root);
    let evilRemote = false;
    const guarded = new WorkDurabilityStore(join(env.root, "mismatch.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, async (args) => evilRemote && args.includes("remote") ? "https://evil.invalid/repo.git" : await fakeGit(env.root)(args), undefined, TEST_SUPERVISOR);
    const other = await guarded.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: mismatch.path, workAttemptId: mismatch.id });
    await guarded.concludeAttempt(other.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "diff" });
    evilRemote = true;
    assert.deepEqual(await guarded.garbageCollect(0), []);
    assert.equal((await stat(mismatch.path)).isDirectory(), true);
  } finally { await env.cleanup(); }
});

test("a retained live generation permits provisioning a distinct sibling workspace", async () => {
  const env = await fixture();
  try {
    const bare = join(env.root, "repos", "repo.git");
    const provisioner = new WorkspaceProvisioner(env.root, async (args) => {
      if (args[0] === "clone") await mkdir(args.at(-1)!, { recursive: true });
      else if (args.includes("worktree") && args.includes("add")) await mkdir(args.at(-2)!, { recursive: true });
      if (args.includes("--is-bare-repository")) return "true";
      if (args.includes("remote") && args.includes("get-url")) return "https://example.invalid/repo.git";
      if (args.includes("cat-file")) return "ok";
      if (args.includes("rev-parse")) return args.includes("--git-common-dir") ? bare : TEST_OID;
      return "";
    });
    const firstId = randomUUID();
    const first = await provisioner.provision({
      repo: "repo",
      workAttemptId: firstId,
      taskId: "first",
      remoteUrl: "https://example.invalid/repo.git",
      revision: TEST_OID,
    });
    const retained = await acquireWorkspaceFence(first.path, "live-supervisor", 1, "shared");
    try {
      const secondId = randomUUID();
      const second = await provisioner.provision({
        repo: "repo",
        workAttemptId: secondId,
        taskId: "second",
        remoteUrl: "https://example.invalid/repo.git",
        revision: TEST_OID,
      });
      assert.equal(second.path, join(env.root, "worktrees", "repo", secondId));
      assert.equal((await stat(second.path)).isDirectory(), true);
    } finally { await retained.release(); }
  } finally { await env.cleanup(); }
});

test("target-exclusive provisioning remains mutually exclusive for the same workspace", async () => {
  const env = await fixture();
  try {
    const target = join(env.root, "worktrees", "repo", randomUUID());
    const sibling = join(env.root, "worktrees", "repo", randomUUID());
    let siblingRan = false;
    await withWorkspaceFence(target, async () => {
      await assert.rejects(() => withWorkspaceFence(target, async () => undefined), /fenced by a live supervisor generation/);
      await assert.rejects(
        () => acquireWorkspaceFence(target, "generation-during-provision", 1, "shared"),
        /fenced by a live supervisor generation/,
      );
      await withWorkspaceFence(sibling, async () => { siblingRan = true; });
    });
    assert.equal(siblingRan, true, "a distinct target remains independently provisionable");

    siblingRan = false;
    const retained = await acquireWorkspaceFence(target, "live-generation", 1, "shared");
    try {
      await assert.rejects(() => withWorkspaceFence(target, async () => undefined), /fenced by a live supervisor generation/);
      await withWorkspaceFence(sibling, async () => { siblingRan = true; });
    } finally { await retained.release(); }
    assert.equal(siblingRan, true, "a sibling remains provisionable beside a retained generation");
  } finally { await env.cleanup(); }
});

test("repo-exclusive GC authority conflicts with every live fence in both acquisition orders", async () => {
  const env = await fixture();
  try {
    const active = join(env.root, "worktrees", "repo", randomUUID());
    const doomed = join(env.root, "worktrees", "repo", randomUUID());
    const retained = await acquireWorkspaceFence(active, "live-supervisor", 1, "shared");
    try {
      await assert.rejects(
        () => acquireWorkspaceFence(doomed, "gc", 1, "exclusive", "repo"),
        /fenced by a live supervisor generation/,
      );
    } finally { await retained.release(); }

    const gc = await acquireWorkspaceFence(doomed, "gc", 1, "exclusive", "repo");
    try {
      await assert.rejects(
        () => withWorkspaceFence(active, async () => undefined),
        /fenced by a live supervisor generation/,
      );
      await assert.rejects(
        () => acquireWorkspaceFence(active, "successor-supervisor", 2, "shared"),
        /fenced by a live supervisor generation/,
      );
    } finally { await gc.release(); }
  } finally { await env.cleanup(); }
});

test("workspace fences remove stale PIDs and treat live pre-scope records as repo-wide", async () => {
  const env = await fixture();
  try {
    const target = join(env.root, "worktrees", "repo", randomUUID());
    const sibling = join(env.root, "worktrees", "repo", randomUUID());
    const directory = join(dirname(target), ".letagents-supervisor-workspace.fences");
    await mkdir(directory, { recursive: true });
    const legacyRecord = (pid: number) => JSON.stringify({
      owner: "legacy-daemon",
      generation: 1,
      pid,
      workspace_path: target,
      mode: "exclusive",
      created_at: "2026-07-16T00:00:00.000Z",
    });

    const stalePath = join(directory, "exclusive-stale.json");
    await writeFile(stalePath, legacyRecord(2_147_483_647));
    let ran = false;
    await withWorkspaceFence(target, async () => { ran = true; });
    assert.equal(ran, true);
    assert.equal((await readdir(directory)).includes("exclusive-stale.json"), false);

    const livePath = join(directory, "exclusive-live-legacy.json");
    await writeFile(livePath, legacyRecord(process.pid));
    try {
      await assert.rejects(
        () => withWorkspaceFence(sibling, async () => undefined),
        /fenced by a live supervisor generation/,
      );
    } finally { await rm(livePath, { force: true }); }
  } finally { await env.cleanup(); }
});

test("workspace fences and terminal attestation protect clean GC", async () => {
  const env = await fixture();
  try {
    const workspace = await provisionedWorkspace(env.root);
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    const execution = await store.startGeneration(attempt.work_attempt_id, "daemon", 1);
    await assert.rejects(() => store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "diff" }), /terminal attestation/);
    await store.recordTerminal(attempt.work_attempt_id, execution.execution_generation_id, { ended_at: "2027-01-01T00:00:01.000Z", exit_code: 0, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "done", actor: "daemon", generation: 1, provider_continuation_id: null });
    await store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done", postmortemDiff: "diff" });
    await withWorkspaceFence(workspace.path, async () => {
      assert.deepEqual(await store.garbageCollect(0), []);
      assert.equal((await stat(workspace.path)).isDirectory(), true);
    });
  } finally { await env.cleanup(); }
});

test("retained shared fences permit concurrent work and prevent GC from deleting a swapped active workspace", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const doomedWorkspace = await provisionedWorkspace(env.root, "doomed");
    const activeWorkspace = await provisionedWorkspace(env.root, "active");
    const doomed = await store.createAttempt({ taskId: "doomed", leaseId: "lease-doomed", leaseEpoch: 1, workspacePath: doomedWorkspace.path, workAttemptId: doomedWorkspace.id });
    const active = await store.createAttempt({ taskId: "active", leaseId: "lease-active", leaseEpoch: 1, workspacePath: activeWorkspace.path, workAttemptId: activeWorkspace.id });
    await store.concludeAttempt(doomed.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    const activeGeneration = await store.startGeneration(active.work_attempt_id, "daemon", 1);
    // Independent supervisor generations share read authority instead of
    // serializing all agents behind a global exclusive lock.
    const secondWorkspace = await provisionedWorkspace(env.root, "second");
    const second = await store.createAttempt({ taskId: "second", leaseId: "lease-second", leaseEpoch: 1, workspacePath: secondWorkspace.path, workAttemptId: secondWorkspace.id });
    await store.startGeneration(second.work_attempt_id, "daemon", 1);
    assert.equal((await readdir(join(env.root, "worktrees", "repo", ".letagents-supervisor-workspace.fences"))).filter((name) => name.startsWith("shared-")).length, 2);
    // Simulate an uncooperative filesystem attacker: it does not acquire any
    // helper fence. GC must fail closed before it can act on either pathname.
    await rm(doomedWorkspace.path, { recursive: true });
    await symlink(activeWorkspace.path, doomedWorkspace.path);
    assert.deepEqual(await store.garbageCollect(0), []);
    assert.equal((await stat(activeWorkspace.path)).isDirectory(), true);
    await store.recordTerminal(active.work_attempt_id, activeGeneration.execution_generation_id, { ended_at: "2027-01-01T00:00:01.000Z", exit_code: 0, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "done", actor: "daemon", generation: 1, provider_continuation_id: null });
  } finally { await env.cleanup(); }
});

test("worker binding cursor survives an exact-session generation rebind and fences stale writers", async () => {
  const env = await fixture();
  try {
    const store = new WorkerBindingStore(join(env.root, "worker-bindings.json"));
    await store.bind({
      entry_id: "entry_exact",
      room_id: "focus_37",
      work_attempt_id: "attempt_exact",
      execution_generation_id: "execution_1",
      agent_session_id: "agent_session_exact",
      agent_session_token: "session-secret",
      api_url: "https://letagents.chat",
    });
    await store.checkpointCursor("entry_exact", "agent_session_exact", "execution_1", "msg_2819");
    const internals = store as unknown as { write: (value: unknown) => Promise<void> };
    const originalWrite = internals.write.bind(internals);
    let writes = 0;
    internals.write = async (value) => { writes += 1; await originalWrite(value); };
    await store.checkpointCursor("entry_exact", "agent_session_exact", "execution_1", "msg_2819");
    assert.equal(writes, 0, "a repeated empty poll cursor performs no credential-store write");
    assert.equal((await store.checkpointCursorMonotonic("entry_exact", "agent_session_exact", "execution_1", "msg_2820")).advanced, true);
    assert.equal((await store.checkpointCursorMonotonic("entry_exact", "agent_session_exact", "execution_1", "msg_2818")).advanced, false);
    assert.equal((await store.get("entry_exact"))?.room_cursor, "msg_2820", "out-of-order compatibility evidence cannot regress progress");
    await store.checkpointCursor("entry_exact", "agent_session_exact", "execution_1", "msg_2822");
    assert.equal((await store.checkpointCursorMonotonic("entry_exact", "agent_session_exact", "execution_1", "msg_2821")).advanced, false);
    assert.equal((await store.get("entry_exact"))?.room_cursor, "msg_2822", "a newer formal response checkpoint wins over delayed compatibility evidence");
    let verifiedPredecessorGeneration: string | null = null;
    const reboundResult = await store.verifyAndAdvanceExecutionGeneration({
      entryId: "entry_exact",
      roomId: "focus_37",
      workAttemptId: "attempt_exact",
      fromExecutionGenerationId: "execution_1",
      toExecutionGenerationId: "execution_2",
      agentSessionId: "agent_session_exact",
    }, async ({ binding }) => {
      verifiedPredecessorGeneration = binding.execution_generation_id;
      return { accepted: true };
    });
    const rebound = reboundResult.binding;
    assert.equal(verifiedPredecessorGeneration, "execution_1", "credential verification runs before durable generation mutation");
    assert.equal(rebound.room_cursor, "msg_2822");
    assert.equal(await store.credentialFor(rebound), "session-secret", "generation rollover preserves only the private in-memory authority");
    let racedVerificationCalled = false;
    assert.equal((await store.verifyAndAdvanceExecutionGeneration({
      entryId: "entry_exact", roomId: "focus_37", workAttemptId: "attempt_exact",
      fromExecutionGenerationId: "execution_1", toExecutionGenerationId: "execution_2",
      agentSessionId: "agent_session_exact",
    }, async () => { racedVerificationCalled = true; return { accepted: true }; })).binding.execution_generation_id, "execution_2", "a formal bind winning the successor race is idempotent");
    assert.equal(racedVerificationCalled, false);
    const rejectedRollover = await store.verifyAndAdvanceExecutionGeneration({
      entryId: "entry_exact", roomId: "focus_37", workAttemptId: "attempt_exact",
      fromExecutionGenerationId: "execution_2", toExecutionGenerationId: "execution_3",
      agentSessionId: "agent_session_exact",
    }, async () => ({ accepted: false }));
    assert.equal(rejectedRollover.advanced, false);
    assert.equal((await store.get("entry_exact"))?.execution_generation_id, "execution_2", "rejected verification preserves predecessor authority");
    await assert.rejects(store.verifyAndAdvanceExecutionGeneration({
      entryId: "entry_exact", roomId: "focus_37", workAttemptId: "attempt_exact",
      fromExecutionGenerationId: "execution_2", toExecutionGenerationId: "execution_3",
      agentSessionId: "agent_session_exact",
    }, async () => { throw new Error("verification timeout"); }), /verification timeout/);
    assert.equal((await store.get("entry_exact"))?.execution_generation_id, "execution_2", "verification timeout preserves predecessor authority");
    await assert.rejects(store.verifyAndAdvanceExecutionGeneration({
      entryId: "entry_exact", roomId: "focus_other", workAttemptId: "attempt_exact",
      fromExecutionGenerationId: "execution_2", toExecutionGenerationId: "execution_3",
      agentSessionId: "agent_session_exact",
    }, async () => ({ accepted: true })), /does not match the durable worker identity/);
    await assert.rejects(
      store.checkpointCursor("entry_exact", "agent_session_exact", "execution_1", "msg_stale"),
      /does not match the active supervised binding/,
    );
    await store.bind({
      entry_id: "entry_peer_b",
      room_id: "focus_37",
      work_attempt_id: "attempt_peer_b",
      execution_generation_id: "execution_peer_b",
      agent_session_id: "agent_session_peer_b",
      agent_session_token: "peer-b-secret",
      api_url: "https://letagents.chat",
    });
    await store.checkpointCursor("entry_peer_b", "agent_session_peer_b", "execution_peer_b", "msg_peer_b");
    assert.equal((await store.get("entry_exact"))?.room_cursor, "msg_2822", "peer B cannot advance peer A's same-room cursor");
    assert.equal((await store.get("entry_peer_b"))?.room_cursor, "msg_peer_b");

    const replacementIdentity = await store.bind({
      entry_id: "entry_exact",
      room_id: "focus_37",
      work_attempt_id: "attempt_exact",
      execution_generation_id: "execution_3",
      agent_session_id: "agent_session_other",
      agent_session_token: "other-secret",
      api_url: "https://letagents.chat",
    });
    assert.equal(replacementIdentity.room_cursor, null, "a different worker identity cannot inherit another session's cursor");
  } finally {
    await env.cleanup();
  }
});

test("one retained supervisor handle survives terminal, rebind, and successor start", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease-1", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    const first = await store.startGeneration(attempt.work_attempt_id, "daemon", 1);
    const fenceDirectory = join(env.root, "worktrees", "repo", ".letagents-supervisor-workspace.fences");
    const held = (await readdir(fenceDirectory)).find((name) => name.startsWith("shared-"));
    assert.ok(held);
    await store.recordTerminal(attempt.work_attempt_id, first.execution_generation_id, { ended_at: "2027-01-01T00:00:01.000Z", exit_code: 0, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "done", actor: "daemon", generation: 1, provider_continuation_id: null });
    await store.rebindAttempt(attempt.work_attempt_id, "lease-2", 2);
    await store.startGeneration(attempt.work_attempt_id, "daemon", 2);
    assert.equal((await readdir(fenceDirectory)).filter((name) => name.startsWith("shared-")).join(), held, "handoff must retain the same fence record without a release/reacquire gap");
  } finally { await env.cleanup(); }
});

test("a live fence in an unrelated repository does not starve safe GC", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root), undefined, TEST_SUPERVISOR);
    const workspace = await provisionedWorkspace(env.root);
    const attempt = await store.createAttempt({ taskId: "task", leaseId: "lease", leaseEpoch: 1, workspacePath: workspace.path, workAttemptId: workspace.id });
    await store.concludeAttempt(attempt.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    const unrelated = join(env.root, "worktrees", "other-repo", randomUUID());
    await mkdir(unrelated, { recursive: true });
    const live = await acquireWorkspaceFence(unrelated, "other-supervisor", 1, "shared");
    try { assert.deepEqual(await store.garbageCollect(0), [attempt.work_attempt_id]); }
    finally { await live.release(); }
  } finally { await env.cleanup(); }
});

test("supervisor quiescence lets same-repository GC progress without stopping live work", async () => {
  const env = await fixture();
  let quiesced: string[] = [];
  let resumed = false;
  try {
    const store = new WorkDurabilityStore(
      join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root),
      async (attempts) => { quiesced = attempts.map((attempt) => attempt.work_attempt_id); return async () => { resumed = true; }; }, TEST_SUPERVISOR,
    );
    const doomedWorkspace = await provisionedWorkspace(env.root, "doomed");
    const liveWorkspace = await provisionedWorkspace(env.root, "live");
    const doomed = await store.createAttempt({ taskId: "doomed", leaseId: "lease-doomed", leaseEpoch: 1, workspacePath: doomedWorkspace.path, workAttemptId: doomedWorkspace.id });
    const live = await store.createAttempt({ taskId: "live", leaseId: "lease-live", leaseEpoch: 1, workspacePath: liveWorkspace.path, workAttemptId: liveWorkspace.id });
    await store.concludeAttempt(doomed.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    await store.startGeneration(live.work_attempt_id, "daemon", 1);
    assert.deepEqual(await store.garbageCollect(0), [doomed.work_attempt_id]);
    assert.deepEqual(quiesced, [live.work_attempt_id]);
    assert.equal(resumed, true);
    assert.equal((await stat(liveWorkspace.path)).isDirectory(), true);
    assert.equal((await readdir(join(env.root, "worktrees", "repo", ".letagents-supervisor-workspace.fences"))).filter((name) => name.startsWith("shared-")).length, 1, "live generation fence is restored before it resumes");
  } finally { await env.cleanup(); }
});

test("quiescence failures never resume a partially unfenced live generation", async () => {
  const env = await fixture();
  let resumed = 0;
  try {
    const store = new WorkDurabilityStore(
      join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root),
      async () => async () => { resumed += 1; }, { supervisor_id: "daemon-host", supervisor_generation: 7 },
      { before_release: async (_attempt, index) => { if (index === 1) throw new Error("injected partial-release failure"); } },
    );
    const targetWorkspace = await provisionedWorkspace(env.root, "target");
    const firstWorkspace = await provisionedWorkspace(env.root, "first");
    const secondWorkspace = await provisionedWorkspace(env.root, "second");
    const target = await store.createAttempt({ taskId: "target", leaseId: "lease-target", leaseEpoch: 1, workspacePath: targetWorkspace.path, workAttemptId: targetWorkspace.id });
    const first = await store.createAttempt({ taskId: "first", leaseId: "lease-first", leaseEpoch: 1, workspacePath: firstWorkspace.path, workAttemptId: firstWorkspace.id });
    const second = await store.createAttempt({ taskId: "second", leaseId: "lease-second", leaseEpoch: 1, workspacePath: secondWorkspace.path, workAttemptId: secondWorkspace.id });
    await store.concludeAttempt(target.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    await store.startGeneration(first.work_attempt_id, "daemon", 1);
    await store.startGeneration(second.work_attempt_id, "daemon", 1);
    assert.deepEqual(await store.garbageCollect(0), []);
    assert.equal(resumed, 0);
    assert.equal((await store.getAttempt(first.work_attempt_id)).state, "coordination_blocked");
    assert.equal((await store.getAttempt(second.work_attempt_id)).state, "coordination_blocked");
  } finally { await env.cleanup(); }
});

test("quiescence restore failure never resumes unfenced work", async () => {
  const env = await fixture();
  let resumed = 0;
  try {
    const store = new WorkDurabilityStore(
      join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root),
      async () => async () => { resumed += 1; }, { supervisor_id: "daemon-host", supervisor_generation: 7 },
      { before_restore: async () => { throw new Error("injected restore failure"); } },
    );
    const targetWorkspace = await provisionedWorkspace(env.root, "target");
    const liveWorkspace = await provisionedWorkspace(env.root, "live");
    const target = await store.createAttempt({ taskId: "target", leaseId: "lease-target", leaseEpoch: 1, workspacePath: targetWorkspace.path, workAttemptId: targetWorkspace.id });
    const live = await store.createAttempt({ taskId: "live", leaseId: "lease-live", leaseEpoch: 1, workspacePath: liveWorkspace.path, workAttemptId: liveWorkspace.id });
    await store.concludeAttempt(target.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    await store.startGeneration(live.work_attempt_id, "daemon", 1);
    assert.deepEqual(await store.garbageCollect(0), []);
    assert.equal(resumed, 0);
    assert.equal((await store.getAttempt(live.work_attempt_id)).state, "coordination_blocked");
  } finally { await env.cleanup(); }
});

test("quiescence resume failure blocks the live attempt", async () => {
  const env = await fixture();
  try {
    const store = new WorkDurabilityStore(
      join(env.root, "attempts.json"), join(env.root, "attempt-data"), undefined, join(env.root, "worktrees"), undefined, fakeGit(env.root),
      async () => async () => { throw new Error("injected resume failure"); }, { supervisor_id: "daemon-host", supervisor_generation: 7 },
    );
    const targetWorkspace = await provisionedWorkspace(env.root, "target");
    const liveWorkspace = await provisionedWorkspace(env.root, "live");
    const target = await store.createAttempt({ taskId: "target", leaseId: "lease-target", leaseEpoch: 1, workspacePath: targetWorkspace.path, workAttemptId: targetWorkspace.id });
    const live = await store.createAttempt({ taskId: "live", leaseId: "lease-live", leaseEpoch: 1, workspacePath: liveWorkspace.path, workAttemptId: liveWorkspace.id });
    await store.concludeAttempt(target.work_attempt_id, { state: "cleanly_concluded", cause: "done" });
    await store.startGeneration(live.work_attempt_id, "daemon", 1);
    assert.deepEqual(await store.garbageCollect(0), []);
    assert.equal((await store.getAttempt(live.work_attempt_id)).state, "coordination_blocked");
  } finally { await env.cleanup(); }
});
