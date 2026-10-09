import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parse, compileScript } from "@vue/compiler-sfc";
import ts from "typescript";
import * as Vue from "vue";
import type { DesktopSupervisorManifestEntry, DesktopSupervisorServiceSnapshot, DesktopSupervisorStateSnapshot } from "../../electron/ipc-types";
import type { DesktopApi } from "../../electron/ipc-types/api";
import { projectServiceHealth, updateServiceEvents } from "../src/domain/service-health";

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
