import assert from "node:assert/strict";
import test from "node:test";

import type {
  DesktopRoomMessage,
  DesktopSupervisorLaunchProgress,
  DesktopSupervisorManifestEntry,
} from "../../electron/ipc-types";
import {
  agentStartupView,
  initialAgentStartupState,
  reduceAgentStartups,
  stageForLaunchPhase,
} from "../src/domain/agent-startup";
import { agentStartupRoomLabel } from "../src/components/desktop/content/room-chat/useAgentStartupRows";
import { buildMessageTimelineEntries } from "../src/components/desktop/content/room-chat/timeline";

const T0 = Date.parse("2026-10-26T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

function entry(overrides: Partial<DesktopSupervisorManifestEntry> = {}): DesktopSupervisorManifestEntry {
  return {
    id: "supervised_a",
    roomId: "github.com/BrosInCode/letagents",
    displayName: "Wren",
    provider: "claude-code",
    model: "Opus 5.5",
    charter: "",
    desiredState: "running",
    observedState: "starting",
    condition: "none",
    lastError: null,
    permissionProfileId: "ask_before_write",
    deliveryMode: "daemon_inbox",
    createdBy: "desktop",
    createdAt: at(0),
    workspacePath: "/tmp/w",
    workAttemptId: "attempt",
    agentSessionId: null,
    agentSessionBindingState: "none",
    bindingUpdatedAt: null,
    executionGenerationId: null,
    providerContinuationId: null,
    providerPid: null,
    workplaceLiveness: { state: "unknown", observedAt: null, detail: null },
    nativeLiveness: { state: "unknown", observedAt: null, detail: null },
    restartCount: 0,
    lastTerminal: null,
    activity: [],
    lastTurnControlSequence: 0,
    turnControl: null,
    ...overrides,
  };
}

/** Phases ended in order, from 200 ms after the entry was created; `open` is the phase still running. */
function progress(ended: Array<[DesktopSupervisorLaunchProgress["phases"][number]["phase"], number]>,
  open: DesktopSupervisorLaunchProgress["phases"][number]["phase"] | null,
  extra: Partial<DesktopSupervisorLaunchProgress> = {}): DesktopSupervisorLaunchProgress {
  let clock = 200;
  const phases: DesktopSupervisorLaunchProgress["phases"] = ended.map(([phase, ms]) => {
    const startedAt = at(clock);
    clock += ms;
    return { phase, startedAt, ms };
  });
  if (open) phases.push({ phase: open, startedAt: at(clock), ms: null });
  return {
    attempt: 1, startedAt: at(200), state: open ? "running" : "launched", current: open, phases,
    endedAt: open ? null : at(clock), firstOutputAt: null, failure: null, slotAhead: null, ...extra,
  };
}

const context = { roomLabel: "#letagents" };
const LAUNCHED: Array<[DesktopSupervisorLaunchProgress["phases"][number]["phase"], number]> =
  [["prepare", 300], ["slot_wait", 5], ["admission", 10], ["process", 1_200], ["bootstrap", 1_000], ["install", 40]];

test("daemon launch phases map to the plain stages per provider", () => {
  assert.equal(stageForLaunchPhase("prepare", "codex"), "prepare");
  assert.equal(stageForLaunchPhase("slot_wait", "codex"), "slot");
  assert.equal(stageForLaunchPhase("admission", "codex"), "process");
  assert.equal(stageForLaunchPhase("process", "codex"), "process");
  assert.equal(stageForLaunchPhase("bootstrap", "claude-code"), "bootstrap");
  assert.equal(stageForLaunchPhase("bootstrap", "codex"), "process", "only Claude's bootstrap is its own stage");
  assert.equal(stageForLaunchPhase("install", "open-model"), "join");
});

test("a Claude start shows its stages in plain words, one at a time", () => {
  const view = agentStartupView(entry({ launchProgress: progress([["prepare", 300], ["slot_wait", 5], ["admission", 10]], "process") }), context, T0 + 600);
  assert.deepEqual(view.stages.map((stage) => [stage.label, stage.state]), [
    ["Checking sign-in and settings", "done"],
    ["Starting Claude Code", "now"],
    ["Connecting to Opus 5.5", "pending"],
    ["Joining #letagents", "pending"],
    ["Reading the room", "pending"],
  ]);
  assert.equal(view.line, "Starting Claude Code…");
  assert.equal(view.status, "running");
  assert.equal(view.fraction, 1 / 5);
  assert.equal(view.stages[0]!.ms, 500, "preparing counts from the agent's creation");
  assert.equal(view.initials, "WR");
});

test("Codex and OpenCode have no bootstrap stage", () => {
  const codex = agentStartupView(entry({ provider: "codex", launchProgress: progress(LAUNCHED.filter(([phase]) => phase !== "install"), "install") }), context, T0);
  assert.deepEqual(codex.stages.map((stage) => stage.key), ["prepare", "process", "join", "context"]);
  assert.equal(codex.stages[1]!.ms, 2_210, "admission, process and any bootstrap count as the start");
  assert.equal(agentStartupView(entry({ provider: "open-model" }), context, T0).stages[1]!.label, "Starting OpenCode");
});

test("a slot wait shows only when it really waited, with the queue position", () => {
  const queued = agentStartupView(entry({ launchProgress: progress([["prepare", 300]], "slot_wait", { slotAhead: 2 }) }), context, T0 + 600);
  assert.equal(queued.stages[1]!.key, "slot");
  assert.equal(queued.line, "Waiting for a free start slot · 2 agents are starting first…");
  const one = agentStartupView(entry({ launchProgress: progress([["prepare", 300]], "slot_wait", { slotAhead: 1 }) }), context, T0 + 600);
  assert.match(one.line, /1 agent is starting first/);
  const instant = agentStartupView(entry({ launchProgress: progress(LAUNCHED.slice(0, 3), "process") }), context, T0 + 600);
  assert.equal(instant.stages.some((stage) => stage.key === "slot"), false);
  const waited = agentStartupView(entry({ launchProgress: progress([["prepare", 300], ["slot_wait", 2_400], ["admission", 5]], "process") }), context, T0 + 3_000);
  assert.equal(waited.stages[1]!.key, "slot");
  assert.equal(waited.stages[1]!.ms, 2_400);
});

test("joining waits for the room bind, reading the room waits for the first output, then it has joined", () => {
  const launched = progress(LAUNCHED, null);
  const joining = agentStartupView(entry({ launchProgress: launched }), context, T0 + 3_000);
  assert.equal(joining.line, "Joining #letagents…");
  const reading = agentStartupView(entry({ launchProgress: launched, readyReachedAt: at(3_500) }), context, T0 + 4_000);
  assert.equal(reading.line, "Reading the room…");
  const joined = agentStartupView(entry({ launchProgress: { ...launched, firstOutputAt: at(4_900) }, readyReachedAt: at(3_500) },
  ), { ...context, effort: "High" }, T0 + 6_000);
  assert.equal(joined.status, "joined");
  assert.equal(joined.line, "Joined in 4.9s · Opus 5.5 · High · Ask before writes");
  assert.equal(joined.fraction, 1);
  assert.equal(joined.timerEndMs, T0 + 4_900);
  assert.deepEqual(joined.stages.map((stage) => stage.ms), [500, 1_210, 1_000, 785, 1_400]);
});

test("an agent with nothing to say yet counts as joined a minute after it joined", () => {
  const launched = progress(LAUNCHED, null);
  const view = agentStartupView(entry({ launchProgress: launched, readyReachedAt: at(3_500) }), context, T0 + 3_500 + 60_000);
  assert.equal(view.status, "joined");
  assert.match(view.line, /^Joined in 3\.5s/);
  assert.equal(view.stages.at(-1)!.ms, null, "no first output was measured");
});

test("a daemon retry after a failure is timed on its own", () => {
  const retry = { ...progress([["prepare", 100]], "slot_wait"), attempt: 2, startedAt: at(9_000) };
  const view = agentStartupView(entry({ launchProgress: retry }), context, T0 + 9_500);
  assert.equal(view.timerStartMs, T0 + 9_000);
  assert.equal(view.status, "running");
});

test("scheduler internals never reach the failure line", () => {
  const view = agentStartupView(entry({ observedState: "failed", condition: "quarantined", lastError: "convergence scheduler failure: x" }), context, T0);
  assert.equal(view.line, "Could not start: The start did not finish.");
});

test("without daemon progress the stages follow the manifest milestones", () => {
  assert.equal(agentStartupView(entry({ workspacePath: null }), context, T0).line, "Checking sign-in and settings…");
  assert.equal(agentStartupView(entry({ providerPid: 42 }), context, T0).line, "Joining #letagents…");
  assert.equal(agentStartupView(entry({ providerPid: 42, readyReachedAt: at(4_000) }), context, T0 + 5_000).status, "joined");
});

test("a failed launch says why, marks its stage and offers its one fix", () => {
  const failed = progress([["prepare", 300], ["slot_wait", 5], ["admission", 10], ["process", 400]], null,
    { state: "failed", failure: { phase: "process", action: "sign_in" } });
  failed.phases.at(-1)!.phase = "process";
  const view = agentStartupView(entry({ launchProgress: { ...failed, phases: failed.phases.slice(0, 4) } }), context, T0 + 2_000);
  assert.equal(view.status, "failed");
  assert.equal(view.line, "Could not start: Claude Code is not signed in on this Mac.");
  assert.deepEqual(view.failure, { reason: "Claude Code is not signed in on this Mac.", action: "sign_in" });
  assert.deepEqual(view.stages.map((stage) => stage.state), ["done", "failed", "pending", "pending", "pending"]);
  const install = agentStartupView(entry({ provider: "codex", launchProgress: { ...failed, failure: { phase: "process", action: "install" } } }), context, T0);
  assert.equal(install.line, "Could not start: Codex could not be found on this Mac.");
});

test("a manifest failure without daemon progress still shows, with the safe detail", () => {
  const view = agentStartupView(entry({ observedState: "failed", lastError: "spawn claude ENOENT" }), context, T0);
  assert.equal(view.status, "failed");
  assert.equal(view.failure!.action, "install");
  const auth = agentStartupView(entry({ observedState: "recovering", condition: "auth_blocked", lastError: "worker bearer expired" }), context, T0);
  assert.equal(auth.failure!.action, "sign_in");
});

test("try again resumes from the failed stage until the daemon's next launch reports", () => {
  const failed = { ...progress([["prepare", 300]], null), state: "failed" as const, endedAt: at(600),
    failure: { phase: "slot_wait" as const, action: "retry" as const } };
  const retrying = agentStartupView(entry({ launchProgress: failed }), { ...context, retryRequestedAtMs: T0 + 1_000 }, T0 + 1_100);
  assert.equal(retrying.status, "running");
  assert.equal(retrying.stages[0]!.state, "done", "the finished stage stays finished");
  assert.equal(retrying.timerStartMs, T0 + 1_000, "the timer counts the new attempt");
  const later = agentStartupView(entry({ launchProgress: { ...failed, endedAt: at(2_000) } }), { ...context, retryRequestedAtMs: T0 + 1_000 }, T0 + 2_100);
  assert.equal(later.status, "failed", "a failure after the retry is news");
});

test("cancel shows at once and keeps the first message", () => {
  const view = agentStartupView(entry({ launchProgress: progress([], "prepare") }), { ...context, cancelRequested: true }, T0);
  assert.equal(view.status, "cancelled");
  assert.equal(view.line, "Cancelled. Your first message is still in the room.");
  assert.equal(agentStartupView(entry({ desiredState: "stopped" }), context, T0).status, "cancelled");
});

test("rows start for never-ready agents, keep their anchor and leave with their entry", () => {
  let state = initialAgentStartupState();
  state = reduceAgentStartups(state, { type: "anchor", entryId: "supervised_a", messageId: "m1", effort: "High" });
  const ready = entry({ id: "old", readyReachedAt: at(-1_000) });
  const stale = entry({ id: "stale", createdAt: at(-7 * 60 * 60_000) });
  state = reduceAgentStartups(state, { type: "entries", entries: [entry(), ready, stale], nowMs: T0 + 100 });
  assert.deepEqual(state.rows, [{ entryId: "supervised_a", anchorMessageId: "m1", effort: "High", retryRequestedAtMs: null, cancelRequested: false }]);
  assert.deepEqual(state.pendingAnchors, {});
  const same = reduceAgentStartups(state, { type: "entries", entries: [entry({ readyReachedAt: at(5_000) })], nowMs: T0 + 6_000 });
  assert.equal(same, state, "a row stays after the agent joined, and an unchanged update is the same state");
  state = reduceAgentStartups(state, { type: "retry", entryId: "supervised_a", nowMs: T0 + 9 });
  assert.equal(state.rows[0]!.retryRequestedAtMs, T0 + 9);
  state = reduceAgentStartups(state, { type: "retry", entryId: "supervised_a", nowMs: null });
  assert.equal(state.rows[0]!.retryRequestedAtMs, null);
  state = reduceAgentStartups(state, { type: "cancel", entryId: "supervised_a" });
  assert.equal(state.rows[0]!.cancelRequested, true);
  state = reduceAgentStartups(state, { type: "cancel_failed", entryId: "supervised_a" });
  assert.equal(state.rows[0]!.cancelRequested, false);
  state = reduceAgentStartups(state, { type: "entries", entries: [], nowMs: T0 });
  assert.deepEqual(state.rows, []);
  const running = entry({ id: "restarted-launch", createdAt: at(-9 * 60 * 60_000), launchProgress: progress([], "prepare") });
  assert.equal(reduceAgentStartups(state, { type: "entries", entries: [running], nowMs: T0 }).rows.length, 1,
    "an old saved agent that is starting for the first time now still gets a row");
});

test("the row sits under its first message, or at the agent's start time", () => {
  const message = (id: string, timestamp: string): DesktopRoomMessage => ({
    id, sender: "Emmy", text: id, attachments: [], agentPromptKind: null, source: "user", timestamp,
    actorLabel: null, agentIdentity: null, threadRootId: id, threadReplyToId: null, thread: null, replyTo: null,
  });
  const messages = [message("m1", at(0)), message("m2", at(0)), message("m3", at(5_000))];
  const anchored = buildMessageTimelineEntries(messages, [], [{ entryId: "a", anchorMessageId: "m1", startedAt: at(1_000) }]);
  assert.deepEqual(anchored.filter((item) => item.type !== "date").map((item) => item.id), ["m1", "agent-startup:a", "m2", "m3"],
    "right under its first message, even when the next message has the same time");
  const two = buildMessageTimelineEntries(messages, [], [
    { entryId: "a", anchorMessageId: "m1", startedAt: at(1_000) }, { entryId: "b", anchorMessageId: "m1", startedAt: at(1_000) }]);
  assert.deepEqual(two.filter((item) => item.type !== "date").map((item) => item.id), ["m1", "agent-startup:a", "agent-startup:b", "m2", "m3"]);
  const timed = buildMessageTimelineEntries(messages, [], [{ entryId: "a", anchorMessageId: "gone", startedAt: at(1_000) }]);
  assert.deepEqual(timed.filter((item) => item.type !== "date").map((item) => item.id), ["m1", "m2", "agent-startup:a", "m3"]);
  assert.equal(timed.find((item) => item.type === "agent-startup")?.type === "agent-startup"
    && timed.find((item) => item.type === "agent-startup")!.id, "agent-startup:a");
});

test("room labels read as #name", () => {
  assert.equal(agentStartupRoomLabel("github.com/BrosInCode/letagents"), "#letagents");
  assert.equal(agentStartupRoomLabel("focus_27"), "#focus_27");
});
