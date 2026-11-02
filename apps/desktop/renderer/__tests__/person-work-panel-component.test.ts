import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

let vite: ViteDevServer;
let PersonWorkPanel: unknown;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  PersonWorkPanel = (await vite.ssrLoadModule(
    "/renderer/src/components/desktop/content/PersonWorkPanel.vue",
  )).default;
});

after(async () => {
  await vite?.close();
});

async function renderPanel(viewerLogin: string | null): Promise<string> {
  const context: { teleports?: Record<string, string> } = {};
  const app = createSSRApp({
    render: () => h(PersonWorkPanel as object, {
      target: { login: "mira", displayName: "Mira Patel", avatarUrl: null },
      roomId: "github.com/acme/app",
      viewerLogin,
      services: { getEvents: async () => ({ events: [], hasMore: false, roomIdentifier: "github.com/acme/app" }), getTicket: async () => null, openExternalUrl: async () => {} },
    }),
  });
  const html = await renderToString(app, context);
  return `${html}${Object.values(context.teleports ?? {}).join("")}`;
}

test("person work panel names the repository and shows one concise empty state", async () => {
  const html = await renderPanel("owen");
  assert.match(html, /No open pull requests recorded in the last 30 days/);
  assert.match(html, /Recorded GitHub activity · last 30 days/);
  assert.match(html, /Mira Patel/);
  assert.match(html, /@mira/);
  assert.match(html, /acme\/app/);
  assert.match(html, /aria-label="Close work panel"/);
  assert.doesNotMatch(html, /Your work|in this room|Waiting for review|Reviews given/);
});

test("person work panel labels the signed-in person's own work", async () => {
  const html = await renderPanel("Mira");
  assert.match(html, /Your work/);
});

test("person work panel wires the focus trap, Escape stopPropagation and deactivate close", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    fileURLToPath(new URL("../src/components/desktop/content/PersonWorkPanel.vue", import.meta.url)),
    "utf8",
  );
  assert.match(source, /trapFocusInDialog\(event, panelElement\.value\)/);
  assert.match(source, /event\.stopPropagation\(\)/);
  assert.match(source, /onDeactivated\(/);
});

test("platform services preserve ticket links across snapshots and reject stale room/ref responses", async (t) => {
  const { createRenderer, nextTick, reactive, ref, ssrContextKey } = await import("vue");
  const globals = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement };
  const pending: Array<{ room: string; resolve: (value: unknown) => void }> = [];
  const prUrl = "https://github.com/acme/app/pull/12";
  const opened: string[] = [];
  Object.assign(globalThis, {
    HTMLElement: class {},
    document: { activeElement: null, addEventListener() {}, removeEventListener() {} },
    window: { letagentsDesktop: { room: {
      getGitHubEvents: async (room: string, query: { eventType: string }) => ({
        roomIdentifier: room, githubRoomIdentifier: room, hasMore: false,
        events: query.eventType === "pull_request" ? [{
          id: "evt_12", eventType: "pull_request", action: "opened", state: "open",
          githubObjectUrl: prUrl, title: "Fix loading", metadata: { author_login: "mira" },
          eventOrderAt: new Date().toISOString(), createdAt: new Date().toISOString(),
        }] : [],
      }),
      getTaskTicket: (room: string) => new Promise(resolve => pending.push({ room, resolve })),
    }, app: { openExternalUrl: async (url: string) => { opened.push(url); } } } },
  });
  // Run the production setup/lifecycle without DOM rendering; UI is covered by SSR and browser QA.
  const renderer = createRenderer({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  });
  const bridge = globalThis.window.letagentsDesktop;
  const services = {
    getEvents: bridge.room.getGitHubEvents,
    getTicket: bridge.room.getTaskTicket,
    openExternalUrl: bridge.app.openExternalUrl,
  };
  Object.assign(globalThis, { window: {} });
  const props = reactive({
    services,
    target: { login: "mira", displayName: "Mira Patel", avatarUrl: null },
    roomId: "github.com/acme/app", viewerLogin: "owen",
    tasks: [{ id: "task_1", title: "Fix loading", prUrl, workflowArtifacts: [], externalRef: "jira:APP-1", ticketState: "open" }],
  });
  const panel = ref<any>(null);
  const Component = { ...(PersonWorkPanel as object), render: () => null };
  const app = renderer.createApp(() => h(Component, { ...props, ref: panel }));
  app.provide(ssrContextKey, { modules: new Set() }); app.mount({});
  t.after(() => { app.unmount(); Object.assign(globalThis, globals); });
  const settle = async () => { for (let i = 0; i < 8; i++) await nextTick(); };
  const state = () => panel.value.$.setupState;
  await settle();
  assert.equal(pending.length, 1);
  pending[0].resolve({ externalRef: "jira:APP-1", url: "https://acme.atlassian.net/browse/APP-1" });
  await settle();
  assert.equal(state().ticketLink(props.tasks[0]), "https://acme.atlassian.net/browse/APP-1");
  await state().openTicket(props.tasks[0]);
  await state().openPullRequest({ prUrl });
  assert.deepEqual(opened, ["https://acme.atlassian.net/browse/APP-1", prUrl]);

  props.tasks = props.tasks.map(task => ({ ...task, title: "Fix loading updated" }));
  await settle();
  assert.equal(pending.length, 1, "unchanged ticket identities do not refetch");
  assert.equal(state().ticketLink(props.tasks[0]), "https://acme.atlassian.net/browse/APP-1");

  props.tasks = props.tasks.map(task => ({ ...task, externalRef: "jira:APP-2" }));
  await settle();
  assert.equal(state().ticketLink(props.tasks[0]), undefined, "old ref must not remain clickable");
  assert.equal(pending.length, 2);
  props.roomId = "focus_20";
  await settle();
  const latest = pending.at(-1)!;
  assert.equal(latest.room, "focus_20");
  latest.resolve({ externalRef: "jira:APP-2", url: "https://acme.atlassian.net/browse/APP-2" });
  pending[1].resolve({ externalRef: "jira:APP-2", url: "https://wrong.example/old-room" });
  await settle();
  assert.equal(state().ticketLink(props.tasks[0]), "https://acme.atlassian.net/browse/APP-2");
});
