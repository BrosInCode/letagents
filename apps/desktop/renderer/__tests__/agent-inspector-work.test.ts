import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer } from "vite";
import type { RetainedExecutionDetail } from "../../shared/execution-protocol";
import {
  agentInspectorWorkArtifacts,
  agentInspectorDetailRevision,
  agentInspectorDetailKey,
  agentInspectorDetailRequestIsCurrent,
  readAgentInspectorWorkDetail,
  invalidateAgentInspectorRuntimeControl,
  createAgentInspectorBackgroundRefresh,
  createAgentInspectorDetailRequest,
  agentInspectorRuntimeControlMatchesFence,
  defaultAgentInspectorWorkSource,
  describeAgentInspectorRuntimeControl,
  describeAgentInspectorUncertainEffect,
  describeRecordedOperation,
  humanizeRecordedTurn,
  humanizeAgentInspectorReceiptState,
  humanizeAgentInspectorTimeline,
  isCurrentAgentInspectorWorkResponse,
} from "../src/domain/agent-inspector-work";

test("work detail source selection uses exact active source before bounded recency", () => {
  assert.equal(defaultAgentInspectorWorkSource({ roomAgentState: { turn: { sourceMessageId: "active" } } } as any, { items: [{ source_message_id: "newest" }] }), "active");
  assert.equal(defaultAgentInspectorWorkSource({ roomAgentState: { turn: { sourceMessageId: null } } } as any, { items: [{ source_message_id: "newest" }] }), "newest");
});

test("recorded execution renders partial evidence without changing the work receipt or implying live status", async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const component = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorWork.vue")).default;
    const operation = { executionId: "op-1", operation: "command" as const, outcome: "failed" as const, startObserved: true, outputBytes: 120, sideEffects: "possible" as const, exitCode: 1, signalNumber: null };
    const execution: RetainedExecutionDetail = { availability: "available", evidenceIncomplete: true, truncated: true, turns: [
      { turnId: "turn-1", state: "terminal", outcome: "completed", operations: [operation, { ...operation, executionId: "op-2", outcome: null, startObserved: false, exitCode: null }] },
    ] };
    const render = (recorded_execution?: RetainedExecutionDetail) => renderToString(createSSRApp(component, {
      resource: { status: "ready", error: null, sourceMessageId: "msg-1", detail: { availability: "available", items: [], uncertain_effects: [], timeline: [], source_message: { sender: "Owner", text: "Check the project" }, receipt: { state: "acknowledged" }, recorded_execution } },
      selectedSourceMessageId: "msg-1", tasks: [], artifacts: [],
    }));
    const html = await render(execution);
    assert.match(html, /Reply published/);
    assert.match(html, /Saved observations, not live status/);
    assert.match(html, /not a complete account/);
    assert.match(html, /bounded selection/);
    assert.match(html, /<details[^>]*open/);
    assert.match(html, /Provider turn completed/);
    assert.match(html, /Command · Failed/);
    assert.match(html, /Exit code 1 · 120 bytes of output recorded · Side effects possible/);
    assert.match(html, /Command · No finish recorded/);
    assert.match(html, /Start was not recorded/);
    assert.doesNotMatch(html, /spinner|Running a command/);
    assert.match(await render({ availability: "not_captured" }), /does not mean the agent did no work/);
    assert.match(await render({ availability: "unavailable" }), /Delivery receipts are still available/);
    assert.match(await render(), /supervisor does not provide recorded execution/);
    assert.match(await render({ ...execution, turns: [] }), /No individual turns could be verified/);
    const bounded = await render({ ...execution, truncated: true, turns: [execution.turns[0]!, { ...execution.turns[0]!, turnId: "omitted-operations", operations: [] }] });
    assert.match(bounded, /0 operations shown/);
    assert.match(bounded, /No individual operations are included/);
    assert.doesNotMatch(bounded, /No individual operations were recorded/);
    for (const [outcome, label] of [["denied_before_start", "Denied before starting"], ["cancelled_before_start", "Cancelled before starting"], ["interrupted_after_start", "Interrupted after starting"], ["lost_after_start", "Outcome lost after starting"]] as const) {
      assert.match(describeRecordedOperation({ ...operation, outcome }).title, new RegExp(label));
    }
    assert.equal(humanizeRecordedTurn({ ...execution.turns[0]!, state: "active", outcome: null }), "No turn finish recorded");
    assert.equal(humanizeRecordedTurn({ ...execution.turns[0]!, state: "lost", outcome: null }), "Provider turn lost");
  } finally { await vite.close(); }
});

test("work response and artifact joins are exact durable identifiers", () => {
  const detail = { availability: "available", entry_id: "agent_a", room_id: "room_a", requested_source_message_id: "source_a", source_message: { id: "source_a" } } as any;
  assert.equal(isCurrentAgentInspectorWorkResponse(detail, "agent_a", "room_a", "source_a"), true);
  assert.equal(isCurrentAgentInspectorWorkResponse(detail, "agent_a", "room_b", "source_a"), false);
  assert.equal(isCurrentAgentInspectorWorkResponse(detail, "agent_a", "room_a", "source_b"), false);
  assert.equal(isCurrentAgentInspectorWorkResponse({ ...detail, requested_source_message_id: "source_b" }, "agent_a", "room_a", "source_a"), false);
  assert.equal(isCurrentAgentInspectorWorkResponse({ availability: "pruned", entry_id: "agent_a", room_id: "room_a", requested_source_message_id: "source_pruned", source_message: null } as any, "agent_a", "room_a", "source_pruned"), true);
  assert.equal(isCurrentAgentInspectorWorkResponse({ availability: "not_loaded", entry_id: "agent_a", room_id: "room_a", requested_source_message_id: null, source_message: null } as any, "agent_a", "room_a", null), true);
  const artifacts = agentInspectorWorkArtifacts([{ id: "task_a" }], [
    { identityKey: "a", linkedTaskIds: ["task_a"], updatedAt: "2026-01-01T00:00:00.000Z", firstSeenAt: "2026-01-01T00:00:00.000Z", kind: "branch", provider: "git", source: "manual", roomId: "room_a", artifactId: null, artifactNumber: null, title: "Exact", url: null, ref: null, state: null, detail: null },
    { identityKey: "b", linkedTaskIds: ["task_b"], updatedAt: "2026-01-02T00:00:00.000Z", firstSeenAt: "2026-01-02T00:00:00.000Z", kind: "branch", provider: "git", source: "manual", roomId: "room_a", artifactId: null, artifactNumber: null, title: "Different", url: null, ref: null, state: null, detail: null },
  ] as any);
  assert.deepEqual(artifacts.map((item) => item.title), ["Exact"]);
});

test("work labels present human language instead of raw causal enums", () => {
  assert.equal(humanizeAgentInspectorReceiptState("acknowledged"), "Reply published");
  assert.equal(humanizeAgentInspectorReceiptState("acknowledged_failed"), "Work did not finish");
  assert.equal(
    humanizeAgentInspectorReceiptState("acknowledged_no_reply", "upgrade_authority_unavailable"),
    "Retired during a safety upgrade",
  );
  assert.match(describeAgentInspectorUncertainEffect("send_message"), /may have completed.*verify external state/i);
  assert.equal(humanizeAgentInspectorTimeline({ phase: "turn_started" } as any), "Work started");
  assert.deepEqual(describeAgentInspectorRuntimeControl({
    control_state: "degraded", runtime_state: "ready", observed_at: "now",
    execution_generation_id: "generation", daemon_generation_id: "4",
  }), {
    state: "degraded",
    label: "Provider check inconclusive",
    detail: "LetAgents could not confirm the provider’s control connection. The agent may still be working; it has not been failed or restarted.",
    observedAt: "now",
  });
  assert.match(describeAgentInspectorRuntimeControl({
    control_state: "unprobeable", runtime_state: "ready", observed_at: null,
    execution_generation_id: "generation", daemon_generation_id: "4",
  })?.detail ?? "", /Silence is not treated as failure/);
  assert.match(describeAgentInspectorRuntimeControl({
    control_state: "responsive", runtime_state: "exited", observed_at: "now",
    execution_generation_id: "generation", daemon_generation_id: "4",
  })?.detail ?? "", /will not infer that unfinished work completed/);
  const fenced = { control_state: "responsive", runtime_state: "ready", observed_at: "now",
    execution_generation_id: "generation", daemon_generation_id: "4", runtime_generation_id: "birth" } as const;
  assert.equal(agentInspectorRuntimeControlMatchesFence(fenced, "generation", 4, "birth"), true);
  assert.equal(agentInspectorRuntimeControlMatchesFence(fenced, "replacement", 4, "birth"), false);
  assert.equal(agentInspectorRuntimeControlMatchesFence(fenced, "generation", 5, "birth"), false);
  assert.equal(agentInspectorRuntimeControlMatchesFence(fenced, "generation", 4, "new-birth"), false);
  assert.equal(agentInspectorRuntimeControlMatchesFence(fenced, "generation", 4), false);
});

test("shell keeps work loading dark, fenced, stale-safe, and routed through canonical reveal", () => {
  const shell = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/DesktopRoomShell.vue", import.meta.url)), "utf8");
  const surface = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/agent-inspector/AgentInspectorSurface.vue", import.meta.url)), "utf8");
  const work = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/agent-inspector/AgentInspectorWork.vue", import.meta.url)), "utf8");
  assert.doesNotMatch(shell, /agentInspectorFoundationEnabled/);
  assert.match(shell, /capabilities\.agentInspectorDetail/);
  assert.match(shell, /agentInspectorDetailRequestIsCurrent/);
  assert.match(shell, /agentInspectorWorkResource\.value = \{ status: "loading", detail: null, error: null, sourceMessageId \}/);
  assert.match(shell, /void loadAgentInspectorWorkDetail\(sourceMessageId, true\)/);
  assert.match(shell, /void loadAgentInspectorWorkDetail\(null, false, false\)/);
  assert.match(shell, /followDefaultSource && sourceMessageId === null/);
  assert.match(shell, /refreshOpenAgentInspectorRuntimeControl\(snapshot\)/);
  assert.match(shell, /invalidateAgentInspectorRuntimeControl\(/);
  assert.match(shell, /readAgentInspectorWorkDetail\(/);
  assert.match(shell, /snapshotGeneration: supervisorStateDaemonGeneration/);
  assert.match(shell, /entry: selectedAgentDetailProjection\.value\?\.entry/);
  assert.match(shell, /if \(!currentDetail \|\| !isCurrent\(\)\) return/);
  assert.match(shell, /activeTab\.value = "chat"[\s\S]{0,120}revealRoomMessage\(canonicalMessageId\)/);
  assert.match(surface, /role="tablist"/);
  assert.match(surface, /ArrowLeft.*ArrowRight.*Home.*End/);
  assert.match(work, /Older detail was removed by local retention/);
  assert.match(work, /did not create retained activated work/);
  assert.match(work, /mutating tool outcomes need verification/i);
  assert.match(work, /A safety upgrade retired this legacy turn/);
  assert.match(work, /Open reply in Chat/);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("background slow reads coalesce changed work and periodically recheck unchanged health", async () => {
  let now = 0;
  const refresh = createAgentInspectorBackgroundRefresh(() => now);
  const slow = deferred<boolean>();
  const calls: string[] = [];
  const read = (name: string) => async () => { calls.push(name); return true; };
  const first = refresh.refresh("birth-a", "work-1", () => { calls.push("first"); return slow.promise; });
  await Promise.resolve();
  refresh.refresh("birth-a", "work-1", read("duplicate"));
  refresh.refresh("birth-a", "work-2", read("superseded"));
  refresh.refresh("birth-a", "work-3", read("latest"));
  assert.deepEqual(calls, ["first"]);
  slow.resolve(true);
  await first;
  assert.deepEqual(calls, ["first", "latest"]);
  await refresh.refresh("birth-a", "work-3", read("too-soon"));
  now = 5_000;
  await refresh.refresh("birth-a", "work-3", read("periodic"));
  assert.deepEqual(calls, ["first", "latest", "periodic"]);
});

test("identity roundtrips, close, and errors cannot reuse stale freshness or trailing work", async () => {
  const refresh = createAgentInspectorBackgroundRefresh(() => 0);
  const calls: string[] = [];
  const read = (name: string) => async () => { calls.push(name); return true; };
  await refresh.refresh("A", "1", read("A1"));
  const slowB = deferred<boolean>();
  const old = refresh.refresh("B", "1", () => slowB.promise);
  await Promise.resolve();
  refresh.refresh("B", "2", read("old trailing"));
  await refresh.refresh("A", "1", read("A2"));
  slowB.resolve(true);
  await old;
  assert.deepEqual(calls, ["A1", "A2"]);
  const pending = deferred<boolean>();
  const closing = refresh.refresh("C", "1", () => pending.promise);
  await Promise.resolve();
  refresh.refresh("C", "2", read("closed trailing"));
  refresh.reset();
  pending.resolve(true);
  await closing;
  await refresh.refresh("A", "1", read("reopened"));
  await refresh.refresh("error", "1", async () => { throw new Error("offline"); });
  await refresh.refresh("error", "1", read("retry"));
  assert.deepEqual(calls, ["A1", "A2", "reopened", "retry"]);
});

test("manual and background detail reads share identity and retain explicit source-follow intent", async () => {
  const requests = createAgentInspectorDetailRequest();
  const pending = deferred<void>();
  const calls: string[] = [];
  let follow = false;
  const first = requests.run("entry/source/birth-a", false, async intent => {
    calls.push("a");
    await pending.promise;
    follow = intent.followDefaultSource;
  });
  assert.deepEqual(calls, ["a"], "admission precedes any newer identity");
  const same = requests.run("entry/source/birth-a", true, async () => { calls.push("duplicate"); });
  assert.equal(first, same);
  requests.run("entry/source/birth-a", false, async () => { calls.push("duplicate background"); });
  await requests.run("entry/new-source/birth-b", false, async () => { calls.push("b"); });
  pending.resolve();
  await first;
  assert.equal(follow, true);
  requests.reset();
  await requests.run("entry/source/birth-a", false, async () => { calls.push("reopened"); });
  assert.deepEqual(calls, ["a", "b", "reopened"]);
});

test("timestamp-only snapshots do not refetch detail but durable work changes do", async () => {
  const entry = { observedState: "running", condition: "ready", bindingUpdatedAt: "1",
    nativeLiveness: { observedAt: "1" }, roomAgentState: { connection: { observedAt: "1" }, ingress: { observedAt: "1" },
      turn: { state: "responding", sourceMessageId: "source" }, inbox: { pendingCount: 1 } }, deliveryReceipts: [{ state: "awaiting_result" }] } as any;
  const refreshed = { ...entry, bindingUpdatedAt: "2", nativeLiveness: { observedAt: "2" }, roomAgentState: {
    ...entry.roomAgentState, connection: { observedAt: "2" }, ingress: { observedAt: "2" } } };
  const refresh = createAgentInspectorBackgroundRefresh(() => 0);
  let calls = 0;
  const read = async () => { calls += 1; return true; };
  await refresh.refresh("birth", agentInspectorDetailRevision(entry), read);
  await refresh.refresh("birth", agentInspectorDetailRevision(refreshed), read);
  assert.equal(calls, 1);
  await refresh.refresh("birth", agentInspectorDetailRevision({ ...refreshed, deliveryReceipts: [{ state: "acknowledged" }] }), read);
  assert.equal(calls, 2);
  await refresh.refresh("new-birth", agentInspectorDetailRevision(refreshed), read);
  assert.equal(calls, 3);
});

test("an old detail response is rejected immediately on daemon snapshot handoff before status negotiation finishes", async () => {
  const entry = { id: "entry", roomId: "room", executionGenerationId: "execution", runtimeGenerationId: "birth" } as any;
  const key = agentInspectorDetailKey(entry, "source", 4);
  const state = { token: 1, snapshotGeneration: 4, statusGeneration: 4, source: "source", birth: "birth" };
  const accepts = () => agentInspectorDetailRequestIsCurrent(key, 1, {
    entry: { ...entry, runtimeGenerationId: state.birth }, roomId: "room", source: state.source,
    generation: state.statusGeneration, snapshotGeneration: state.snapshotGeneration, token: state.token,
  });
  assert.equal(accepts(), true);
  state.snapshotGeneration = 0;
  assert.equal(accepts(), true, "detail remains supported before the first push snapshot");
  state.snapshotGeneration = 4;
  const old = deferred<void>();
  let painted = false;
  const response = old.promise.then(() => { if (accepts()) painted = true; });
  state.snapshotGeneration = 5;
  old.resolve();
  await response;
  assert.equal(painted, false, "old daemon response cannot restore health during negotiation");
  state.snapshotGeneration = 4;
  state.birth = "replacement-with-same-pid-and-execution";
  assert.equal(accepts(), false);
  state.birth = "birth";
  state.source = "other-source";
  assert.equal(accepts(), false);
  state.source = "source";
  state.token = 2;
  assert.equal(accepts(), false, "close/reopen invalidates an otherwise matching old read");
});

test("detail refresh retains exact last-check evidence and drops mismatched health synchronously and on errors", async () => {
  const entry = { id: "entry", roomId: "room", executionGenerationId: "execution", runtimeGenerationId: "birth" } as any;
  const detail = { entry_id: "entry", room_id: "room", requested_source_message_id: "source", availability: "available",
    source_message: { id: "source" }, runtime_control: { control_state: "responsive", runtime_state: "ready", observed_at: "then",
      execution_generation_id: "execution", daemon_generation_id: "4", runtime_generation_id: "birth" } } as any;
  const initial = { status: "ready", sourceMessageId: "source", detail, error: null } as any;
  let resource = initial;
  const slow = deferred<any>();
  const reading = readAgentInspectorWorkDetail({ entry, source: "source", generation: 4, previous: resource,
    read: () => slow.promise, isCurrent: () => true, write: next => { resource = next; } });
  assert.equal(resource.status, "refreshing");
  assert.equal(resource.detail.runtime_control, detail.runtime_control);
  const same = { entries: [entry], daemonGeneration: 4 } as any;
  assert.equal(invalidateAgentInspectorRuntimeControl(resource, same, "entry", "room"), resource);
  resource = invalidateAgentInspectorRuntimeControl(resource, { ...same, daemonGeneration: 5 }, "entry", "room");
  assert.equal(resource.detail.runtime_control, null);
  slow.resolve(detail);
  await reading;
  assert.equal(resource.status, "ready");
  for (const replacement of [{ ...entry, runtimeGenerationId: "new-birth" }, { ...entry, runtimeGenerationId: null }]) {
    const next = deferred<any>();
    const read = readAgentInspectorWorkDetail({ entry: replacement, source: "source", generation: 4, previous: initial,
      read: () => next.promise, isCurrent: () => true, write: value => { resource = value; } });
    assert.equal(resource.detail.runtime_control, null, "unmatched cached health is stripped at admission");
    next.resolve(detail);
    await read;
    assert.equal(resource.detail.runtime_control, null, "unmatched response health stays stripped");
  }
  await readAgentInspectorWorkDetail({ entry, source: "source", generation: 4, previous: initial,
    read: async () => { throw new Error("offline"); }, isCurrent: () => true, write: next => { resource = next; } });
  assert.equal(resource.status, "error");
  assert.equal(resource.detail.runtime_control, null);
  assert.equal(resource.detail.source_message.id, "source", "exact retained history survives the health failure");
});
