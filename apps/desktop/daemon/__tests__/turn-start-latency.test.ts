import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProviderActionPort } from "../provider-action-port.js";
import { SupervisedAgentDelivery } from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import {
  setTurnStartLatencyReporter,
  turnStartLatency,
  TurnStartLatency,
  type StartLatencyRecord,
  type TurnStartLatencySample,
} from "../turn-start-latency.js";

const WALL_START = Date.parse("2026-10-17T10:00:00.000Z");

function fakeClock() {
  let time = 0;
  return {
    clock: { now: () => time, wallNow: () => WALL_START + time },
    advance(ms: number) { time += ms; },
    wall(offsetMs = 0) { return new Date(WALL_START + time + offsetMs).toISOString(); },
  };
}

function recorder() {
  const records: StartLatencyRecord[] = [];
  return { records, report: (record: StartLatencyRecord) => { records.push(record); } };
}

function turnSamples(records: StartLatencyRecord[]): TurnStartLatencySample[] {
  return records.flatMap(record => record.event === "turn_start_latency" ? [record.sample] : []);
}

let messageNumber = 0;
/** A room message as the inbox stores it: a person's unless `automated`. */
const arrival = (inboxItemId = "inbox-1", overrides: { agentId?: string; busy?: boolean; liveHandle?: boolean; automated?: boolean; timestamp?: unknown } = {}) => {
  const timestamp = "timestamp" in overrides ? overrides.timestamp : new Date(WALL_START - 120).toISOString();
  return {
    agentId: overrides.agentId ?? "agent-1",
    item: {
      inbox_item_id: inboxItemId,
      source_message_id: `msg_${++messageNumber}`,
      source_message: overrides.automated
        ? { source: "agent", agent_identity: { key: "peer" }, timestamp }
        : { source: "browser", timestamp },
    },
    busy: overrides.busy ?? false,
    liveHandle: overrides.liveHandle ?? true,
  };
};

test("a warm turn is split into ordered phases ending at the adapter's first observed output", () => {
  const time = fakeClock();
  const { records, report } = recorder();
  const latency = new TurnStartLatency(time.clock);
  latency.setReporter(report);
  latency.received(arrival());
  time.advance(40);
  const trace = latency.begin("agent-1", "inbox-1", "codex")!;
  time.advance(300);
  trace.providerCalled();
  time.advance(5);
  trace.mark("provider_entry");
  time.advance(2);
  trace.mark("dispatch_checks");
  time.advance(150);
  trace.mark("workspace_begin");
  time.advance(3);
  trace.mark("dispatch_intent");
  time.advance(80);
  trace.mark("provider_start");
  time.advance(2_000);
  const observedAt = time.wall();
  time.advance(25);
  assert.equal(trace.observeOutput("reasoning", observedAt), true);
  assert.equal(trace.observeOutput("text", time.wall()), false, "only the first output counts");
  trace.providerEnded("reply");
  trace.end();

  assert.deepEqual(turnSamples(records), [{
    provider: "codex",
    source: "person",
    start: "warm",
    attempt: 1,
    busy_at_arrival: false,
    idle_ms: null,
    outcome: "first_output",
    first_output: "reasoning",
    elapsed_ms: 2_580,
    server_to_inbox_ms: 120,
    first_output_queue_ms: 25,
    phases_ms: {
      inbox_wait: 40, context: 300, provider_entry: 5, dispatch_checks: 2,
      workspace_begin: 150, dispatch_intent: 3, provider_start: 80, first_output: 2_000,
    },
    launch: null,
  }]);
});

test("without a reporter nothing is kept and no trace begins", () => {
  const time = fakeClock();
  const latency = new TurnStartLatency(time.clock);
  latency.received(arrival());
  assert.equal(latency.begin("agent-1", "inbox-1", "codex"), null);
  assert.equal(latency.beginLaunch("agent-1", "codex"), null);

  const { records, report } = recorder();
  latency.setReporter(report);
  assert.equal(latency.begin("agent-1", "inbox-1", "codex"), null, "an arrival seen before the reporter is not measured");
  latency.received(arrival());
  latency.setReporter(null);
  latency.setReporter(report);
  assert.equal(latency.begin("agent-1", "inbox-1", "codex"), null, "removing the reporter forgets waiting arrivals");
  assert.deepEqual(records, []);
});

test("output from before the provider call, or observed before it, belongs to another turn", () => {
  const time = fakeClock();
  const { records, report } = recorder();
  const latency = new TurnStartLatency(time.clock);
  latency.setReporter(report);
  latency.received(arrival());
  const trace = latency.begin("agent-1", "inbox-1", "claude-code")!;
  latency.observeOutput("agent-1", "item/agentMessage/delta", time.wall());
  time.advance(10);
  const beforeCall = time.wall();
  time.advance(10);
  trace.providerCalled();
  time.advance(10);
  latency.observeOutput("agent-1", "item/agentMessage/delta", beforeCall);
  latency.observeOutput("agent-1", "thread/read", time.wall());
  latency.observeOutput("agent-2", "item/agentMessage/delta", time.wall());
  assert.deepEqual(records, []);
  latency.observeOutput("agent-1", "item/toolCall/updated", time.wall());
  assert.equal(turnSamples(records)[0]?.first_output, "tool");
});

test("a display queue that lags the provider result still records the earlier observed output", () => {
  const time = fakeClock();
  const { records, report } = recorder();
  const latency = new TurnStartLatency(time.clock);
  latency.setReporter(report);
  latency.received(arrival());
  const trace = latency.begin("agent-1", "inbox-1", "claude-code")!;
  trace.providerCalled();
  time.advance(1_000);
  const observedAt = time.wall();
  time.advance(500);
  trace.providerEnded("reply");
  time.advance(700);
  latency.observeOutput("agent-1", "item/agentMessage/delta", observedAt);
  const [sample] = turnSamples(records);
  assert.equal(sample?.outcome, "first_output");
  assert.equal(sample?.elapsed_ms, 1_000);
  assert.equal(sample?.first_output_queue_ms, 1_200);

  latency.received(arrival("inbox-2"));
  const late = latency.begin("agent-1", "inbox-2", "claude-code")!;
  late.providerCalled();
  time.advance(100);
  late.providerEnded("reply");
  time.advance(100);
  latency.observeOutput("agent-1", "item/agentMessage/delta", time.wall());
  late.end();
  assert.equal(turnSamples(records)[1]?.outcome, "no_visible_output", "output observed after the result is not this turn's start");
});

test("turns without visible output are reported as silent answers or failures", () => {
  const time = fakeClock();
  const { records, report } = recorder();
  const latency = new TurnStartLatency(time.clock);
  latency.setReporter(report);
  for (const [id, outcome] of [["silent", "no_reply"], ["failed", "failed"], ["thrown", null]] as const) {
    latency.received(arrival(id));
    const trace = latency.begin("agent-1", id, "codex")!;
    trace.providerCalled();
    time.advance(900);
    if (outcome) trace.providerEnded(outcome);
    time.advance(400);
    trace.end();
  }
  assert.deepEqual(turnSamples(records).map(sample => [sample.outcome, sample.elapsed_ms, sample.phases_ms.turn_end]), [
    ["no_visible_output", 900, 900],
    ["failed", 900, 900],
    ["failed", 1_300, 1_300],
  ]);
});

test("an attempt that ends before its provider call is measured from the original arrival on retry", () => {
  const time = fakeClock();
  const { records, report } = recorder();
  const latency = new TurnStartLatency(time.clock);
  latency.setReporter(report);
  latency.received(arrival());
  time.advance(100);
  latency.begin("agent-1", "inbox-1", "codex")!.end();
  assert.deepEqual(records, []);
  time.advance(2_000);
  const retry = latency.begin("agent-1", "inbox-1", "codex")!;
  assert.ok(retry, "the arrival was restored");
  retry.providerCalled();
  time.advance(50);
  latency.observeOutput("agent-1", "item/agentMessage/delta", time.wall());
  assert.equal(turnSamples(records)[0]?.phases_ms.inbox_wait, 2_100);
  assert.equal(turnSamples(records)[0]?.attempt, 2, "the sample says its wait spans a retry");
  assert.equal(latency.begin("agent-1", "inbox-1", "codex"), null, "a measured arrival is not measured twice");
});

test("a launch that completes while a message waits makes that turn cold and carries its phases", () => {
  const time = fakeClock();
  const { records, report } = recorder();
  const latency = new TurnStartLatency(time.clock);
  latency.setReporter(report);
  const launch = latency.beginLaunch("agent-1", "claude-code")!;
  time.advance(30);
  launch.mark("prepare");
  latency.received(arrival("inbox-1", { liveHandle: false }));
  time.advance(500);
  launch.mark("slot_wait");
  time.advance(10);
  launch.mark("admission");
  time.advance(3_000);
  launch.mark("process");
  time.advance(9_000);
  launch.markProcessReturned();
  time.advance(40);
  launch.mark("install");
  launch.complete("resume");
  launch.complete("fresh");
  const trace = latency.begin("agent-1", "inbox-1", "claude-code")!;
  trace.providerCalled();
  time.advance(4_000);
  latency.observeOutput("agent-1", "item/agentMessage/delta", time.wall());

  const launchPhases = { prepare: 30, slot_wait: 500, admission: 10, process: 3_000, bootstrap: 9_000, install: 40 };
  assert.deepEqual(records[0], {
    event: "provider_launch_latency",
    sample: { provider: "claude-code", launch: "resume", elapsed_ms: 12_580, phases_ms: launchPhases },
  });
  trace.providerEnded("reply");
  trace.end();
  const [sample] = turnSamples(records);
  assert.equal(sample?.start, "cold");
  assert.deepEqual(sample?.launch, { launch: "resume", elapsed_ms: 12_580, phases_ms: launchPhases, waited_ms: 12_550 });
  assert.equal(sample?.elapsed_ms, 16_550);

  time.advance(60_000);
  latency.received(arrival("inbox-2"));
  const next = latency.begin("agent-1", "inbox-2", "claude-code")!;
  next.providerCalled();
  latency.observeOutput("agent-1", "item/agentMessage/delta", time.wall());
  assert.deepEqual([turnSamples(records)[1]?.start, turnSamples(records)[1]?.launch, turnSamples(records)[1]?.idle_ms],
    ["warm", null, 60_000], "only the first turn after a launch is its cold start");
});

test("after a restart the first turn is cold even when its message reaches the inbox after the launch", () => {
  const time = fakeClock();
  const { records, report } = recorder();
  const latency = new TurnStartLatency(time.clock);
  latency.setReporter(report);
  const launch = latency.beginLaunch("agent-1", "codex")!;
  time.advance(1_800);
  launch.markProcessReturned();
  launch.complete("resume");
  time.advance(200);
  latency.received(arrival());
  const trace = latency.begin("agent-1", "inbox-1", "codex")!;
  trace.providerCalled();
  time.advance(6_000);
  latency.observeOutput("agent-1", "item/agentMessage/delta", time.wall());
  const [sample] = turnSamples(records);
  assert.equal(sample?.start, "cold");
  assert.equal(sample?.launch?.waited_ms, 0);
  assert.equal(sample?.launch?.elapsed_ms, 1_800);
});

test("a launch without a native ready signal records its whole start as process", () => {
  const time = fakeClock();
  const { records, report } = recorder();
  const latency = new TurnStartLatency(time.clock);
  latency.setReporter(report);
  const launch = latency.beginLaunch("agent-1", "codex")!;
  launch.mark("prepare");
  launch.mark("slot_wait");
  launch.mark("admission");
  time.advance(2_500);
  launch.markProcessReturned();
  launch.mark("install");
  launch.complete("fresh");
  assert.deepEqual(records[0]?.sample.phases_ms, { prepare: 0, slot_wait: 0, admission: 0, process: 2_500, install: 0 });
});

test("Cursor turns are labelled as per-turn processes and a missing live handle as cold", () => {
  const time = fakeClock();
  const { records, report } = recorder();
  const latency = new TurnStartLatency(time.clock);
  latency.setReporter(report);
  for (const [id, provider, liveHandle] of [["cursor", "cursor", true], ["attach", "codex", false]] as const) {
    latency.received(arrival(id, { liveHandle, busy: true, automated: true, timestamp: "not a time" }));
    const trace = latency.begin("agent-1", id, provider)!;
    trace.providerCalled();
    latency.observeOutput("agent-1", "item/agentMessage/delta", "not a time");
  }
  assert.deepEqual(turnSamples(records).map(sample => [sample.start, sample.source, sample.busy_at_arrival,
    sample.server_to_inbox_ms, sample.first_output_queue_ms]), [
    ["per_turn_process", "automated", true, null, null],
    ["cold", "automated", true, null, null],
  ]);
});

test("a failing sink or clock never escapes, and waiting arrivals stay bounded", () => {
  const time = fakeClock();
  const latency = new TurnStartLatency(time.clock);
  latency.setReporter(() => { throw new Error("sink unavailable"); });
  latency.received(arrival());
  const trace = latency.begin("agent-1", "inbox-1", "codex")!;
  trace.providerCalled();
  assert.doesNotThrow(() => latency.observeOutput("agent-1", "item/agentMessage/delta", time.wall()));
  assert.doesNotThrow(() => trace.end());

  let broken = false;
  const failing = new TurnStartLatency({ now: () => { if (broken) throw new Error("clock"); return 0; }, wallNow: () => WALL_START });
  const { records, report } = recorder();
  failing.setReporter(report);
  failing.received(arrival());
  const failingTrace = failing.begin("agent-1", "inbox-1", "codex")!;
  broken = true;
  assert.doesNotThrow(() => failingTrace.providerCalled());
  assert.doesNotThrow(() => failingTrace.end());
  assert.doesNotThrow(() => failing.received(arrival("inbox-2")));
  assert.deepEqual(records, []);

  const bounded = new TurnStartLatency(time.clock);
  bounded.setReporter(() => {});
  for (let index = 0; index < 300; index += 1) bounded.received(arrival(`inbox-${index}`));
  assert.equal(bounded.begin("agent-1", "inbox-0", "codex"), null, "the oldest arrivals are dropped");
  assert.ok(bounded.begin("agent-1", "inbox-299", "codex"));
});

test("an untimed turn after a launch takes its cold start and sets the next turn's idle time", () => {
  const time = fakeClock();
  const { records, report } = recorder();
  const latency = new TurnStartLatency(time.clock);
  latency.setReporter(report);
  const launch = latency.beginLaunch("agent-1", "claude-code")!;
  time.advance(5_000);
  launch.markProcessReturned();
  launch.complete("fresh");
  latency.unmeasuredTurnStarted("agent-1");
  time.advance(3_000);
  latency.unmeasuredTurnEnded("agent-1");
  time.advance(7_000);
  latency.received(arrival());
  const trace = latency.begin("agent-1", "inbox-1", "claude-code")!;
  trace.providerCalled();
  latency.observeOutput("agent-1", "item/agentMessage/delta", time.wall());
  const [sample] = turnSamples(records);
  assert.deepEqual([sample?.start, sample?.launch, sample?.idle_ms], ["warm", null, 7_000]);
});

test("a relaunch during a turn is the next turn's cold start, and the turn takes no output after it", () => {
  const time = fakeClock();
  const { records, report } = recorder();
  const latency = new TurnStartLatency(time.clock);
  latency.setReporter(report);
  latency.received(arrival("inbox-1"));
  const crashed = latency.begin("agent-1", "inbox-1", "codex")!;
  crashed.providerCalled();
  time.advance(1_000);
  const relaunch = latency.beginLaunch("agent-1", "codex")!;
  time.advance(600);
  relaunch.markProcessReturned();
  relaunch.complete("resume");
  latency.observeOutput("agent-1", "item/agentMessage/delta", time.wall());
  crashed.providerEnded("failed");
  crashed.end();
  latency.received(arrival("inbox-2"));
  const next = latency.begin("agent-1", "inbox-2", "codex")!;
  next.providerCalled();
  time.advance(4_000);
  latency.observeOutput("agent-1", "item/agentMessage/delta", time.wall());
  assert.deepEqual(turnSamples(records).map(sample => [sample.outcome, sample.start, sample.launch?.launch ?? null]), [
    ["failed", "warm", null],
    ["first_output", "cold", "resume"],
  ]);
});

test("odd inbox rows, a throwing clock, and a removed reporter keep nothing and throw nothing", () => {
  const time = fakeClock();
  const { records, report } = recorder();
  const latency = new TurnStartLatency(time.clock);
  latency.setReporter(report);
  for (const item of [
    { inbox_item_id: "odd-1", source_message_id: 5 as unknown as string, source_message: null },
    { inbox_item_id: "odd-2", source_message_id: "msg_1", source_message: { get timestamp() { throw new Error("row"); } } },
  ]) assert.doesNotThrow(() => latency.received({ agentId: "agent-1", item, busy: false, liveHandle: true }));

  let broken = false;
  const failing = new TurnStartLatency({ now: () => { if (broken) throw new Error("clock"); return 0; }, wallNow: () => WALL_START });
  failing.setReporter(report);
  failing.received(arrival());
  broken = true;
  assert.equal(failing.begin("agent-1", "inbox-1", "codex"), null);

  latency.setReporter(null);
  latency.launchCompleted("agent-1", 0, { provider: "codex", launch: "fresh", elapsed_ms: 1, phases_ms: {} });
  latency.turnEnded("agent-1", 0);
  latency.unmeasuredTurnEnded("agent-1");
  latency.setReporter(report);
  latency.received(arrival());
  const trace = latency.begin("agent-1", "inbox-1", "codex")!;
  trace.providerCalled();
  latency.observeOutput("agent-1", "item/agentMessage/delta", time.wall());
  const [sample] = turnSamples(records);
  assert.deepEqual([sample?.launch, sample?.idle_ms], [null, null], "nothing was kept while no reporter was installed");
});

test("one agent's unclaimed arrivals cannot push out another agent's waiting message", () => {
  const time = fakeClock();
  const latency = new TurnStartLatency(time.clock);
  latency.setReporter(() => {});
  latency.received(arrival("other", { agentId: "agent-2" }));
  for (let index = 0; index < 70; index += 1) latency.received(arrival(`burst-${index}`));
  assert.ok(latency.begin("agent-2", "other", "codex"), "the other agent's message is still waiting");
  assert.equal(latency.begin("agent-1", "burst-5", "codex"), null, "this agent's oldest arrivals were dropped");
  assert.ok(latency.begin("agent-1", "burst-6", "codex"));
});

/**
 * Polls `messages` into a real inbox and delivers them with a fake provider.
 * Returns the samples once `expected` of them were reported.
 */
async function deliverRoomMessages(messages: Array<Record<string, unknown>>, expected: number, options: {
  beforePoll?: () => void;
  onTurn?: (sourceMessageId: string, agentId: string) => void;
  observeStartingWorkspace?: () => Promise<string>;
} = {}): Promise<TurnStartLatencySample[]> {
  const root = await mkdtemp(join(tmpdir(), "letagents-turn-start-latency-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const { records, report } = recorder();
  const agent = {
    agentId: "stone", roomId: "room", provider: "codex", deliveryMode: "daemon_inbox" as const, apiUrl: "https://letagents.test", agentSessionId: "session-1", bearer: "memory", executionGenerationId: "generation-1", daemonGeneration: 1,
    handle: { workAttemptId: "attempt", providerContinuationId: "thread", pid: 1, providerConnection: { kind: "codex_app_server" as const, url: "ws://127.0.0.1:1", pid: 1, processIdentity: "test-process-birth" }, observedState: "working" as const },
    workAttemptId: "attempt", providerContinuationId: "thread", providerConnection: { kind: "codex_app_server" as const, url: "ws://127.0.0.1:1", pid: 1, processIdentity: "test-process-birth" },
  };
  const port = {
    capabilities: async () => ({
      resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: false, survivesRestart: true,
      turnControl: "unsupported" as const, continuationRepair: "unsupported" as const,
    }),
    spawn: async () => { throw new Error("not used"); }, attach: async () => null, attachAction: async () => ({ state: "absent" as const }), resume: async () => { throw new Error("not used"); }, poke: async () => {}, stop: async () => ({ endedAt: "", exitCode: 0, signal: null, terminalCause: "stopped" as const, providerContinuationId: null }), onExit: async () => () => {},
    runRoomTurn: async (_handle, request, turnOptions) => {
      await turnOptions?.beforeNativeDispatch?.();
      await turnOptions?.checkpointTurnStarted?.(`native-${request.inboxItemId}`);
      options.onTurn?.(String((request.sourceMessage as { id?: string } | null)?.id), agent.agentId);
      return { turnId: `native-${request.inboxItemId}`, outcome: "no_reply" as const, text: null, evidence: "stream" as const };
    },
  } satisfies ProviderActionPort;
  let polls = 0;
  const delivery = new SupervisedAgentDelivery(store, port, {
    poll: async () => (polls++ === 0 ? { messages } : { messages: [] }),
    publish: async () => { throw new Error("no-reply delivery must not publish"); },
  }, async () => true, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  options.observeStartingWorkspace);
  setTurnStartLatencyReporter(report);
  try {
    options.beforePoll?.();
    await store.bootstrapCursor({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: null });
    await delivery.poll(agent);
    const deadline = Date.now() + 5_000;
    while (turnSamples(records).length < expected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    return turnSamples(records);
  } finally {
    setTurnStartLatencyReporter(null);
    await delivery.fenceAndDrain();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

const roomMessage = (id: string, extra: Record<string, unknown> = { source: "browser" }) => ({
  id, timestamp: new Date().toISOString(), activation: { for_current_agent: { decision: "activate" } }, ...extra,
});

test("a delivered room turn is timed from inbox commit to first output through the real delivery path", async () => {
  const order: string[] = [];
  const samples = await deliverRoomMessages([
    roomMessage("msg_1"),
    roomMessage("msg_2", { source: "agent", agent_identity: { key: "peer" } }),
  ], 2, {
    observeStartingWorkspace: async () => { order.push("workspace"); return "baseline"; },
    onTurn: (id, agentId) => {
      if (id !== "msg_1") return;
      order.push("output");
      // The stream coordinator does this when it projects a live-display event.
      turnStartLatency.observeOutput(agentId, "item/agentMessage/delta", new Date().toISOString());
    },
  });
  assert.deepEqual(samples.map(sample => [sample.provider, sample.source, sample.start, sample.outcome, sample.first_output]), [
    ["codex", "person", "warm", "first_output", "text"],
    ["codex", "automated", "warm", "no_visible_output", null],
  ]);
  assert.deepEqual(Object.keys(samples[0]!.phases_ms), [
    "inbox_wait", "context", "provider_entry", "dispatch_checks", "workspace_begin", "dispatch_intent", "provider_start", "turn_checkpoint", "first_output",
  ]);
  assert.deepEqual(Object.keys(samples[1]!.phases_ms).at(-1), "turn_end");
  assert.equal(samples[1]!.busy_at_arrival, false);
  assert.equal(typeof samples[0]!.server_to_inbox_ms, "number");
  assert.deepEqual(order, ["workspace", "output", "workspace"]);
});

test("through the real delivery path, an untimed first turn after a launch takes its cold start", async () => {
  // 65 arrivals: the per-agent limit drops the first, so its turn runs untimed.
  const messages = Array.from({ length: 65 }, (_, index) => roomMessage(`msg_${index + 1}`));
  const samples = await deliverRoomMessages(messages, 64, {
    beforePoll: () => {
      const launch = turnStartLatency.beginLaunch("stone", "codex")!;
      launch.markProcessReturned();
      launch.complete("resume");
    },
  });
  assert.equal(samples.length, 64);
  assert.deepEqual(samples.map(sample => sample.start).filter(start => start !== "warm"), [],
    "the untimed msg_1 turn ran on the launch, so no later turn is its cold start");
  assert.ok(samples.every(sample => sample.launch === null));
});

test("the daemon entrypoint writes start-up samples to their own file, created only by the first sample", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turn-start-latency-log-"));
  try {
    const lifecyclePath = join(directory, "daemon-lifecycle.jsonl");
    const turnPath = join(directory, "daemon-turn-latency.jsonl");
    for (const sample of [false, true]) {
      const script = `
        import { startDaemonLifecycleDiagnostics } from ${JSON.stringify(new URL("../lifecycle-log.ts", import.meta.url).href)};
        import { turnStartLatency } from ${JSON.stringify(new URL("../turn-start-latency.ts", import.meta.url).href)};
        startDaemonLifecycleDiagnostics(${JSON.stringify(lifecyclePath)});
        ${sample ? `
        const launch = turnStartLatency.beginLaunch("agent", "codex");
        launch.markProcessReturned();
        launch.complete("fresh");` : ""}
      `;
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: "ignore", timeout: 10_000 });
      assert.ifError(child.error);
      assert.equal(child.status, 0);
      assert.equal(existsSync(turnPath), sample, sample ? "the first sample creates the file" : "no sample, no file");
    }
    const lines = (await readFile(turnPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(lines.map(line => line.event), ["provider_launch_latency"]);
    assert.deepEqual(JSON.parse(lines[0].detail), { provider: "codex", launch: "fresh", elapsed_ms: 0, phases_ms: { process: 0 } });
    const lifecycle = (await readFile(lifecyclePath, "utf8")).trim().split("\n").map(line => JSON.parse(line).event);
    assert.ok(!lifecycle.includes("provider_launch_latency"), "process failures keep their own file");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
