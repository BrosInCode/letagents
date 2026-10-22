import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createRenderer,
  createSSRApp,
  defineComponent,
  h,
  nextTick,
  ref,
  reactive,
  effectScope,
  ssrContextKey,
  type Component,
} from "vue";
import * as Vue from "vue";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import { createServer, transformWithEsbuild, type ViteDevServer } from "vite";
import type {
  MyWorkCard,
  MyWorkPage,
} from "../../../../shared/ticket-connectors.mjs";
import type { MyWorkApi, WorkQuery } from "../../../../shared/ui/my-work/types";
import {
  checkSummaryLabel,
  myWorkTrackerOptions,
  myWorkRefreshDelay,
  myWorkCardKey,
  primaryPullRequest,
  reviewSummaryLabel,
  roomsWithChangedTasks,
  workGroup,
  workMatches,
  workSignal,
  safeWorkUrl,
} from "../../../../shared/ui/my-work/model";
function card(overrides: Partial<MyWorkCard> = {}): MyWorkCard {
  return {
    task_id: "task_12",
    room_id: "github.com/acme/app",
    room_name: "acme/app",
    title: "Proration rounding",
    external_ref: "jira:HT-1234",
    key: "HT-1234",
    provider: "jira",
    ticket_state: "in_review",
    ticket_status: "In Review",
    ticket_url: "https://acme.atlassian.net/browse/HT-1234",
    ticket_assignee_label: "Emmy",
    work_state: "in_review",
    assigned_via: "tracker",
    agent: {
      label: "Ada",
      agent_key: "agent:ada",
      display_name: "Ada",
      status: "working",
      status_text: "Waiting for CI on PR #88",
      last_heartbeat_at: "2026-10-21T10:00:00.000Z",
    },
    threads: { count: 2, last_activity_at: "2026-10-21T09:00:00.000Z" },
    pull_requests: [
      {
        url: "https://github.com/acme/app/pull/88",
        number: "88",
        title: "Fix proration rounding",
        state: "open",
        draft: false,
        merged: false,
        review_summary: { total: 2, approved: 1, changes_requested: 1 },
        check_summary: { total: 4, success: 3, failure: 1, pending: 0 },
      },
    ],
    needs_me: true,
    needs_me_reasons: ["review_requested"],
    jev_needs_me: false,
    updated_at: "2026-10-21T10:00:00.000Z",
    ...overrides,
  };
}

function page(overrides: Partial<MyWorkPage> = {}): MyWorkPage {
  return {
    cards: [card()],
    next_cursor: null,
    has_connections: true,
    providers: ["jira"],
    ...overrides,
  };
}

// A minimal host renderer, so MyWorkView can load its page and render again.
// v-model on <select> and checkboxes listens on the element itself.
type HostNode = {
  type: string;
  text: string;
  props: Record<string, unknown>;
  children: HostNode[];
  parent: HostNode | null;
  addEventListener(): void;
  removeEventListener(): void;
  options: unknown[];
  style: Record<string, unknown>;
  showModal(): void;
  close(): void;
  focus(): void;
  querySelector(): null;
};
const hostNode = (type: string, text = ""): HostNode => ({
  type,
  text,
  props: {},
  children: [],
  parent: null,
  addEventListener() {},
  removeEventListener() {},
  options: [],
  style: {},
  showModal() {},
  close() {},
  focus() {},
  querySelector() {
    return null;
  },
});
const testRenderer = createRenderer<HostNode, HostNode>({
  patchProp(node, key, _previous, next) {
    node.props[key] = next;
  },
  insert(child, parent, anchor) {
    child.parent = parent;
    if (!anchor) parent.children.push(child);
    else parent.children.splice(parent.children.indexOf(anchor), 0, child);
  },
  remove(child) {
    const index = child.parent?.children.indexOf(child) ?? -1;
    if (index >= 0) child.parent!.children.splice(index, 1);
    child.parent = null;
  },
  createElement(type) {
    return hostNode(type);
  },
  createText(text) {
    return hostNode("#text", text);
  },
  createComment(text) {
    return hostNode("#comment", text);
  },
  setText(node, text) {
    node.text = text;
  },
  setElementText(node, text) {
    node.text = text;
    node.children = [];
  },
  parentNode(node) {
    return node.parent;
  },
  nextSibling(node) {
    const siblings = node.parent?.children ?? [];
    return siblings[siblings.indexOf(node) + 1] ?? null;
  },
  querySelector() {
    return null;
  },
  setScopeId() {
    return undefined;
  },
  cloneNode(node) {
    return { ...node, props: { ...node.props }, children: [...node.children] };
  },
  insertStaticContent(content, parent, anchor) {
    const node = hostNode("#static", content);
    node.parent = parent;
    if (!anchor) parent.children.push(node);
    else parent.children.splice(parent.children.indexOf(anchor), 0, node);
    return [node, node];
  },
});

function find(
  node: HostNode,
  test: (node: HostNode) => boolean,
  found: HostNode[] = [],
): HostNode[] {
  if (test(node)) found.push(node);
  for (const child of node.children) find(child, test, found);
  return found;
}
const byTestId = (root: HostNode, id: string) =>
  find(root, (node) => node.props["data-testid"] === id);
const textOf = (node: HostNode): string =>
  node.type === "#comment"
    ? ""
    : node.type === "#text"
      ? node.text
      : node.text + node.children.map(textOf).join("");

/** Gives an SSR-loaded component a client render function, compiled from its template. */
async function attachClientRender(
  component: Component,
  modulePath: string,
): Promise<void> {
  const source = await readFile(modulePath, "utf8");
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
    .replace(
      /^import \{([\s\S]*?)\} from "vue"\n/,
      (_match, bindings: string) =>
        `const {${bindings.replace(/\s+as\s+/g, ": ")}} = vue\n`,
    )
    .replace("export function render", "function render");
  const transformed = await transformWithEsbuild(
    clientCode,
    `${modulePath}.ts`,
    { loader: "ts", target: "esnext" },
  );
  (component as { render?: unknown }).render = Function(
    "vue",
    `${transformed.code}\nreturn render;`,
  )(Vue);
}

let vite: ViteDevServer;
let MyWork: Component, WorkDetail: Component, FilterDropdown: Component;
let useMyWork: typeof import("../../../../shared/ui/my-work/useMyWork").useMyWork;
const shared = fileURLToPath(
  new URL("../../../../shared/ui/", import.meta.url),
);
const emptyApi: MyWorkApi = {
  read: async () => page(),
  mentions: async () => [],
};
before(async () => {
  Object.assign(globalThis, {
    window: { addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, removeEventListener() {} },
  });
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  for (const file of [
    "my-work/MyWork.vue",
    "my-work/WorkDetail.vue",
    "FilterDropdown.vue",
    "my-work/WorkIcon.vue",
    "ChatAvatar.vue",
    "DisclosurePanel.vue",
    "ThreadTransition.vue",
  ]) {
    const component = (await vite.ssrLoadModule(`/@fs${shared}${file}`))
      .default;
    await attachClientRender(component, `${shared}${file}`);
    if (file === "my-work/MyWork.vue") MyWork = component;
    if (file === "my-work/WorkDetail.vue") WorkDetail = component;
    if (file === "FilterDropdown.vue") FilterDropdown = component;
  }
  useMyWork = (await vite.ssrLoadModule(`/@fs${shared}my-work/useMyWork.ts`))
    .useMyWork;
});
after(async () => {
  await vite?.close();
});
const settle = async () => {
  for (let i = 0; i < 8; i++) await nextTick();
};
async function mount(
  component: Component,
  props: () => Record<string, unknown>,
) {
  const root = hostNode("root");
  const app = testRenderer.createApp(
    defineComponent({ setup: () => () => h(component, props()) }),
  );
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.mount(root);
  await settle();
  return { root, unmount: () => app.unmount() };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("work groups use actual needs-you signals, distinguish completed from queued and keep source filters honest", () => {
  assert.equal(workGroup(card()), "attention");
  assert.equal(
    workGroup(card({ needs_me: false, work_state: "blocked" })),
    "active",
  );
  for (const work_state of ["done", "merged", "cancelled"])
    assert.equal(workGroup(card({ needs_me: false, work_state })), "done");
  assert.equal(
    workGroup(card({ needs_me: false, work_state: "assigned" })),
    "queue",
  );
  assert.equal(
    workGroup(card({ needs_me: true, work_state: "done" })),
    "attention",
  );
  assert.equal(workSignal(card()), "Review requested");
  assert.equal(workMatches(card(), "proration"), true);
  assert.equal(workMatches(card(), "HT-1234"), true);
  assert.deepEqual(
    myWorkTrackerOptions(page({ has_connections: false, providers: [] })),
    [],
  );
  assert.deepEqual(
    myWorkTrackerOptions(page()).map((x) => x.label),
    ["All sources", "Jira", "LetAgents"],
  );
});
test("CI/review summaries preserve server facts and external links allow only web protocols", () => {
  const pr = primaryPullRequest(card())!;
  assert.equal(reviewSummaryLabel(pr), "1 approved, 1 change request");
  assert.equal(checkSummaryLabel(pr), "Checks 3/4 passed, 1 failed");
  assert.equal(safeWorkUrl("javascript:alert(1)"), undefined);
  assert.equal(safeWorkUrl("file:///private"), undefined);
  assert.equal(safeWorkUrl(pr.url), pr.url);
});
test("refresh remains event-driven and coalesces room changes", () => {
  assert.deepEqual(roomsWithChangedTasks({ a: "1" }, undefined), []);
  assert.deepEqual(roomsWithChangedTasks({ a: "2" }, { a: "1" }), ["a"]);
  assert.equal(myWorkRefreshDelay(["a"], new Set(["a"]), 1000, 2000), 2000);
  assert.equal(myWorkRefreshDelay(["b"], new Set(["a"]), 1000, 2000), 29000);
});
test("real cards render grouped rows, custom filters and no removed demo labels", async () => {
  const queries: WorkQuery[] = [];
  const api: MyWorkApi = {
    ...emptyApi,
    read: async (query) => {
      queries.push(query);
      return page({
        cards: [
          card(),
          card({
            task_id: "task_2",
            title: "Release notes",
            needs_me: false,
            work_state: "done",
          }),
        ],
      });
    },
  };
  const { root, unmount } = await mount(MyWork, () => ({ api }));
  try {
    assert.equal(queries[0]?.includeCompleted, true);
    assert.equal(byTestId(root, "my-work-row").length, 2);
    const text = textOf(root);
    assert.match(text, /Needs you/);
    assert.match(text, /Recently completed/);
    assert.match(text, /Proration rounding/);
    assert.doesNotMatch(text, /YOUR WORKSPACE|Assigned to you & your agents/);
    assert.equal(find(root, (n) => n.type === "select").length, 0);
    assert.equal(find(root, (n) => n.props.popover === "auto").length, 2);
  } finally {
    unmount();
  }
});
test("new arrivals in an earlier group stay behind Show updates; existing nodes and open groups stay stable", async () => {
  const active = card({
    needs_me: false,
    task_id: "task_2",
    work_state: "in_progress",
  });
  let next = page({ cards: [active] });
  const api: MyWorkApi = { ...emptyApi, read: async () => next };
  const props = reactive({ api, tasksChangedAt: { r: "1" }, connected: true });
  const { root, unmount } = await mount(MyWork, () => props);
  try {
    const old = byTestId(root, "my-work-row")[0];
    // A reconnect is an event-driven read; advance only the refresh gate, not a polling clock.
    const realNow = Date.now;
    Date.now = () => realNow() + 60000;
    try {
      next = page({
        cards: [card(), { ...active, updated_at: "2026-10-21T11:00:00Z" }],
      });
      props.connected = false;
      await settle();
      props.connected = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      await settle();
    } finally {
      Date.now = realNow;
    }
    assert.equal(byTestId(root, "my-work-row").length, 1);
    assert.equal(byTestId(root, "my-work-row")[0], old);
    const button = find(
      root,
      (n) => n.type === "button" && textOf(n).includes("Show updates"),
    )[0]!;
    assert.ok(button);
    (button.props.onClick as () => void)();
    await settle();
    assert.equal(byTestId(root, "my-work-row").length, 2);
  } finally {
    unmount();
  }
});
test("empty filtered pages retain Load more; Needs you does not relabel filtered counts as all work", async () => {
  const api: MyWorkApi = {
    ...emptyApi,
    read: async (query) =>
      page({ cards: query.needsMe ? [] : [card()], next_cursor: "next" }),
  };
  const { root, unmount } = await mount(MyWork, () => ({ api }));
  try {
    const tab = find(
      root,
      (n) => n.props.role === "tab" && textOf(n).startsWith("Needs you"),
    )[0]!;
    (tab.props.onClick as () => void)();
    await settle();
    assert.equal(byTestId(root, "my-work-more").length, 1);
    assert.match(textOf(byTestId(root, "my-work-empty")[0]!), /loaded so far/);
    const all = find(
      root,
      (n) => n.props.role === "tab" && textOf(n).startsWith("All work"),
    )[0]!;
    assert.equal(textOf(all), "All work");
  } finally {
    unmount();
  }
});
test("details keep Updates selected and retain its content when the same card receives CI updates", async () => {
  const value = ref(card());
  const api: MyWorkApi = {
    ...emptyApi,
    mentions: async () => [
      {
        messageId: "msg_1",
        threadRootId: "msg_1",
        sender: "Ada",
        text: "Please check the rounding.",
        timestamp: "2026-10-21T10:00:00Z",
      },
    ],
  };
  const { root, unmount } = await mount(WorkDetail, () => ({
    card: value.value,
    hasConnections: true,
    api,
    titleId: "detail-title",
  }));
  try {
    const updates = find(
      root,
      (n) => n.props.role === "tab" && textOf(n) === "Updates",
    )[0]!;
    (updates.props.onClick as () => void)();
    await settle();
    assert.match(textOf(root), /Please check the rounding/);
    value.value = { ...value.value, updated_at: "2026-10-21T12:00:00Z" };
    await settle();
    assert.equal(updates.props["aria-selected"], true);
    assert.match(textOf(root), /Please check the rounding/);
  } finally {
    unmount();
  }
});
test("detail transport responses from a previous card cannot overwrite the next card", async () => {
  const pending = deferred<any>();
  const value = ref(card());
  const api: MyWorkApi = { ...emptyApi, mentions: () => pending.promise };
  const { root, unmount } = await mount(WorkDetail, () => ({
    card: value.value,
    hasConnections: true,
    api,
    titleId: "detail-title",
  }));
  try {
    const updates = find(
      root,
      (n) => n.props.role === "tab" && textOf(n) === "Updates",
    )[0]!;
    (updates.props.onClick as () => void)();
    await settle();
    value.value = card({ task_id: "task_99", title: "Different card" });
    await settle();
    pending.resolve([
      {
        messageId: "old",
        threadRootId: "old",
        sender: "Old",
        text: "Stale response",
        timestamp: "",
      },
    ]);
    await settle();
    assert.doesNotMatch(textOf(root), /Stale response/);
  } finally {
    unmount();
  }
});
test("custom dropdown labels selected options and exposes a searchable listbox", async () => {
  const html = await renderToString(
    createSSRApp(FilterDropdown, {
      modelValue: "room-b",
      label: "Filter by room",
      searchable: true,
      options: [
        { id: "", label: "All rooms" },
        { id: "room-b", label: "Pocket Notes" },
      ],
    }),
  );
  assert.match(html, /aria-label="Filter by room: Pocket Notes"/);
  assert.match(html, /role="listbox"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /Find a room/);
  assert.doesNotMatch(html, /<select/);
});
test("a filter change and disposal fence old requests, including failures", async () => {
  const first = deferred<MyWorkPage>(),
    second = deferred<MyWorkPage>();
  let calls = 0;
  const api: MyWorkApi = {
    ...emptyApi,
    read: () => (++calls === 1 ? first.promise : second.promise),
  };
  const scope = effectScope();
  const state = scope.run(() => useMyWork({ api }))!;
  state.filters.roomId = "next-room";
  await settle();
  second.resolve(page({ cards: [card({ room_id: "next-room" })] }));
  await settle();
  first.reject(new Error("stale error"));
  await settle();
  assert.equal(state.cards.value[0]?.room_id, "next-room");
  assert.equal(state.error.value, "");
  scope.stop();
  const late = deferred<MyWorkPage>(),
    stopped = effectScope();
  const disposed = stopped.run(() =>
    useMyWork({ api: { ...emptyApi, read: () => late.promise } }),
  )!;
  stopped.stop();
  late.resolve(page());
  await settle();
  assert.equal(disposed.cards.value.length, 0);
});
test("refresh preserves every loaded page past 100 cards, stable order and retryable failures", async () => {
  const all = Array.from({ length: 125 }, (_, i) =>
    card({ task_id: `task_${i + 1}`, needs_me: false }),
  );
  let fail = false;
  const api: MyWorkApi = {
    ...emptyApi,
    read: async (query) => {
      if (fail) throw new Error("Connection lost");
      const offset = Number(query.cursor || 0);
      return page({
        cards: all.slice(offset, offset + 50),
        next_cursor: offset + 50 < all.length ? String(offset + 50) : null,
      });
    },
  };
  const scope = effectScope(),
    state = scope.run(() => useMyWork({ api }))!;
  await settle();
  await state.loadMore();
  await state.loadMore();
  assert.equal(state.cards.value.length, 125);
  const keys = state.cards.value.map(myWorkCardKey),
    row = state.cards.value[60];
  await state.reload();
  assert.deepEqual(state.cards.value.map(myWorkCardKey), keys);
  assert.equal(state.cards.value[60], row);
  fail = true;
  await state.reload();
  assert.equal(state.error.value, "Connection lost");
  assert.equal(state.cards.value.length, 125);
  fail = false;
  await state.reload();
  assert.equal(state.error.value, "");
  scope.stop();
});
