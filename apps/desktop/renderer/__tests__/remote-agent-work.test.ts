import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer } from "vite";

import type { DesktopAgentPresence, DesktopManagedAgentSession } from "../../electron/ipc-types";
import { remoteAgentWorkIndicators, type ManagedAgentWorkIndicator } from "../src/domain/managed-agents";
import { mergeRoomResponseParticipants } from "../src/domain/room-response-participants";

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
  ], [], [], "room_1", [], NOW);
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
  ], [], [], "room_1", [], NOW);
  assert.deepEqual(rows.map(row => row.displayName), ["Long"]);
  assert.equal(rows[0]!.summary.length, 100);
  assert.doesNotMatch(rows[0]!.summary, /\n/);
});

test("the viewer's own agents keep their local rows: no remote row duplicates them", () => {
  const local = { agentKey: "Shannon/birch", agentSessionId: "session_birch" };
  const managed = { id: "managed_1", roomIdentifier: "room_1", agentSessionId: "session_cedar", agentKey: "desktop/codex/x",
    actorLabel: "Cedar | Shannon's agent | Codex", displayName: "Cedar" } as DesktopManagedAgentSession;
  const rows = remoteAgentWorkIndicators([
    presence("Birch"),
    presence("Birch", { agentSessionId: "session_birch_successor" }),
    presence("Cedar"),
    presence("Dogwood"),
    presence("Fir"),
    presence("Fir", { actorLabel: "Fir again" }),
  ], [local], [managed], "room_1", [{ agentKey: "SHANNON/dogwood", agentSessionId: null }], NOW);
  assert.deepEqual(rows.map(row => row.displayName), ["Fir"], "local entries, managed sessions and existing rows win; one row per agent");
});

test("remote rows follow the local rows in the strip and never replace one", () => {
  const localRow: ManagedAgentWorkIndicator = { id: "supervised_1", displayName: "Oak", summary: "Writing a response",
    startedAt: "2026-10-15T09:59:00.000Z", agentSessionId: "session_oak", agentKey: "EmmyMay/oak" };
  const remote = remoteAgentWorkIndicators([presence("Birch"), presence("Oak", { agentKey: "EmmyMay/oak", agentSessionId: "session_oak" })],
    [{ agentKey: "EmmyMay/oak", agentSessionId: "session_oak" }], [], "room_1", [], NOW);
  const merged = mergeRoomResponseParticipants([localRow], remote, []);
  assert.deepEqual(merged.map(row => [row.displayName, row.remote ?? false]), [["Oak", false], ["Birch", true]]);
});

test("the room shell adds remote rows after its local rows", () => {
  const shell = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/DesktopRoomShell.vue", import.meta.url)), "utf8");
  assert.match(shell, /\], \[\.\.\.pendingResponseParticipants\.value, [^\n]*\.\.\.remoteAgentWorkIndicators\(roomPresence\.value,\s*supervisorEntries\.value, roomManagedAgentSessions\.value, props\.room\.identifier\)\], props\.messages\)/);
});

test("the live strip shows a remote row as a label with the same look, marked data-remote, that opens nothing", async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const component = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-chat/RoomMessageViewport.vue")).default;
    const localRow: ManagedAgentWorkIndicator = { id: "supervised_1", displayName: "Oak", summary: "Writing a response",
      startedAt: "2026-10-15T09:59:00.000Z", agentSessionId: "session_oak", agentKey: "EmmyMay/oak" };
    const [remoteRow] = remoteAgentWorkIndicators([presence("Birch", { statusText: "Reading `app.ts`" })], [], [], "room_1", [], NOW);
    const rendered = await renderToString(createSSRApp(component, {
      active: true, activeSearchMessageId: null, activeThreadParentId: null, hasOlderMessages: false,
      loadingOlderMessages: false, messages: [], threadMessages: [], messageNamespace: "remote-rows",
      localAgentWork: [localRow, remoteRow], deliveryReceiptsByMessage: {}, hasFilteredRoomActivity: false,
      roomIdentifier: "room_1", githubActivityAvailable: false, roomLoading: false, searchQuery: "", taskReferenceIds: new Set(),
    }));
    const html = rendered.replace(/ data-v-[a-f0-9]+/g, "");
    const rows = [...html.matchAll(/<(button|div)[^>]*data-testid="room-local-agent-work"[^>]*>[\s\S]*?<\/\1>/g)].map(match => match[0]);
    assert.equal(rows.length, 2);
    assert.match(rows[0]!, /^<button/);
    assert.doesNotMatch(rows[0]!, /data-remote/);
    assert.match(rows[0]!, /aria-label="Oak: Writing a response\. Open live activity"/);
    const remote = rows[1]!;
    assert.match(remote, /^<div/, "not a button: this desktop has no live stream to open for it");
    assert.match(remote, /data-remote="true"/);
    assert.match(remote, /class="room-local-agent-work"/, "the same row, with the same look");
    assert.match(remote, /aria-label="Birch is working: Reading `app.ts`"/);
    assert.doesNotMatch(remote, /Open live activity/);
    assert.match(remote, /<strong>Birch<\/strong><span>·<\/span><span data-testid="room-local-agent-work-echo">Reading `app.ts`<\/span>/);
  } finally { await vite.close(); }
});

test("a remote row has no click handler and no hover or press look", () => {
  const viewport = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/room-chat/RoomMessageViewport.vue", import.meta.url)), "utf8");
  const remote = /<div\s+v-if="work\.remote"[\s\S]*?<\/div>/.exec(viewport)?.[0] ?? "";
  assert.ok(remote);
  assert.doesNotMatch(remote, /@click|open-agent|workIndicatorAgentTarget/);
  const css = readFileSync(fileURLToPath(new URL("../../../../shared/ui/room-agent-work.css", import.meta.url)), "utf8");
  assert.match(css, /\.room-local-agent-work\[data-remote\]\s*\{\s*cursor:\s*default;/);
  assert.match(css, /\.room-local-agent-work\[data-remote\]:hover\s*\{\s*background:\s*transparent;/);
});
