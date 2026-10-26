import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer } from "vite";

import type { DesktopAgentPresence } from "../../electron/ipc-types";
import { remoteAgentWorkIndicators, type ManagedAgentWorkIndicator } from "../src/domain/managed-agents";
import { mergeRoomResponseParticipants } from "../src/domain/room-response-participants";
import { roomShellSource } from "./room-shell-source";

const NOW = Date.parse("2026-10-15T10:00:00.000Z");

function presence(name: string, overrides: Partial<DesktopAgentPresence> = {}): DesktopAgentPresence {
  return {
    roomId: "room_1",
    actorLabel: `${name} | Shannon's agent | Codex`,
    agentKey: `Shannon/${name.toLowerCase()}`,
    agentInstanceId: null,
    agentSessionId: `session_${name.toLowerCase()}`,
    sessionKind: "worker",
    runtime: "codex",
    displayName: name,
    ownerLabel: "Shannon",
    ideLabel: "Codex",
    repoBranch: null,
    status: "working",
    statusText: "Using a tool",
    lastHeartbeatAt: new Date(NOW - 5_000).toISOString(),
    freshness: "active",
    activityState: "active",
    sourceFlags: ["presence"],
    livenessObservation: null,
    ...overrides,
  } as DesktopAgentPresence;
}

test("a working agent of another member gets a remote row with the line its daemon published", () => {
  const rows = remoteAgentWorkIndicators([
    presence("Birch", { statusText: "Thinking through the request" }),
    presence("Cedar", { statusText: null }),
    presence("Elm", { status: "reviewing", statusText: "Reviewing" }),
  ], [], [], NOW);
  assert.deepEqual(rows.map(row => [row.id, row.displayName, row.summary, row.remote]), [
    ["remote:shannon/birch", "Birch", "Thinking through the request", true],
    ["remote:shannon/cedar", "Cedar", "Working", true],
    ["remote:shannon/elm", "Elm", "Reviewing", true],
  ]);
  assert.equal(rows[0]!.agentSessionId, "session_birch", "the row names that exact agent");
  assert.equal(rows[0]!.startedAt, "", "presence tells when the agent was seen, not when its work started");
});

test("idle, blocked and stale agents get no remote row, and the text is one bounded line", () => {
  const rows = remoteAgentWorkIndicators([
    presence("Idle", { status: "idle", statusText: "Connected — listening" }),
    presence("Blocked", { status: "blocked" }),
    presence("Stale", { lastHeartbeatAt: new Date(NOW - 91_000).toISOString() }),
    presence("Nameless", { agentKey: null, agentSessionId: null }),
    presence("Long", { statusText: `Line one\nline two ${"x".repeat(200)}` }),
  ], [], [], NOW);
  assert.deepEqual(rows.map(row => row.displayName), ["Long"]);
  assert.equal(rows[0]!.summary.length, 100);
  assert.doesNotMatch(rows[0]!.summary, /\n/);
});

test("the viewer's own agents keep their local rows: no remote row duplicates them", () => {
  const local = { agentKey: "Shannon/birch", agentSessionId: "session_birch" };
  const rows = remoteAgentWorkIndicators([
    presence("Birch"),
    presence("Birch", { agentSessionId: "session_birch_successor" }),
    presence("Dogwood"),
    presence("Fir"),
    presence("Fir", { actorLabel: "Fir again" }),
  ], [local], [{ agentKey: "SHANNON/dogwood", agentSessionId: null }], NOW);
  assert.deepEqual(rows.map(row => row.displayName), ["Fir"], "local entries and existing rows win; one row per agent");
});

test("remote rows follow the local rows in the strip and never replace one", () => {
  const localRow: ManagedAgentWorkIndicator = { id: "supervised_1", displayName: "Oak", summary: "Writing a response",
    startedAt: "2026-10-15T09:59:00.000Z", agentSessionId: "session_oak", agentKey: "EmmyMay/oak" };
  const remote = remoteAgentWorkIndicators([presence("Birch"), presence("Oak", { agentKey: "EmmyMay/oak", agentSessionId: "session_oak" })],
    [{ agentKey: "EmmyMay/oak", agentSessionId: "session_oak" }], [], NOW);
  const merged = mergeRoomResponseParticipants([localRow], remote, []);
  assert.deepEqual(merged.map(row => [row.displayName, row.remote ?? false]), [["Oak", false], ["Birch", true]]);
});

test("the room shell adds remote rows after its local rows", () => {
  const shell = roomShellSource();
  assert.match(shell, /\], \[\.\.\.pendingResponseParticipants\.value, [^\n]*\.\.\.remoteAgentWorkIndicators\(props\.presence,\s*supervisorEntries\.value, \[\], workWindowNow\.value\)\], props\.messages\)/);
});

test("the activity line counts a remote agent with the local ones, and its row is marked data-remote and opens nothing", async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const component = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-chat/RoomMessageViewport.vue")).default;
    const localRow: ManagedAgentWorkIndicator = { id: "supervised_1", displayName: "Oak", summary: "Writing a response",
      startedAt: "2026-10-15T09:59:00.000Z", agentSessionId: "session_oak", agentKey: "EmmyMay/oak" };
    const [remoteRow] = remoteAgentWorkIndicators([presence("Birch", { statusText: "Reading `app.ts`" })], [], [], NOW);
    const render = async (localAgentWork: ManagedAgentWorkIndicator[]) => (await renderToString(createSSRApp(component, {
      active: true, activeSearchMessageId: null, activeThreadParentId: null, hasOlderMessages: false,
      loadingOlderMessages: false, messages: [], threadMessages: [], messageNamespace: "remote-rows",
      localAgentWork, deliveryReceiptsByMessage: {}, hasFilteredRoomActivity: false,
      roomIdentifier: "room_1", githubActivityAvailable: false, roomLoading: false, searchQuery: "", taskReferenceIds: new Set(),
    }))).replace(/ data-v-[a-f0-9]+/g, "");
    const both = await render([localRow, remoteRow!]);
    assert.match(both, /<strong>2 agents<\/strong> <span class="room-activity-shimmer">are working<\/span>/);
    assert.equal(both.match(/class="room-activity-anchor"/g)?.length, 2, "each agent, remote too, has a reply anchor");
    const remoteOnly = await render([remoteRow!]);
    assert.match(remoteOnly, /<strong>Birch<\/strong> <span class="room-activity-shimmer" data-testid="room-activity-live-echo">Reading `app.ts`<\/span>/);
  } finally { await vite.close(); }
});

test("a remote row has no Open button and no hover look", () => {
  const line = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/room-chat/RoomActivityLine.vue", import.meta.url)), "utf8");
  assert.match(line, /:data-remote="work\.remote \|\| undefined"/);
  // Open is the row's only way to the agent, and a remote agent has no live stream on this desktop.
  assert.match(line, /<button\s+v-if="!work\.remote"[\s\S]*?@click="openWork\(work\)"/);
  const css = readFileSync(fileURLToPath(new URL("../src/styles/room-activity-line.css", import.meta.url)), "utf8");
  assert.match(css, /\.room-activity-row\[data-remote\]:hover\s*\{\s*background:\s*transparent;/);
});
