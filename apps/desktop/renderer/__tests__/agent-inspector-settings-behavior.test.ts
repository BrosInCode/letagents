import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse, compileScript, compileTemplate } from "@vue/compiler-sfc";
import * as Vue from "vue";
import { createRenderer, nextTick, ssrContextKey, type App } from "vue";
import { createServer, transformWithEsbuild, type ViteDevServer } from "vite";
import type { AgentInspectorProjection } from "../src/domain/agent-inspector";
import type { AgentInspectorConfigurationResource, AgentInspectorRoomMoveResource } from "../src/domain/agent-inspector-settings";

interface HostNode {
  type: string;
  text: string;
  props: Record<string, unknown>;
  children: HostNode[];
  parent: HostNode | null;
  focusCount: number;
  value: unknown;
  options: unknown[];
  classList: { add: (...names: string[]) => void; remove: (...names: string[]) => void; contains: (name: string) => boolean };
  ownerDocument: typeof testDocument;
  offsetHeight: number;
  focus: () => void;
  contains: (candidate: unknown) => boolean;
  closest: (selector: string) => HostNode | null;
  getBoundingClientRect: () => { width: number };
  querySelector: (selector: string) => HostNode | null;
  querySelectorAll: (selector: string) => HostNode[];
  addEventListener: (name: string, listener: EventListener) => void;
  removeEventListener: (name: string, listener: EventListener) => void;
}

const documentListeners = new Map<string, Set<EventListener>>();
const testDocument = {
  activeElement: null as HostNode | null,
  body: null as unknown as HostNode,
  documentElement: null as unknown as HostNode,
  querySelector: (_selector: string) => null as HostNode | null,
  addEventListener(name: string, listener: EventListener) {
    const listeners = documentListeners.get(name) ?? new Set<EventListener>();
    listeners.add(listener);
    documentListeners.set(name, listeners);
  },
  removeEventListener(name: string, listener: EventListener) {
    documentListeners.get(name)?.delete(listener);
  },
};
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const testWindow = {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  getComputedStyle: () => ({
    transitionDelay: "",
    transitionDuration: "",
    animationDelay: "",
    animationDuration: "",
    transitionProperty: "",
  }),
};
Object.assign(globalThis, {
  document: testDocument,
  window: testWindow,
  requestAnimationFrame: (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  },
});

function descendants(node: HostNode): HostNode[] {
  return [node, ...node.children.flatMap(descendants)];
}

function matches(node: HostNode, selector: string): boolean {
  if (selector === "button:not([disabled])") return node.type === "button" && !node.props.disabled;
  if (selector === "button") return node.type === "button";
  if (selector === '[role="menu"]') return node.props.role === "menu";
  return false;
}

function hostNode(type: string, text = ""): HostNode {
  const listeners = new Map<string, EventListener>();
  const classes = new Set<string>();
  const node = {
    type,
    text,
    props: {},
    children: [],
    parent: null,
    focusCount: 0,
    value: "",
    options: [],
    classList: {
      add: (...names: string[]) => names.forEach((name) => classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
      contains: (name: string) => classes.has(name),
    },
    ownerDocument: testDocument,
    offsetHeight: 0,
    focus() {
      node.focusCount += 1;
      testDocument.activeElement = node;
    },
    contains(candidate: unknown) {
      return descendants(node).includes(candidate as HostNode);
    },
    closest(selector: string) {
      let candidate: HostNode | null = node;
      while (candidate) {
        if (matches(candidate, selector)) return candidate;
        candidate = candidate.parent;
      }
      return null;
    },
    getBoundingClientRect() {
      return { width: 800 };
    },
    querySelector(selector: string) {
      return descendants(node).find((candidate) => candidate !== node && matches(candidate, selector)) ?? null;
    },
    querySelectorAll(selector: string) {
      return descendants(node).filter((candidate) => candidate !== node && matches(candidate, selector));
    },
    addEventListener(name: string, listener: EventListener) {
      listeners.set(name, listener);
    },
    removeEventListener(name: string, listener: EventListener) {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
  } satisfies HostNode;
  return node;
}

const testBody = hostNode("body");
testDocument.body = testBody;
testDocument.documentElement = hostNode("html");

const renderer = createRenderer<HostNode, HostNode>({
  patchProp(node, key, _previous, next) {
    node.props[key] = next;
    if (key === "value") node.value = next;
  },
  insert(child, parent, anchor) {
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index >= 0) parent.children.splice(index, 0, child);
    else parent.children.push(child);
    child.parent = parent;
  },
  remove(child) {
    if (!child.parent) return;
    child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = null;
  },
  createElement: (type) => hostNode(type),
  createText: (text) => hostNode("#text", text),
  createComment: (text) => hostNode("#comment", text),
  setText(node, text) { node.text = text; },
  setElementText(node, text) {
    const child = hostNode("#text", text);
    child.parent = node;
    node.children = [child];
  },
  parentNode: (node) => node.parent,
  nextSibling(node) {
    const siblings = node.parent?.children ?? [];
    return siblings[siblings.indexOf(node) + 1] ?? null;
  },
  querySelector: (selector) => selector === "body" ? testBody : null,
  setScopeId: () => undefined,
  cloneNode(node) { return { ...node, props: { ...node.props }, children: [...node.children] }; },
  insertStaticContent(content, parent, anchor) {
    const node = hostNode("#static", content);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index >= 0) parent.children.splice(index, 0, node);
    else parent.children.push(node);
    node.parent = parent;
    return [node, node];
  },
});

function textContent(node: HostNode): string {
  return [node.text, ...node.children.map(textContent)].join("");
}

function buttonByText(root: HostNode, text: string): HostNode {
  const button = descendants(root).find((node) => node.type === "button" && textContent(node).includes(text));
  assert.ok(button, `expected a ${text} button`);
  return button;
}

function nodeByProp(root: HostNode, key: string, value: unknown): HostNode {
  const node = descendants(root).find((candidate) => candidate.props[key] === value);
  assert.ok(node, `expected node with ${key}=${String(value)}`);
  return node;
}

function mount(component: object, props: Record<string, unknown>): { root: HostNode; app: App } {
  const root = hostNode("root");
  const app = renderer.createApp(component, props);
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.mount(root);
  return { root, app };
}

async function attachClientRender(component: object, modulePath: string): Promise<void> {
  const source = await readFile(fileURLToPath(new URL(`../src/${modulePath}`, import.meta.url)), "utf8");
  const descriptor = parse(source, { filename: modulePath }).descriptor;
  assert.ok(descriptor.template);
  const script = compileScript(descriptor, { id: modulePath });
  const compiled = compileTemplate({
    source: descriptor.template.content,
    filename: modulePath,
    id: modulePath,
    compilerOptions: { bindingMetadata: script.bindings },
  });
  assert.deepEqual(compiled.errors, []);
  const clientCode = compiled.code
    .replace(/^import \{([\s\S]*?)\} from "vue"\n/, (_match, bindings: string) => `const {${bindings.replace(/\s+as\s+/g, ": ")}} = vue\n`)
    .replace("export function render", "function render");
  const transformed = await transformWithEsbuild(clientCode, `${modulePath}.ts`, { loader: "ts", target: "esnext" });
  (component as { render?: unknown }).render = Function("vue", `${transformed.code}\nreturn render;`)(Vue);
}

let vite: ViteDevServer;
let AgentInspectorSettings: object;
let AgentInspectorLifecycleActions: object;
let AgentInspectorHost: object;
let AgentInspectorStatusSurface: object;
let AgentInspectorSurface: object;
let AgentInspectorOverview: object;
let AgentInspectorNow: object;
let ProviderBadge: object;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  AgentInspectorSettings = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorSettings.vue")).default;
  AgentInspectorLifecycleActions = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorLifecycleActions.vue")).default;
  AgentInspectorSurface = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorSurface.vue")).default;
  AgentInspectorHost = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorHost.vue")).default;
  AgentInspectorStatusSurface = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorStatusSurface.vue")).default;
  AgentInspectorOverview = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorOverview.vue")).default;
  AgentInspectorNow = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorNow.vue")).default;
  ProviderBadge = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/desktop-chat-message/ProviderBadge.vue")).default;
  await Promise.all([
    attachClientRender(AgentInspectorSettings, "components/desktop/content/agent-inspector/AgentInspectorSettings.vue"),
    attachClientRender(AgentInspectorLifecycleActions, "components/desktop/content/agent-inspector/AgentInspectorLifecycleActions.vue"),
    attachClientRender(AgentInspectorSurface, "components/desktop/content/agent-inspector/AgentInspectorSurface.vue"),
    attachClientRender(AgentInspectorHost, "components/desktop/content/agent-inspector/AgentInspectorHost.vue"),
    attachClientRender(AgentInspectorStatusSurface, "components/desktop/content/agent-inspector/AgentInspectorStatusSurface.vue"),
    attachClientRender(AgentInspectorOverview, "components/desktop/content/agent-inspector/AgentInspectorOverview.vue"),
    attachClientRender(AgentInspectorNow, "components/desktop/content/agent-inspector/AgentInspectorNow.vue"),
    attachClientRender(ProviderBadge, "components/desktop/content/desktop-chat-message/ProviderBadge.vue"),
  ]);
});

after(async () => {
  await vite?.close();
  if (originalDocument) Object.assign(globalThis, { document: originalDocument });
  else Reflect.deleteProperty(globalThis, "document");
  if (originalWindow) Object.assign(globalThis, { window: originalWindow });
  else Reflect.deleteProperty(globalThis, "window");
  if (originalRequestAnimationFrame) Object.assign(globalThis, { requestAnimationFrame: originalRequestAnimationFrame });
  else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
});

const configuration = {
  entryId: "agent_a",
  daemonGeneration: 7,
  provider: "codex",
  model: "gpt-next",
  reasoningEffort: "high" as const,
  charter: "Coordinate work.",
  permissionProfileId: "full_access" as const,
  supervisedPermissionProfiles: [{ id: "full_access", label: "Full access", description: "Lets Codex work in this trusted workspace.", status: "available" as const, risk: "high" as const, detail: null, isDefault: true }],
  providerLaunchPolicy: { approvalPolicy: "never" },
  configRevision: 4,
  runtimeConfigurationRevision: 4,
};
const readyResource: AgentInspectorConfigurationResource = {
  status: "ready",
  configuration,
  draft: {
    model: configuration.model,
    reasoningEffort: configuration.reasoningEffort,
    charter: configuration.charter,
    permissionProfileId: configuration.permissionProfileId,
  },
  error: null,
};
const noMove: AgentInspectorRoomMoveResource = { status: "idle", move: null, error: null };
const provider = {
  id: "codex",
  name: "Codex",
  description: "",
  capabilities: ["desktop_managed_runtime"],
  runtimeCommand: null,
  mcpTargetId: "codex",
  permissionProfiles: [{
    id: "full_access",
    label: "Full access",
    description: "Lets Codex work in this trusted workspace.",
    status: "available",
    risk: "high",
    detail: null,
  }],
  defaultPermissionProfileId: "full_access",
};

function settingsProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entryId: "agent_a",
    workspacePath: "/tmp/worktree",
    retired: false,
    resource: readyResource,
    move: noMove,
    moveAvailable: true,
    providers: [provider],
    destinations: [{ identifier: "room_b", displayName: "Room B" }],
    busy: false,
    applyPending: false,
    conflict: false,
    ...overrides,
  };
}

test("mounted initial settings error has a working Retry control", () => {
  let reloads = 0;
  const mounted = mount(AgentInspectorSettings, settingsProps({
    resource: { status: "error", configuration: null, draft: null, error: "daemon unavailable" },
    onReload: () => { reloads += 1; },
  }));
  const retry = buttonByText(mounted.root, "Retry");
  assert.equal(retry.props.disabled, false);
  (retry.props.onClick as () => void)();
  assert.equal(reloads, 1);
  mounted.app.unmount();
});

test("mounted Settings exposes provider-declared permission profiles as a single-choice control", () => {
  const patches: Array<Record<string, unknown>> = [];
  const mounted = mount(AgentInspectorSettings, settingsProps({ onPatch: (patch: Record<string, unknown>) => patches.push(patch) }));
  const radios = descendants(mounted.root).filter((node) => node.type === "input" && node.props.type === "radio");
  assert.equal(radios.length, 1, "Codex has one truthful permission profile rather than a misleading disabled selector");
  assert.equal(radios[0]?.props.checked, true);
  assert.equal(radios[0]?.props.disabled, false);
  assert.match(textContent(mounted.root), /Lets Codex work in this trusted workspace/);
  (radios[0]?.props.onChange as () => void)();
  assert.deepEqual(patches, [{ permissionProfileId: "full_access" }]);
  mounted.app.unmount();
});

test("mounted Settings honors exact supervised profile gates instead of generic provider availability", () => {
  const claudeConfiguration = {
    ...configuration,
    provider: "claude-code",
    permissionProfileId: "read_only" as const,
    reasoningEffort: null,
    supervisedPermissionProfiles: [
      { id: "read_only", label: "Read-only", description: "Read safely.", status: "available" as const, risk: "low" as const, detail: null, isDefault: true },
      { id: "ask_before_write", label: "Ask before writes", description: "Ask before a write.", status: "gated" as const, risk: "medium" as const, detail: "Claude supervised prompt bridging is not available yet.", isDefault: false },
      { id: "full_access", label: "Full access", description: "Trusted writes.", status: "available" as const, risk: "high" as const, detail: null, isDefault: false },
    ],
  };
  const mounted = mount(AgentInspectorSettings, settingsProps({
    resource: { status: "ready", configuration: claudeConfiguration, draft: { model: claudeConfiguration.model, reasoningEffort: null, charter: claudeConfiguration.charter, permissionProfileId: "read_only" }, error: null },
    // The generic catalog deliberately still calls this available for interactive workers.
    providers: [{ ...provider, id: "claude-code", permissionProfiles: [{ id: "ask_before_write", label: "Ask before writes", description: "Generic local worker option.", status: "available", risk: "medium", detail: null, isDefault: true }] }],
  }));
  const radios = descendants(mounted.root).filter((node) => node.type === "input" && node.props.type === "radio");
  const ask = radios.find((radio) => radio.props.value === "ask_before_write");
  assert.equal(ask?.props.disabled, true);
  assert.match(textContent(mounted.root), /Claude supervised prompt bridging is not available yet/);
  mounted.app.unmount();
});

test("mounted Settings keeps its two-step retirement confirmation", async () => {
  let settingsRetires = 0;
  const settings = mount(AgentInspectorSettings, settingsProps({ onRetire: () => { settingsRetires += 1; } }));
  (buttonByText(settings.root, "Retire agent").props.onClick as () => void)();
  await nextTick();
  assert.equal(settingsRetires, 0);
  assert.match(textContent(settings.root), /history and worktree stay available/);
  (buttonByText(settings.root, "Confirm retire agent").props.onClick as () => void)();
  assert.equal(settingsRetires, 1);
  settings.app.unmount();
});

test("the lifecycle overflow leaves retirement at the base of Overview", async () => {
  const emitted: string[] = [];
  const lifecycle = mount(AgentInspectorLifecycleActions, {
    entryId: "agent_a",
    roomId: "room_a",
    compact: true,
    busy: false,
    actions: [
      { kind: "mention", label: "Mention", available: true },
      { kind: "pause", label: "Pause", available: true },
      { kind: "reconnect", label: "Reconnect", available: true },
      { kind: "retire_agent", label: "Retire agent", available: true, danger: true },
    ],
    onAction: (intent: { kind: string }) => emitted.push(intent.kind),
  });
  (nodeByProp(lifecycle.root, "aria-label", "More agent actions").props.onClick as () => void)();
  await nextTick();
  assert.doesNotMatch(textContent(lifecycle.root), /Retire agent/);
  assert.deepEqual(emitted, []);
  lifecycle.app.unmount();
});

test("mounted Overview retirement stays contextual and requires explicit confirmation", async () => {
  const surfaceSource = await readFile(
    fileURLToPath(new URL("../src/components/desktop/content/agent-inspector/AgentInspectorSurface.vue", import.meta.url)),
    "utf8",
  );
  const settingsSource = await readFile(
    fileURLToPath(new URL("../src/components/desktop/content/agent-inspector/AgentInspectorSettings.vue", import.meta.url)),
    "utf8",
  );
  const actions: Array<Record<string, unknown>> = [];
  const projection: AgentInspectorProjection = {
    entryId: "agent_a",
    roomId: "room_a",
    agentKey: "emmymay/gardensignal",
    displayName: "GardenSignal",
    ownerAttribution: "EmmyMay's agent",
    provider: "codex",
    model: "gpt-next",
    charter: "Coordinate work.",
    overallState: "online",
    overallLabel: "Online",
    overallDetail: "",
    deliveryProgress: null,
    liveWork: {
      active: false,
      state: "idle",
      startedAt: null,
      detail: null,
      freshness: "fresh",
      agentState: "online",
    },
    now: null,
    assignedWork: [],
    recentOutcome: null,
    continuationRecovery: null,
    turnControl: null,
    actions: [
      { kind: "mention", label: "Mention", available: true },
      { kind: "retire_agent", label: "Retire agent", available: true, danger: true },
    ],
    mentionInsertText: "agent:emmymay/gardensignal",
    resourceFreshness: "fresh",
    entry: {
      id: "agent_a",
      roomId: "room_a",
      displayName: "GardenSignal",
      agentKey: "emmymay/gardensignal",
      provider: "codex",
      model: "gpt-next",
      charter: "Coordinate work.",
      desiredState: "running",
      observedState: "idle",
      condition: "none",
      permissionProfileId: "full_access",
      deliveryMode: "daemon_inbox",
      createdBy: "desktop",
      createdAt: "2026-08-29T00:00:00.000Z",
      workspacePath: "/tmp/worktree",
      workAttemptId: "work_a",
      agentSessionId: "session_a",
      agentSessionBindingState: "active",
      bindingUpdatedAt: "2026-08-29T00:00:00.000Z",
      executionGenerationId: "generation_a",
      providerContinuationId: "continuation_a",
      providerPid: 1234,
      workplaceLiveness: { state: "reachable", observedAt: "2026-08-29T00:00:00.000Z", detail: null },
      nativeLiveness: { state: "idle", observedAt: "2026-08-29T00:00:00.000Z", detail: null },
      restartCount: 0,
      lastTerminal: null,
      activity: [],
      lastTurnControlSequence: 0,
      turnControl: null,
    },
  };
  const runtimeDetail = {
    availability: "not_loaded", entry_id: "agent_a", room_id: "room_a", requested_source_message_id: null,
    inbox_item_id: null, source_message: null, receipt: null, terminal: null, publication: null,
    continuation_repair: null, timeline: [], items: [], uncertain_effects: [], history_boundary: null,
    runtime_control: { control_state: "degraded", runtime_state: "ready", observed_at: "2026-08-29T00:00:01.000Z",
      execution_generation_id: "generation_a", daemon_generation_id: "1" },
  };
  const projectionResource = Vue.ref(projection);
  const workResource = Vue.ref<Record<string, unknown>>({
    status: "ready",
    detail: runtimeDetail,
    error: null,
    sourceMessageId: null,
  });
  const surfaceProps = {
    actionState: null,
    compact: false,
    selectedWorkSourceMessageId: null,
    workArtifacts: [],
    settingsResource: readyResource,
    roomMoveResource: noMove,
    roomMoveAvailable: true,
    providers: [provider],
    destinations: [],
    settingsConflict: false,
    liveFeed: { events: [], ended: false, droppedEvents: 0 },
    onAction: (intent: Record<string, unknown>) => actions.push(intent),
  };
  const Harness = {
    setup: () => () => Vue.h(AgentInspectorSurface, {
      ...surfaceProps,
      projection: projectionResource.value,
      workResource: workResource.value,
    }),
  };
  const mounted = mount(Harness, {});

  assert.ok(descendants(mounted.root).some((node) => String(node.props.class).includes("agent-inspector-overview-retire")));
  assert.match(textContent(mounted.root), /Provider check inconclusive/);
  assert.match(textContent(mounted.root), /may still be working/);
  assert.match(textContent(mounted.root), /Checked/);
  assert.equal(descendants(mounted.root).some((node) => node.props.role === "alert"), false);
  const providerRow = () => descendants(mounted.root).find(node => node.type === "dt" && textContent(node) === "Provider status")?.parent;
  const initialProviderRow = providerRow();
  assert.ok(initialProviderRow);
  const timestampSlot = descendants(initialProviderRow).find(node => node.type === "small");
  assert.ok(timestampSlot);
  for (let refresh = 0; refresh < 2; refresh += 1) {
    workResource.value = { status: "refreshing", detail: { ...runtimeDetail, runtime_control: null }, error: null, sourceMessageId: null };
    await nextTick();
    assert.equal(providerRow(), initialProviderRow, "refresh retains the provider row instead of unmounting it");
    assert.match(textContent(initialProviderRow), /Checking provider/);
    assert.equal(descendants(initialProviderRow).find(node => node.type === "small"), timestampSlot);
    assert.equal(timestampSlot.props["aria-hidden"], true, "the empty timestamp slot is reserved without exposing stale text");
    assert.doesNotMatch(textContent(initialProviderRow), /Provider check inconclusive|Checked/,
      "a refresh placeholder never repeats invalidated process health or its timestamp");
    workResource.value = { status: "ready", detail: runtimeDetail, error: null, sourceMessageId: null };
    await nextTick();
    assert.equal(providerRow(), initialProviderRow);
    assert.match(textContent(initialProviderRow), /Provider check inconclusive/);
  }
  projectionResource.value = { ...projection, entry: { ...projection.entry, providerPid: null } };
  workResource.value = {
    status: "error",
    detail: { ...runtimeDetail, runtime_control: null },
    error: "Provider refresh failed.",
    sourceMessageId: null,
  };
  await nextTick();
  assert.equal(providerRow(), initialProviderRow);
  assert.match(textContent(initialProviderRow), /Provider status unavailable/);
  assert.doesNotMatch(textContent(initialProviderRow), /Checking provider|Provider check inconclusive|Checked/,
    "failed reconciliation cannot leave health from an absent process birth visible");
  const retire = buttonByText(mounted.root, "Retire agent");
  retire.focus();
  (retire.props.onClick as () => void)();
  await nextTick();
  assert.deepEqual(actions, []);
  assert.ok(nodeByProp(mounted.root, "role", "alert"));
  const keep = buttonByText(mounted.root, "Keep agent");
  assert.equal(testDocument.activeElement, keep, "confirmation moves focus to the safe action");
  (keep.props.onClick as () => void)();
  await nextTick();
  const restoredRetire = buttonByText(mounted.root, "Retire agent");
  assert.equal(testDocument.activeElement, restoredRetire, "cancelling returns focus to the retire action");
  (restoredRetire.props.onClick as () => void)();
  await nextTick();
  (buttonByText(mounted.root, "Confirm retire agent").props.onClick as () => void)();
  assert.deepEqual(actions, [{ entryId: "agent_a", roomId: "room_a", kind: "retire_agent" }]);
  mounted.app.unmount();

  assert.doesNotMatch(surfaceSource, /agent-inspector-danger-footer/, "the inspector has no persistent destructive footer");
  assert.match(surfaceSource, /class="agent-inspector-overview-retire"/, "Overview owns the visible retire action");
  assert.match(surfaceSource, /Confirm retire agent/, "Overview retirement remains a two-step confirmation");
  assert.match(surfaceSource, /AGENT_INSPECTOR_RETIRE_CONFIRMATION/, "Overview uses the shared retirement warning");
  assert.match(surfaceSource, /<AgentInspectorSettings/, "retirement remains available through Settings");
  assert.match(surfaceSource, /@retire="emit\('retire'\)"/, "Settings still forwards the retire action");
  assert.match(settingsSource, /class="agent-inspector-danger"/, "retire is placed in the contextual danger zone");
  assert.match(settingsSource, /Confirm retire agent/, "retiring stays a two-step confirmation");
  assert.match(settingsSource, /AGENT_INSPECTOR_RETIRE_CONFIRMATION/, "the confirmation copy is the shared retire warning");
  assert.match(settingsSource, /watch\(\(\) => props\.entryId/, "confirmation resets when the inspected agent changes");
});

test("mounted room-move recovery survives an inspector remount without an in-memory operation id", () => {
  const preparedMove: AgentInspectorRoomMoveResource = {
    status: "idle",
    error: null,
    move: {
      operationId: "move_1",
      requestId: "request_1",
      entryId: "agent_a",
      sourceRoomId: "room_a",
      destinationRoomId: "room_b",
      daemonGeneration: 7,
      workAttemptId: null,
      executionGenerationId: null,
      agentSessionId: null,
      phase: "prepared",
      remoteRoomId: null,
      destinationCursor: null,
      error: null,
      createdAt: "now",
      updatedAt: "now",
    },
  };
  const first = mount(AgentInspectorSettings, settingsProps({ move: preparedMove }));
  assert.ok(buttonByText(first.root, "Continue move"));
  assert.match(textContent(first.root), /Move saved/);
  first.app.unmount();

  const reopened = mount(AgentInspectorSettings, settingsProps({ move: preparedMove }));
  assert.ok(buttonByText(reopened.root, "Continue move"));
  assert.match(textContent(reopened.root), /rediscovered and resumed/);
  reopened.app.unmount();
});

test("mounted busy and refreshing settings prevent draft edits and overlapping saves", () => {
  const busy = mount(AgentInspectorSettings, settingsProps({ busy: true }));
  for (const control of descendants(busy.root).filter((node) => node.type === "textarea" || node.type === "select")) {
    if (Object.hasOwn(control.props, "readonly")) assert.notEqual(control.props.readonly, false);
    else assert.equal(control.props.disabled, true);
  }
  assert.equal(buttonByText(busy.root, "Saving…").props.disabled, true);
  busy.app.unmount();

  const refreshing = mount(AgentInspectorSettings, settingsProps({
    resource: { ...readyResource, status: "refreshing" },
  }));
  assert.equal(buttonByText(refreshing.root, "Save changes").props.disabled, true);
  refreshing.app.unmount();
});

test("mounted Settings offers an explicit, non-overlapping restart only for a saved runtime lag", () => {
  let applies = 0;
  const laggingConfiguration = { ...configuration, runtimeConfigurationRevision: 3 };
  const laggingResource = { ...readyResource, configuration: laggingConfiguration };
  const lagging = mount(AgentInspectorSettings, settingsProps({
    resource: laggingResource,
    onApply: () => { applies += 1; },
  }));
  const apply = buttonByText(lagging.root, "Restart with saved revision");
  assert.equal(apply.props.disabled, false);
  assert.match(textContent(lagging.root), /Draft edits are not included until saved/);
  (apply.props.onClick as () => void)();
  assert.equal(applies, 1);
  lagging.app.unmount();

  const current = mount(AgentInspectorSettings, settingsProps());
  assert.equal(descendants(current.root).some((node) => node.type === "button" && textContent(node) === "Restart with saved revision"), false);
  current.app.unmount();

  const pending = mount(AgentInspectorSettings, settingsProps({ resource: laggingResource, applyPending: true }));
  assert.equal(buttonByText(pending.root, "Restarting…").props.disabled, true);
  pending.app.unmount();

  const retired = mount(AgentInspectorSettings, settingsProps({ resource: laggingResource, retired: true }));
  assert.equal(descendants(retired.root).some((node) => node.type === "button" && textContent(node) === "Restart with saved revision"), false);
  retired.app.unmount();
});

test("Settings apply uses exact authority fences and explicit reload recovers an accepted restart", async () => {
  const shell = await readFile(
    fileURLToPath(new URL("../src/components/desktop/content/DesktopRoomShell.vue", import.meta.url)),
    "utf8",
  );
  const apply = await readFile(
    fileURLToPath(new URL("../src/components/desktop/content/room-shell/useAgentInspectorConfigurationApply.ts", import.meta.url)),
    "utf8",
  );
  assert.match(shell, /@settings-reload="reloadAgentInspectorSettings"/);
  assert.match(shell, /function reloadAgentInspectorSettings\(\)[\s\S]{0,500}action\?\.kind === "apply_settings"[\s\S]{0,250}agentInspectorActionState\.value = null;[\s\S]{0,180}loadAgentInspectorSettings\(true\)/);
  assert.match(shell, /useAgentInspectorConfigurationApply\(/);
  assert.match(apply, /snapshotConfigurationApply\(options\.configurationResource\.value, projection\.entryId\)/);
  assert.match(apply, /entryId: snapshot\.entryId,[\s\S]{0,140}daemonGeneration: snapshot\.daemonGeneration,[\s\S]{0,140}expectedConfigurationRevision: snapshot\.expectedConfigurationRevision/);
  assert.match(apply, /if \(!options\.operationIdentityCurrent\(operation\)\) return;/);
  assert.match(apply, /options\.recoverGeneration\(operation, snapshot\.preservedDraft\)/);
  assert.match(apply, /settleConfigurationAlreadyApplied/);
});

test("overflow Escape stops propagation, closes, and returns focus; outside and focus-out also dismiss", async () => {
  const mounted = mount(AgentInspectorLifecycleActions, {
    entryId: "agent_a",
    roomId: "room_a",
    compact: true,
    busy: false,
    actions: [
      { kind: "mention", label: "Mention", available: true },
      { kind: "pause", label: "Pause", available: true },
      { kind: "reconnect", label: "Reconnect", available: true },
    ],
  });
  const trigger = nodeByProp(mounted.root, "aria-label", "More agent actions");
  (trigger.props.onClick as () => void)();
  await nextTick();
  const menu = nodeByProp(mounted.root, "role", "menu");
  let prevented = false;
  let stopped = false;
  (menu.props.onKeydown as (event: object) => void)({
    key: "Escape",
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  });
  await nextTick();
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(descendants(mounted.root).some((node) => node.props.role === "menu"), false);
  assert.equal(trigger.focusCount, 1);

  (trigger.props.onClick as () => void)();
  await nextTick();
  const outside = hostNode("button");
  for (const listener of documentListeners.get("pointerdown") ?? []) {
    listener({ target: outside } as unknown as Event);
  }
  await nextTick();
  assert.equal(descendants(mounted.root).some((node) => node.props.role === "menu"), false);

  (trigger.props.onClick as () => void)();
  await nextTick();
  const overflow = descendants(mounted.root).find((node) => String(node.props.class).includes("agent-inspector-overflow"));
  assert.ok(overflow);
  testDocument.activeElement = outside;
  (overflow.props.onFocusout as (event: object) => void)({ relatedTarget: outside });
  await nextTick();
  await nextTick();
  assert.equal(descendants(mounted.root).some((node) => node.props.role === "menu"), false);
  mounted.app.unmount();
});

test("wide Host closes on a primary pointer press outside and stays open for inside interaction", async () => {
  const originalBounds = testDocument.documentElement.getBoundingClientRect;
  testDocument.documentElement.getBoundingClientRect = () => ({ width: 1280 });
  const opener = hostNode("button");
  testDocument.activeElement = opener;
  let closeCount = 0;
  const mounted = mount(AgentInspectorHost, {
    open: true,
    projection: null,
    selection: {
      kind: "external",
      displayName: "External agent",
      sender: "External agent",
    },
    actionState: null,
    workResource: { status: "idle", detail: null, error: null, sourceMessageId: null },
    selectedWorkSourceMessageId: null,
    workArtifacts: [],
    settingsResource: { status: "idle", configuration: null, draft: null, error: null },
    roomMoveResource: noMove,
    roomMoveAvailable: false,
    providers: [],
    destinations: [],
    settingsConflict: false,
    roomIdentifier: "room_a",
    requestVersion: 1,
    managedSessions: [],
    reasoningSessions: [],
    onClose: () => { closeCount += 1; },
  });
  await nextTick();

  const wideHost = descendants(mounted.root).find((node) =>
    String(node.props.class).includes("agent-inspector-host-wide")
  );
  assert.ok(wideHost);
  const inside = wideHost.children[0] ?? wideHost;
  for (const listener of documentListeners.get("pointerdown") ?? []) {
    listener({
      button: 0,
      target: inside,
    } as unknown as Event);
  }
  assert.equal(closeCount, 0, "interacting inside the Inspector must not dismiss it");

  const outside = hostNode("button");
  for (const listener of documentListeners.get("pointerdown") ?? []) {
    listener({
      button: 2,
      target: outside,
    } as unknown as Event);
  }
  assert.equal(closeCount, 0, "secondary pointer actions must not dismiss the Inspector");

  for (const listener of documentListeners.get("pointerdown") ?? []) {
    listener({
      button: 0,
      target: outside,
    } as unknown as Event);
  }
  assert.equal(closeCount, 1);

  // Model the browser moving focus to the clicked target after pointerdown.
  // Unmount must not yank focus back to the element that opened the Inspector.
  testDocument.activeElement = outside;
  mounted.app.unmount();
  assert.equal(opener.focusCount, 0);
  assert.equal(testDocument.activeElement, outside);
  testDocument.documentElement.getBoundingClientRect = originalBounds;
});

test("retrying unavailable agent details keeps keyboard focus inside the Inspector", async () => {
  const originalBounds = testDocument.documentElement.getBoundingClientRect;
  testDocument.documentElement.getBoundingClientRect = () => ({ width: 1280 });
  testDocument.activeElement = null;
  const Harness = Vue.defineComponent({
    setup() {
      const selection = Vue.ref({
        kind: "unavailable" as const,
        unavailableReason: "load_error" as const,
        displayName: "GardenPoint",
        sender: "GardenPoint",
      });
      return () => Vue.h(AgentInspectorHost, {
        open: true,
        projection: null,
        selection: selection.value,
        actionState: null,
        workResource: { status: "idle", detail: null, error: null, sourceMessageId: null },
        selectedWorkSourceMessageId: null,
        workArtifacts: [],
        settingsResource: { status: "idle", configuration: null, draft: null, error: null },
        roomMoveResource: noMove,
        roomMoveAvailable: false,
        providers: [],
        destinations: [],
        settingsConflict: false,
        liveFeed: { events: [], ended: false, droppedEvents: 0 },
        roomIdentifier: "room_a",
        requestVersion: 1,
        managedSessions: [],
        reasoningSessions: [],
        onRetry: () => {
          selection.value = {
            kind: "resolving",
            displayName: "GardenPoint",
            sender: "GardenPoint",
          } as typeof selection.value;
        },
      });
    },
  });
  const mounted = mount(Harness, {});
  await nextTick();

  const retry = buttonByText(mounted.root, "Try again");
  retry.focus();
  assert.equal(testDocument.activeElement, retry);
  (retry.props.onClick as () => void)();
  await nextTick();
  await nextTick();

  assert.equal(descendants(mounted.root).includes(retry), false);
  const close = nodeByProp(mounted.root, "aria-label", "Close agent inspector");
  assert.equal(testDocument.activeElement, close);
  mounted.app.unmount();
  testDocument.documentElement.getBoundingClientRect = originalBounds;
});

test("compact Host gives the overflow menu first Escape ownership before closing the Inspector", async () => {
  const unsavedModel = "gpt-next-unsaved";
  let closeCount = 0;
  let currentModel = readyResource.draft!.model;
  testDocument.activeElement = null;

  const projection = {
    entryId: "agent_a",
    roomId: "room_a",
    agentKey: "emmymay/gardensignal",
    displayName: "GardenSignal",
    ownerAttribution: "EmmyMay's agent",
    provider: "codex",
    model: "gpt-next",
    charter: readyResource.draft!.charter,
    overallState: "online",
    overallLabel: "Online",
    overallDetail: "",
    now: null,
    assignedWork: [],
    recentOutcome: null,
    actions: [
      { kind: "mention", label: "Mention", available: true },
      { kind: "pause", label: "Pause", available: true },
      { kind: "reconnect", label: "Reconnect", available: true },
    ],
    mentionInsertText: "agent:emmymay/gardensignal",
    resourceFreshness: "fresh",
    entry: { agentKey: "emmymay/gardensignal", workspacePath: "/tmp/worktree" },
  };

  const Harness = Vue.defineComponent({
    setup() {
      const open = Vue.ref(true);
      const settingsResource = Vue.ref<AgentInspectorConfigurationResource>({
        ...readyResource,
        draft: { ...readyResource.draft! },
      });
      return () => Vue.h(AgentInspectorHost, {
        open: open.value,
        projection,
        selection: { kind: "managed" },
        actionState: null,
        workResource: { status: "idle", detail: null, error: null, sourceMessageId: null },
        selectedWorkSourceMessageId: null,
        workArtifacts: [],
        settingsResource: settingsResource.value,
        roomMoveResource: noMove,
        roomMoveAvailable: true,
        providers: [provider],
        destinations: [],
        settingsConflict: false,
        onSettingsPatch: (patch: Partial<NonNullable<AgentInspectorConfigurationResource["draft"]>>) => {
          settingsResource.value = {
            ...settingsResource.value,
            draft: { ...settingsResource.value.draft!, ...patch },
          };
          currentModel = settingsResource.value.draft!.model;
        },
        onClose: () => {
          closeCount += 1;
          open.value = false;
        },
      });
    },
  });

  const mounted = mount(Harness, {});
  await nextTick();
  await nextTick();
  assert.ok(nodeByProp(testBody, "role", "dialog"), "compact Inspector should be mounted");

  (buttonByText(testBody, "Settings").props.onClick as () => void)();
  await nextTick();
  const model = descendants(testBody).find((node) => node.type === "input" && node.props.placeholder === "Provider default");
  assert.ok(model, "expected the mounted Settings model field");
  (model.props.onInput as (event: object) => void)({ target: { value: unsavedModel } });
  await nextTick();
  assert.equal(currentModel, unsavedModel);

  const trigger = nodeByProp(testBody, "aria-label", "More agent actions");
  (trigger.props.onClick as () => void)();
  await nextTick();
  const menu = nodeByProp(testBody, "role", "menu");
  const menuItem = buttonByText(menu, "Pause");
  let firstPrevented = false;
  let firstStopped = false;
  const firstEscape = {
    key: "Escape",
    target: menuItem,
    preventDefault: () => { firstPrevented = true; },
    stopPropagation: () => { firstStopped = true; },
  };
  for (const listener of documentListeners.get("keydown") ?? []) {
    listener(firstEscape as unknown as Event);
  }
  assert.equal(closeCount, 0, "document capture must yield Escape to the open menu");
  (menu.props.onKeydown as (event: object) => void)(firstEscape);
  await nextTick();

  assert.equal(firstPrevented, true);
  assert.equal(firstStopped, true);
  assert.equal(descendants(testBody).some((node) => node.props.role === "menu"), false);
  assert.equal(trigger.focusCount, 1);
  assert.equal(testDocument.activeElement, trigger);
  assert.ok(nodeByProp(testBody, "role", "dialog"), "Inspector remains open after menu dismissal");
  assert.equal(currentModel, unsavedModel, "menu dismissal must preserve the Settings draft");
  assert.equal(descendants(testBody).find((node) => node.type === "input" && node.props.placeholder === "Provider default")?.props.value, unsavedModel);

  let secondPrevented = false;
  const secondEscape = {
    key: "Escape",
    target: trigger,
    preventDefault: () => { secondPrevented = true; },
    stopPropagation: () => undefined,
  };
  for (const listener of documentListeners.get("keydown") ?? []) {
    listener(secondEscape as unknown as Event);
  }
  await nextTick();
  assert.equal(secondPrevented, true);
  assert.equal(closeCount, 1);
  assert.equal(descendants(testBody).some((node) => node.props.role === "dialog"), false);
  mounted.app.unmount();
});
