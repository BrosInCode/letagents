import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse, compileScript, compileTemplate } from "@vue/compiler-sfc";
import * as Vue from "vue";
import { createRenderer, nextTick, ssrContextKey, type App } from "vue";
import { createServer, transformWithEsbuild, type ViteDevServer } from "vite";
import { projectAgentInspector, type AgentInspectorProjection } from "../src/domain/agent-inspector";
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
  getRootNode: () => typeof testDocument;
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
const originalDocumentConstructor = globalThis.Document;
const originalShadowRootConstructor = globalThis.ShadowRoot;
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
  Document: class {},
  ShadowRoot: class {},
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
  if (selector === '.workspace-reader-backdrop') return String(node.props.class ?? '').split(' ').includes('workspace-reader-backdrop');
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
    getRootNode: () => testDocument,
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
let AgentInspectorDiagnostics: object;
let AgentInspectorLifecycleActions: object;
let AgentInspectorHost: object;
let AgentInspectorStatusSurface: object;
let AgentInspectorSurface: object;
let AgentInspectorOverview: object;
let AgentInspectorNow: object;
let AgentInspectorSignal: object;
let ProviderBadge: object;
let AgentInspectorHomeHarness: object;
let DesktopSwitch: object;
let agentRoomAudienceKey: symbol;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  AgentInspectorDiagnostics = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorDiagnostics.vue")).default;
  AgentInspectorSettings = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorSettings.vue")).default;
  AgentInspectorLifecycleActions = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorLifecycleActions.vue")).default;
  AgentInspectorSurface = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorSurface.vue")).default;
  await Promise.all(["AgentInspectorLive", "AgentInspectorDiagnostics"].map(name =>
    vite.ssrLoadModule(`/renderer/src/components/desktop/content/agent-inspector/${name}.vue`)));
  AgentInspectorHost = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorHost.vue")).default;
  AgentInspectorStatusSurface = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorStatusSurface.vue")).default;
  AgentInspectorOverview = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorOverview.vue")).default;
  AgentInspectorNow = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorNow.vue")).default;
  AgentInspectorSignal = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorSignal.vue")).default;
  ProviderBadge = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/desktop-chat-message/ProviderBadge.vue")).default;
  AgentInspectorHomeHarness = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorHomeHarness.vue")).default;
  DesktopSwitch = (await vite.ssrLoadModule("/renderer/src/components/desktop/controls/DesktopSwitch.vue")).default;
  agentRoomAudienceKey = (await vite.ssrLoadModule("/renderer/src/domain/agent-home-harness.ts")).agentRoomAudienceKey;
  await Promise.all([
    attachClientRender(AgentInspectorDiagnostics, "components/desktop/content/agent-inspector/AgentInspectorDiagnostics.vue"),
    attachClientRender(AgentInspectorSettings, "components/desktop/content/agent-inspector/AgentInspectorSettings.vue"),
    attachClientRender(AgentInspectorLifecycleActions, "components/desktop/content/agent-inspector/AgentInspectorLifecycleActions.vue"),
    attachClientRender(AgentInspectorSurface, "components/desktop/content/agent-inspector/AgentInspectorSurface.vue"),
    attachClientRender(AgentInspectorHost, "components/desktop/content/agent-inspector/AgentInspectorHost.vue"),
    attachClientRender(AgentInspectorStatusSurface, "components/desktop/content/agent-inspector/AgentInspectorStatusSurface.vue"),
    attachClientRender(AgentInspectorOverview, "components/desktop/content/agent-inspector/AgentInspectorOverview.vue"),
    attachClientRender(AgentInspectorNow, "components/desktop/content/agent-inspector/AgentInspectorNow.vue"),
    attachClientRender(AgentInspectorSignal, "components/desktop/content/agent-inspector/AgentInspectorSignal.vue"),
    attachClientRender(ProviderBadge, "components/desktop/content/desktop-chat-message/ProviderBadge.vue"),
    attachClientRender(AgentInspectorHomeHarness, "components/desktop/content/agent-inspector/AgentInspectorHomeHarness.vue"),
    attachClientRender(DesktopSwitch, "components/desktop/controls/DesktopSwitch.vue"),
  ]);
});

after(async () => {
  await vite?.close();
  if (originalDocumentConstructor) Object.assign(globalThis, { Document: originalDocumentConstructor });
  else Reflect.deleteProperty(globalThis, "Document");
  if (originalShadowRootConstructor) Object.assign(globalThis, { ShadowRoot: originalShadowRootConstructor });
  else Reflect.deleteProperty(globalThis, "ShadowRoot");
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
    displayName: "Ada",
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

test("deleting retired history requires the displayed agent name", async () => {
  let purges = 0;
  const mounted = mount(AgentInspectorSettings, settingsProps({ retired: true, onPurge: () => { purges += 1; } }));
  const button = buttonByText(mounted.root, "Delete history and settings");
  const input = descendants(mounted.root).find(node => node.type === "input" && node.props["onUpdate:modelValue"]);
  assert.ok(input);
  assert.equal(button.props.disabled, true);
  (input.props["onUpdate:modelValue"] as (value: string) => void)("agent_a");
  await nextTick();
  assert.equal(button.props.disabled, true, "the internal ID is not the confirmation phrase");
  (input.props["onUpdate:modelValue"] as (value: string) => void)("Ada");
  await nextTick();
  assert.equal(button.props.disabled, false);
  (button.props.onClick as () => void)();
  assert.equal(purges, 1);
  assert.match(textContent(mounted.root), /project files will remain/);
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
      { id: "ask_before_write", label: "Ask before writes", description: "Ask before a write.", status: "gated" as const, risk: "medium" as const, detail: "Approval requests are unavailable in this connection mode.", isDefault: false },
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
  assert.match(textContent(mounted.root), /Approval requests are unavailable in this connection mode/);
  mounted.app.unmount();
});

test("mounted Settings keeps its two-step retirement confirmation", async () => {
  let settingsRetires = 0;
  const settings = mount(AgentInspectorSettings, settingsProps({ onRetire: () => { settingsRetires += 1; } }));
  (buttonByText(settings.root, "Retire agent").props.onClick as () => void)();
  await nextTick();
  assert.equal(settingsRetires, 0);
  assert.match(textContent(settings.root), /history and project files stay available/);
  (buttonByText(settings.root, "Confirm retire agent").props.onClick as () => void)();
  assert.equal(settingsRetires, 1);
  settings.app.unmount();
});

test("the lifecycle overflow leaves retirement in Settings", async () => {
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

test("mounted inspector preserves selected tabs on refresh and keeps retirement contextual", async () => {
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
  const requestVersion = Vue.ref(1);
  const initialTab = Vue.ref<"overview" | "work">("overview");
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
      requestVersion: requestVersion.value,
      initialTab: initialTab.value,
      roomDisplayName: "My project",
      workResource: workResource.value,
    }),
  };
  const mounted = mount(Harness, {});

  assert.equal(descendants(mounted.root).some((node) => String(node.props.class).includes("agent-inspector-overview-retire")), false);
  assert.match(textContent(mounted.root), /My project/);
  assert.match(textContent(mounted.root), /Status uncertain/);
  assert.match(textContent(mounted.root), /may still be working/);
  assert.match(textContent(mounted.root), /Checked/);
  assert.equal(descendants(mounted.root).some((node) => node.props.role === "alert"), false);
  const providerRow = () => descendants(mounted.root).find(node => node.type === "dt" && textContent(node) === "Agent app status")?.parent;
  const initialProviderRow = providerRow();
  assert.ok(initialProviderRow);
  const timestampSlot = descendants(initialProviderRow).find(node => node.type === "small");
  assert.ok(timestampSlot);
  for (let refresh = 0; refresh < 2; refresh += 1) {
    workResource.value = { status: "refreshing", detail: { ...runtimeDetail, runtime_control: null }, error: null, sourceMessageId: null };
    await nextTick();
    assert.equal(providerRow(), initialProviderRow, "refresh retains the provider row instead of unmounting it");
    assert.match(textContent(initialProviderRow), /Checking agent app/);
    assert.equal(descendants(initialProviderRow).find(node => node.type === "small"), timestampSlot);
    assert.equal(timestampSlot.props["aria-hidden"], true, "the empty timestamp slot is reserved without exposing stale text");
    assert.doesNotMatch(textContent(initialProviderRow), /Status uncertain|Checked/,
      "a refresh placeholder never repeats invalidated process health or its timestamp");
    workResource.value = { status: "ready", detail: runtimeDetail, error: null, sourceMessageId: null };
    await nextTick();
    assert.equal(providerRow(), initialProviderRow);
    assert.match(textContent(initialProviderRow), /Status uncertain/);
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
  assert.match(textContent(initialProviderRow), /Agent app status unavailable/);
  assert.doesNotMatch(textContent(initialProviderRow), /Checking agent app|Status uncertain|Checked/,
    "failed reconciliation cannot leave health from an absent process birth visible");
  const selectInspectorTab = async (label: string) => {
    (buttonByText(mounted.root, label).props.onClick as () => void)();
    await nextTick();
  };
  const selectedInspectorTab = () => descendants(mounted.root).find(node => node.props.role === "tab" && node.props["aria-selected"] === true);
  for (const label of ["Overview", "Live", "Work", "Settings", "Diagnostics"]) {
    await selectInspectorTab(label);
    for (let refresh = 0; refresh < 2; refresh += 1) {
      projectionResource.value = { ...projectionResource.value, entry: { ...projectionResource.value.entry } };
      await nextTick();
      assert.equal(textContent(selectedInspectorTab()!), label, `${label} stays selected through a same-agent snapshot replacement`);
    }
  }
  requestVersion.value += 1;
  await nextTick();
  assert.equal(textContent(selectedInspectorTab()!), "Overview", "an explicit inspector-open request still resets the tab");
  initialTab.value = "work";
  await nextTick();
  assert.equal(textContent(selectedInspectorTab()!), "Work", "explicit Work navigation still selects Work");
  await selectInspectorTab("Settings");
  projectionResource.value = { ...projectionResource.value, entryId: "agent_b" };
  await nextTick();
  assert.equal(textContent(selectedInspectorTab()!), "Work", "opening a different agent resets to the requested initial tab");
  projectionResource.value = { ...projectionResource.value, entryId: "agent_a" };
  initialTab.value = "overview";
  await nextTick();
  assert.equal(descendants(mounted.root).some(node => node.type === 'button' && textContent(node) === 'Retire agent'), false, 'Overview stays focused on status and work');
  mounted.app.unmount();

  assert.doesNotMatch(surfaceSource, /agent-inspector-danger-footer/, "the inspector has no persistent destructive footer");
  assert.doesNotMatch(surfaceSource, /agent-inspector-overview-retire/, "retirement lives in Settings");
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
  assert.match(textContent(reopened.root), /reopen these settings to resume/);
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
  const apply = buttonByText(lagging.root, "Restart to apply changes");
  assert.equal(apply.props.disabled, false);
  assert.match(textContent(lagging.root), /Save your edits before restarting/);
  (apply.props.onClick as () => void)();
  assert.equal(applies, 1);
  lagging.app.unmount();

  const current = mount(AgentInspectorSettings, settingsProps());
  assert.equal(descendants(current.root).some((node) => node.type === "button" && textContent(node) === "Restart to apply changes"), false);
  current.app.unmount();

  const pending = mount(AgentInspectorSettings, settingsProps({ resource: laggingResource, applyPending: true }));
  assert.equal(buttonByText(pending.root, "Restarting…").props.disabled, true);
  pending.app.unmount();

  const retired = mount(AgentInspectorSettings, settingsProps({ resource: laggingResource, retired: true }));
  assert.equal(descendants(retired.root).some((node) => node.type === "button" && textContent(node) === "Restart to apply changes"), false);
  retired.app.unmount();
});

test("Overview waits for a historical identity before loading intensity and reloads on reopen", async () => {
  const shell = await readFile(fileURLToPath(new URL("../src/components/desktop/content/DesktopRoomShell.vue", import.meta.url)), "utf8");
  const opening = shell.slice(shell.indexOf("function openAgentDetailRequest("), shell.indexOf("async function loadAgentInspectorProviders("));
  assert.doesNotMatch(opening, /loadAgentInspectorSettings\(/, "an unresolved opening must not mark settings unavailable");
  const watcher = shell.slice(shell.indexOf("// Identity can resolve after"), shell.indexOf("function closeAgentDetail("));
  const projection = Vue.ref<{ entryId: string } | null>(null);
  const version = Vue.ref(0);
  const resource = Vue.ref({ status: "idle" });
  let loads = 0;
  let stop: (() => void) | undefined;
  new Function("watch", "selectedAgentDetailProjection", "selectedAgentDetailRequestVersion", "agentInspectorConfigurationResource", "loadAgentInspectorSettings", watcher)(
    (...args: Parameters<typeof Vue.watch>) => { stop = Vue.watch(...args); }, projection, version, resource,
    () => { loads += 1; resource.value.status = "ready"; },
  );
  version.value += 1;
  await nextTick();
  assert.equal(loads, 0);
  projection.value = { entryId: "agent_a" };
  await nextTick();
  assert.equal(loads, 1);
  resource.value.status = "idle";
  version.value += 1;
  await nextTick();
  assert.equal(loads, 2, "reopening the same agent loads its current configuration once");
  stop?.();
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

  const readerBackdrop = hostNode('div');
  readerBackdrop.props.class = 'workspace-reader-backdrop';
  const readerButton = hostNode('button');
  readerButton.parent = readerBackdrop;
  for (const target of [readerButton, readerBackdrop]) {
    for (const listener of documentListeners.get('pointerdown') ?? []) listener({ button: 0, target } as unknown as Event);
  }
  assert.equal(closeCount, 0, 'the teleported workspace reader owns its controls and backdrop');

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
  const model = descendants(testBody).find((node) => node.type === "input" && node.props.placeholder === "Default model");
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
  assert.equal(descendants(testBody).find((node) => node.type === "input" && node.props.placeholder === "Default model")?.props.value, unsavedModel);

  const readerBackdrop = hostNode('div');
  readerBackdrop.props.class = 'workspace-reader-backdrop';
  const readerInput = hostNode('textarea');
  readerInput.parent = readerBackdrop;
  for (const listener of documentListeners.get('keydown') ?? []) listener({
    key: 'Escape', target: readerInput,
    preventDefault: () => assert.fail('the reader must receive Escape before the compact inspector'),
    stopPropagation: () => assert.fail('the reader must receive Escape before the compact inspector'),
  } as unknown as Event);
  assert.equal(closeCount, 0, 'Escape inside the workspace reader must preserve the inspector');

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

function troubleshootingProps() {
  const entry = {
    id: "diagnostic_a", roomId: "room_a", provider: "codex", createdAt: "2026-09-14T10:00:00Z",
    desiredState: "running", observedState: "idle", condition: "none", agentSessionBindingState: "active",
    providerPid: 123, executionGenerationId: "generation_a", restartCount: 0,
    workplaceLiveness: { state: "reachable" }, nativeLiveness: { state: "idle" }, activity: [],
    roomAgentState: {
      connection: { state: "disconnected", detail: "Room connection lost", observedAt: null },
      ingress: { state: "blocked", detail: null, observedAt: null },
      inbox: { state: "empty", pendingCount: 0 }, turn: { state: "idle" },
    },
  };
  return {
    projection: { entryId: entry.id, roomId: entry.roomId, entry, resourceFreshness: "fresh", overallState: "needs_attention",
      actions: [{ kind: "reconnect", label: "Reconnect", available: true }], turnControl: null },
    workResource: { status: "ready", detail: null, error: null, sourceMessageId: null },
    daemonStatus: { healthy: true, generation: 1, capabilities: {} },
  } as any;
}

test("primary and Diagnostics recovery choices never dispatch until a restart is confirmed", async () => {
  for (const route of ["primary", "diagnostics", "unsupported"] as const) {
    const state = troubleshootingProps();
    Object.assign(state.projection.entry, {
      displayName: "QuartzMeadow", createdBy: "owner", charter: "Notes", provider: "claude-code", deliveryMode: "daemon_inbox",
      observedState: "recovering", condition: "coordination_blocked", runtimeGenerationId: "runtime_a",
      providerContinuationId: "continuation_a", workAttemptId: "attempt_a", lastTerminal: null,
      turnControl: null, lastTurnControlSequence: 0,
    });
    state.projection.entry.roomAgentState.task = { state: "none", taskId: null, title: null };
    state.daemonStatus.capabilities = { agentRuntimeRecovery: true, agentRuntimeRecoveryV2: route !== "unsupported" };
    state.projection = projectAgentInspector(state.projection.entry, { roomId: "room_a" });
    const actions: unknown[] = [];
    const mounted = mount(AgentInspectorSurface, {
      ...state, compact: false, initialTab: route === "diagnostics" ? "diagnostics" : "overview",
      actionState: null, requestVersion: 1, selectedWorkSourceMessageId: null, workArtifacts: [],
      settingsResource: readyResource, roomMoveResource: noMove, roomMoveAvailable: false,
      providers: [], destinations: [], settingsConflict: false, liveFeed: { events: [], ended: false, droppedEvents: 0 },
      onAction: (intent: unknown) => actions.push(intent),
    });
    if (route !== "diagnostics") (buttonByText(mounted.root, "Recovery options").props.onClick as () => void)();
    await new Promise<void>(resolve => setImmediate(resolve));
    await nextTick();
    if (route === "diagnostics") {
      (buttonByText(mounted.root, "Troubleshoot this issue").props.onClick as () => void)();
      await nextTick();
    }
    assert.deepEqual(actions, [], "entering choices must not prepare a grant or invoke recovery IPC");
    if (route === "unsupported") {
      assert.equal(descendants(mounted.root).some(node => node.props["aria-label"] === "Runtime recovery"), false);
      assert.equal(descendants(mounted.root).some(node => node.props["data-action"] === "recover"), false);
    } else {
      assert.ok(nodeByProp(mounted.root, "aria-label", "Runtime recovery"));
      const resume = descendants(mounted.root).find(node => node.type === "input" && node.props.value === "restart_runtime");
      assert.ok(resume);
      (resume.props["onUpdate:modelValue"] as (value: string) => void)("restart_runtime");
      await nextTick();
      await (buttonByText(mounted.root, "Review restart").props.onClick as () => Promise<void>)();
      assert.deepEqual(actions, []);
      (buttonByText(mounted.root, "Cancel").props.onClick as () => void)();
      await nextTick();
      assert.deepEqual(actions, [], "cancelling retains the current runtime");
      await (buttonByText(mounted.root, "Review restart").props.onClick as () => Promise<void>)();
      (buttonByText(mounted.root, "Restart and resume").props.onClick as () => void)();
      assert.deepEqual(actions, [{ entryId: "diagnostic_a", roomId: "room_a", kind: "restart_runtime" }]);
    }
    mounted.app.unmount();
  }
});

test("runtime restart confirmation survives unchanged observations and cancels when the runtime changes", async () => {
  const state = Vue.ref(troubleshootingProps());
  state.value.daemonStatus.capabilities.agentRuntimeRecoveryV2 = true;
  state.value.projection.entry.runtimeGenerationId = "runtime_a";
  state.value.projection.actions = [{ kind: "restart_runtime", label: "Restart and resume", available: true }];
  const actions: unknown[] = [];
  const mounted = mount({ setup: () => () => Vue.h(AgentInspectorDiagnostics, {
    ...state.value, onAction: (intent: unknown) => actions.push(intent), refreshDiagnostics: async () => true,
  }) }, {});
  (buttonByText(mounted.root, "Agent runtime").props.onClick as () => void)();
  await nextTick();
  await (buttonByText(mounted.root, "Review restart").props.onClick as () => Promise<void>)();
  await nextTick();
  const title = descendants(mounted.root).find(node => node.type === "h4" && textContent(node) === "Restart and resume?");
  assert.ok(title);
  assert.equal(testDocument.activeElement, title);
  state.value = { ...state.value, projection: { ...state.value.projection, entry: { ...state.value.projection.entry } } };
  await nextTick();
  assert.match(textContent(mounted.root), /Restart and resume\?/);
  assert.equal(testDocument.activeElement, title, "a status refresh must preserve confirmation focus");
  state.value.projection.entry.runtimeGenerationId = "runtime_b";
  await nextTick();
  assert.doesNotMatch(textContent(mounted.root), /Restart and resume\?/);
  assert.ok(buttonByText(mounted.root, "Review restart"));
  assert.deepEqual(actions, [], "neither a refresh nor a runtime change authorizes a restart");
  mounted.app.unmount();
});

test("diagnostic verification survives live projection updates and waits for a fresh read", async () => {
  const state = Vue.ref(troubleshootingProps());
  const actions: unknown[] = [];
  let finish: (fresh: boolean) => void = () => undefined;
  let refreshes = 0;
  const mounted = mount({ setup: () => () => Vue.h(AgentInspectorDiagnostics, {
    ...state.value,
    onAction: (intent: unknown) => actions.push(intent),
    refreshDiagnostics: () => { refreshes++; return new Promise<boolean>(resolve => { finish = resolve; }); },
  }) }, {});
  (buttonByText(mounted.root, "Troubleshoot this issue").props.onClick as () => void)();
  await nextTick();
  (buttonByText(mounted.root, "Reconnect").props.onClick as () => void)();
  await nextTick();
  assert.deepEqual(actions, [{ entryId: "diagnostic_a", roomId: "room_a", kind: "reconnect" }]);
  assert.equal(descendants(mounted.root).filter(node => node.props["data-check"]).length, 4, "all connection checks stay visible during recovery");
  assert.match(textContent(mounted.root), /accepted request alone does not confirm/);
  state.value = { ...state.value, actionState: { status: "error", message: "The recovery request timed out." } };
  await nextTick();
  assert.match(textContent(mounted.root), /Recovery needs attention/);
  const pending = (buttonByText(mounted.root, "Check again").props.onClick as () => Promise<void>)();
  await nextTick();
  await nextTick();
  state.value = { ...state.value, projection: { ...state.value.projection, entry: {
    ...state.value.projection.entry,
    roomAgentState: { ...state.value.projection.entry.roomAgentState,
      connection: { state: "connected" }, ingress: { state: "observing" } },
  } } };
  await nextTick();
  assert.match(textContent(mounted.root), /Recovery needs attention/);
  assert.doesNotMatch(textContent(mounted.root), /Check confirmed/);
  assert.equal(refreshes, 1);
  finish(true);
  await pending;
  await nextTick();
  assert.match(textContent(mounted.root), /Check confirmed/);
  assert.doesNotMatch(textContent(mounted.root), /Recovery needs attention|recovery request timed out/);
  assert.match(textContent(mounted.root), /Connected and listening/);
  assert.ok(buttonByText(mounted.root, "Back to all checks"));
  state.value = troubleshootingProps();
  await nextTick();
  assert.doesNotMatch(textContent(mounted.root), /Check confirmed/);
  assert.match(textContent(mounted.root), /state changed after verification/);
  mounted.app.unmount();
});

test("diagnostics never confirms recovery after a failed refresh or an agent switch", async () => {
  const state = Vue.ref(troubleshootingProps());
  let finish: (fresh: boolean) => void = () => undefined;
  const mounted = mount({ setup: () => () => Vue.h(AgentInspectorDiagnostics, {
    ...state.value, refreshDiagnostics: () => new Promise<boolean>(resolve => { finish = resolve; }),
  }) }, {});
  (buttonByText(mounted.root, "Background service").props.onClick as () => void)();
  await nextTick();
  const failed = (buttonByText(mounted.root, "Refresh and verify").props.onClick as () => Promise<void>)();
  await nextTick(); await nextTick(); finish(false); await failed; await nextTick();
  assert.match(textContent(mounted.root), /Couldn’t confirm fresh checks/);
  assert.doesNotMatch(textContent(mounted.root), /Check confirmed/);
  const late = (buttonByText(mounted.root, "Check again").props.onClick as () => Promise<void>)();
  await nextTick(); await nextTick();
  state.value = { ...state.value, projection: { ...state.value.projection, entryId: "diagnostic_b", entry: { ...state.value.projection.entry, id: "diagnostic_b" } } };
  await nextTick(); finish(true); await late; await nextTick();
  assert.doesNotMatch(textContent(mounted.root), /Check confirmed|Verify the result|Checks refreshed/);
  assert.match(textContent(mounted.root), /Troubleshoot this issue/);
  mounted.app.unmount();
});

test("saved tool permissions refresh with Settings and recover from a failed revoke without a stuck button", async () => {
  const rule = { id: "rule", revision: 1, ownerId: "host", createdAtMs: 1, scope: { toolLabel: "Bash", projectName: "Do App" } };
  const revocations: unknown[] = [];
  let reads = 0;
  let granted = false;
  let attempt = 0;
  let finish!: () => void;
  Object.assign(window, { letagentsDesktop: { supervisor: {
    listHostToolRules: async () => { reads++; return granted ? [rule] : []; },
    revokeHostToolRule: async (input: unknown) => {
      revocations.push(input);
      if (++attempt === 1) throw new Error("temporary disconnect");
      await new Promise<void>(resolve => { finish = resolve; });
      granted = false;
    },
  } } });
  const mounted = mount(AgentInspectorSettings, settingsProps());
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick(); };
  try {
    await flush();
    assert.equal(reads, 1);
    granted = true;
    (buttonByText(mounted.root, "Reload").props.onClick as () => void)();
    await flush();
    assert.match(textContent(mounted.root), /Bash · Do App/);
    await (buttonByText(mounted.root, "Revoke").props.onClick as () => Promise<void>)();
    await flush();
    const retry = buttonByText(mounted.root, "Retry").props.onClick as () => Promise<void>;
    const revoking = (buttonByText(mounted.root, "Revoke").props.onClick as () => Promise<void>)();
    await retry(); // A stale Retry callback must not invalidate the in-flight mutation.
    finish(); await revoking; await flush();
    assert.equal(textContent(mounted.root).includes("Revoking…"), false);
    assert.equal(textContent(mounted.root).includes("Bash · Do App"), false);
    assert.deepEqual(revocations, Array(2).fill({ agentId: "agent_a", ruleId: "rule", revision: 1 }));
  } finally { mounted.app.unmount(); delete (window as unknown as Record<string, unknown>).letagentsDesktop; }
});

test("saved permission responses from the previous inspector cannot appear for a different agent", async () => {
  let finishOld!: (rules: unknown[]) => void;
  const entry = Vue.ref("old-agent");
  Object.assign(window, { letagentsDesktop: { supervisor: {
    listHostToolRules: (agentId: string) => agentId === "old-agent" ? new Promise(resolve => { finishOld = resolve; }) : Promise.resolve([]),
  } } });
  const mounted = mount({ setup: () => () => Vue.h(AgentInspectorSettings, settingsProps({ entryId: entry.value })) }, {});
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick(); };
  try {
    await flush(); entry.value = "new-agent"; await flush();
    finishOld([{ id: "old-rule", scope: { toolLabel: "Old tool", projectName: "Old project" } }]);
    await flush();
    assert.equal(textContent(mounted.root).includes("Old tool"), false);
  } finally { mounted.app.unmount(); delete (window as unknown as Record<string, unknown>).letagentsDesktop; }
});


test("room workspace permissions distinguish old and current scopes before revocation", async () => {
  const rules = [
    { id: "old", revision: 1, ownerId: "host", createdAtMs: 1,
      scope: { kind: "room_workspace", toolLabel: "Write", roomId: "OLD-ROOM", workAttemptId: "aaaaaaaa-1111", canonicalWorkspacePath: "/old/workspace" } },
    { id: "current", revision: 1, ownerId: "host", createdAtMs: 2,
      scope: { kind: "room_workspace", toolLabel: "Write", roomId: "NEW-ROOM", workAttemptId: "bbbbbbbb-2222", canonicalWorkspacePath: "/new/workspace" } },
  ];
  const revoked: unknown[] = [];
  Object.assign(window, { letagentsDesktop: { supervisor: {
    listHostToolRules: async () => rules,
    revokeHostToolRule: async (input: unknown) => { revoked.push(input); },
  } } });
  const mounted = mount(AgentInspectorSettings, settingsProps());
  try {
    await new Promise(resolve => setImmediate(resolve)); await nextTick();
    assert.match(textContent(mounted.root), /Write · Room OLD-ROOM · Workspace aaaaaaaa/);
    assert.match(textContent(mounted.root), /Write · Room NEW-ROOM · Workspace bbbbbbbb/);
    assert.doesNotMatch(textContent(mounted.root), /This room workspace/);
    const current = descendants(mounted.root).find(node => node.type === "span" && node.props.title === "bbbbbbbb-2222 · /new/workspace");
    assert.ok(current);
    const buttons = descendants(mounted.root).filter(node => node.type === "button" && textContent(node) === "Revoke");
    await (buttons[1]!.props.onClick as () => Promise<void>)();
    assert.equal((revoked[0] as { ruleId: string }).ruleId, "current");
  } finally { mounted.app.unmount(); }
});

function ownSetupResource(overrides: Record<string, unknown> = {}, draft: Record<string, unknown> = {}): AgentInspectorConfigurationResource {
  const withSetup = { ...configuration, homeHarness: { enabled: false, pending: false, availability: "available" as const }, ...overrides };
  return { status: "ready", configuration: withSetup as never, error: null, draft: {
    model: withSetup.model, reasoningEffort: withSetup.reasoningEffort, charter: withSetup.charter,
    permissionProfileId: withSetup.permissionProfileId, ...draft,
  } as never };
}
const ownSetupSwitch = (root: HostNode) => descendants(root).find((node) => node.props["data-testid"] === "agent-inspector-home-harness");
const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); await nextTick(); };

test("the owner's own setup is a switch that is off by default and saved on its own through the app's signed request", async () => {
  const requests: unknown[] = [];
  let reloads = 0;
  const saved = Vue.ref(ownSetupResource());
  Object.assign(window, { letagentsDesktop: { supervisor: {
    setAgentHomeHarness: async (input: { enabled: boolean }) => {
      requests.push(input);
      return { outcome: "updated", configuration: { ...saved.value.configuration, homeHarness: { enabled: input.enabled, pending: true, availability: "available" }, configRevision: 5 },
        ...(input.enabled ? {} : { restart: "restarting" }) };
    },
  } } });
  const patches: unknown[] = [];
  const saves: unknown[] = [];
  const mounted = mount({ setup: () => () => Vue.h(AgentInspectorSettings, settingsProps({
    resource: saved.value,
    onReload: () => {
      reloads += 1;
      saved.value = reloads === 1
        ? ownSetupResource({ homeHarness: { enabled: true, pending: true, availability: "available" }, configRevision: 5 })
        : ownSetupResource({ homeHarness: { enabled: false, pending: true, availability: "available" }, configRevision: 6 });
    },
    onPatch: (patch: unknown) => patches.push(patch), onSave: (overwrite: unknown) => saves.push(overwrite),
  })) }, {});
  try {
    await settle();
    const toggle = ownSetupSwitch(mounted.root);
    assert.ok(toggle, "an agent of the owner's gets the switch");
    assert.equal(toggle.props.role, "switch");
    assert.equal(toggle.props["aria-checked"], false, "it is off until the owner turns it on");
    assert.equal(toggle.props.disabled, false);
    assert.equal(toggle.props["aria-labelledby"], "agent-inspector-home-harness-title");
    assert.equal(toggle.props["aria-describedby"], "agent-inspector-home-harness-description");
    const text = textContent(mounted.root);
    assert.match(text, /Use your own Codex setup/);
    assert.match(text, /Lets this agent use your own Codex setup: your MCP servers, plugins, app connectors, skills, hooks, memories, and browser or computer control\. Those tools act as you\./);
    assert.match(text, /With Full access, those tools run without asking you\./);
    assert.match(text, /Anyone who can message this agent in the room can ask it to use them\./);
    assert.match(text, /Servers and hooks that a project adds stay off, and the agent will not start in a project that changes your servers/);
    assert.match(text, /Turning this on takes effect the next time the agent starts\. Turning it off restarts the agent straight away if it is idle\./);

    (toggle.props.onClick as () => void)();
    await settle();
    assert.deepEqual(requests, [{ entryId: "agent_a", daemonGeneration: 7, expectedRevision: 4, enabled: true }]);
    assert.equal(reloads, 1, "the saved settings are read again");
    assert.deepEqual(patches, [], "it is not an edit to the draft");
    assert.deepEqual(saves, [], "and it does not ride on Save changes");
    assert.equal(ownSetupSwitch(mounted.root)!.props["aria-checked"], true);
    assert.match(textContent(mounted.root), /Restart the agent to apply them\./, "it applies at the next start, like any saved change");
    const timing = (root: HostNode) => textContent(descendants(root).find((node) => node.props["data-testid"] === "agent-inspector-home-harness-timing")!);
    const restart = (root: HostNode) => descendants(root).find((node) => node.props["data-testid"] === "agent-inspector-home-harness-restart");
    assert.equal(timing(mounted.root), "This agent has not restarted since you turned this on. It gets your setup the next time it starts.");
    assert.equal(restart(mounted.root), undefined, "turning it on restarts nothing, and nothing says it did");

    (ownSetupSwitch(mounted.root)!.props.onClick as () => void)();
    await settle();
    assert.deepEqual(requests[1], { entryId: "agent_a", daemonGeneration: 7, expectedRevision: 5, enabled: false });
    assert.equal(ownSetupSwitch(mounted.root)!.props["aria-checked"], false);
    // Off is saved, but it is only over once the running agent restarts, and the panel says which it is.
    assert.equal(timing(mounted.root), "If this agent is still running, it keeps your setup until it restarts.");
    assert.equal(textContent(restart(mounted.root)!), "Restarting this agent now so it stops using your setup.");
    assert.equal(restart(mounted.root)!.props["data-tone"], undefined);
  } finally { mounted.app.unmount(); delete (window as unknown as Record<string, unknown>).letagentsDesktop; }
});

test("the approval note follows the agent's saved access level and its agent app", async () => {
  Object.assign(window, { letagentsDesktop: { supervisor: { setAgentHomeHarness: async () => ({ outcome: "invalid", error: "unused" }) } } });
  try {
    for (const [provider, permissionProfileId, expected] of [
      ["codex", "ask_before_write", /With Ask before writes, you approve each of those tools before it runs\. Two kinds run without asking: tools your own Codex settings already approve, and tools their own server labels read-only, which nothing checks\./],
      ["codex", "auto_review", /With Auto, Codex decides whether each of those tools runs\. You are not asked\./],
      ["claude-code", "ask_before_write", /unless your own Claude Code rules already allow it\./],
      ["claude-code", "read_only", /only where your own Claude Code rules allow them\. Nothing asks you\./],
    ] as const) {
      const mounted = mount(AgentInspectorSettings, settingsProps({ resource: ownSetupResource({ provider, permissionProfileId, reasoningEffort: null }) }));
      await settle();
      assert.match(textContent(mounted.root), expected, `${provider}/${permissionProfileId}`);
      assert.match(textContent(mounted.root), provider === "codex" ? /Use your own Codex setup/ : /Use your own Claude Code setup/);
      mounted.app.unmount();
    }
  } finally { delete (window as unknown as Record<string, unknown>).letagentsDesktop; }
});

test("a rental, a Cursor agent and an Open Model agent get a reason instead of a switch", async () => {
  const requests: unknown[] = [];
  Object.assign(window, { letagentsDesktop: { supervisor: { setAgentHomeHarness: async (input: unknown) => { requests.push(input); } } } });
  try {
    for (const [provider, availability, reason] of [
      ["cursor", "rental", /A rented agent works for someone else, so it never uses your own setup\./],
      ["codex", "rental", /A rented agent works for someone else, so it never uses your own setup\./],
      ["cursor", "unsupported", /Cursor agents run in a sealed copy of Cursor, so they cannot load your own Cursor setup\./],
      ["open-model", "unsupported", /Open Model agents run LetAgents' own copy of OpenCode, which has no setup of yours to load\./],
      ["codex", "polling", /Not available for this agent: it fetches its own messages, so LetAgents can't reliably switch your setup off again\./],
      ["claude-code", "polling", /Not available for this agent: it fetches its own messages/],
    ] as const) {
      const mounted = mount(AgentInspectorSettings, settingsProps({
        // Even a service that wrongly said "on" would not produce a control here.
        resource: ownSetupResource({ provider, reasoningEffort: null, homeHarness: { enabled: true, pending: true, availability } }),
      }));
      await settle();
      assert.equal(ownSetupSwitch(mounted.root), undefined, `${provider}/${availability} has no switch`);
      assert.match(textContent(mounted.root), reason);
      assert.doesNotMatch(textContent(mounted.root), /Those tools act as you/);
      mounted.app.unmount();
    }
    assert.deepEqual(requests, []);
  } finally { delete (window as unknown as Record<string, unknown>).letagentsDesktop; }
});

test("the switch is absent when the background service or the app cannot change it", async () => {
  // An older background service reports nothing about it.
  Object.assign(window, { letagentsDesktop: { supervisor: { setAgentHomeHarness: async () => ({}) } } });
  const older = mount(AgentInspectorSettings, settingsProps());
  await settle();
  assert.equal(ownSetupSwitch(older.root), undefined);
  assert.doesNotMatch(textContent(older.root), /Use your own/);
  older.app.unmount();
  // An app bridge without the signed request cannot offer it either.
  Object.assign(window, { letagentsDesktop: { supervisor: {} } });
  const bridge = mount(AgentInspectorSettings, settingsProps({ resource: ownSetupResource() }));
  await settle();
  assert.equal(ownSetupSwitch(bridge.root), undefined);
  bridge.app.unmount();
  delete (window as unknown as Record<string, unknown>).letagentsDesktop;
});

test("the switch does not answer while settings are saving, retired, or holding unsaved edits", async () => {
  const requests: unknown[] = [];
  Object.assign(window, { letagentsDesktop: { supervisor: { setAgentHomeHarness: async (input: unknown) => { requests.push(input); return { outcome: "invalid", error: "unused" }; } } } });
  try {
    for (const [name, props, note] of [
      ["saving", { busy: true, resource: ownSetupResource() }, null],
      ["retired", { retired: true, resource: ownSetupResource() }, null],
      ["refreshing", { resource: { ...ownSetupResource(), status: "refreshing" } }, null],
      ["unsaved edits", { resource: ownSetupResource({}, { model: "another-model" }) }, /Save or reload your other changes before changing this\./],
    ] as const) {
      const mounted = mount(AgentInspectorSettings, settingsProps(props));
      await settle();
      const toggle = ownSetupSwitch(mounted.root);
      assert.ok(toggle, name);
      assert.equal(toggle.props.disabled, true, name);
      (toggle.props.onClick as () => void)();
      await settle();
      if (note) assert.match(textContent(mounted.root), note);
      mounted.app.unmount();
    }
    assert.deepEqual(requests, [], "nothing was sent");
  } finally { delete (window as unknown as Record<string, unknown>).letagentsDesktop; }
});

test("a refused or failed change leaves the switch where the saved settings have it and says why", async () => {
  let reloads = 0;
  for (const [reply, message] of [
    [async () => ({ outcome: "invalid", error: "A rented agent works for someone else and cannot use your own setup." }), /A rented agent works for someone else and cannot use your own setup\./],
    [async () => ({ outcome: "conflict", configuration: {} }), /These settings were changed elsewhere, so nothing was changed\. Try again\./],
    [async () => { throw new Error("Host approvals require the main application window."); }, /Couldn’t change this\. Reload the settings to check it, then try again\./],
  ] as const) {
    Object.assign(window, { letagentsDesktop: { supervisor: { setAgentHomeHarness: reply } } });
    const mounted = mount(AgentInspectorSettings, settingsProps({ resource: ownSetupResource(), onReload: () => { reloads += 1; } }));
    try {
      await settle();
      (ownSetupSwitch(mounted.root)!.props.onClick as () => void)();
      await settle();
      assert.equal(ownSetupSwitch(mounted.root)!.props["aria-checked"], false);
      assert.match(textContent(mounted.root), message);
      assert.equal(ownSetupSwitch(mounted.root)!.props["aria-disabled"], undefined, "it can be tried again");
    } finally { mounted.app.unmount(); delete (window as unknown as Record<string, unknown>).letagentsDesktop; }
  }
  assert.equal(reloads, 2, "a refusal or a conflict is followed by reading the saved settings; a failure is left for the owner to reload");
});

test("turning it on where other people can reach the agent shows who can ask it to use the owner's tools", async () => {
  Object.assign(window, { letagentsDesktop: { supervisor: { setAgentHomeHarness: async () => ({ outcome: "invalid", error: "unused" }) } } });
  const roomNote = (root: HostNode) => descendants(root).find((node) => node.props["data-testid"] === "agent-inspector-home-harness-room")!;
  try {
    for (const [audience, enabled, warning, expected] of [
      ["public", true, true, /This room is public\. Anyone who can post here can ask this agent to use your tools\./],
      ["shared", true, true, /Other people are in this room\. Any of them can ask this agent to use your tools\./],
      ["public", false, false, /This room is public\./],
      ["private", true, false, /Anyone who can message this agent in the room can ask it to use them\./],
    ] as const) {
      const mounted = mount({ setup() {
        Vue.provide(agentRoomAudienceKey, Vue.ref(audience));
        return () => Vue.h(AgentInspectorSettings, settingsProps({ resource: ownSetupResource({ homeHarness: { enabled, pending: false, availability: "available" } }) }));
      } }, {});
      await settle();
      const note = roomNote(mounted.root);
      assert.match(textContent(note), expected, `${audience}/${enabled}`);
      assert.equal(note.props["data-tone"], warning ? "warning" : undefined, `${audience}/${enabled}`);
      assert.equal(note.props.role, warning ? "alert" : undefined, `${audience}/${enabled}`);
      mounted.app.unmount();
    }
  } finally { delete (window as unknown as Record<string, unknown>).letagentsDesktop; }
});

test("a second click while the first change is still being saved sends nothing", async () => {
  const requests: unknown[] = [];
  let finish!: (result: unknown) => void;
  Object.assign(window, { letagentsDesktop: { supervisor: {
    setAgentHomeHarness: (input: unknown) => { requests.push(input); return new Promise((resolve) => { finish = resolve; }); },
  } } });
  let reloads = 0;
  const mounted = mount(AgentInspectorSettings, settingsProps({ resource: ownSetupResource(), onReload: () => { reloads += 1; } }));
  try {
    await settle();
    (ownSetupSwitch(mounted.root)!.props.onClick as () => void)();
    await settle();
    const saving = ownSetupSwitch(mounted.root)!;
    assert.equal(saving.props["aria-checked"], true, "the switch shows what was asked for while it is saved");
    assert.equal(saving.props["aria-disabled"], true, "and that it is busy");
    // Clicked again, and a third time, before the app has answered.
    (saving.props.onClick as () => void)();
    (ownSetupSwitch(mounted.root)!.props.onClick as () => void)();
    await settle();
    assert.equal(requests.length, 1, "only the first click is sent");
    assert.equal(ownSetupSwitch(mounted.root)!.props["aria-checked"], true, "and it is not flipped back");
    assert.equal(reloads, 0);
    finish({ outcome: "updated", configuration: {} });
    await settle();
    assert.equal(reloads, 1, "the one answer is followed by one read of the saved settings");
    assert.equal(ownSetupSwitch(mounted.root)!.props["aria-disabled"], undefined);
    assert.equal(requests.length, 1);
  } finally { mounted.app.unmount(); delete (window as unknown as Record<string, unknown>).letagentsDesktop; }
});

test("with the owner's setup on, each access level says what still asks, the move warns, and saved tool permissions are spoken to", async () => {
  const rule = { id: "rule", revision: 1, ownerId: "host", createdAtMs: 1, scope: { toolLabel: "Bash", projectName: "Do App" } };
  const find = (root: HostNode, id: string) => descendants(root).find((node) => node.props["data-testid"] === id);
  for (const [enabled, rules] of [[true, [rule]], [true, []], [false, [rule]]] as const) {
    Object.assign(window, { letagentsDesktop: { supervisor: {
      setAgentHomeHarness: async () => ({ outcome: "invalid", error: "unused" }), listHostToolRules: async () => rules,
    } } });
    const mounted = mount(AgentInspectorSettings, settingsProps({ resource: ownSetupResource({
      provider: "claude-code", permissionProfileId: "ask_before_write", reasoningEffort: null,
      homeHarness: { enabled, pending: false, availability: "available" },
      supervisedPermissionProfiles: [{ id: "ask_before_write", label: "Ask before writes", description: "From the background service.", status: "available", risk: "medium", detail: null, isDefault: false }],
    }) }));
    try {
      await settle();
      const text = textContent(mounted.root);
      const ownerLimits = /Asks before it changes files or runs write commands, except where your own Claude Code rules already allow it\. Your hooks run without asking\./;
      const isolatedLimits = /Can't change files or run write commands until you approve each one\./;
      assert.equal(ownerLimits.test(text), enabled, `on=${enabled}`);
      assert.equal(isolatedLimits.test(text), !enabled, `on=${enabled}: the unconditional promise is shown only where it is true`);
      // Moving the agent takes the switch with it, and says so beside the move.
      const move = find(mounted.root, "agent-inspector-move-own-setup");
      assert.equal(Boolean(move), enabled);
      if (move) {
        assert.match(textContent(move), /This agent keeps using your own Claude Code setup after a move\. Anyone who can message it in the room you move it to can ask it to use your tools\./);
        assert.equal(move.props.role, "alert");
        assert.equal(move.props["data-tone"], "warning");
      }
      // Tools under Always allowed stop applying when this changes, and the toggle says so when there are any.
      const rulesNote = find(mounted.root, "agent-inspector-home-harness-rules");
      assert.equal(Boolean(rulesNote), rules.length > 0, `rules=${rules.length}`);
      if (rulesNote) assert.match(textContent(rulesNote), /Changing this pauses the tools under Always allowed\. They stay listed but stop applying, so the agent asks again\. Changing it back restores them\./);
    } finally { mounted.app.unmount(); delete (window as unknown as Record<string, unknown>).letagentsDesktop; }
  }
});

test("a working agent that kept the owner's setup is not restarted, and the panel says it still has it", async () => {
  for (const [restart, expected] of [
    ["busy", "This agent is working, so it was not restarted yet. It keeps your setup until this turn ends, then restarts before it takes another."],
    ["not_restarted", "This agent was not restarted. If it is running, it keeps your setup until it restarts."],
  ] as const) {
    const saved = Vue.ref(ownSetupResource({ homeHarness: { enabled: true, pending: false, availability: "available" } }));
    Object.assign(window, { letagentsDesktop: { supervisor: { setAgentHomeHarness: async () => ({ outcome: "updated", configuration: saved.value.configuration, restart }) } } });
    const mounted = mount({ setup: () => () => Vue.h(AgentInspectorSettings, settingsProps({
      resource: saved.value,
      onReload: () => { saved.value = ownSetupResource({ homeHarness: { enabled: false, pending: true, availability: "available" }, configRevision: 5 }); },
    })) }, {});
    try {
      await settle();
      (ownSetupSwitch(mounted.root)!.props.onClick as () => void)();
      await settle();
      const note = descendants(mounted.root).find((node) => node.props["data-testid"] === "agent-inspector-home-harness-restart")!;
      assert.equal(textContent(note), expected);
      assert.equal(note.props["data-tone"], "warning");
      assert.equal(ownSetupSwitch(mounted.root)!.props["aria-checked"], false, "the saved choice is off");
    } finally { mounted.app.unmount(); delete (window as unknown as Record<string, unknown>).letagentsDesktop; }
  }
});

test("the inspector header marks an agent that is set to use the owner's own setup", async () => {
  for (const [homeHarness, label, title] of [
    ["on", "Your setup", "This agent uses your own Codex setup."],
    ["after_restart", "Setup pending", "This agent is set to use your own Codex setup. It gets it the next time it starts."],
    ["until_restart", "Setup ending", "You turned this off, but this agent is still running with your own Codex setup. It loses it when it restarts."],
    [undefined, null, null],
  ] as const) {
    const state = troubleshootingProps();
    Object.assign(state.projection.entry, {
      displayName: "QuartzMeadow", createdBy: "owner", charter: "Notes", provider: "codex", deliveryMode: "daemon_inbox",
      observedState: "idle", condition: "none", runtimeGenerationId: "runtime_a",
      providerContinuationId: "continuation_a", workAttemptId: "attempt_a", lastTerminal: null,
      turnControl: null, lastTurnControlSequence: 0, ...(homeHarness ? { homeHarness } : {}),
    });
    state.projection.entry.roomAgentState.task = { state: "none", taskId: null, title: null };
    state.projection = projectAgentInspector(state.projection.entry, { roomId: "room_a" });
    const mounted = mount(AgentInspectorSurface, {
      ...state, compact: false, initialTab: "overview", actionState: null, requestVersion: 1, selectedWorkSourceMessageId: null,
      workArtifacts: [], settingsResource: readyResource, roomMoveResource: noMove, roomMoveAvailable: false,
      providers: [], destinations: [], settingsConflict: false, liveFeed: { events: [], ended: false, droppedEvents: 0 },
    });
    await settle();
    const badge = descendants(mounted.root).find((node) => node.props["data-testid"] === "agent-inspector-own-setup");
    if (homeHarness) {
      assert.ok(badge);
      assert.equal(textContent(badge), label);
      assert.equal(badge.props.title, title);
    } else {
      assert.equal(badge, undefined, "an agent without it carries no mark");
    }
    mounted.app.unmount();
  }
});
