import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parse, compileScript } from "@vue/compiler-sfc";
import ts from "typescript";
import * as Vue from "vue";
import type { DesktopSupervisorManifestEntry, DesktopSupervisorServiceSnapshot, DesktopSupervisorStateSnapshot } from "../../electron/ipc-types";
import type { DesktopApi } from "../../electron/ipc-types/api";
import { projectServiceHealth, updateServiceEvents } from "../src/domain/service-health";
import { useSettingsAgents } from "../src/composables/useSettingsAgents";
import type { DesktopAccountRoomEntry, DesktopRoomLiveMetadata } from "../../electron/ipc-types";
import { overrideSupervisedAgentsSupported } from "../src/domain/supervised-agents-support";

type Host = { children: Host[]; parent: Host | null; props: Record<string, any>; text: string };
const node = (text = ""): Host => ({ children: [], parent: null, props: {}, text });
const renderer = Vue.createRenderer<Host, Host>({
  createElement: () => node(), createText: node, createComment: node,
  setText: (n, text) => { n.text = text; }, setElementText: (n, text) => { n.text = text; },
  patchProp: (n, key, _old, value) => { n.props[key] = value; },
  insert(n, parent, anchor) { n.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; const old = parent.children.indexOf(n); if (old >= 0) parent.children.splice(old, 1); if (at < 0) parent.children.push(n); else parent.children.splice(at, 0, n); },
  remove(n) { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); },
  parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
});
function all(root: Host): Host[] { return [root, ...root.children.flatMap(all)]; }
const find = (root: Host, id: string) => all(root).find(n => n.props["data-testid"] === id);
async function flush() { for (let i = 0; i < 4; i++) { await Promise.resolve(); await Vue.nextTick(); } }

async function component(supervisor: Partial<DesktopApi["supervisor"]> | undefined) {
  const path = new URL("../src/components/desktop/settings/panes/SettingsDiagnosticsPane.vue", import.meta.url);
  const source = await readFile(path, "utf8");
  const descriptor = parse(source, { filename: path.pathname }).descriptor;
  const compiled = compileScript(descriptor, { id: "service-health-test", inlineTemplate: true });
  const modules: Record<string, any> = {
    vue: Vue,
    "@lucide/vue": Object.fromEntries(["ChevronRight"].map(name => [name, { render: () => null }])),
    "../../../../ipc/index.js": { desktopIpc: { supervisor } },
    "../../../../domain/service-health": { projectServiceHealth, updateServiceEvents },
    // Ticket connectors PR6: the Jev metrics section reads its own bridge; not part of this test.
    "./SettingsJevMetrics.vue": { default: { render: () => null } },
  };
  const javascript = ts.transpileModule(compiled.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/import\s+\{([\s\S]*?)\}\s+from\s+["']([^"']+)["'];?/g, (_all, names: string, name: string) => {
      assert.ok(modules[name], `unexpected component dependency ${name}`);
      return `const {${names.replace(/\s+as\s+/g, ": ")}} = modules[${JSON.stringify(name)}];`;
    })
    .replace(/import\s+(\w+)\s+from\s+["']([^"']+)["'];?/g, (_all, binding: string, name: string) => {
      assert.ok(modules[name], `unexpected component dependency ${name}`);
      return `const ${binding} = modules[${JSON.stringify(name)}].default;`;
    }).replace("export default", "return");
  return Function("modules", javascript)(modules);
}

const observedAt = "2026-10-09T14:00:00.000Z";
function agent(overrides: Partial<DesktopSupervisorManifestEntry> = {}): DesktopSupervisorManifestEntry {
  return {
    id: "agent-a", roomId: "room-a", displayName: "Maple", agentKey: "owner/maple", provider: "codex",
    model: "test-model", charter: "Help.", desiredState: "running", observedState: "working", condition: "none", lastError: null,
    permissionProfileId: null, deliveryMode: "daemon_inbox", createdBy: "owner", createdAt: observedAt, workspacePath: "/tmp/service-health-test",
    workAttemptId: "attempt-a", agentSessionId: "session-a", agentSessionBindingState: "active", bindingUpdatedAt: observedAt,
    executionGenerationId: "generation-a", providerContinuationId: "continuation-a", providerPid: 123,
    workplaceLiveness: { state: "healthy", observedAt, detail: null }, nativeLiveness: { state: "healthy", observedAt, detail: null },
    restartCount: 0, lastTerminal: null, activity: [],
    roomAgentState: {
      connection: { state: "connected", observedAt, detail: null }, ingress: { state: "observing", observedAt, detail: null },
      inbox: { state: "empty", pendingCount: 0, blockedByMessageId: null, detail: null },
      turn: { state: "idle", inboxItemId: null, sourceMessageId: null, providerTurnId: null, detail: null },
      task: { state: "none", taskId: null, title: null },
    }, deliveryReceipts: [], lastTurnControlSequence: 0, turnControl: null, ...overrides,
  };
}
function snapshot(entries = [agent()], generation = 1, sequence = 1): DesktopSupervisorServiceSnapshot {
  return {
    observedAt, state: { entries, daemonGeneration: generation, sequence },
    status: {
      healthy: true, protocolVersion: 1, implementationVersion: `test-v${generation}`, generation, pid: 123, startedAt: observedAt,
      recoveryDiagnostics: null, capabilities: { roomDeliveryRetry: true, providerContinuationRepair: true, roomDeliverySkip: true,
        agentInspectorDetail: true, agentInspectorSettings: true, agentRoomMove: true, agentLifecycle: true, agentStateSubscription: true },
    },
  };
}
const text = (root: Host) => all(root).map(n => n.text).join(" ");
async function mount(supervisor?: Partial<DesktopApi["supervisor"]>, props: Record<string, unknown> = {}) {
  const root = node(); const pane = await component(supervisor);
  const app = renderer.createApp(pane, props);
  const vm = app.mount(root) as unknown as { refresh(): Promise<void>; busy: boolean };
  return { root, app, vm };
}

test("Health shows the service, all rooms, approval-first rows and exact inspector targets", async () => {
  const opened: unknown[] = [];
  const mounted = await mount({
    getServiceSnapshot: async () => snapshot([agent(), agent({ id: "agent-b", roomId: "room-b", displayName: "Birch", desiredState: "paused", observedState: "stopped" })]),
    listHostApprovals: async room => ({ available: true, error: null, approvals: room === "room-b" ? [{
      id: "approval-b", requestKey: "request-b", status: "pending", detail: null, retryDecision: null, dismissKey: null,
      presentation: { agentId: "agent-b", displayName: "Birch", provider: "codex", title: "Run a command", details: "pwd", denyScope: "request" },
    }] : [] }),
  }, { onOpenAgent: (intent: unknown) => opened.push(intent), rooms: [{ roomIdentifier: "room-a", displayName: "Main room", focusRooms: [{ roomIdentifier: "room-b", displayName: "Design room" }] }] });
  try {
    await flush();
    assert.match(text(mounted.root), /test-v1/);
    assert.match(text(mounted.root), /Main room/); assert.match(text(mounted.root), /Design room/);
    const rows = all(mounted.root).filter(n => String(n.props["data-testid"] ?? "").startsWith("service-agent-"));
    assert.equal(rows.length, 2); assert.equal(rows[0].props["data-testid"], "service-agent-agent-b");
    assert.match(text(rows[0]), /1 approval waiting/);
    rows[0].props.onClick();
    assert.deepEqual(opened, [{ roomIdentifier: "room-b", agentEntryId: "agent-b" }]);
    assert.ok(find(mounted.root, "service-counts"));
    assert.match(text(mounted.root), /Service start and changes observed while this page is open/);
  } finally { mounted.app.unmount(); }
});

test("unavailable service, missing bridge and failed reads never claim an empty fleet", async () => {
  for (const bridge of [undefined, { getServiceSnapshot: async () => ({ status: null, state: null, observedAt }) },
    { getServiceSnapshot: async () => { throw new Error("private internal path"); } }]) {
    const mounted = await mount(bridge);
    try {
      await flush();
      assert.ok(find(mounted.root, "service-agents-unavailable"));
      assert.equal(find(mounted.root, "service-counts"), undefined);
      assert.equal(find(mounted.root, "service-agents-empty"), undefined);
      assert.doesNotMatch(text(mounted.root), /private internal path/);
    } finally { mounted.app.unmount(); }
  }
  const empty = await mount({ getServiceSnapshot: async () => snapshot([]) });
  try { await flush(); assert.ok(find(empty.root, "service-agents-empty")); }
  finally { empty.app.unmount(); }
});

test("stream updates cannot be rolled back by an older read; restart triggers a fresh read and unmount unsubscribes", async () => {
  let push!: (value: DesktopSupervisorStateSnapshot) => void;
  let resolve!: (value: DesktopSupervisorServiceSnapshot) => void;
  let stops = 0; let reads = 0;
  const mounted = await mount({
    getServiceSnapshot: () => { reads++; return new Promise(done => { resolve = done; }); },
    onState: callback => { push = callback; return () => { stops++; }; },
  });
  try {
    const newer = snapshot([agent({ displayName: "Newest name" })], 1, 8);
    push(newer.state!); resolve(snapshot()); await flush();
    assert.match(text(mounted.root), /Newest name/);
    push(snapshot([agent({ displayName: "Stale name" })], 1, 7).state!); await flush();
    assert.doesNotMatch(text(mounted.root), /Stale name/);
    push(snapshot([agent({ displayName: "After restart" })], 2).state!); await flush();
    assert.equal(reads, 2); assert.match(text(mounted.root), /service restarted/i);
    resolve(snapshot([agent({ displayName: "After restart" })], 2)); await flush();
    assert.match(text(mounted.root), /test-v2/); assert.match(text(mounted.root), /After restart/);
    assert.doesNotMatch(text(mounted.root), /test-v1/);
  } finally { mounted.app.unmount(); }
  assert.equal(stops, 1);
  push(snapshot([], 3).state!); await flush(); assert.equal(reads, 2);
});

test("maintenance and unavailable fleet reads stay unknown through stream pushes until a supported read", async () => {
  for (const maintenance of [true, false]) {
    let push!: (value: DesktopSupervisorStateSnapshot) => void;
    let current = snapshot();
    const mounted = await mount({
      getServiceSnapshot: async () => current,
      onState: callback => { push = callback; return () => {}; },
    });
    try {
      await flush();
      assert.ok(find(mounted.root, "service-counts"));
      assert.match(text(mounted.root), /Maple/);
      current = snapshot();
      current.state = null;
      if (maintenance) current.status!.maintenanceHoldId = "test-maintenance";
      else current.status!.capabilities.agentStateSubscription = false;
      await mounted.vm.refresh(); await flush();
      const assertUnavailable = () => {
        assert.ok(find(mounted.root, "service-agents-unavailable"));
        assert.equal(find(mounted.root, "service-counts"), undefined);
        assert.equal(find(mounted.root, "service-agents-empty"), undefined);
        assert.equal(find(mounted.root, "service-recovery"), undefined);
        assert.doesNotMatch(text(mounted.root), /Maple|During hold/);
      };
      assertUnavailable();
      push(snapshot([agent({ displayName: "During hold" })], 1, 2).state!);
      await flush(); assertUnavailable();
      current = snapshot([agent({ displayName: "After supported read" })], 1, 3);
      await mounted.vm.refresh(); await flush();
      assert.ok(find(mounted.root, "service-counts"));
      assert.match(text(mounted.root), /After supported read/);
      push(snapshot([agent({ displayName: "Live update" })], 1, 4).state!);
      await flush(); assert.match(text(mounted.root), /Live update/);
    } finally { mounted.app.unmount(); }
  }
});

test("a restart that overtakes the initial read schedules a fresh read immediately", async () => {
  let push!: (value: DesktopSupervisorStateSnapshot) => void;
  const resolvers: ((value: DesktopSupervisorServiceSnapshot) => void)[] = [];
  const mounted = await mount({
    getServiceSnapshot: () => new Promise(done => { resolvers.push(done); }),
    onState: callback => { push = callback; return () => {}; },
  });
  try {
    push(snapshot([], 2).state!); resolvers[0](snapshot()); await flush();
    assert.equal(resolvers.length, 2);
    assert.doesNotMatch(text(mounted.root), /test-v1/);
    resolvers[1](snapshot([], 2)); await flush(); assert.match(text(mounted.root), /test-v2/);
  } finally { mounted.app.unmount(); }
});

test("approval failures stay unknown and periodic read checks stop when the page closes", async () => {
  const set = globalThis.setInterval; const clear = globalThis.clearInterval;
  let tick!: () => void; let cancelled = false; let readCount = 0;
  globalThis.setInterval = ((callback: () => void, ms: number) => { assert.equal(ms, 15_000); tick = callback; return 42; }) as any;
  globalThis.clearInterval = (() => { cancelled = true; }) as any;
  let mounted: Awaited<ReturnType<typeof mount>> | undefined;
  try {
    mounted = await mount({
      getServiceSnapshot: async () => { readCount++; return snapshot(); },
      listHostApprovals: async () => ({ available: false, approvals: [], error: "unavailable" }),
    });
    await flush(); assert.match(text(mounted.root), /Approvals unavailable/); assert.doesNotMatch(text(mounted.root), /0 approvals waiting/);
    tick(); await flush(); assert.equal(readCount, 2);
    mounted.app.unmount(); mounted = undefined;
    assert.equal(cancelled, true); tick(); await flush(); assert.equal(readCount, 2);
  } finally { mounted?.app.unmount(); globalThis.setInterval = set; globalThis.clearInterval = clear; }
});

function liveMetadata(): DesktopRoomLiveMetadata {
  return { roomIdentifier: "room-a", participants: [{ participantKey: "remote", kind: "agent", displayName: "Remote agent",
    actorLabel: "remote", agentKey: "other/remote", ideLabel: "Cursor", hiddenAt: null, activityState: "active" }], presence: [],
    sourceStates: { participants: { status: "ready" }, presence: { status: "ready" } } } as unknown as DesktopRoomLiveMetadata;
}

async function mountAgents(
  supervisor: Partial<DesktopApi["supervisor"]>,
  readMetadata: (roomIdentifier: string, options?: unknown) => Promise<DesktopRoomLiveMetadata> = async () => liveMetadata(),
  archiveAgents?: DesktopApi["room"]["archiveAgents"],
) {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const listeners = new Map<string, unknown>();
  Object.assign(globalThis, {
    window: { letagentsDesktop: { supervisor, room: { getLiveMetadata: readMetadata, archiveAgents }, workers: { listAgentProviders: async () => [] } } },
    document: { visibilityState: "visible", addEventListener: (name: string, fn: unknown) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) },
  });
  let agents!: ReturnType<typeof useSettingsAgents>;
  const rooms = Vue.ref([{ roomIdentifier: "room-a", name: "Main", displayName: "Main", focusRooms: [], archived: false, role: "admin" }] as DesktopAccountRoomEntry[]);
  const app = renderer.createApp({ setup() { agents = useSettingsAgents(() => rooms.value); return () => null; } });
  app.mount(node());
  return { agents, rooms, listeners, close() { app.unmount(); Object.assign(globalThis, { window: originalWindow, document: originalDocument }); } };
}

test("Agents roster keeps newer live state, retains stale rooms, retries and releases its subscription", async () => {
  let push!: (state: DesktopSupervisorStateSnapshot) => void;
  let resolve!: (value: DesktopSupervisorServiceSnapshot) => void;
  let stops = 0;
  let failMetadata = false;
  let next: DesktopSupervisorServiceSnapshot | null = null;
  const mounted = await mountAgents({
    getServiceSnapshot: () => next ? Promise.resolve(next) : new Promise(done => { resolve = done; }),
    onState: callback => { push = callback; return () => { stops++; }; },
    listHostApprovals: async () => ({ available: true, error: null, approvals: [] }),
  }, async () => { if (failMetadata) throw new Error("offline"); return liveMetadata(); });
  try {
    push(snapshot([agent({ displayName: "Newer live name" })], 1, 8).state!);
    next = snapshot(); resolve(next); await flush(); await flush();
    assert.ok(mounted.agents.rows.value.some(row => row.name === "Newer live name"));
    assert.ok(mounted.agents.rows.value.some(row => row.name === "Remote agent" && row.external));
    push(snapshot([agent({ displayName: "Outdated name" })], 1, 7).state!); await flush();
    assert.ok(!mounted.agents.rows.value.some(row => row.name === "Outdated name"));
    failMetadata = true;
    next = { ...snapshot(), status: null, state: null };
    await mounted.agents.refresh(); await flush();
    assert.equal(mounted.agents.rows.value.length, 2, "a failure preserves known rows");
    assert.ok(mounted.agents.rows.value.every(row => row.stale));
    assert.ok(mounted.agents.errors.value.some(error => /Could not refresh 1 room/.test(error)));
    failMetadata = false; next = snapshot([agent()], 2);
    await mounted.agents.refresh(); await flush();
    assert.deepEqual(mounted.agents.errors.value, []);
    assert.ok(mounted.agents.rows.value.every(row => !row.stale));
    mounted.rooms.value = []; await flush(); await flush();
    assert.equal(mounted.agents.rows.value.length, 0, "leaving a room removes its rows");
  } finally { mounted.close(); }
  assert.equal(stops, 1);
  assert.equal(mounted.listeners.size, 0);
});

test("Agents roster still shows external room agents on hosts without managed agent support", async () => {
  overrideSupervisedAgentsSupported(false);
  let reads = 0;
  const mounted = await mountAgents({ getServiceSnapshot: async () => { reads++; return snapshot(); } });
  try {
    await flush(); await flush();
    assert.equal(reads, 0);
    assert.equal(mounted.agents.rows.value.length, 1);
    assert.equal(mounted.agents.rows.value[0]!.external, true);
    assert.deepEqual(mounted.agents.errors.value, []);
  } finally { mounted.close(); overrideSupervisedAgentsSupported(true); }
});

test("the Agents roster signs approval reads only for rooms hosting a local agent and refreshes a minute apart", async () => {
  const set = globalThis.setInterval; const clear = globalThis.clearInterval;
  let intervalMs = 0;
  globalThis.setInterval = ((_callback: () => void, ms: number) => { intervalMs = ms; return 7; }) as any;
  globalThis.clearInterval = (() => {}) as any;
  const approvalReads: string[] = [];
  const metadataReads: Array<{ roomIdentifier: string; options: unknown }> = [];
  let withLocalAgent = false;
  let mounted: Awaited<ReturnType<typeof mountAgents>> | undefined;
  try {
    mounted = await mountAgents({
      getServiceSnapshot: async () => (withLocalAgent ? snapshot([agent()], 1) : snapshot([], 1)),
      onState: () => () => {},
      listHostApprovals: async (roomIdentifier: string) => {
        approvalReads.push(roomIdentifier);
        return { available: true, error: null, approvals: [] };
      },
    }, async (roomIdentifier, options) => { metadataReads.push({ roomIdentifier, options }); return liveMetadata(); });
    await flush(); await flush();
    // An agent-free room must not cost a signed daemon read every round.
    assert.deepEqual(approvalReads, []);
    withLocalAgent = true;
    await mounted.agents.refresh(); await flush();
    assert.deepEqual(approvalReads, ["room-a"]);
    // The roster is the only clocked read left, and it is no longer 15s.
    assert.equal(intervalMs, 60_000);
    // The roster uses only participants and presence, so it asks for only those.
    assert.ok(metadataReads.length >= 2);
    assert.ok(metadataReads.every(read => read.roomIdentifier === "room-a"));
    assert.ok(metadataReads.every(read => JSON.stringify(read.options) === JSON.stringify({ include: ["participants", "presence"] })));
  } finally { mounted?.close(); globalThis.setInterval = set; globalThis.clearInterval = clear; }
});

test("archive targets exact offline rows, preserves unrelated rows and reports partial room failures", async () => {
  const old = { ...liveMetadata().participants[0], participantKey: "old", displayName: "Old", activityState: "offline" as const };
  const remaining = new Map([['room-a', [old, { ...old, participantKey: "keep", displayName: "Keep" }]], ['room-b', [old]]]);
  const calls: unknown[] = [];
  const mounted = await mountAgents({ getServiceSnapshot: async () => snapshot([]) }, async room => ({
    ...liveMetadata(), roomIdentifier: room, participants: remaining.get(room)!,
  }), async (room, keys) => {
    calls.push([room, keys]);
    if (room === 'room-b') throw Error('Forbidden');
    remaining.set(room, remaining.get(room)!.filter(p => !keys.includes(p.participantKey)));
    return { archivedParticipantKeys: keys, skippedParticipantKeys: [] };
  });
  try {
    mounted.rooms.value.push({ ...mounted.rooms.value[0], roomIdentifier: 'room-b', displayName: 'Second' });
    await flush(); await flush(); await mounted.agents.refresh();
    await mounted.agents.archiveAgents(['room-a:old', 'room-b:old']);
    await flush(); await flush();
    assert.deepEqual(calls, [['room-a', ['old']], ['room-b', ['old']]]);
    assert.deepEqual(mounted.agents.rows.value.map(row => row.id).sort(), ['room-a:keep', 'room-b:old']);
    assert.match(mounted.agents.archiveFeedback.value!, /1 agent archived/);
    assert.match(mounted.agents.archiveError.value!, /Second/);
    assert.equal(mounted.agents.archiveBusy.value, false);
  } finally { mounted.close(); }
});

test("archive rechecks current eligibility and reports a reconnect without hiding the agent", async () => {
  const old = { ...liveMetadata().participants[0], activityState: 'offline' as const };
  let calls = 0;
  const mounted = await mountAgents({ getServiceSnapshot: async () => snapshot([]) }, async () => ({ ...liveMetadata(), participants: [old] }), async () => {
    calls++;
    return { archivedParticipantKeys: [], skippedParticipantKeys: ['remote'] };
  });
  try {
    await flush(); await flush();
    await mounted.agents.archiveAgents(['room-a:remote']);
    assert.equal(calls, 1);
    assert.equal(mounted.agents.rows.value.length, 1);
    assert.match(mounted.agents.archiveFeedback.value!, /1 agent was skipped/);
    mounted.rooms.value[0].role = 'participant'; await flush(); await flush();
    await mounted.agents.archiveAgents(['room-a:remote']);
    assert.equal(calls, 1, 'lost room-admin access is rechecked before dispatch');
  } finally { mounted.close(); }
});
