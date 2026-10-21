import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRenderer, createSSRApp, defineComponent, h, nextTick, ssrContextKey, type Component } from "vue";
import * as Vue from "vue";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import { createServer, transformWithEsbuild, type ViteDevServer } from "vite";

import type { MyWorkCard, MyWorkPage } from "../../../../shared/ticket-connectors.mjs";
import {
  checkSummaryLabel,
  myWorkColumns,
  myWorkTrackerOptions,
  primaryPullRequest,
  reviewSummaryLabel,
  roomsWithChangedTasks,
} from "../src/components/desktop/content/my-work/my-work-presentation";
import { taskForTicketQuery } from "../src/components/desktop/content/room-board/ticket-ref";

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
      label: "Ada", agent_key: "agent:ada", display_name: "Ada", status: "working",
      status_text: "Waiting for CI on PR #88", last_heartbeat_at: "2026-10-21T10:00:00.000Z",
    },
    threads: { count: 2, last_activity_at: "2026-10-21T09:00:00.000Z" },
    pull_requests: [{
      url: "https://github.com/acme/app/pull/88", number: "88", title: "Fix proration rounding", state: "open", draft: false, merged: false,
      review_summary: { total: 2, approved: 1, changes_requested: 1 },
      check_summary: { total: 4, success: 3, failure: 1, pending: 0 },
    }],
    needs_me: true,
    needs_me_reasons: ["review_requested"],
    updated_at: "2026-10-21T10:00:00.000Z",
    ...overrides,
  };
}

function page(overrides: Partial<MyWorkPage> = {}): MyWorkPage {
  return { cards: [card()], next_cursor: null, has_connections: true, providers: ["jira"], ...overrides };
}

test("zero-connector mode hides the ticket state column and the tracker filter", () => {
  assert.deepEqual(myWorkColumns(page()).map((column) => column.label), ["Ticket", "Ticket state", "Agent work", "PR"]);
  assert.deepEqual(myWorkColumns(page({ has_connections: false, providers: [] })).map((column) => column.label), ["Ticket", "Agent work", "PR"]);
  assert.deepEqual(myWorkTrackerOptions(page({ has_connections: false, providers: [] })), []);
  assert.deepEqual(myWorkTrackerOptions(page()).map((option) => option.id), ["", "jira", "native"]);
});

test("PR summaries read in plain words; an open PR is the row's PR", () => {
  const [pr] = card().pull_requests;
  assert.equal(reviewSummaryLabel(pr!), "1 approved, 1 change request");
  assert.equal(checkSummaryLabel(pr!), "Checks 3/4 passed, 1 failed");
  assert.equal(reviewSummaryLabel({ ...pr!, review_summary: { total: 0, approved: 0, changes_requested: 0 } }), "No reviews");
  assert.equal(checkSummaryLabel({ ...pr!, check_summary: null }), null);
  const merged = { ...pr!, url: "https://github.com/acme/app/pull/80", state: "merged", merged: true };
  assert.equal(primaryPullRequest(card({ pull_requests: [merged, pr!] }))?.url, pr!.url);
});

test("only a moved tasksChangedAt asks for a re-read", () => {
  const room = (tasksChangedAt: string | null) => ({ roomId: "r1", latestMessageId: null, latestMessageAt: null, working: [], tasksChangedAt });
  assert.deepEqual(roomsWithChangedTasks({ r1: room("t1") }, undefined), []);
  assert.deepEqual(roomsWithChangedTasks({ r1: room("t1") }, { r1: room(null) }), ["r1"]);
  assert.deepEqual(roomsWithChangedTasks({ r1: room("t1") }, { r1: room("t1") }), []);
  assert.deepEqual(roomsWithChangedTasks({ r1: { ...room("t1"), latestMessageId: "msg_2" } }, { r1: room("t1") }), [], "a new message is not a card change");
});

test("room search: a typed ticket key names its card", () => {
  const tasks = [{ id: "task_1", externalRef: "jira:HT-1234" }, { id: "task_2", externalRef: "linear:ENG-7" }, { id: "task_3", externalRef: null }];
  assert.equal(taskForTicketQuery(tasks, "HT-1234")?.id, "task_1");
  assert.equal(taskForTicketQuery(tasks, " ht-1234 ")?.id, "task_1");
  assert.equal(taskForTicketQuery(tasks, "jira:HT-1234")?.id, "task_1");
  assert.equal(taskForTicketQuery(tasks, "ENG-7")?.id, "task_2", "a bare key finds a Linear card too");
  assert.equal(taskForTicketQuery(tasks, "jira:ENG-7"), null, "a named tracker must match");
  assert.equal(taskForTicketQuery(tasks, "HT-12"), null);
  assert.equal(taskForTicketQuery(tasks, "proration"), null);
});

// ---------------------------------------------------------------------------
// Rendering

let vite: ViteDevServer;
let TicketDetailPanel: Component;
let MyWorkView: Component;
const getMyWorkCalls: unknown[] = [];
let nextPage: MyWorkPage = page();

before(async () => {
  Object.assign(globalThis, {
    window: {
      letagentsDesktop: {
        room: {
          getTaskMentions: async () => [],
          getMyWork: async (query: unknown) => { getMyWorkCalls.push(query); return nextPage; },
        },
      },
    },
  });
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  TicketDetailPanel = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/my-work/TicketDetailPanel.vue")).default;
  MyWorkView = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/MyWorkView.vue")).default;
});

after(async () => {
  await vite?.close();
});

async function renderPanel(props: { card: MyWorkCard; hasConnections: boolean }): Promise<string> {
  const app = createSSRApp(defineComponent({ setup: () => () => h(TicketDetailPanel, props) }));
  return renderToString(app);
}

function sectionText(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  assert.ok(at >= 0, `${testId} is rendered`);
  const start = html.indexOf(">", at) + 1;
  const end = html.indexOf("</section>", start);
  return html.slice(start, end).replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

test("the ticket detail panel has three columns: Ticket | Agent work | PR, with links out", async () => {
  const html = await renderPanel({ card: card(), hasConnections: true });
  const columns = [...html.matchAll(/<section[^>]*aria-label="([^"]+)"[^>]*data-testid="my-work-detail-[a-z]+"/g)].map((match) => match[1]);
  assert.deepEqual(columns, ["Ticket", "Agent work", "Pull requests"]);
  assert.equal(
    sectionText(html, "my-work-detail-ticket"),
    'Ticket Ticket state In review Jira status In Review Assignee Emmy Jira Open HT-1234',
  );
  const agent = sectionText(html, "my-work-detail-agent");
  assert.match(agent, /Work state In Review Owner Ada Last seen .+ Waiting for CI on PR #88 Open card in acme\/app/);
  assert.equal(
    sectionText(html, "my-work-detail-pr"),
    'PR GitHub · #88 · Open Fix proration rounding 1 approved, 1 change request Checks 3/4 passed, 1 failed',
  );
  assert.match(html, /href="https:\/\/acme\.atlassian\.net\/browse\/HT-1234"/);
  assert.match(html, /href="https:\/\/github\.com\/acme\/app\/pull\/88"/);
  assert.match(html, /data-testid="task-linked-threads"/, "the thread list is the board inspector's");
  assert.match(sectionText(html, "my-work-detail-needs-me").replace(/<\/?ul[^>]*>/g, ""), /Your review is requested/);
});

test("zero-connector mode: the panel shows no ticket state", async () => {
  const html = await renderPanel({
    card: card({ ticket_state: null, ticket_status: null, ticket_url: null, ticket_assignee_label: null, assigned_via: "native" }),
    hasConnections: false,
  });
  const ticket = sectionText(html, "my-work-detail-ticket");
  assert.doesNotMatch(ticket, /Ticket state|Jira status|Assignee|not shown/);
  assert.doesNotMatch(html, /desktop-task-ticket-state/);
});

// A minimal host renderer, so MyWorkView can load its page and render again.
// v-model on <select> and checkboxes listens on the element itself.
type HostNode = {
  type: string; text: string; props: Record<string, unknown>; children: HostNode[]; parent: HostNode | null;
  addEventListener(): void; removeEventListener(): void; options: unknown[];
};
const hostNode = (type: string, text = ""): HostNode => ({
  type, text, props: {}, children: [], parent: null, addEventListener() {}, removeEventListener() {}, options: [],
});
const testRenderer = createRenderer<HostNode, HostNode>({
  patchProp(node, key, _previous, next) { node.props[key] = next; },
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
  createElement(type) { return hostNode(type); },
  createText(text) { return hostNode("#text", text); },
  createComment(text) { return hostNode("#comment", text); },
  setText(node, text) { node.text = text; },
  setElementText(node, text) { node.text = text; node.children = []; },
  parentNode(node) { return node.parent; },
  nextSibling(node) {
    const siblings = node.parent?.children ?? [];
    return siblings[siblings.indexOf(node) + 1] ?? null;
  },
  querySelector() { return null; },
  setScopeId() { return undefined; },
  cloneNode(node) { return { ...node, props: { ...node.props }, children: [...node.children] }; },
  insertStaticContent(content, parent, anchor) {
    const node = hostNode("#static", content);
    node.parent = parent;
    if (!anchor) parent.children.push(node);
    else parent.children.splice(parent.children.indexOf(anchor), 0, node);
    return [node, node];
  },
});

function find(node: HostNode, test: (node: HostNode) => boolean, found: HostNode[] = []): HostNode[] {
  if (test(node)) found.push(node);
  for (const child of node.children) find(child, test, found);
  return found;
}
const byTestId = (root: HostNode, id: string) => find(root, (node) => node.props["data-testid"] === id);
const textOf = (node: HostNode): string => (node.type === "#text" ? node.text : node.text + node.children.map(textOf).join(""));

/** Gives an SSR-loaded component a client render function, compiled from its template. */
async function attachClientRender(component: Component, modulePath: string): Promise<void> {
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

async function mountMyWork(): Promise<{ root: HostNode; unmount: () => void }> {
  await attachClientRender(MyWorkView, "components/desktop/content/MyWorkView.vue");
  const root = hostNode("root");
  const app = testRenderer.createApp(defineComponent({
    setup: () => () => h(MyWorkView, { activity: { connected: true, rooms: {} }, active: true }),
  }));
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.mount(root);
  for (let i = 0; i < 5; i++) await nextTick();
  return { root, unmount: () => app.unmount() };
}

test("My work lists the account's cards with four columns when a tracker is connected", async () => {
  nextPage = page();
  getMyWorkCalls.length = 0;
  const { root, unmount } = await mountMyWork();
  try {
    assert.deepEqual(getMyWorkCalls[0], { cursor: null, limit: 50, tracker: null, roomId: null, needsMe: false });
    const headers = find(root, (node) => node.type === "th").map(textOf);
    assert.deepEqual(headers, ["Ticket", "Ticket state", "Agent work", "PR"]);
    const [row] = byTestId(root, "my-work-row");
    assert.ok(row);
    const text = textOf(row!).replace(/\s+/g, " ");
    assert.match(text, /HT-1234/);
    assert.match(text, /In review/);
    assert.match(text, /Waiting for CI on PR #88/);
    assert.match(text, /#88 · Open/);
    assert.equal(byTestId(root, "my-work-zero-connector").length, 0);
    assert.equal(byTestId(root, "my-work-filter-tracker").length, 1);
  } finally {
    unmount();
  }
});

test("zero-connector mode: no ticket state column, a hint, and native cards assigned to me", async () => {
  nextPage = page({
    has_connections: false,
    providers: [],
    cards: [card({
      task_id: "task_3", external_ref: null, key: null, provider: null, ticket_state: null, ticket_status: null, ticket_url: null,
      title: "Write the release notes", assigned_via: "native", needs_me: false, needs_me_reasons: [], pull_requests: [],
    })],
  });
  const { root, unmount } = await mountMyWork();
  try {
    const headers = find(root, (node) => node.type === "th").map(textOf);
    assert.deepEqual(headers, ["Ticket", "Agent work", "PR"]);
    assert.equal(byTestId(root, "my-work-zero-connector").length, 1);
    assert.equal(byTestId(root, "my-work-filter-tracker").length, 0);
    const [row] = byTestId(root, "my-work-row");
    assert.match(textOf(row!), /Write the release notes/);
    assert.equal(find(row!, (node) => node.props["data-column"] === "ticket-state").length, 0);
  } finally {
    unmount();
  }
});
