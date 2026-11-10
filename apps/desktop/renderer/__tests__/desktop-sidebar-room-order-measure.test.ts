// The sidebar's room lists read row positions (getBoundingClientRect, which
// forces layout) only in an update in which the order of rows changed. A room
// switch or an unread change reads none. The move transition still plays on a
// reorder.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import * as Vue from "vue";
import { createRenderer, h, nextTick, ssrContextKey, type App } from "vue";
import { createServer, transformWithEsbuild, type ViteDevServer } from "vite";

const rowHeight = 30;
const counts = { positionReads: 0 };
const motion = { reduced: false };

/** A host node that is an `Element` (TransitionGroup checks), with counted geometry. */
class FakeElement {
  kind: "element" | "text" | "comment";
  type?: string;
  text: string;
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  props: Record<string, unknown> = {};
  style: Record<string, string> = {};
  classes = new Set<string>();
  listeners = new Map<string, Set<(event: unknown) => void>>();
  nodeType: number;
  constructor(kind: FakeElement["kind"], type?: string, text = "") {
    this.kind = kind; this.type = type; this.text = text;
    this.nodeType = kind === "element" ? 1 : kind === "text" ? 3 : 8;
  }
  get isConnected(): boolean { return this.parent !== null; }
  get ownerDocument() { return globalThis.document; }
  get parentNode(): FakeElement | null { return this.parent; }
  get offsetWidth(): number { return 200; }
  get offsetHeight(): number { return this.height(); }
  get classList() {
    return { add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name), contains: (name: string) => this.classes.has(name) };
  }
  height(): number {
    if (this.kind !== "element") return 0;
    const inner = this.children.reduce((sum, child) => sum + child.height(), 0);
    return this.type === "button" ? rowHeight : inner;
  }
  top(): number {
    if (!this.parent) return 0;
    let top = this.parent.top();
    for (const sibling of this.parent.children) {
      if (sibling === this) break;
      top += sibling.height();
    }
    return top;
  }
  getBoundingClientRect() {
    counts.positionReads += 1;
    const top = this.top();
    return { top, bottom: top + this.height(), left: 0, right: 200, width: 200, height: this.height(), x: 0, y: top };
  }
  getClientRects() { return [this.getBoundingClientRect()]; }
  addEventListener(name: string, listener: (event: unknown) => void) { this.listeners.set(name, (this.listeners.get(name) ?? new Set()).add(listener)); }
  removeEventListener(name: string, listener: (event: unknown) => void) { this.listeners.get(name)?.delete(listener); }
  cloneNode() { return new FakeElement(this.kind, this.type); }
  appendChild(child: FakeElement) { this.children.push(child); child.parent = this; }
  removeChild(child: FakeElement) { this.children.splice(this.children.indexOf(child), 1); child.parent = null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  scrollIntoView() {}
  focus() {}
  contains() { return false; }
  closest() { return null; }
  setAttribute(name: string, value: unknown) { this.props[name] = value; }
  removeAttribute(name: string) { delete this.props[name]; }
}

function descendants(node: FakeElement): FakeElement[] {
  return [node, ...node.children.flatMap(descendants)];
}

const renderer = createRenderer<FakeElement, FakeElement>({
  patchProp(node, key, _previous, next) {
    if (key === "class") node.classes = new Set(String(next ?? "").split(/\s+/).filter(Boolean));
    node.props[key] = next;
  },
  insert(child, parent, anchor) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
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
  createElement: (type) => new FakeElement("element", type),
  createText: (text) => new FakeElement("text", undefined, text),
  createComment: (text) => new FakeElement("comment", undefined, text),
  setText(node, text) { node.text = text; },
  setElementText(node, text) { node.children = [new FakeElement("text", undefined, text)]; },
  parentNode: (node) => node.parent,
  nextSibling(node) {
    const siblings = node.parent?.children || [];
    return siblings[siblings.indexOf(node) + 1] || null;
  },
});

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
let DesktopSidebar: object;
const savedGlobals = {
  window: globalThis.window, document: globalThis.document, Element: globalThis.Element, HTMLElement: globalThis.HTMLElement,
  requestAnimationFrame: globalThis.requestAnimationFrame,
};

before(async () => {
  const body = new FakeElement("element", "body");
  Object.assign(globalThis, {
    window: {
      setTimeout, clearTimeout, addEventListener: () => undefined, removeEventListener: () => undefined,
      requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
      cancelAnimationFrame: clearTimeout, localStorage: { getItem: () => null, setItem: () => undefined },
      matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
      // Under reduced motion the move class has `transition: none` (sidebar-rooms.css).
      getComputedStyle: () => (motion.reduced
        ? { transitionDelay: "0s", transitionDuration: "0s", transitionProperty: "none", animationDelay: "", animationDuration: "" }
        : { transitionDelay: "0s", transitionDuration: "0.18s", transitionProperty: "transform", animationDelay: "", animationDuration: "" }),
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    document: { body, activeElement: null, addEventListener() {}, removeEventListener() {}, querySelector: () => null, visibilityState: "visible", hasFocus: () => true },
    Element: FakeElement,
    HTMLElement: FakeElement,
  });
  Object.defineProperty(body, "offsetHeight", { get: () => 0 });
  vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  const path = "../src/components/desktop/sidebar/DesktopSidebar.vue";
  DesktopSidebar = (await vite.ssrLoadModule("/renderer/src/components/desktop/sidebar/DesktopSidebar.vue")).default;
  // A child room is one row; the other parts of the sidebar are not measured here.
  const childRoom = (await vite.ssrLoadModule("/renderer/src/components/desktop/sidebar/SidebarChildRoom.vue")).default;
  Object.assign(childRoom, { setup: undefined, render: () => h("button", { class: "room-row" }) });
  for (const file of ["SidebarRoomActivity", "RoomUnreadBadge", "RoomMutedIcon", "SidebarRoomSwitcher", "CompanyScopeMenu", "SidebarAccountMenu"]) {
    const module = (await vite.ssrLoadModule(`/renderer/src/components/desktop/sidebar/${file}.vue`)).default;
    Object.assign(module, { setup: undefined, render: () => null });
  }
  const menu = (await vite.ssrLoadModule("/renderer/src/components/desktop/controls/DesktopContextMenu.vue")).default;
  Object.assign(menu, { setup: undefined, render: () => null });
  await attachClientRender(DesktopSidebar, path);
});

after(async () => {
  await vite?.close();
  Object.assign(globalThis, savedGlobals);
});

function room(id: string, extra: Partial<Record<string, unknown>> = {}) {
  return {
    id, type: "room", kind: "parent", roomIdentifier: id, title: id, meta: "", sectionLabel: "", headline: "", description: "",
    latestMessageId: null, latestMessageAt: null, hasUnread: false, pinned: false, source: "account", ...extra,
  };
}

function project(id: string, children: string[] = [], extra: Partial<Record<string, unknown>> = {}) {
  return {
    id, roomName: id, parent: room(id, extra),
    branchRooms: children.map(child => room(child, { kind: "branch", parentRoomIdentifier: id, ...extra })), focusRooms: [],
  };
}

const flush = async () => { for (let index = 0; index < 4; index += 1) { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); } };

async function mountSidebar() {
  const projects = [project("alpha", ["alpha-1", "alpha-2"]), project("beta", ["beta-1"]), project("gamma")];
  const props = Vue.reactive<Record<string, unknown>>({
    activeEntry: projects[0]!.parent, primaryRoom: projects[0]!.parent, projectEntries: projects,
    settingsEntry: { id: "system:settings", type: "system", title: "Settings", description: "", sectionLabel: "" },
    pinnedCollapsed: false, roomsCollapsed: false, collapsedProjects: { beta: true }, selectionActive: false, selectedEntryIds: [],
    batchActionBusy: null, updateStatus: null, authStatus: null, authBusy: false,
  });
  const errors: unknown[] = [];
  const root = new FakeElement("element", "root");
  root.parent = new FakeElement("element", "document");
  const app: App = renderer.createApp({ setup: () => () => h(DesktopSidebar, { ...props }) });
  app.config.errorHandler = (error) => { errors.push(error); };
  app.config.warnHandler = () => undefined;
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.mount(root);
  await flush();
  const projectList = descendants(root).find(node => node.classes.has("project-list"))!;
  const order = () => projectList.children.filter(node => node.type === "article").map(node => String(node.props["data-testid"]));
  return { props, app, root, errors, projectList, order, projects };
}

test("a room switch and an unread change read no row positions in the sidebar", async () => {
  const view = await mountSidebar();
  try {
    assert.deepEqual(view.order(), ["room-group-alpha", "room-group-beta", "room-group-gamma"]);
    counts.positionReads = 0;
    view.props.activeEntry = view.projects[0]!.branchRooms[1];
    await flush();
    view.props.activeEntry = view.projects[2]!.parent;
    // A new list with the same order, as an unread update makes.
    view.props.projectEntries = [project("alpha", ["alpha-1", "alpha-2"], { hasUnread: true }), project("beta", ["beta-1"]), project("gamma")];
    await flush();
    const active = descendants(view.root).find(node => node.props["data-sidebar-entry-id"] === "gamma");
    assert.equal(active?.props["data-active"], true, "the sidebar did update");
    assert.equal(counts.positionReads, 0, `${counts.positionReads} position reads for updates that moved no row`);
    assert.deepEqual(view.errors, []);
  } finally { view.app.unmount(); }
});

test("a reorder still reads positions and plays the move transition", async () => {
  const view = await mountSidebar();
  try {
    counts.positionReads = 0;
    view.props.projectEntries = [view.projects[2]!, view.projects[0]!, view.projects[1]!];
    await flush();
    assert.deepEqual(view.order(), ["room-group-gamma", "room-group-alpha", "room-group-beta"]);
    assert.ok(counts.positionReads > 0, "the reorder measured the rows");
    const moving = view.projectList.children.filter(node => node.classes.has("sidebar-room-order-move")).map(node => String(node.props["data-testid"]));
    assert.deepEqual(moving.sort(), ["room-group-alpha", "room-group-beta", "room-group-gamma"], "every row that moved slides");
    assert.deepEqual(view.errors, []);
  } finally { view.app.unmount(); }
});

test("opening a project's room list still measures, so the rows below it slide", async () => {
  const view = await mountSidebar();
  try {
    counts.positionReads = 0;
    view.props.collapsedProjects = {};
    await flush();
    assert.ok(counts.positionReads > 0);
    const gamma = view.projectList.children.find(node => node.props["data-testid"] === "room-group-gamma")!;
    assert.ok(gamma.classes.has("sidebar-room-order-move"), "the row below the opened list slides down");
    assert.deepEqual(view.errors, []);
  } finally { view.app.unmount(); }
});

test("under reduced motion a reorder leaves no move class and no pending listener on a row", async () => {
  const view = await mountSidebar();
  motion.reduced = true;
  try {
    view.props.projectEntries = [view.projects[2]!, view.projects[0]!, view.projects[1]!];
    await flush();
    assert.deepEqual(view.order(), ["room-group-gamma", "room-group-alpha", "room-group-beta"]);
    for (const row of view.projectList.children.filter(node => node.type === "article")) {
      const name = String(row.props["data-testid"]);
      assert.ok(!row.classes.has("sidebar-room-order-move"), `${name} has no move class`);
      assert.equal(row.listeners.get("transitionend")?.size ?? 0, 0, `${name} waits for no transitionend`);
      assert.ok(!row.style.transform, `${name} has no transform`);
    }
    assert.deepEqual(view.errors, []);
  } finally {
    motion.reduced = false;
    view.app.unmount();
  }
});
