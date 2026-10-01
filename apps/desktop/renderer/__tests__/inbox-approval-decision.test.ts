import assert from "node:assert/strict";
import { after, before, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import * as Vue from "vue";
import { computed, createRenderer, defineComponent, h, nextTick, ref, ssrContextKey } from "vue";
import { createServer, type ViteDevServer } from "vite";
import type { DesktopHostApproval } from "../../shared/host-approvals";
import type { DesktopNeedsYou } from "../../electron/ipc-types/knowledge.js";

interface HostNode {
  type?: string; text: string; children: HostNode[]; parent: HostNode | null; props: Record<string, unknown>;
  focus: () => void; getBoundingClientRect: () => { top: number; left: number };
  addEventListener: () => void; removeEventListener: () => void; getRootNode: () => { activeElement: null };
  // What Vue's list transition reads from an element.
  nodeType: number; readonly parentNode: HostNode | null; style: Record<string, string>; classList: Set<string>;
  cloneNode: () => HostNode; appendChild: (child: HostNode) => void; removeChild: (child: HostNode) => void;
}

/** Element nodes, so the real list transition treats them as elements. */
class HostElement {}
let focused: HostNode | null = null;
function hostNode(type?: string, text = ""): HostNode {
  const node: HostNode = { type, text, children: [], parent: null, props: {},
    focus: () => { focused = node; }, getBoundingClientRect: () => ({ top: 0, left: 0 }),
    // Form directives such as the room search's v-model listen on their element.
    addEventListener: () => undefined, removeEventListener: () => undefined, getRootNode: () => ({ activeElement: null }),
    nodeType: type ? 1 : 3, get parentNode() { return node.parent; }, style: {}, classList: new Set<string>(),
    cloneNode: () => hostNode(type), appendChild: (child) => { node.children.push(child); child.parent = node; },
    removeChild: (child) => { node.children.splice(node.children.indexOf(child), 1); child.parent = null; } };
  return type ? Object.setPrototypeOf(node, HostElement.prototype) : node;
}

const renderer = createRenderer<HostNode, HostNode>({
  patchProp(node, key, _previous, next) { node.props[key] = next; },
  insert(child, parent, anchor) {
    // Moving a node takes it out of its old place first, as the DOM does.
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index >= 0) parent.children.splice(index, 0, child); else parent.children.push(child);
    child.parent = parent;
  },
  remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; },
  createElement: (type) => hostNode(type),
  createText: (text) => hostNode(undefined, text),
  createComment: (text) => hostNode(undefined, text),
  setText(node, text) { node.text = text; },
  setElementText(node, text) { node.children = [hostNode(undefined, text)]; },
  parentNode: (node) => node.parent,
  nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
});

const descendants = (node: HostNode): HostNode[] => [node, ...node.children.flatMap(descendants)];
const text = (node: HostNode) => descendants(node).map(child => child.text).join("");

let vite: ViteDevServer;
let InboxView: object;
/** InboxView with the real list transition instead of a pass-through. */
let InboxViewWithListTransition: object;
let store: typeof import("../src/components/desktop/content/room-chat/host-approvals");
let attention: typeof import("../src/components/desktop/content/room-inbox/agent-attention");

before(async () => {
  Object.assign(globalThis, { document: { addEventListener: () => undefined, removeEventListener: () => undefined } });
  vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  InboxView = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/InboxView.vue")).default;
  store = await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-chat/host-approvals.ts");
  attention = await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-inbox/agent-attention.ts");
  // Mount the real template with a renderer that records the host tree. The
  // list animation has no layout to measure here, so it renders its children.
  const modulePath = "components/desktop/content/InboxView.vue";
  const source = await readFile(fileURLToPath(new URL(`../src/${modulePath}`, import.meta.url)), "utf8");
  const descriptor = parse(source, { filename: modulePath }).descriptor;
  const script = compileScript(descriptor, { id: modulePath });
  const compiled = compileTemplate({ source: descriptor.template!.content, filename: modulePath, id: modulePath, compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(compiled.errors, []);
  const code = compiled.code
    .replace(/^import \{([\s\S]*?)\} from "vue"\n/, (_match, bindings: string) => `const {${bindings.replace(/\s+as\s+/g, ": ")}} = vue\n`)
    .replace("export function render", "function render");
  const ListPassThrough = defineComponent((_props, { slots }) => () => h("div", slots.default?.()));
  (InboxView as { render?: unknown }).render = Function("vue", `${code}\nreturn render;`)({ ...Vue, TransitionGroup: ListPassThrough });
  InboxViewWithListTransition = { ...InboxView, render: Function("vue", `${code}\nreturn render;`)(Vue) };
});

after(async () => { await vite?.close(); });

const approval: DesktopHostApproval = { id: "presentation-1", status: "pending", detail: null, retryDecision: null, dismissKey: null,
  presentation: { agentId: "supervised_copper", displayName: "CopperRidge", provider: "open-model", title: "Run a command",
    details: JSON.stringify({ permission: "bash", patterns: ["git status"] }), denyScope: "session_pending" } };
const data: DesktopNeedsYou = { rooms: [{ roomIdentifier: "room-a", displayName: "fern-reef", records: [], tasks: [], truncated: false }],
  failures: [], limited: false, signedOut: false, cloudUnavailable: false };

/** A request selected for you waits HOST_APPROVAL_SETTLE_MS before its actions wake; tests that act on it wait that out. */
async function settle(context: TestContext) {
  context.mock.timers.tick(400);
  await nextTick();
}

/** Mount the Inbox with one pending approval in room-a, derived as App derives it, and decide it. */
async function decideOnlyApproval(context: TestContext, rooms = ref<string[]>([])) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  Object.assign(globalThis, { window: { letagentsDesktop: { supervisor: {
    listHostApprovals: async () => ({ available: true, approvals: [structuredClone(approval)], error: null }),
    decideHostApproval: async () => "decision_sent",
  } } } });
  store.resetHostApprovals();
  await store.refreshHostApprovals("room-a");
  const Harness = defineComponent(() => {
    const items = computed(() => attention.buildAgentAttentionItems({ approvalRooms: store.hostApprovalRooms(), nowMs: Date.now() }));
    return () => h(InboxView, { data, attention: items.value, rooms: rooms.value, loading: false, error: "" });
  });
  const root = hostNode("root");
  const app = renderer.createApp(Harness);
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.mount(root);
  await settle(context);
  const allow = descendants(root).find(node => node.type === "button" && text(node) === "Allow once");
  assert.ok(allow, "the approval offers Allow once");
  await (allow.props.onClick as () => Promise<void>)();
  await nextTick(); await nextTick();
  return { root, app };
}

test("deciding the only Needs you item keeps it open with its result and focuses its heading", async (context) => {
  const { root, app } = await decideOnlyApproval(context);
  try {
    const page = text(root);
    assert.doesNotMatch(page, /You’re clear for now/, "the decided item does not give way to the empty state");
    assert.match(page, /Decision sent/);
    const heading = descendants(root).find(node => node.type === "h2" && node.props.id === "request-title");
    assert.ok(heading, "the detail pane stays mounted");
    assert.match(text(heading), /CopperRidge · Run a command/);
    assert.equal(focused, heading, "focus moves to the decided item's heading");
  } finally { app.unmount(); }
});

test("filtering the decided item's room out of view lets it go", async (context) => {
  const rooms = ref<string[]>([]);
  const { root, app } = await decideOnlyApproval(context, rooms);
  try {
    assert.match(text(root), /Decision sent/);
    rooms.value = ["room-b"];
    await nextTick(); await nextTick();
    assert.doesNotMatch(text(root), /CopperRidge · Run a command|Decision sent/, "room-a's decision is not shown under room-b");
  } finally { app.unmount(); }
});

const approvalNamed = (id: string, displayName: string, command: string, requestKey: string | null = null): DesktopHostApproval => ({
  ...structuredClone(approval), id, requestKey,
  presentation: { ...approval.presentation, displayName, details: JSON.stringify({ permission: "bash", patterns: [command] }) },
});
const boardIntent = (id: string, createdAt: string) => ({ kind: "board_intent" as const, key: JSON.stringify(["room-a", "board-intent", id]),
  roomIdentifier: "room-a", timestamp: createdAt, intent: { id, taskId: "task_6", actionType: "task_claim", status: "pending",
    proposerActorLabel: "LunarAmber | Someone's agent | Open Model", payload: { task_id: "task_6", assignee: "LunarAmber | Someone's agent | Open Model" },
    createdAt, expiresAt: null } });
const queueTitles = (root: HostNode) => descendants(root).filter(node => node.type === "button" && node.props.class === "knowledge-queue-item")
  .map(node => text(descendants(node).find(child => child.type === "strong")!));
const detailTitle = (root: HostNode) => text(descendants(root).find(node => node.type === "h2" && node.props.id === "request-title")!);

/** Mount the Inbox over a live approval list for room-a plus any extra attention items. */
async function mountQueue(context: TestContext, listed: { approvals: DesktopHostApproval[] }, extra = ref<AgentAttentionItemLike[]>([]),
  { component = InboxView, platform = {} }: { component?: object; platform?: Record<string, unknown> } = {}) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  Object.assign(globalThis, { window: { ...platform, matchMedia: () => ({ matches: false }), letagentsDesktop: { supervisor: {
    listHostApprovals: async () => ({ available: true, approvals: structuredClone(listed.approvals), error: null }),
    decideHostApproval: async () => "decision_sent",
  } } } });
  store.resetHostApprovals();
  await store.refreshHostApprovals("room-a");
  const Harness = defineComponent(() => {
    const items = computed(() => [...attention.buildAgentAttentionItems({ approvalRooms: store.hostApprovalRooms(), nowMs: Date.now() }), ...extra.value]);
    return () => h(component, { data, attention: items.value, loading: false, error: "" });
  });
  const root = hostNode("root");
  const app = renderer.createApp(Harness);
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.mount(root);
  await nextTick();
  await settle(context);
  return { root, app };
}
type AgentAttentionItemLike = ReturnType<typeof boardIntent>;
const clickButton = async (root: HostNode, label: string) => {
  const button = descendants(root).find(node => node.type === "button" && text(node) === label);
  assert.ok(button, `the ${label} button is shown`);
  await (button.props.onClick as () => Promise<void>)();
  await nextTick(); await nextTick();
};

test("a decision moves on to the next request in its place and says what was sent", async (context) => {
  const { root, app } = await mountQueue(context, { approvals: [approvalNamed("p-1", "CopperRidge", "git status"), approvalNamed("p-2", "SparrowReef", "npm test")] });
  try {
    assert.deepEqual(queueTitles(root), ["CopperRidge · Run a command", "SparrowReef · Run a command"]);
    assert.equal(detailTitle(root), "CopperRidge · Run a command");
    await clickButton(root, "Allow once");
    assert.equal(detailTitle(root), "SparrowReef · Run a command", "the next request is selected explicitly");
    assert.deepEqual(queueTitles(root), ["SparrowReef · Run a command"]);
    const status = descendants(root).find(node => node.type === "p" && node.props.role === "status" && /Decision sent/.test(text(node)));
    assert.ok(status, "the outcome of the previous decision is announced");
    assert.match(text(status), /Decision sent: CopperRidge · Run a command/);
    const allow = descendants(root).find(node => node.type === "button" && text(node) === "Allow once")!;
    assert.equal(allow.props.disabled, true, "the next request's decisions wait until it settles under the pointer");
  } finally { app.unmount(); }
});

test("new requests never move the selected row, whether chosen or shown first", async (context) => {
  const listed = { approvals: [approvalNamed("p-1", "CopperRidge", "git status"), approvalNamed("p-2", "SparrowReef", "npm test")] };
  const extra = ref<AgentAttentionItemLike[]>([]);
  const { root, app } = await mountQueue(context, listed, extra);
  try {
    // A board request waiting longer than both approvals sorts above them.
    extra.value = [boardIntent("bi_1", "2026-09-30T00:00:00.000Z")];
    await nextTick(); await nextTick();
    assert.deepEqual(queueTitles(root), ["CopperRidge · Run a command", "Assign task_6 to LunarAmber", "SparrowReef · Run a command"],
      "the arrival joins below the row on screen");
    assert.equal(detailTitle(root), "CopperRidge · Run a command");
    const second = descendants(root).filter(node => node.props.class === "knowledge-queue-item")[2]!;
    (second.props.onClick as () => void)();
    await nextTick();
    extra.value = [...extra.value, boardIntent("bi_0", "2026-09-29T00:00:00.000Z")];
    await nextTick(); await nextTick();
    assert.equal(queueTitles(root).indexOf("SparrowReef · Run a command"), 2, "the chosen row keeps its place");
    assert.equal(detailTitle(root), "SparrowReef · Run a command");
  } finally { app.unmount(); }
});

test("a decided row leaves the list at once, even while the window draws no frames", async (context) => {
  // Animation frames stop while the window is hidden or occluded. A CSS leave
  // transition waits for them, so the decided row stayed listed beside the next.
  const saved = { Element: (globalThis as Record<string, unknown>).Element, requestAnimationFrame: globalThis.requestAnimationFrame, document: globalThis.document };
  let frames = 0;
  Object.assign(globalThis, { Element: HostElement, requestAnimationFrame: () => ++frames,
    document: { ...globalThis.document, body: { offsetHeight: 0 } } });
  const getComputedStyle = () => ({ transitionDelay: "0s", transitionDuration: "0.13s", transitionProperty: "background-color, border-color",
    animationDelay: "0s", animationDuration: "0s" });
  const { root, app } = await mountQueue(context, { approvals: [approvalNamed("p-1", "CopperRidge", "git status"), approvalNamed("p-2", "SparrowReef", "npm test")] },
    undefined, { component: InboxViewWithListTransition, platform: { getComputedStyle } });
  try {
    assert.deepEqual(queueTitles(root), ["CopperRidge · Run a command", "SparrowReef · Run a command"]);
    await clickButton(root, "Allow once");
    assert.deepEqual(queueTitles(root), ["SparrowReef · Run a command"], "only the next request is listed");
    assert.equal(frames, 0, "without drawing a frame");
  } finally {
    app.unmount();
    Object.assign(globalThis, saved);
  }
});

test("a request withdrawn while selected gives way to the next, whose actions wait to settle", async (context) => {
  const listed = { approvals: [approvalNamed("p-1", "CopperRidge", "git status"), approvalNamed("p-2", "SparrowReef", "npm test")] };
  const { root, app } = await mountQueue(context, listed);
  try {
    assert.equal(detailTitle(root), "CopperRidge · Run a command");
    assert.equal(descendants(root).find(node => node.type === "button" && text(node) === "Allow once")!.props.disabled, false);
    // The turn ends, or the composer decides it: the request leaves the list.
    listed.approvals = [listed.approvals[1]!];
    await store.refreshHostApprovals("room-a");
    await nextTick(); await nextTick();
    assert.equal(detailTitle(root), "SparrowReef · Run a command", "the next request takes its place");
    const allow = () => descendants(root).find(node => node.type === "button" && text(node) === "Allow once")!;
    assert.equal(allow().props.disabled, true, "a click meant for the withdrawn request cannot answer this one");
    context.mock.timers.tick(400);
    await nextTick();
    assert.equal(allow().props.disabled, false);
  } finally { app.unmount(); }
});

test("the first request to arrive in an empty list waits to settle before it can be answered", async (context) => {
  const listed: { approvals: DesktopHostApproval[] } = { approvals: [] };
  const { root, app } = await mountQueue(context, listed);
  try {
    assert.equal(descendants(root).some(node => node.type === "h2" && node.props.id === "request-title"), false, "nothing to decide yet");
    listed.approvals = [approvalNamed("p-1", "CopperRidge", "git status")];
    await store.refreshHostApprovals("room-a");
    await nextTick(); await nextTick();
    assert.equal(detailTitle(root), "CopperRidge · Run a command");
    const allow = () => descendants(root).find(node => node.type === "button" && text(node) === "Allow once")!;
    assert.equal(allow().props.disabled, true, "a click aimed at the empty Inbox cannot answer it");
    await settle(context);
    assert.equal(allow().props.disabled, false);
  } finally { app.unmount(); }
});

test("a request presented again keeps one row and its selection", async (context) => {
  const listed = { approvals: [approvalNamed("p-1", "CopperRidge", "git status", "request-a"), approvalNamed("p-2", "SparrowReef", "npm test", "request-b")] };
  const { root, app } = await mountQueue(context, listed);
  try {
    const second = descendants(root).filter(node => node.props.class === "knowledge-queue-item")[1]!;
    (second.props.onClick as () => void)();
    await nextTick();
    // Main mints a new presentation ID for the same native request.
    listed.approvals = [listed.approvals[0]!, { ...listed.approvals[1]!, id: "p-2-again" }];
    await store.refreshHostApprovals("room-a");
    await nextTick(); await nextTick();
    assert.deepEqual(queueTitles(root), ["CopperRidge · Run a command", "SparrowReef · Run a command"], "no duplicate row");
    assert.equal(detailTitle(root), "SparrowReef · Run a command", "the same request stays selected");
  } finally { app.unmount(); }
});

test("answering one of several requests stays in Needs you and selects the next one", async () => {
  const { createKnowledgeRecord } = await import("../../../../shared/room-knowledge.mjs");
  const ask = (id: string, title: string, createdAt: string) => ({ ...createKnowledgeRecord("room-a", "attention",
    { client_id: `request-${id}`, category: "decision", title, body: "Choose one." }, { id: "agent", label: "HarborMarsh", kind: "agent" }, createdAt), id });
  const records = [ask("rec_1", "Pick a launch date", "2026-09-30T10:00:00.000Z"), ask("rec_2", "Name the release", "2026-09-30T09:00:00.000Z")];
  const responses: unknown[] = [];
  // The response box's v-model checks the document it belongs to.
  Object.assign(globalThis, { Document: class Document {}, ShadowRoot: class ShadowRoot {} });
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }), letagentsDesktop: { room: {
    reviseKnowledge: async (_room: string, _type: string, id: string, input: { expected_version: number; response: string }) => {
      responses.push({ id, ...input });
      const record = records.find(item => item.id === id)!;
      return { ...record, version: record.version + 1, response: { body: input.response, actor: { id: "owner", label: "Owner", kind: "human" }, at: "2026-09-30T11:00:00.000Z" } };
    },
  } } } });
  const section = ref<"needs-you" | "updates" | "answered">("needs-you");
  const Harness = defineComponent(() => () => h(InboxView, { data: { ...data, rooms: [{ ...data.rooms[0]!, records }] }, loading: false, error: "",
    section: section.value, "onUpdate:section": (next: typeof section.value) => { section.value = next; } }));
  const root = hostNode("root");
  const app = renderer.createApp(Harness);
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.mount(root);
  try {
    await nextTick();
    assert.equal(detailTitle(root), "Pick a launch date");
    const textarea = descendants(root).find(node => node.type === "textarea")!;
    (textarea.props["onUpdate:modelValue"] as (value: string) => void)("Next Tuesday");
    await nextTick();
    const form = descendants(root).find(node => node.type === "form")!;
    await (form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => undefined });
    await new Promise(resolve => setImmediate(resolve)); await nextTick(); await nextTick();
    assert.deepEqual(responses, [{ id: "rec_1", expected_version: 1, response: "Next Tuesday" }]);
    assert.equal(section.value, "needs-you", "the view stays on the remaining requests");
    assert.equal(detailTitle(root), "Name the release");
    assert.deepEqual(queueTitles(root), ["Name the release"], "the answered request leaves Needs you at once");
    assert.ok(descendants(root).some(node => node.props.role === "status" && /Answer sent: Pick a launch date/.test(text(node))));
  } finally { app.unmount(); }
});
