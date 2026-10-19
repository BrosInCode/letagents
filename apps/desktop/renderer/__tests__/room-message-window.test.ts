import assert from "node:assert/strict";
import { after, before, describe, it, test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import * as Vue from "vue";
import { createRenderer, h, nextTick, ssrContextKey, type App } from "vue";
import { createServer, transformWithEsbuild, type ViteDevServer } from "vite";
import {
  anchoredScrollTop,
  grownDownwardState,
  grownUpwardState,
  indexEntriesByMessageId,
  messageWindowChunk,
  messageWindowReach,
  messageWindowSize,
  messageWindowTargetAbove,
  messageWindowTargetBelow,
  resolveWindowBounds,
  windowStateFor,
  windowStateIncluding,
  type MessageWindowState,
  type WindowEntry,
} from "../src/components/desktop/content/room-chat/message-window";

// ---------------------------------------------------------------------------
// Pure window rules
// ---------------------------------------------------------------------------

/** A timeline like buildMessageTimelineEntries makes: a day divider every 50 messages. */
function timeline(count: number, prefix = "m"): WindowEntry[] {
  const entries: WindowEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (index % 50 === 0) entries.push({ type: "date" });
    entries.push({ type: "message", message: { id: `${prefix}${index}` } });
  }
  return entries;
}

function bounds(entries: WindowEntry[], state: MessageWindowState, pins: string[] = []) {
  return resolveWindowBounds(entries, state, indexEntriesByMessageId(entries), pins);
}

describe("message mount window rules", () => {
  it("mounts only the newest entries of a long room, plus the day divider at the top edge", () => {
    const entries = timeline(5000);
    const { start, end } = bounds(entries, { kind: "latest" });
    assert.equal(end, entries.length);
    assert.ok(end - start <= messageWindowSize + 1, `${end - start} entries mounted`);
    assert.ok(end - start >= messageWindowSize);
    const short = timeline(30);
    assert.deepEqual(bounds(short, { kind: "latest" }), { start: 0, end: short.length });
  });

  it("includes the day divider directly above the first mounted entry", () => {
    const entries = timeline(500);
    const dividerIndex = entries.findIndex((entry, index) => index > 100 && entry.type === "date");
    const state = windowStateFor(entries, dividerIndex + 1, entries.length);
    assert.equal(bounds(entries, state).start, dividerIndex);
  });

  it("keeps a GitHub group whole and finds its members by message id", () => {
    const entries: WindowEntry[] = [...timeline(10), { type: "github-group", messages: [{ id: "g1" }, { id: "g2" }] }, ...timeline(5, "n")];
    const index = indexEntriesByMessageId(entries);
    assert.equal(index.get("g2"), 11);
    const state = windowStateFor(entries, 11, entries.length);
    assert.equal(bounds(entries, state).start, 11);
  });

  it("grows upward one chunk at a time and opens to the top of history at the start", () => {
    const entries = timeline(1000);
    let current = bounds(entries, { kind: "latest" });
    const grown = grownUpwardState(entries, current)!;
    const next = bounds(entries, grown);
    assert.ok(current.start - next.start >= messageWindowChunk && current.start - next.start <= messageWindowChunk + 1);
    assert.equal(next.end, entries.length, "growing upward keeps the newest entries");
    current = next;
    while (current.start > 0) current = bounds(entries, grownUpwardState(entries, current)!);
    assert.equal(grownUpwardState(entries, current), null, "at the top, older history comes from the server");
    const top = windowStateFor(entries, 0, entries.length);
    assert.deepEqual(top, { kind: "range", start: null, end: null });
    const withOlderPage = [...timeline(50, "old"), ...entries];
    assert.equal(bounds(withOlderPage, top).start, 0, "an older page mounts when the window is at the top");
  });

  it("keeps a fixed start when older pages arrive below the top", () => {
    const entries = timeline(1000);
    const state = grownUpwardState(entries, bounds(entries, { kind: "latest" }))!;
    const withOlderPage = [...timeline(50, "old"), ...entries];
    const after = bounds(withOlderPage, state);
    assert.equal(withOlderPage.length - after.start, entries.length - bounds(entries, state).start, "the same rows stay mounted");
  });

  it("a near jump target extends the window; a far one gets a detached window", () => {
    const entries = timeline(5000);
    const index = indexEntriesByMessageId(entries);
    const latest = bounds(entries, { kind: "latest" });
    const nearId = "m4700";
    const near = bounds(entries, windowStateIncluding(entries, latest, index, nearId)!);
    assert.equal(near.end, entries.length);
    assert.ok(near.start <= index.get(nearId)! - messageWindowTargetAbove + 1);
    const far = bounds(entries, windowStateIncluding(entries, latest, index, "m10")!);
    assert.ok(far.start <= index.get("m10")! && far.end > index.get("m10")!);
    assert.ok(far.end < entries.length, "a far target does not mount everything down to the newest");
    assert.ok(far.end - far.start <= messageWindowTargetAbove + messageWindowTargetBelow + 1);
    assert.equal(windowStateIncluding(entries, latest, index, "m4999"), null, "a mounted target needs no change");
    assert.equal(windowStateIncluding(entries, latest, index, "missing"), null, "an unloaded target falls back to history paging");
  });

  it("a target near the newest entries joins them instead of detaching", () => {
    const entries = timeline(5000);
    const index = indexEntriesByMessageId(entries);
    const detached = bounds(entries, windowStateIncluding(entries, bounds(entries, { kind: "latest" }), index, "m10")!);
    const target = `m${5000 - messageWindowSize - 20}`;
    const joined = bounds(entries, windowStateIncluding(entries, detached, index, target)!);
    assert.equal(joined.end, entries.length);
  });

  it("a detached window grows downward and joins the newest entries", () => {
    const entries = timeline(5000);
    const index = indexEntriesByMessageId(entries);
    let current = bounds(entries, windowStateIncluding(entries, bounds(entries, { kind: "latest" }), index, "m2000")!);
    const startBefore = current.start;
    let steps = 0;
    while (current.end < entries.length) {
      const next = bounds(entries, grownDownwardState(entries, current)!);
      assert.equal(next.start, startBefore, "growing downward never moves the top edge");
      assert.ok(next.end > current.end);
      current = next;
      steps += 1;
    }
    assert.ok(steps > 1);
    assert.equal(grownDownwardState(entries, current), null);
  });

  it("pulls a near pinned thread root inside the window, but not a far one", () => {
    const entries = timeline(5000);
    const latest = bounds(entries, { kind: "latest" });
    const index = indexEntriesByMessageId(entries);
    const nearRoot = `m${5000 - messageWindowSize - 50}`;
    const pinnedStart = bounds(entries, { kind: "latest" }, [nearRoot]).start;
    assert.ok(pinnedStart <= index.get(nearRoot)! && pinnedStart >= index.get(nearRoot)! - 1, "the root, with its day divider");
    const farRoot = `m${5000 - messageWindowSize - messageWindowReach - 200}`;
    assert.equal(bounds(entries, { kind: "latest" }, [farRoot]).start, latest.start);
  });

  it("falls back to the last index when the start message is gone", () => {
    const entries = timeline(1000);
    const state: MessageWindowState = { kind: "range", start: { messageId: "deleted", index: 400 }, end: null };
    assert.equal(bounds(entries, state).start, 400);
  });

  it("keeps the anchor row at the same screen offset after rows mount above it", () => {
    // Before: the anchor row is 12 px above the viewport top at scrollTop 150.
    // 100 rows of 40 px mount above it, so it is now 4000 px lower.
    assert.equal(anchoredScrollTop(150, -12, 3988), 4150);
    assert.equal(anchoredScrollTop(4150, -12, -4012), 150, "rows that leave above it move it back");
    assert.equal(anchoredScrollTop(10, 0, -50), 0);
  });
});

// ---------------------------------------------------------------------------
// The mounted viewport
// ---------------------------------------------------------------------------

const rowHeight = 40;

interface HostNode {
  kind: "element" | "text" | "comment";
  type?: string;
  text: string;
  children: HostNode[];
  parent: HostNode | null;
  props: Record<string, unknown>;
  style: Record<string, string>;
  [key: string]: unknown;
}

function elementChildren(node: HostNode): HostNode[] {
  return node.children.filter(child => child.kind === "element");
}

function heightOf(node: HostNode): number {
  const style = node.props.style as Record<string, string> | undefined;
  return style?.height ? Number.parseFloat(style.height) : rowHeight;
}

function isList(node: HostNode | null): boolean {
  return node?.props["data-testid"] === "room-chat-list";
}

function descendants(node: HostNode): HostNode[] {
  return [node, ...node.children.flatMap(descendants)];
}

function hostNode(kind: HostNode["kind"], type?: string, text = ""): HostNode {
  let scrollTop = 0;
  const node: HostNode = {
    kind, type, text, children: [], parent: null, props: {}, style: {},
    isConnected: true, clientHeight: 0,
    get dataset() {
      return { messageId: node.props["data-message-id"], scrollAnchorId: node.props["data-scroll-anchor-id"] };
    },
    get scrollHeight() {
      return isList(node) ? elementChildren(node).reduce((sum, child) => sum + heightOf(child), 0) : 0;
    },
    get scrollTop() { return scrollTop; },
    set scrollTop(value: number) {
      const max = Math.max(0, (node.scrollHeight as number) - (node.clientHeight as number));
      scrollTop = Math.max(0, Math.min(value, max));
    },
    getClientRects: () => (isList(node) ? [{}] : []),
    getRootNode: () => ({ activeElement: null }),
    getBoundingClientRect() {
      if (isList(node)) return { top: 0, bottom: node.clientHeight as number, left: 0, right: 800, width: 800, height: node.clientHeight as number };
      const list = node.parent;
      if (!isList(list)) return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
      let top = -(list!.scrollTop as number);
      for (const sibling of elementChildren(list!)) {
        if (sibling === node) break;
        top += heightOf(sibling);
      }
      return { top, bottom: top + heightOf(node), left: 0, right: 800, width: 800, height: heightOf(node) };
    },
    classList: { add: () => undefined, remove: () => undefined },
    focus: () => undefined, scrollTo: () => undefined, dispatchEvent: () => true, closest: () => null,
    scrollIntoView: () => { scrolledIntoView.push(String(node.props["data-message-id"])); },
    addEventListener: () => undefined, removeEventListener: () => undefined,
    querySelectorAll: (selector: string) => {
      if (!selector.includes("data-message-id")) return [];
      return elementChildren(node).filter(child => child.props["data-message-id"] || child.props["data-scroll-anchor-id"]);
    },
    querySelector: (selector: string) => {
      const match = /\[data-(testid|message-id)="([^"]+)"\]/.exec(selector);
      if (!match) return null;
      const [key, value] = match[1] === "testid" ? ["data-testid", match[2]] : ["data-message-id", match[2]];
      return descendants(node).find(child => child.props[key] === value) ?? null;
    },
  };
  return node;
}

const scrolledIntoView: string[] = [];

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
  createElement: (type) => { if (type === "article") articlesCreated.count += 1; return hostNode("element", type); },
  createText: (text) => hostNode("text", undefined, text),
  createComment: (text) => hostNode("comment", undefined, text),
  setText(node, text) { node.text = text; },
  setElementText(node, text) { node.children = [hostNode("text", undefined, text)]; },
  parentNode: (node) => node.parent,
  nextSibling(node) {
    const siblings = node.parent?.children || [];
    return siblings[siblings.indexOf(node) + 1] || null;
  },
});
/** Every message row ever created, so a brief full mount cannot hide. */
const articlesCreated = { count: 0 };

async function attachClientRender(component: object, path: string): Promise<void> {
  const source = await readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  const descriptor = parse(source, { filename: path }).descriptor;
  const script = compileScript(descriptor, { id: path });
  const compiled = compileTemplate({ source: descriptor.template!.content, filename: path, id: path, compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(compiled.errors, []);
  const clientCode = compiled.code
    .replace(/^import \{([\s\S]*?)\} from "vue"\n/, (_match, bindings: string) => `const {${bindings.replace(/\s+as\s+/g, ": ")}} = vue\n`)
    .replace("export function render", "function render");
  const transformed = await transformWithEsbuild(clientCode, `${path}.ts`, { loader: "ts", target: "esnext" });
  (component as { render?: unknown }).render = Function("vue", `${transformed.code}\nreturn render;`)(Vue);
}

let vite: ViteDevServer;
let RoomMessageViewport: object;
const savedGlobals = { window: globalThis.window, document: globalThis.document, CSS: globalThis.CSS };

before(async () => {
  Object.assign(globalThis, {
    window: {
      setTimeout, clearTimeout, addEventListener: () => undefined, removeEventListener: () => undefined,
      requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
      cancelAnimationFrame: clearTimeout, localStorage: { getItem: () => null, setItem: () => undefined },
      matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    },
    document: { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", hasFocus: () => true },
    CSS: { escape: (value: string) => value },
  });
  vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  RoomMessageViewport = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-chat/RoomMessageViewport.vue")).default;
  const chatMessage = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/DesktopChatMessage.vue")).default;
  // These tests count mounted rows; the message body itself is covered elsewhere.
  Object.assign(chatMessage, {
    setup: undefined,
    render(ctx: { message: { id: string } }) {
      return h("article", { "data-message-id": ctx.message.id, "data-testid": `room-message-${ctx.message.id}` });
    },
  });
  const groupedUpdates = await vite.ssrLoadModule(fileURLToPath(new URL("../../../../shared/ui/RoomGitHubUpdates.vue", import.meta.url)));
  await attachClientRender(groupedUpdates.default, "../../../../shared/ui/RoomGitHubUpdates.vue");
  await attachClientRender(RoomMessageViewport, "../src/components/desktop/content/room-chat/RoomMessageViewport.vue");
});

after(async () => {
  await vite?.close();
  Object.assign(globalThis, savedGlobals);
});

function roomMessages(count: number, prefix = "msg") {
  const start = Date.parse("2026-10-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}_${index}`, sender: index % 2 ? "Oak" : "Emmy", text: `message ${index}`, attachments: [], agentPromptKind: null,
    source: "browser", timestamp: new Date(start + index * 10 * 60_000).toISOString(), actorLabel: null, agentIdentity: null,
    threadRootId: `${prefix}_${index}`, threadReplyToId: null, thread: null, replyTo: null,
  }));
}

const flush = async () => { for (let index = 0; index < 4; index += 1) { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); } };

async function mountViewport(count: number) {
  const props = Vue.reactive<Record<string, unknown>>({
    active: true, activeSearchMessageId: null, activeThreadParentId: null, hasOlderMessages: false,
    loadingOlderMessages: false, messages: roomMessages(count), threadMessages: [], messageNamespace: "room-a",
    localAgentWork: [], deliveryReceiptsByMessage: {}, hasFilteredRoomActivity: false,
    roomIdentifier: "room-a", githubActivityAvailable: false, roomLoading: false, searchQuery: "", taskReferenceIds: new Set(),
    initialScrollPosition: null,
  });
  const calls: string[] = [];
  const root = hostNode("element", "root");
  let viewport: { scrollToMessage: (id: string) => boolean } | null = null;
  const app: App = renderer.createApp({
    setup() {
      return () => h(RoomMessageViewport, {
        ...props, ref: (value: unknown) => { viewport = value as typeof viewport; },
        "onLoad-older": () => calls.push("load-older"),
        "onReveal-message": (id: string) => calls.push(`reveal:${id}`),
      });
    },
  });
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.mount(root);
  const list = descendants(root).find(node => isList(node))!;
  list.clientHeight = 600;
  await flush();
  const mounted = () => descendants(list).filter(node => node.type === "article").map(node => String(node.props["data-message-id"]));
  const scroll = async (top: number) => {
    list.scrollTop = top;
    (list.props.onScroll as () => void)();
    await flush();
  };
  const firstVisible = () => {
    const row = elementChildren(list).find(node => node.props["data-message-id"] && (node.getBoundingClientRect as () => DOMRect)().bottom > 0);
    return row ? { id: row.props["data-message-id"], offset: (row.getBoundingClientRect as () => DOMRect)().top } : null;
  };
  const atBottom = () => (list.scrollHeight as number) - (list.scrollTop as number) - (list.clientHeight as number) < 1;
  return { props, app, list, calls, mounted, scroll, firstVisible, atBottom, viewport: () => viewport! };
}

test("a long room mounts a bounded window of the newest messages, at the bottom", async () => {
  articlesCreated.count = 0;
  const view = await mountViewport(2000);
  try {
    assert.ok(articlesCreated.count <= messageWindowSize, `${articlesCreated.count} rows created while opening the room`);
    const mounted = view.mounted();
    assert.ok(mounted.length <= messageWindowSize && mounted.length >= messageWindowSize - 10, `${mounted.length} rows mounted`);
    assert.equal(mounted.at(-1), "msg_1999");
    assert.ok(!mounted.includes("msg_0"));
    await view.scroll(view.list.scrollHeight as number);
    assert.ok(view.atBottom());
  } finally { view.app.unmount(); }
});

test("scrolling up mounts the next chunk and keeps the visible row in place", async () => {
  const view = await mountViewport(2000);
  try {
    await view.scroll(view.list.scrollHeight as number);
    await view.scroll(150);
    // The window grew; the scroll position was moved by the height of the new rows.
    const grownCount = view.mounted().length;
    assert.ok(grownCount >= messageWindowSize + messageWindowChunk - 10, `${grownCount} rows after growing`);
    const anchor = view.firstVisible();
    const before = { top: view.list.scrollTop as number, anchor };
    await view.scroll((view.list.scrollTop as number) - 1);
    assert.deepEqual(view.firstVisible()?.id, before.anchor?.id, "the reader still sees the same row");
    assert.ok(Math.abs((view.firstVisible()?.offset ?? 0) - ((before.anchor?.offset ?? 0) + 1)) <= 1);
    assert.ok((view.list.scrollTop as number) > 2000, "rows mounted above the reader, not under it");
    assert.deepEqual(view.calls, [], "loaded rows are used before history is requested");
  } finally { view.app.unmount(); }
});

test("growing upward restores the exact anchor offset", async () => {
  const view = await mountViewport(2000);
  try {
    await view.scroll(view.list.scrollHeight as number);
    view.list.scrollTop = 150;
    const anchor = view.firstVisible()!;
    (view.list.props.onScroll as () => void)();
    await flush();
    const after = view.firstVisible()!;
    assert.equal(after.id, anchor.id);
    assert.equal(after.offset, anchor.offset);
  } finally { view.app.unmount(); }
});

test("a jump to a loaded message outside the window mounts it, then scrolls to it", async () => {
  const view = await mountViewport(2000);
  try {
    scrolledIntoView.length = 0;
    assert.equal(view.viewport().scrollToMessage("msg_10"), true, "a loaded message is never sent to history paging");
    await flush();
    assert.ok(view.mounted().includes("msg_10"));
    assert.deepEqual(scrolledIntoView, ["msg_10"]);
    assert.ok(view.mounted().length < 400, `${view.mounted().length} rows: the jump does not mount everything below it`);
    assert.ok(descendants(view.list).some(node => node.props["data-testid"] === "room-message-window-gap"));
    assert.equal(view.viewport().scrollToMessage("not_loaded"), false, "an unloaded message keeps the reveal fallback");
  } finally { view.app.unmount(); }
});

test("a new message while following keeps the bottom and the window bound", async () => {
  const view = await mountViewport(2000);
  try {
    await view.scroll(view.list.scrollHeight as number);
    for (let index = 0; index < 5; index += 1) {
      view.props.messages = [...(view.props.messages as unknown[]), { ...roomMessages(1, `new${index}`)[0], timestamp: "2026-11-01T00:00:00.000Z" }];
      await flush();
      assert.ok(view.atBottom(), `still at the bottom after message ${index}`);
    }
    assert.ok(view.mounted().length <= messageWindowSize + 1);
    assert.equal(view.mounted().at(-1), "new4_0");
  } finally { view.app.unmount(); }
});

test("a new message while reading a detached window is not mounted and does not move the reader", async () => {
  const view = await mountViewport(2000);
  try {
    view.viewport().scrollToMessage("msg_500");
    await flush();
    const anchor = view.firstVisible();
    view.props.messages = [...(view.props.messages as unknown[]), { ...roomMessages(1, "late")[0], timestamp: "2026-11-01T00:00:00.000Z" }];
    await flush();
    assert.ok(!view.mounted().includes("late_0"));
    assert.deepEqual(view.firstVisible(), anchor);
  } finally { view.app.unmount(); }
});

test("search steps across the whole room mount each hit", async () => {
  const view = await mountViewport(2000);
  try {
    for (const id of ["msg_1900", "msg_700", "msg_3"]) {
      view.props.activeSearchMessageId = id;
      await flush();
      assert.ok(view.mounted().includes(id), `${id} is mounted`);
      assert.ok(view.mounted().length < 500, `${view.mounted().length} rows for ${id}`);
    }
  } finally { view.app.unmount(); }
});

test("opening a far thread mounts its root, so the inline thread panel renders", async () => {
  const view = await mountViewport(2000);
  try {
    view.props.activeThreadParentId = "msg_42";
    await flush();
    assert.ok(view.mounted().includes("msg_42"));
  } finally { view.app.unmount(); }
});

test("a room switch resets the window to the newest messages", async () => {
  const view = await mountViewport(2000);
  try {
    view.viewport().scrollToMessage("msg_10");
    await flush();
    assert.ok(view.mounted().includes("msg_10"));
    view.props.roomIdentifier = "room-b";
    view.props.messageNamespace = "room-b";
    articlesCreated.count = 0;
    view.props.messages = roomMessages(3000, "b");
    await flush();
    assert.ok(articlesCreated.count <= messageWindowSize, `${articlesCreated.count} rows created by the switch`);
    const mounted = view.mounted();
    assert.ok(mounted.length <= messageWindowSize, `${mounted.length} rows after the switch`);
    assert.equal(mounted.at(-1), "b_2999");
    assert.ok(!descendants(view.list).some(node => node.props["data-testid"] === "room-message-window-gap"));
  } finally { view.app.unmount(); }
});

test("at the top of loaded history the viewport asks for older messages", async () => {
  const view = await mountViewport(300);
  try {
    view.props.hasOlderMessages = true;
    await flush();
    view.calls.length = 0;
    await view.scroll(view.list.scrollHeight as number);
    await view.scroll(100);
    assert.deepEqual(view.calls, [], "the first scroll mounts loaded rows");
    for (let step = 0; step < 4 && !view.calls.length; step += 1) await view.scroll(100);
    assert.deepEqual(view.calls, ["load-older"]);
    assert.ok(view.mounted().includes("msg_0"), "history is requested only once every loaded row is mounted");
  } finally { view.app.unmount(); }
});
