import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRenderer, defineComponent, h, nextTick, ref, type Component } from "vue";

import { createIdlePreloader, lazyView, type IdleScheduler } from "../src/lazy-views";

/** What `import()` gives: a module namespace whose default export is the view. */
function moduleOf<T>(view: T): { default: T } {
  return Object.defineProperty({ default: view }, Symbol.toStringTag, { value: "Module" });
}

/** A scheduler the test drives by hand: nothing runs until it says so. */
function manualScheduler() {
  const paints: (() => void)[] = [];
  const idles: { callback: () => void; timeoutMs: number }[] = [];
  const scheduler: IdleScheduler = {
    afterPaint: (callback) => { paints.push(callback); },
    whenIdle: (callback, timeoutMs) => { idles.push({ callback, timeoutMs }); },
  };
  return {
    scheduler,
    paints,
    idles,
    paint() { paints.shift()?.(); },
    async idle() {
      idles.shift()?.callback();
      // Let the task's promise settle and the next slot be requested.
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    },
  };
}

test("the idle preloader does nothing before the first-room signal", () => {
  const clock = manualScheduler();
  const calls: string[] = [];
  createIdlePreloader([async () => { calls.push("settings"); }], clock.scheduler);
  assert.equal(clock.paints.length, 0);
  assert.equal(clock.idles.length, 0);
  assert.deepEqual(calls, []);
});

test("after the signal it waits for a painted frame, then loads one view per idle slot, in order", async () => {
  const clock = manualScheduler();
  const calls: string[] = [];
  const start = createIdlePreloader([
    async () => { calls.push("settings"); },
    async () => { calls.push("inbox"); },
  ], clock.scheduler, 1234);

  start();
  assert.equal(clock.paints.length, 1);
  assert.equal(clock.idles.length, 0, "no idle request before the frame has painted");

  clock.paint();
  assert.equal(clock.idles.length, 1);
  assert.equal(clock.idles[0].timeoutMs, 1234);
  assert.deepEqual(calls, []);

  await clock.idle();
  assert.deepEqual(calls, ["settings"]);
  assert.equal(clock.idles.length, 1, "the next view waits for its own idle slot");

  await clock.idle();
  assert.deepEqual(calls, ["settings", "inbox"]);
  assert.equal(clock.idles.length, 0);
});

test("the idle preloader runs once, however often the signal comes", async () => {
  const clock = manualScheduler();
  let loads = 0;
  const start = createIdlePreloader([async () => { loads += 1; }], clock.scheduler);
  start();
  start();
  start();
  assert.equal(clock.paints.length, 1);
  clock.paint();
  await clock.idle();
  start();
  assert.equal(clock.paints.length, 0);
  assert.equal(loads, 1);
});

test("a rejected or throwing import does not stop the views after it", async () => {
  const clock = manualScheduler();
  const calls: string[] = [];
  const start = createIdlePreloader([
    () => Promise.reject(new Error("chunk missing")),
    () => { throw new Error("loader threw"); },
    async () => { calls.push("my-work"); },
  ], clock.scheduler);
  start();
  clock.paint();
  await clock.idle();
  await clock.idle();
  await clock.idle();
  assert.deepEqual(calls, ["my-work"]);
});

test("the idle preloader never throws, even when the scheduler does", () => {
  const throwing: IdleScheduler = {
    afterPaint: () => { throw new Error("no frames"); },
    whenIdle: () => { throw new Error("no idle"); },
  };
  assert.doesNotThrow(() => createIdlePreloader([async () => undefined], throwing)());

  const idleThrows: IdleScheduler = {
    afterPaint: (callback) => callback(),
    whenIdle: () => { throw new Error("no idle"); },
  };
  assert.doesNotThrow(() => createIdlePreloader([async () => undefined], idleThrows)());
});

test("without requestIdleCallback or requestAnimationFrame the default scheduler still preloads", async () => {
  assert.equal(typeof (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback, "undefined");
  let loads = 0;
  createIdlePreloader([async () => { loads += 1; }])();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(loads, 1);
});

// A tiny DOM: enough to see what a mounted lazy view draws, and to click it.
type FakeNode = { kind: string; parent: FakeNode | null; children: FakeNode[]; text?: string; props: Record<string, unknown> };
function fakeNode(kind: string, text?: string): FakeNode {
  return { kind, parent: null, children: [], text, props: {} };
}
function detach(node: FakeNode): void {
  if (!node.parent) return;
  node.parent.children.splice(node.parent.children.indexOf(node), 1);
  node.parent = null;
}
const renderer = createRenderer<FakeNode, FakeNode>({
  patchProp(node, key, _previous, next) { node.props[key] = next; },
  insert(child, parent, anchor) {
    detach(child);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) parent.children.push(child);
    else parent.children.splice(index, 0, child);
    child.parent = parent;
  },
  remove: detach,
  createElement: (tag) => fakeNode(tag),
  createText: (text) => fakeNode("#text", text),
  createComment: (text) => fakeNode("#comment", text),
  setText(node, text) { node.text = text; },
  setElementText(node, text) { node.children = []; node.text = text; },
  parentNode: (node) => node.parent,
  nextSibling(node) {
    if (!node.parent) return null;
    return node.parent.children[node.parent.children.indexOf(node) + 1] ?? null;
  },
});
function find(node: FakeNode, match: (candidate: FakeNode) => boolean): FakeNode | null {
  if (match(node)) return node;
  for (const child of node.children) {
    const found = find(child, match);
    if (found) return found;
  }
  return null;
}
const failureOf = (root: FakeNode) => find(root, (node) => node.props["data-testid"] === "lazy-view-failed");
const textOf = (node: FakeNode): string => (node.text ?? "") + node.children.map(textOf).join("");
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
    await nextTick();
  }
}
function mount(component: unknown, props: () => Record<string, unknown>) {
  const root = fakeNode("root");
  const app = renderer.createApp({ render: () => h(component as Component, props()) });
  app.config.warnHandler = () => undefined;
  app.mount(root);
  return { root, unmount: () => app.unmount() };
}
const Modal = defineComponent({
  props: { open: Boolean },
  render() { return this.open ? h("main", "Add agent controls") : null; },
});

test("a preloaded view renders in the same pass as it mounts", async () => {
  let loads = 0;
  const view = lazyView(async () => { loads += 1; return moduleOf(Modal); }, { label: "Add agent" });
  await view.preload();
  await view.preload();
  assert.equal(loads, 1, "the chunk is requested once");
  assert.equal(view.loaded(), true);

  const { root, unmount } = mount(view.component, () => ({ open: true }));
  assert.ok(find(root, (node) => node.kind === "main"), "rendered without waiting for a tick");
  unmount();
});

test("a view whose import failed at mount renders once a later preload succeeds", async () => {
  let attempts = 0;
  const view = lazyView(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("Failed to fetch dynamically imported module");
    return moduleOf(Modal);
  }, { label: "Add agent", retryDelaysMs: [60_000], visible: (attrs) => attrs.open === true });
  const open = ref(false);
  const { root, unmount } = mount(view.component, () => ({ open: open.value }));
  await settle();
  assert.equal(attempts, 1);
  assert.equal(failureOf(root), null, "a closed window shows no failure");

  await view.preload();
  open.value = true;
  await settle();
  assert.equal(attempts, 2);
  assert.ok(find(root, (node) => node.kind === "main"), "the mounted window renders after the preload");
  unmount();
});

test("a mounted view retries its import a bounded number of times", async () => {
  let attempts = 0;
  const view = lazyView(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("chunk missing");
    return moduleOf(Modal);
  }, { label: "Board", retryDelaysMs: [1, 1] });
  const { root, unmount } = mount(view.component, () => ({ open: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  await settle();
  assert.equal(attempts, 3);
  assert.ok(find(root, (node) => node.kind === "main"));
  assert.equal(failureOf(root), null);
  unmount();
});

test("a chunk that stays missing shows the error toast, and its button tries again", async () => {
  let missing = true;
  let attempts = 0;
  const view = lazyView(async () => {
    attempts += 1;
    if (missing) throw new Error("chunk missing");
    return moduleOf(Modal);
  }, { label: "Settings", retryDelaysMs: [1] });
  const { root, unmount } = mount(view.component, () => ({ open: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await settle();
  assert.equal(attempts, 2, "one load and one retry, then it stops");
  const failure = failureOf(root);
  assert.ok(failure, "the failure is visible");
  assert.equal(failure.props.class, "desktop-action-toast");
  assert.equal(failure.props["data-state"], "error");
  assert.match(textOf(failure), /Settings did not load\. Click to try again, or restart LetAgents\./);

  missing = false;
  (failure.props.onClick as () => void)();
  await settle();
  assert.equal(failureOf(root), null);
  assert.ok(find(root, (node) => node.kind === "main"));
  unmount();
});

test("the first-run wizard keeps the launch splash while it loads, and shows the failure over it", async () => {
  const Splash = defineComponent({ render: () => h("section", { class: "desktop-launch-splash" }) });
  const view = lazyView(async () => { throw new Error("chunk missing"); }, {
    label: "Setup",
    loading: () => h(Splash),
    retryDelaysMs: [],
  });
  const { root, unmount } = mount(view.component, () => ({}));
  assert.ok(find(root, (node) => node.kind === "section"), "the splash is drawn at once");
  assert.equal(failureOf(root), null);
  await settle();
  assert.ok(find(root, (node) => node.kind === "section"), "the splash stays under the failure");
  assert.match(textOf(failureOf(root)!), /Setup did not load/);
  unmount();
});

test("App.vue builds the first-run wizard with the launch splash and the failure path", () => {
  const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
  assert.match(app, /const FirstRunOnboardingView = lazyView\(\(\) => import\("\.\/components\/desktop\/setup\/FirstRunOnboardingView\.vue"\), \{\s*label: "Setup",\s*loading: \(\) => h\(FirstRunSplashView/);
});
