import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { parse, compileScript, compileTemplate } from "@vue/compiler-sfc";
import * as Vue from "vue";
import { createRenderer, nextTick, ssrContextKey, type App } from "vue";
import { createServer, type ViteDevServer } from "vite";
import { createRoomDeliveryRetryCoordinator } from "../src/domain/room-delivery-retry";

interface HostNode {
  kind: "element" | "text" | "comment";
  type?: string;
  text: string;
  children: HostNode[];
  parent: HostNode | null;
  props: Record<string, unknown>;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  classList: { add: (...names: string[]) => void; remove: (...names: string[]) => void };
  focus: (_options?: FocusOptions) => void;
  scrollTo: (_options?: ScrollToOptions) => void;
  querySelector: (_selector: string) => null;
  addEventListener: (_name: string, _listener: EventListener) => void;
  removeEventListener: (_name: string, _listener: EventListener) => void;
}

function hostNode(kind: HostNode["kind"], type?: string, text = ""): HostNode {
  return {
    kind, type, text, children: [], parent: null, props: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    classList: { add: () => undefined, remove: () => undefined }, focus: () => undefined, scrollTo: () => undefined,
    querySelector: () => null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
  };
}

const teleportTarget = hostNode("element", "body");
// The custom renderer deliberately has no browser DOM. These narrow platform
// shims cover lifecycle cleanup and scroll helpers while leaving all DOM
// assertions below against the renderer's own host tree.
Object.assign(globalThis, {
  window: {
    setTimeout, clearTimeout, addEventListener: () => undefined, removeEventListener: () => undefined,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout, innerWidth: 1200, innerHeight: 800,
    location: { href: "http://localhost/" }, getSelection: () => null,
    document: { documentElement: { style: { scrollBehavior: "" } } },
  },
  document: { documentElement: { style: { scrollBehavior: "" } } },
});

const renderer = createRenderer<HostNode, HostNode>({
  patchProp(node, key, _previous, next) { node.props[key] = next; },
  insert(child, parent, anchor) {
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index >= 0) parent.children.splice(index, 0, child); else parent.children.push(child);
    child.parent = parent;
  },
  remove(child) {
    const parent = child.parent;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(child), 1);
    child.parent = null;
  },
  createElement: (type) => hostNode("element", type),
  createText: (text) => hostNode("text", undefined, text),
  createComment: (text) => hostNode("comment", undefined, text),
  setText(node, text) { node.text = text; },
  setElementText(node, text) { node.children = [hostNode("text", undefined, text)]; },
  parentNode: (node) => node.parent,
  nextSibling(node) {
    const siblings = node.parent?.children || [];
    return siblings[siblings.indexOf(node) + 1] || null;
  },
  insertStaticContent(content, parent, anchor) {
    const node = hostNode("text", undefined, content);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index >= 0) parent.children.splice(index, 0, node); else parent.children.push(node);
    node.parent = parent;
    return [node, node];
  },
  querySelector: () => teleportTarget,
});

function descendants(node: HostNode): HostNode[] {
  return [node, ...node.children.flatMap(descendants)];
}

function buttons(root: HostNode): HostNode[] {
  return descendants(root).filter((node) => node.type === "button");
}

function buttonByText(root: HostNode, text: string): HostNode {
  const button = buttons(root).find((node) => descendants(node).some((child) => child.text === text));
  assert.ok(button, `expected a ${text} button`);
  return button;
}

function message(id = "message_1") {
  return {
    id,
    sender: "Emmy",
    text: "Please investigate this",
    attachments: [],
    agentPromptKind: null,
    source: "browser",
    timestamp: "2026-07-20T12:00:00.000Z",
    actorLabel: null,
    agentIdentity: null,
    threadRootId: null,
    threadReplyToId: null,
    thread: null,
    replyTo: null,
  };
}

const emptyThreadSummary = {
  count: 0, unreadCount: 0, latest: null, latestPreview: null, latestTimestamp: null,
  participants: [], hasPartialHistory: false, loadingEarlier: false,
};

let vite: ViteDevServer;
let DesktopChatMessage: object;
let RoomMessageViewport: object;
let RoomThreadPanel: object;
let DesktopLongMessageContent: object;
let DesktopAttachmentDrafts: object;

async function attachClientRender(component: object, modulePath: string): Promise<void> {
  const source = await readFile(fileURLToPath(new URL(`../src/${modulePath}`, import.meta.url)), "utf8");
  const descriptor = parse(source, { filename: modulePath }).descriptor;
  assert.ok(descriptor.template, `${modulePath} must have a template`);
  const script = compileScript(descriptor, { id: modulePath });
  const compiled = compileTemplate({
    source: descriptor.template.content,
    filename: modulePath,
    id: modulePath,
    compilerOptions: { bindingMetadata: script.bindings },
  });
  assert.deepEqual(compiled.errors, [], `client template compilation failed for ${modulePath}`);
  const clientCode = compiled.code
    .replace(/^import \{([\s\S]*?)\} from "vue"\n/, (_match, bindings: string) => `const {${bindings.replace(/\s+as\s+/g, ": ")}} = vue\n`)
    .replace("export function render", "function render");
  (component as { render?: unknown }).render = Function("vue", `${clientCode}\nreturn render;`)(Vue);
}

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent",
    server: { middlewareMode: true },
  });
  [DesktopChatMessage, RoomMessageViewport, RoomThreadPanel, DesktopLongMessageContent, DesktopAttachmentDrafts] = await Promise.all([
    vite.ssrLoadModule("/renderer/src/components/desktop/content/DesktopChatMessage.vue").then((module) => module.default),
    vite.ssrLoadModule("/renderer/src/components/desktop/content/room-chat/RoomMessageViewport.vue").then((module) => module.default),
    vite.ssrLoadModule("/renderer/src/components/desktop/content/room-chat/RoomThreadPanel.vue").then((module) => module.default),
    vite.ssrLoadModule("/renderer/src/components/desktop/content/DesktopLongMessageContent.vue").then((module) => module.default),
    vite.ssrLoadModule("/renderer/src/components/desktop/content/DesktopAttachmentDrafts.vue").then((module) => module.default),
  ]);
  await Promise.all([
    attachClientRender(DesktopChatMessage, "components/desktop/content/DesktopChatMessage.vue"),
    attachClientRender(RoomMessageViewport, "components/desktop/content/room-chat/RoomMessageViewport.vue"),
    attachClientRender(RoomThreadPanel, "components/desktop/content/room-chat/RoomThreadPanel.vue"),
    attachClientRender(DesktopLongMessageContent, "components/desktop/content/DesktopLongMessageContent.vue"),
    attachClientRender(DesktopAttachmentDrafts, "components/desktop/content/DesktopAttachmentDrafts.vue"),
  ]);
});

after(async () => { await vite?.close(); });

function mount(component: object, props: Record<string, unknown>): { root: HostNode; app: App } {
  const root = hostNode("element", "root");
  const app = renderer.createApp(component, props);
  // Vite's SSR module loader compiles script setup for SSR. Supplying its
  // context lets that setup run while the client template above is mounted by
  // the custom renderer.
  app.provide(ssrContextKey, { modules: new Set<string>() });
  for (const name of ["DesktopGitHubEventCard", "DesktopLongMessageContent", "DesktopMessageAttachments", "ProviderBadge", "Check", "Copy", "CornerUpLeft", "LocateFixed", "MessageSquare", "X", "MessageSquarePlus", "Paperclip", "Send"]) {
    app.component(name, { render: () => null });
  }
  app.component("DesktopChatMessage", DesktopChatMessage);
  app.mount(root);
  return { root, app };
}

test("mounted shared message retry button is a native, exact, capability-aware control", async () => {
  const calls: Array<[string, string]> = [];
  const base = {
    message: message(), threadSummary: emptyThreadSummary, activeThreadRoot: false,
    highlightQuery: "", searchActive: false,
    deliveryReceipts: [{ agentId: "oak", agentName: "Oak", state: "blocked", blockedByMessageId: null }],
    onRetryDelivery: (agentId: string, sourceMessageId: string) => calls.push([agentId, sourceMessageId]),
  };

  const unavailable = mount(DesktopChatMessage, { ...base, deliveryRecoveryAvailable: false });
  const unavailableButton = buttonByText(unavailable.root, "Retry unavailable");
  assert.equal(unavailableButton.props.type, "button", "the browser supplies Enter/Space button activation semantics");
  assert.equal(unavailableButton.props.disabled, true);
  assert.equal(unavailableButton.props["aria-label"], "Retry delivery for Oak is unavailable");
  assert.equal(calls.length, 0);
  unavailable.app.unmount();

  const available = mount(DesktopChatMessage, { ...base, deliveryRecoveryAvailable: true });
  const retryButton = buttonByText(available.root, "Retry");
  assert.equal(retryButton.props.type, "button");
  assert.equal(retryButton.props.disabled, false);
  (retryButton.props.onClick as () => void)();
  assert.deepEqual(calls, [["oak", "message_1"]], "one activation carries exactly the receipt identity");
  available.app.unmount();

  const busy = mount(DesktopChatMessage, {
    ...base,
    deliveryRecoveryAvailable: true,
    deliveryRetryKeys: new Set(["oak:message_1"]),
    deliveryReceipts: [
      { agentId: "oak", agentName: "Oak", state: "blocked", blockedByMessageId: null },
      { agentId: "pine", agentName: "Pine", state: "blocked", blockedByMessageId: null },
    ],
  });
  const [oakButton, pineButton] = buttons(busy.root).filter((node) => node.props["aria-label"] === "Retry delivery for Oak is unavailable" || node.props["aria-label"] === "Retry delivery for Pine");
  assert.equal(oakButton?.props.disabled, true, "only the matching agent receipt is busy");
  assert.equal(pineButton?.props.disabled, false, "another agent can retry the same message concurrently");
  busy.app.unmount();
});

test("missing-conversation controls render only before provider work starts", () => {
  const restores: Array<[string, string]> = [];
  const skips: Array<[string, string]> = [];
  const base = {
    message: message(),
    threadSummary: emptyThreadSummary,
    activeThreadRoot: false,
    highlightQuery: "",
    searchActive: false,
    continuationRepairAvailable: true,
    roomDeliverySkipAvailable: true,
    onRestoreConversation: (agentId: string, sourceMessageId: string) => restores.push([agentId, sourceMessageId]),
    onSkipDelivery: (agentId: string, sourceMessageId: string) => skips.push([agentId, sourceMessageId]),
  };
  const safeReceipt = {
    agentId: "oak",
    agentName: "Oak",
    state: "blocked",
    blockedByMessageId: null,
    failureCode: "provider_continuation_missing",
    attemptCount: 0,
    providerTurnId: null,
  };
  const safe = mount(DesktopChatMessage, { ...base, deliveryReceipts: [safeReceipt] });
  const restoreButton = buttonByText(safe.root, "Restore and retry");
  const skipButton = buttonByText(safe.root, "Skip message");
  (restoreButton.props.onClick as () => void)();
  (skipButton.props.onClick as () => void)();
  assert.deepEqual(restores, [["oak", "message_1"]]);
  assert.deepEqual(skips, [["oak", "message_1"]]);
  safe.app.unmount();

  const ambiguous = mount(DesktopChatMessage, {
    ...base,
    deliveryReceipts: [{ ...safeReceipt, attemptCount: 1, providerTurnId: "turn_started" }],
  });
  assert.equal(
    buttons(ambiguous.root).some((button) =>
      descendants(button).some((child) => child.text === "Restore and retry" || child.text === "Skip message")),
    false,
    "started provider work must never expose replacement or cancellation controls",
  );
  ambiguous.app.unmount();
});

test("mounted main viewport and thread panel forward the same retry event contract", async () => {
  const mainCalls: Array<[string, string]> = [];
  const viewport = mount(RoomMessageViewport, {
    active: true, activeSearchMessageId: null, activeThreadParentId: null, hasOlderMessages: false,
    loadingOlderMessages: false, messages: [message()], threadMessages: [], messageNamespace: "test",
    localAgentWork: [], deliveryReceiptsByMessage: { message_1: [{ agentId: "oak", agentName: "Oak", state: "blocked", blockedByMessageId: null }] },
    deliveryRecoveryAvailable: true, deliveryRetryKeys: new Set(), hasFilteredRoomActivity: false,
    roomIdentifier: "room", githubActivityAvailable: false, roomLoading: false, searchQuery: "", taskReferenceIds: new Set(),
    onRetryDelivery: (agentId: string, sourceMessageId: string) => mainCalls.push([agentId, sourceMessageId]),
  });
  (buttonByText(viewport.root, "Retry").props.onClick as () => void)();
  assert.deepEqual(mainCalls, [["oak", "message_1"]]);
  viewport.app.unmount();

  const threadCalls: Array<[string, string]> = [];
  const thread = mount(RoomThreadPanel, {
    parent: message(), initialThreadSummary: null, replies: [], participants: [], roomIdentifier: "room",
    sending: false, sendError: null, attaching: false, attachmentDrafts: [], attachmentError: null,
    pendingAttachmentDrafts: [], hasOlderReplies: false, loadingOlderReplies: false, revealMessageId: null,
    searchQuery: "", activeSearchMessageId: null, taskReferenceIds: new Set(),
    deliveryReceiptsByMessage: { message_1: [{ agentId: "oak", agentName: "Oak", state: "blocked", blockedByMessageId: null }] },
    deliveryRecoveryAvailable: true, deliveryRetryKeys: new Set(),
    onRetryDelivery: (agentId: string, sourceMessageId: string) => threadCalls.push([agentId, sourceMessageId]),
  });
  (buttonByText(thread.root, "Retry").props.onClick as () => void)();
  assert.deepEqual(threadCalls, [["oak", "message_1"]]);
  thread.app.unmount();
  await nextTick();
});

test("retry coordinator suppresses duplicate receipts and isolates concurrent successes and failures", async () => {
  const coordinator = createRoomDeliveryRetryCoordinator();
  let resolveOak!: (value: "accepted") => void;
  let rejectPine!: (reason: Error) => void;
  const oak = coordinator.run({ agentId: "oak", sourceMessageId: "message_1" }, () => new Promise<"accepted">((resolve) => { resolveOak = resolve; }));
  const duplicate = await coordinator.run({ agentId: "oak", sourceMessageId: "message_1" }, async () => "must not run");
  const pine = coordinator.run({ agentId: "pine", sourceMessageId: "message_1" }, () => new Promise<never>((_resolve, reject) => { rejectPine = reject; }));

  assert.deepEqual(new Set(coordinator.retryingKeys.value), new Set(["oak:message_1", "pine:message_1"]));
  assert.deepEqual(duplicate, { started: false });

  resolveOak("accepted");
  const oakResult = await oak;
  assert.deepEqual(oakResult, { started: true, ok: true, value: "accepted" });
  assert.deepEqual(new Set(coordinator.retryingKeys.value), new Set(["pine:message_1"]));

  const failure = new Error("provider unreachable");
  rejectPine(failure);
  const pineResult = await pine;
  assert.equal(pineResult.started, true);
  assert.equal(pineResult.ok, false);
  if (!pineResult.ok && pineResult.started) assert.equal(pineResult.error, failure);
  assert.equal(coordinator.retryingKeys.value.size, 0);
});
