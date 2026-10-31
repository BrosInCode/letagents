import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, ref } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer } from "vite";

import { sharedLiveState, sharedLiveViewForAgent } from "../src/domain/agent-inspector-shared-live";
import { liveSharingUnavailableReason } from "../src/domain/agent-live-sharing";
import { removeSnapshotLiveActivitySession, upsertSnapshotLiveActivitySession } from "../src/domain/desktop-room-snapshots";
import type { DesktopReasoningSession, DesktopRoomSnapshot } from "../../electron/ipc-types";

const AGENT_KEY = "owner/garden-signal";

function live(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    state: "working",
    started_at: "2026-10-18T10:00:00.000Z",
    ended_at: null,
    request_message_id: "msg_42",
    omitted_earlier: false,
    entries: [
      { kind: "note", id: "e1", text: "Checking **the failing test** first." },
      { kind: "action", id: "e2", headline: "Ran a shell command", status: "completed", tool: "shell", count: 1 },
      { kind: "action", id: "e3", headline: "Editing a file", status: "running", tool: "edit", count: 1 },
      { kind: "update", id: "e4", text: "Found it: a stale fixture." },
    ],
    ...overrides,
  };
}

function session(overrides: Partial<DesktopReasoningSession> = {}, snapshot: unknown = live()): DesktopReasoningSession {
  return {
    id: "rs_live", kind: "live", roomId: "room_a", actorLabel: "GardenSignal", agentKey: AGENT_KEY, taskId: null, title: null,
    status: "working", summary: "Editing a file", latestPayload: { summary: "Editing a file", live: snapshot },
    goal: null, checking: null, hypothesis: null, blocker: null, nextAction: null, milestone: null, confidence: null,
    closedAt: null, createdAt: "2026-10-18T10:00:00.000Z", updatedAt: "2026-10-18T10:00:09.000Z", ...overrides,
  };
}

test("a shared turn is found only for the exact agent, and only in the stored shape", () => {
  const view = sharedLiveViewForAgent(AGENT_KEY, [session()]);
  assert.equal(view?.sessionId, "rs_live");
  assert.equal(view?.currentStep, "Editing a file");
  assert.equal(view?.snapshot.entries.length, 4);
  assert.equal(sharedLiveViewForAgent("OWNER/Garden-Signal", [session()])?.sessionId, "rs_live", "keys compare as the server stores them");
  assert.equal(sharedLiveViewForAgent("owner/other", [session()]), null);
  assert.equal(sharedLiveViewForAgent(null, [session()]), null, "a label alone never selects a live view");
  assert.equal(sharedLiveViewForAgent(AGENT_KEY, [session({ kind: "reasoning" })]), null, "a reasoning session is not a live view");
  assert.equal(sharedLiveViewForAgent(AGENT_KEY, [session({ kind: undefined })]), null, "an older server's session is not a live view");
  assert.equal(sharedLiveViewForAgent(AGENT_KEY, [session({}, live({ entries: [{ kind: "action", id: "e1", headline: "Ran", status: "completed", tool: "shell", input: "ls" }] }))]), null,
    "a snapshot outside the stored shape is not shown");
  const newer = session({ id: "rs_newer", updatedAt: "2026-10-18T10:05:00.000Z" });
  assert.equal(sharedLiveViewForAgent(AGENT_KEY, [session(), newer])?.sessionId, "rs_newer");
});

test("a running shared turn is shown as running only while the agent's presence says it works", () => {
  const snapshot = sharedLiveViewForAgent(AGENT_KEY, [session()])!.snapshot;
  assert.equal(sharedLiveState(snapshot, "responding"), "working");
  assert.equal(sharedLiveState(snapshot, "online"), "stopped", "an idle agent whose last snapshot says working stopped updating it");
  assert.equal(sharedLiveState(snapshot, "unshared"), "stopped");
  assert.equal(sharedLiveState(snapshot, "needs_attention"), "attention", "waiting for an approval is not a stop");
  assert.equal(sharedLiveState(snapshot, "disconnected"), "stopped");
  assert.equal(sharedLiveState(snapshot, "stale"), "delayed");
  assert.equal(sharedLiveState({ ...snapshot, state: "ended", ended_at: "2026-10-18T10:05:00.000Z" }, "disconnected"), "finished");
});

test("the room snapshot keeps one shared turn per agent and drops it when removed", () => {
  const base = { liveActivitySessions: [] } as unknown as DesktopRoomSnapshot;
  const first = upsertSnapshotLiveActivitySession(base, session())!;
  const second = upsertSnapshotLiveActivitySession(first, session({ id: "rs_next" }))!;
  assert.deepEqual(second.liveActivitySessions.map((item) => item.id), ["rs_next"], "a newer turn of the agent replaces the older one");
  const other = upsertSnapshotLiveActivitySession(second, session({ id: "rs_other", agentKey: "owner/other" }))!;
  assert.deepEqual(other.liveActivitySessions.map((item) => item.id), ["rs_other", "rs_next"]);
  assert.equal(upsertSnapshotLiveActivitySession(other, session({ id: "rs_reasoning", kind: "reasoning" })), other, "reasoning sessions never enter the list");
  assert.deepEqual(removeSnapshotLiveActivitySession(other, "rs_next")!.liveActivitySessions.map((item) => item.id), ["rs_other"]);
});

test("the owner's switch explains when an agent cannot share", () => {
  assert.equal(liveSharingUnavailableReason({ enabled: false, availability: "available" }), null);
  assert.match(liveSharingUnavailableReason({ enabled: false, availability: "rental" })!, /rented agent/);
  assert.match(liveSharingUnavailableReason({ enabled: false, availability: "polling" })!, /fetches its own room messages/);
});

test("other members get a Live tab only while the owner shares, without any action inputs or outputs", async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const surface = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorParticipantSurface.vue")).default;
    const props = (overrides: Record<string, unknown> = {}) => ({
      compact: false,
      projection: { kind: "external", title: "GardenSignal", eyebrow: "Room participant", heading: "Externally managed agent", detail: "Managed elsewhere." },
      shared: { owner: false, ownerLabel: "Owner’s agent", provider: "Codex", signal: { state: "responding", label: "Working", detail: "Working in this room.", tone: "blue", moving: true } },
      roomIdentifier: "room_a",
      requestVersion: 1,
      reasoning: null,
      workspaceAgentKey: AGENT_KEY,
      ...overrides,
    });
    const without = await renderToString(createSSRApp(surface, props()));
    assert.doesNotMatch(without, /participant-live-tab/, "no Live tab while the owner does not share");
    assert.match(without, /participant-overview-tab/);

    const view = sharedLiveViewForAgent(AGENT_KEY, [session()]);
    const overview = await renderToString(createSSRApp(surface, props({ liveView: view })));
    assert.match(overview, /id="participant-live-tab"[^>]*>Live</);

    const html = await renderToString(createSSRApp(surface, props({ liveView: view, initialTab: "live" })));
    assert.match(html, /data-tab="live"/);
    assert.match(html, /In progress/);
    assert.match(html, /Editing a file/);
    assert.match(html, /<strong>the failing test<\/strong>/, "work notes keep the owner's timeline look");
    assert.match(html, /Work note/);
    assert.match(html, /Agent update/);
    assert.match(html, /Ran a shell command/);
    assert.match(html, /Current request/);
    assert.match(html, /class="agent-live-timeline"/);
    assert.match(html, /data-current="true"/, "the running action is emphasized as in the owner's view");
    assert.doesNotMatch(html, /<details|Input|Output|Full error/, "no expandable bodies for other members");

    const offline = await renderToString(createSSRApp(surface, props({
      liveView: view, initialTab: "live",
      shared: { owner: false, ownerLabel: "Owner’s agent", provider: "Codex", signal: { state: "disconnected", label: "Offline", detail: "", tone: "neutral", moving: false } },
    })));
    assert.match(offline, /Stopped updating/);
    assert.doesNotMatch(offline, /data-running="true"|data-current="true"/);

    const finished = sharedLiveViewForAgent(AGENT_KEY, [session({}, live({ state: "ended", ended_at: "2026-10-18T10:02:05.000Z", omitted_earlier: true }))]);
    const done = await renderToString(createSSRApp(surface, props({ liveView: finished, initialTab: "live" })));
    assert.match(done, /Finished/);
    assert.match(done, /Worked for 2m 5s/);
    assert.match(done, /Earlier updates from this request were left out/);
  } finally { await vite.close(); }
});

test("the owner's live sharing switch is a DesktopSwitch that starts off", async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const component = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorLiveSharing.vue")).default;
    const configuration = { entryId: "agent_1", daemonGeneration: 3, provider: "codex", configRevision: 2 };
    const render = (state: Record<string, unknown>, unsavedEdits = false) => renderToString(createSSRApp(component, {
      configuration, state, disabled: false, unsavedEdits,
    }));
    const off = await render({ enabled: false, availability: "available" });
    assert.match(off, /Share live activity with the room/);
    assert.match(off, /data-testid="agent-inspector-live-sharing"/);
    assert.match(off, /aria-checked="false"/);
    assert.match(off, /Anyone who can read this room sees a Live tab/);
    assert.match(off, /Notes and updates can quote code or text the agent read/);
    assert.match(off, /Commands, tool results and error details are not shared/);
    assert.match(off, /This room is public: anyone can read it, even without signing in/, "without a known audience, the note assumes the widest one");
    // The key must come from the same module copy that the server render uses.
    const { agentRoomAudienceKey } = await vite.ssrLoadModule("/renderer/src/domain/agent-home-harness.ts");
    for (const [audience, note] of [["public", /anyone can read it, even without signing in/], ["shared", /Other people are in this room/], ["private", /anyone who joins it later/]] as const) {
      const app = createSSRApp(component, { configuration, state: { enabled: false, availability: "available" }, disabled: false, unsavedEdits: false });
      app.provide(agentRoomAudienceKey, ref(audience));
      assert.match(await renderToString(app), note, audience);
    }
    assert.match(off, /Off\. Only you see this agent’s Live tab/);
    const on = await render({ enabled: true, availability: "available" });
    assert.match(on, /aria-checked="true"/);
    assert.match(on, /removes what the room can already see/);
    const polling = await render({ enabled: false, availability: "polling" });
    assert.doesNotMatch(polling, /role="switch"/);
    assert.match(polling, /fetches its own room messages/);
    const pollingOn = await render({ enabled: true, availability: "polling" });
    assert.match(pollingOn, /aria-checked="true"/, "a saved choice that can no longer be turned on can still be turned off");
    assert.doesNotMatch(pollingOn, /role="switch"[^>]*disabled/);
    const blocked = await render({ enabled: false, availability: "available" }, true);
    assert.match(blocked, /Save or reload your other changes before turning this on/);
    const busyOn = await renderToString(createSSRApp(component, { configuration, state: { enabled: true, availability: "available" }, disabled: true, unsavedEdits: true }));
    assert.doesNotMatch(busyOn, /role="switch"[^>]*disabled/, "turning sharing off is never blocked by other settings");
  } finally { await vite.close(); }
});
