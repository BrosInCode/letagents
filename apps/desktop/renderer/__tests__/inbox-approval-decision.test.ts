import assert from "node:assert/strict";
import { after, before, test } from "node:test";
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
  addEventListener: () => void; removeEventListener: () => void;
}

let focused: HostNode | null = null;
function hostNode(type?: string, text = ""): HostNode {
  const node: HostNode = { type, text, children: [], parent: null, props: {},
    focus: () => { focused = node; }, getBoundingClientRect: () => ({ top: 0, left: 0 }),
    // Form directives such as the room search's v-model listen on their element.
    addEventListener: () => undefined, removeEventListener: () => undefined };
  return node;
}

const renderer = createRenderer<HostNode, HostNode>({
  patchProp(node, key, _previous, next) { node.props[key] = next; },
  insert(child, parent, anchor) {
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
});

after(async () => { await vite?.close(); });

const approval: DesktopHostApproval = { id: "presentation-1", status: "pending", detail: null, retryDecision: null, dismissKey: null,
  presentation: { agentId: "supervised_copper", displayName: "CopperRidge", provider: "open-model", title: "Run a command",
    details: JSON.stringify({ permission: "bash", patterns: ["git status"] }), denyScope: "session_pending" } };
const data: DesktopNeedsYou = { rooms: [{ roomIdentifier: "room-a", displayName: "fern-reef", records: [], tasks: [], truncated: false }],
  failures: [], limited: false, signedOut: false, cloudUnavailable: false };

/** Mount the Inbox with one pending approval in room-a, derived as App derives it, and decide it. */
async function decideOnlyApproval(rooms = ref<string[]>([])) {
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
  const allow = descendants(root).find(node => node.type === "button" && text(node) === "Allow once");
  assert.ok(allow, "the approval offers Allow once");
  await (allow.props.onClick as () => Promise<void>)();
  await nextTick(); await nextTick();
  return { root, app };
}

test("deciding the only Needs you item keeps it open with its result and focuses its heading", async () => {
  const { root, app } = await decideOnlyApproval();
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

test("filtering the decided item's room out of view lets it go", async () => {
  const rooms = ref<string[]>([]);
  const { root, app } = await decideOnlyApproval(rooms);
  try {
    assert.match(text(root), /Decision sent/);
    rooms.value = ["room-b"];
    await nextTick(); await nextTick();
    assert.doesNotMatch(text(root), /CopperRidge · Run a command|Decision sent/, "room-a's decision is not shown under room-b");
  } finally { app.unmount(); }
});
