import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse, compileScript, compileTemplate } from "@vue/compiler-sfc";
import * as Vue from "vue";
import { createRenderer, nextTick, ssrContextKey, type App } from "vue";
import { createServer, transformWithEsbuild, type ViteDevServer } from "vite";
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
  focus: () => void;
  contains: (candidate: unknown) => boolean;
  querySelector: (selector: string) => HostNode | null;
  querySelectorAll: (selector: string) => HostNode[];
  addEventListener: (name: string, listener: EventListener) => void;
  removeEventListener: (name: string, listener: EventListener) => void;
}

const documentListeners = new Map<string, Set<EventListener>>();
const testDocument = {
  activeElement: null as HostNode | null,
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
Object.assign(globalThis, { document: testDocument });

function descendants(node: HostNode): HostNode[] {
  return [node, ...node.children.flatMap(descendants)];
}

function matches(node: HostNode, selector: string): boolean {
  if (selector === "button:not([disabled])") return node.type === "button" && !node.props.disabled;
  if (selector === "button") return node.type === "button";
  return false;
}

function hostNode(type: string, text = ""): HostNode {
  const listeners = new Map<string, EventListener>();
  const node = {
    type,
    text,
    props: {},
    children: [],
    parent: null,
    focusCount: 0,
    value: "",
    options: [],
    focus() {
      node.focusCount += 1;
      testDocument.activeElement = node;
    },
    contains(candidate: unknown) {
      return descendants(node).includes(candidate as HostNode);
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
  querySelector: () => null,
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

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  AgentInspectorSettings = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorSettings.vue")).default;
  AgentInspectorLifecycleActions = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorLifecycleActions.vue")).default;
  await Promise.all([
    attachClientRender(AgentInspectorSettings, "components/desktop/content/agent-inspector/AgentInspectorSettings.vue"),
    attachClientRender(AgentInspectorLifecycleActions, "components/desktop/content/agent-inspector/AgentInspectorLifecycleActions.vue"),
  ]);
});

after(async () => {
  await vite?.close();
  if (originalDocument) Object.assign(globalThis, { document: originalDocument });
  else Reflect.deleteProperty(globalThis, "document");
});

const configuration = {
  entryId: "agent_a",
  daemonGeneration: 7,
  provider: "codex",
  model: "gpt-next",
  reasoningEffort: "high" as const,
  charter: "Coordinate work.",
  permissionProfileId: "full_access" as const,
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
    providerLaunchPolicy: configuration.providerLaunchPolicy,
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
  permissionProfiles: [],
  defaultPermissionProfileId: null,
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

test("mounted Settings and overflow use the same two-step retirement confirmation", async () => {
  let settingsRetires = 0;
  const settings = mount(AgentInspectorSettings, settingsProps({ onRetire: () => { settingsRetires += 1; } }));
  (buttonByText(settings.root, "Retire agent").props.onClick as () => void)();
  await nextTick();
  assert.equal(settingsRetires, 0);
  assert.match(textContent(settings.root), /history and worktree stay available/);
  (buttonByText(settings.root, "Confirm retire agent").props.onClick as () => void)();
  assert.equal(settingsRetires, 1);
  settings.app.unmount();

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
  (buttonByText(lifecycle.root, "Retire agent").props.onClick as () => void)();
  await nextTick();
  assert.deepEqual(emitted, []);
  assert.match(textContent(lifecycle.root), /history and worktree stay available/);
  (buttonByText(lifecycle.root, "Confirm retire agent").props.onClick as () => void)();
  assert.deepEqual(emitted, ["retire_agent"]);
  lifecycle.app.unmount();
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
    assert.equal(control.props.disabled, true);
  }
  assert.equal(buttonByText(busy.root, "Saving…").props.disabled, true);
  busy.app.unmount();

  const refreshing = mount(AgentInspectorSettings, settingsProps({
    resource: { ...readyResource, status: "refreshing" },
  }));
  assert.equal(buttonByText(refreshing.root, "Save changes").props.disabled, true);
  refreshing.app.unmount();
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
