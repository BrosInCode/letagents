import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import { transformSync } from "esbuild";
import * as Vue from "vue";
import { createRenderer, createSSRApp, defineComponent, h, nextTick, ssrContextKey, type Component } from "vue";
import { createServer, type ViteDevServer } from "vite";
import {
  repoCollaboratorRequiredBody,
  roomMembershipRequiredBody,
} from "../../../../shared/room-membership.mjs";
import type {
  DesktopAccountRoomJoinRequest,
  DesktopRoomAccess,
  RoomJoinRequestSummary,
} from "../../electron/ipc-types";

// The 403 bodies come from the shared module, as the server builds them; the
// real refusals only reach the app once the server turns the rule on.

interface HostNode {
  type?: string; text: string; children: HostNode[]; parent: HostNode | null; props: Record<string, unknown>;
  nodeType: number; readonly parentNode: HostNode | null; style: Record<string, string>;
  addEventListener: () => void; removeEventListener: () => void; focus: () => void;
}
function hostNode(type?: string, text = ""): HostNode {
  const node: HostNode = { type, text, children: [], parent: null, props: {}, nodeType: type ? 1 : 3,
    get parentNode() { return node.parent; }, style: {}, addEventListener: () => undefined, removeEventListener: () => undefined, focus: () => undefined };
  return node;
}
const renderer = createRenderer<HostNode, HostNode>({
  patchProp(node, key, _previous, next) { node.props[key] = next; },
  insert(child, parent, anchor) {
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
const text = (node: HostNode) => descendants(node).map((child) => child.text).join("");
const button = (root: HostNode, label: string) => descendants(root).find((node) => node.type === "button" && text(node).trim() === label);
async function click(root: HostNode, label: string): Promise<void> {
  const target = button(root, label);
  assert.ok(target, `the ${label} button is shown`);
  await (target.props.onClick as () => Promise<void> | void)();
  for (let tick = 0; tick < 6; tick += 1) await nextTick();
}
const flush = async () => { for (let tick = 0; tick < 6; tick += 1) { await new Promise((resolve) => setImmediate(resolve)); await nextTick(); } };

let vite: ViteDevServer;
let AuthOnboardingView: Component;
let RoomJoinAccess: Component;
let RoomMembers: Component;
let InboxView: Component;
let joinRequestsStore: typeof import("../src/composables/useRoomJoinRequests");
let roomAccessChangedKey: symbol;
let sessionModule: typeof import("../src/composables/app/useAppSession");

/** Gives a component loaded for SSR the client render function this host renderer needs. */
async function useClientRender(component: Component, path: string, vue: Record<string, unknown> = Vue): Promise<void> {
  const source = await readFile(path, "utf8");
  const descriptor = parse(source, { filename: path }).descriptor;
  const script = compileScript(descriptor, { id: path });
  const compiled = compileTemplate({ source: descriptor.template!.content, filename: path, id: path,
    compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(compiled.errors, []);
  const code = compiled.code
    .replace(/^import \{([\s\S]*?)\} from "vue"\n/, (_match, bindings: string) => `const {${bindings.replace(/\s+as\s+/g, ": ")}} = vue\n`)
    .replace("export function render", "function render");
  (component as { render?: unknown }).render = Function("vue", `${transformSync(code, { loader: "ts" }).code}\nreturn render;`)(vue);
}

const desktopRoot = (relative: string) => fileURLToPath(new URL(`../${relative}`, import.meta.url));

before(async () => {
  Object.assign(globalThis, { document: { addEventListener: () => undefined, removeEventListener: () => undefined, hidden: false } });
  vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  AuthOnboardingView = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/AuthOnboardingView.vue")).default;
  RoomJoinAccess = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/RoomJoinAccess.vue")).default;
  RoomMembers = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-shell/RoomMembers.vue")).default;
  InboxView = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/InboxView.vue")).default;
  joinRequestsStore = await vite.ssrLoadModule("/renderer/src/composables/useRoomJoinRequests.ts") as typeof joinRequestsStore;
  roomAccessChangedKey = (await vite.ssrLoadModule("/renderer/src/composables/roomAccessChanged.ts")).roomAccessChangedKey;
  sessionModule = await vite.ssrLoadModule("/renderer/src/composables/app/useAppSession.ts") as typeof sessionModule;
  const ChatAvatar = (await vite.ssrLoadModule(fileURLToPath(new URL("../../../../shared/ui/ChatAvatar.vue", import.meta.url)))).default;
  await useClientRender(ChatAvatar, fileURLToPath(new URL("../../../../shared/ui/ChatAvatar.vue", import.meta.url)));
  await useClientRender(RoomJoinAccess, desktopRoot("src/components/desktop/content/RoomJoinAccess.vue"));
  await useClientRender(RoomMembers, desktopRoot("src/components/desktop/content/room-shell/RoomMembers.vue"));
  for (const relative of ["inbox/InboxLayout.vue", "inbox/InboxResponse.vue"]) {
    const path = fileURLToPath(new URL(`../../../../shared/ui/${relative}`, import.meta.url));
    await useClientRender((await vite.ssrLoadModule(path)).default, path);
  }
  const ListPassThrough = defineComponent((_props, { slots }) => () => h("div", slots.default?.()));
  await useClientRender(InboxView, desktopRoot("src/components/desktop/content/InboxView.vue"), { ...Vue, TransitionGroup: ListPassThrough });
});

after(async () => { await vite?.close(); });

function membershipAccess(joinRequest: RoomJoinRequestSummary | null, displayName = "Design room"): DesktopRoomAccess {
  const body = roomMembershipRequiredBody({ room_id: "design-room", display_name: displayName, join_request: joinRequest });
  return { status: "membership_required", title: "Ask to join this room", message: body.message, roomIdentifier: body.room_id,
    deviceFlowUrl: null, code: body.code, httpStatus: 403, displayName: body.display_name, joinRequest: body.join_request };
}

const account = { id: "acct_me", provider: "github", providerUserId: "1", login: "ada", displayName: "Ada", avatarUrl: null };
const authStatus = { authenticated: true, account, pendingDeviceAuth: null, error: null };
const pending: RoomJoinRequestSummary = { id: "rjr_1", state: "pending", created_at: new Date(Date.now() - 5 * 60_000).toISOString(), decided_at: null, retry_after: null };

async function renderGate(access: DesktopRoomAccess, roomLabel: string | null = "design-room"): Promise<string> {
  const app = createSSRApp({ render: () => h(AuthOnboardingView, { access, authStatus, busy: false, feedback: null, roomLabel, sidebarMode: "expanded" }) });
  return renderToString(app);
}

test("the gate names a members-only room by its own name and offers Ask to join", async () => {
  const html = await renderGate(membershipAccess(null));
  assert.match(html, /data-access-state="membership"/);
  assert.match(html, /Design room/, "the refusal's room name replaces the bare identifier");
  assert.match(html, /members only/);
  assert.match(html, /Ask to join this room/);
  assert.match(html, /Only members can open this room/);
  assert.match(html, />\s*Ask to join\s*</);
  assert.match(html, />\s*Check again\s*</);
});

test("the gate shows a pending request with Cancel, and a declined one with its wait", async () => {
  const waiting = await renderGate(membershipAccess(pending));
  assert.match(waiting, /Waiting for an admin/);
  assert.match(waiting, /You asked to join 5 min ago/);
  assert.match(waiting, /Cancel request/);
  assert.doesNotMatch(waiting, />\s*Ask to join\s*</);

  const declinedAt = new Date().toISOString();
  const retryAfter = new Date(Date.now() + 30 * 60_000).toISOString();
  const declined = await renderGate(membershipAccess({ ...pending, state: "declined", decided_at: declinedAt, retry_after: retryAfter }));
  assert.match(declined, /An admin declined your request/);
  assert.match(declined, /You can ask again in (30|29) min/);
  assert.match(declined, /<button[^>]*disabled[^>]*>\s*Ask again\s*</, "Ask again waits for the end of the wait");

  const over = await renderGate(membershipAccess({ ...pending, state: "declined", decided_at: declinedAt, retry_after: new Date(Date.now() - 1000).toISOString() }));
  assert.match(over, /An admin declined your last request. You can ask again./);
  assert.match(over, /<button(?![^>]*disabled)[^>]*>\s*Ask again\s*</);
});

test("a public-repo refusal sends the person to a repository admin, with no join request", async () => {
  const body = repoCollaboratorRequiredBody({ room_id: "github.com/acme/app" });
  const html = await renderGate({ status: "repo_collaborator_required", title: "", message: body.message, roomIdentifier: body.room_id,
    deviceFlowUrl: null, code: body.code, httpStatus: 403 }, "github.com/acme/app");
  assert.match(html, /data-access-state="repo_collaborator"/);
  assert.match(html, /Ask a repository admin to add you on GitHub/);
  assert.match(html, /Only people with a role on this GitHub repository can open its room/);
  assert.doesNotMatch(html, /Ask to join/);
  assert.match(html, />\s*Check again\s*</);
});

function installBridge(roomMembers: Record<string, (...args: never[]) => unknown>): void {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }), letagentsDesktop: { roomMembers } } });
}

function mount(component: Component, props: () => Record<string, unknown>, provides: Array<[symbol | string, unknown]> = []) {
  const root = hostNode("root");
  const app = renderer.createApp(defineComponent(() => () => h(component, props())));
  app.provide(ssrContextKey, { modules: new Set<string>() });
  for (const [key, value] of provides) app.provide(key, value);
  app.mount(root);
  return { root, app };
}

test("Ask to join shows Waiting at once, and Cancel brings Ask back", async () => {
  const calls: unknown[][] = [];
  installBridge({
    requestJoin: (async (...args: unknown[]) => { calls.push(["requestJoin", ...args]); return { ok: true, joinRequest: pending }; }) as never,
    decideJoinRequest: (async (...args: unknown[]) => {
      calls.push(["decideJoinRequest", ...args]);
      return { ok: true, joinRequest: { ...pending, state: "cancelled", decided_at: new Date().toISOString() } };
    }) as never,
  });
  const { root, app } = mount(RoomJoinAccess, () => ({ access: membershipAccess(null), account, busy: false, now: Date.now() }));
  try {
    await click(root, "Ask to join");
    assert.match(text(root), /Waiting for an admin/);
    await click(root, "Cancel request");
    assert.match(text(root), /Ask to join this room/);
    assert.deepEqual(calls, [["requestJoin", "design-room"], ["decideJoinRequest", "design-room", "rjr_1", "cancel"]]);
  } finally { app.unmount(); }
});

test("a cooldown answer shows the decline and its wait; a member answer opens the room", async () => {
  const retryAfter = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
  let answer: unknown = { ok: false, status: 429, code: "ROOM_JOIN_REQUEST_COOLDOWN", message: "Wait.",
    joinRequest: { ...pending, state: "declined", retry_after: retryAfter } };
  installBridge({ requestJoin: (async () => answer) as never });
  const refreshes: number[] = [];
  const root = hostNode("root");
  const app = renderer.createApp(defineComponent(() => () => h(RoomJoinAccess, {
    access: membershipAccess(null), account, busy: false, now: Date.now(), "onRefresh-room": () => refreshes.push(1),
  })));
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.mount(root);
  try {
    await click(root, "Ask to join");
    assert.match(text(root), /An admin declined your request/);
    assert.match(text(root), /You can ask again in 3 h/);
    app.unmount();

    answer = { ok: false, status: 409, code: "ROOM_ALREADY_MEMBER", message: "Already a member.", joinRequest: null };
    const again = renderer.createApp(defineComponent(() => () => h(RoomJoinAccess, {
      access: membershipAccess(null), account, busy: false, now: Date.now(), "onRefresh-room": () => refreshes.push(2),
    })));
    again.provide(ssrContextKey, { modules: new Set<string>() });
    const second = hostNode("root");
    again.mount(second);
    await click(second, "Ask to join");
    assert.deepEqual(refreshes, [2], "an existing member is sent straight to the room");
    again.unmount();
  } catch (error) { app.unmount(); throw error; }
});

const member = (accountId: string, login: string, role: "admin" | "member") => ({
  account_id: accountId, login, display_name: null, avatar_url: null, role, added_via: "seed", joined_at: "2026-10-01T00:00:00.000Z",
});
const joinRequest = (id: string, login: string): DesktopAccountRoomJoinRequest => ({
  id, state: "pending", created_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), decided_at: null, retry_after: null,
  room_id: "design-room", account_id: `acct_${login}`, login, display_name: null, avatar_url: null, decided_by_login: null,
  room_display_name: "Design room",
});

test("an admin sees members and requests, approves one, and meets the last-admin refusal", async () => {
  let members = [member("acct_me", "ada", "admin"), member("acct_bo", "bo", "member")];
  const calls: unknown[][] = [];
  installBridge({
    list: (async () => ({ ok: true, roomId: "design-room", accessRoomId: "design-room", managedBy: "letagents", canManage: true, members, viewerAccountId: "acct_me" })) as never,
    listJoinRequests: (async () => ({ ok: true, joinRequests: [joinRequest("rjr_7", "cy")] })) as never,
    listAccountJoinRequests: (async () => ({ ok: true, joinRequests: [] })) as never,
    decideJoinRequest: (async (...args: unknown[]) => {
      calls.push(["decide", ...args]);
      members = [...members, member("acct_cy", "cy", "member")];
      return { ok: true, joinRequest: { ...joinRequest("rjr_7", "cy"), state: "approved" } };
    }) as never,
    remove: (async (...args: unknown[]) => {
      calls.push(["remove", ...args]);
      return { ok: false, status: 409, code: "ROOM_LAST_ADMIN", message: "room_last_admin", joinRequest: null };
    }) as never,
  });
  const summaries: Array<string | null> = [];
  const { root, app } = mount(RoomMembers, () => ({ roomIdentifier: "design-room", onSummary: (value: string | null) => summaries.push(value) }));
  try {
    await flush();
    const page = text(root);
    assert.match(page, /cy asks to join/);
    assert.match(page, /@cy · asked 2 h ago/);
    assert.match(page, /ada\s*You/);
    assert.match(page, /@bo · Member/);
    assert.ok(button(root, "Make admin"), "an admin can promote a member");
    assert.ok(button(root, "Leave"), "everyone can leave");
    assert.equal(summaries.at(-1), "2 · 1 waiting");

    await click(root, "Approve");
    await flush();
    assert.doesNotMatch(text(root), /cy asks to join/);
    assert.match(text(root), /@cy · Member/, "the approved person is listed as a member");
    assert.deepEqual(calls[0], ["decide", "design-room", "rjr_7", "approve"]);

    await click(root, "Leave");
    await click(root, "Leave room");
    assert.deepEqual(calls.at(-1), ["remove", "design-room", "acct_me"]);
    assert.match(text(root), /A room needs at least one admin. Make another member an admin first./);
  } finally { app.unmount(); }
});

test("a member sees no admin actions, and a repo room says GitHub manages members", async () => {
  installBridge({
    list: (async () => ({ ok: true, roomId: "design-room", accessRoomId: "design-room", managedBy: "letagents", canManage: false,
      members: [member("acct_me", "ada", "member"), member("acct_bo", "bo", "admin")], viewerAccountId: "acct_me" })) as never,
    listAccountJoinRequests: (async () => ({ ok: true, joinRequests: [] })) as never,
  });
  const plain = mount(RoomMembers, () => ({ roomIdentifier: "design-room" }));
  try {
    await flush();
    assert.equal(button(plain.root, "Make admin"), undefined);
    assert.equal(button(plain.root, "Remove"), undefined);
    assert.ok(button(plain.root, "Leave"));
    assert.match(text(plain.root), /Only room admins can let people in or remove them./);
  } finally { plain.app.unmount(); }

  installBridge({
    list: (async () => ({ ok: true, roomId: "github.com/acme/app", accessRoomId: "github.com/acme/app", managedBy: "github", canManage: false, members: [], viewerAccountId: "acct_me" })) as never,
    listAccountJoinRequests: (async () => ({ ok: true, joinRequests: [] })) as never,
  });
  const repo = mount(RoomMembers, () => ({ roomIdentifier: "github.com/acme/app" }));
  try {
    await flush();
    assert.match(text(repo.root), /Members are managed on GitHub/);
    assert.equal(button(repo.root, "Leave"), undefined);
  } finally { repo.app.unmount(); }
});

test("in a focus room the list is the parent's, and Leave asks the app to check the room", async () => {
  const calls: unknown[][] = [];
  installBridge({
    list: (async () => ({ ok: true, roomId: "focus_9", accessRoomId: "design-room", managedBy: "letagents", canManage: false,
      members: [member("acct_me", "ada", "member"), member("acct_bo", "bo", "admin")], viewerAccountId: "acct_me" })) as never,
    listAccountJoinRequests: (async () => ({ ok: true, joinRequests: [] })) as never,
    remove: (async (...args: unknown[]) => { calls.push(args); return { ok: true, accountId: "acct_me" }; }) as never,
  });
  let rechecks = 0;
  const { root, app } = mount(RoomMembers, () => ({ roomIdentifier: "focus_9" }), [[roomAccessChangedKey, () => { rechecks += 1; }]]);
  try {
    await flush();
    assert.match(text(root), /This focus room uses the members of its parent room/);
    await click(root, "Leave");
    await click(root, "Leave parent room");
    assert.deepEqual(calls, [["focus_9", "acct_me"]]);
    assert.match(text(root), /You left the parent room and all of its focus rooms/);
    assert.equal(rechecks, 1, "the app checks the room again after Leave");
  } finally { app.unmount(); }
});

test("a server without member routes hides the section", async () => {
  installBridge({
    list: (async () => ({ ok: false, status: 404, code: null, message: "Not found", joinRequest: null })) as never,
    listAccountJoinRequests: (async () => ({ ok: true, joinRequests: [] })) as never,
  });
  const summaries: Array<string | null> = [];
  const { root, app } = mount(RoomMembers, () => ({ roomIdentifier: "design-room", onSummary: (value: string | null) => summaries.push(value) }));
  try {
    await flush();
    assert.equal(descendants(root).some((node) => node.type === "section"), false);
    assert.equal(summaries.at(-1), null);
  } finally { app.unmount(); }
});

test("an Inbox join request is approved in place and leaves Needs you", async () => {
  const calls: unknown[][] = [];
  let pendingRequests = [joinRequest("rjr_9", "dee")];
  installBridge({
    listAccountJoinRequests: (async () => ({ ok: true, joinRequests: pendingRequests })) as never,
    decideJoinRequest: (async (...args: unknown[]) => {
      calls.push(args);
      pendingRequests = [];
      return { ok: true, joinRequest: { ...joinRequest("rjr_9", "dee"), state: "approved" } };
    }) as never,
  });
  joinRequestsStore.roomJoinRequests.reset();
  await joinRequestsStore.roomJoinRequests.refresh();
  const data = { rooms: [], failures: [], limited: false, signedOut: false, cloudUnavailable: false };
  const { root, app } = mount(InboxView, () => ({ data, loading: false, error: "", joinRequests: joinRequestsStore.roomJoinRequests.items.value }));
  try {
    await flush();
    assert.match(text(root), /dee asks to join/);
    assert.match(text(root), /Join request/);
    assert.match(text(root), /Design room/);
    await click(root, "Approve");
    await flush();
    assert.deepEqual(calls, [["design-room", "rjr_9", "approve"]]);
    assert.equal(joinRequestsStore.roomJoinRequests.items.value.length, 0, "the request leaves Needs you");
    assert.match(text(root), /Approved/);
  } finally { app.unmount(); joinRequestsStore.roomJoinRequests.reset(); }
});

/**
 * The app's real refusal handling, with a small app context. Every room check
 * opens the room's stream before its snapshot, so the refresh below sends the
 * refusal while it runs, as the real one does.
 */
function mountSession(status: DesktopRoomAccess["status"] = "ready") {
  const loading = Vue.ref(false);
  const access = Vue.ref({ ...membershipAccess(null), status });
  const refreshes: number[] = [];
  const syncs: Array<string | null> = [];
  const app: Record<string, unknown> = {
    accountRooms: Vue.ref([]), attentionIntent: Vue.ref(null), authDialogOpen: Vue.ref(false), authStatus: Vue.ref(authStatus),
    firstRunStage: Vue.ref(null), inboxRentalError: Vue.ref(""), inboxRentals: Vue.ref([]), inboxSection: Vue.ref("needs-you"),
    loading, notificationRevealMessageId: Vue.ref(null), notificationRevealNonce: Vue.ref(0), rentalRequestCount: Vue.ref(0),
    repoStatus: Vue.ref(null), rootRoomSnapshot: Vue.ref(null), selectedSnapshot: Vue.ref({ roomIdentifier: "design-room" }),
    settingsAccountRooms: Vue.ref([]), sidebarLatestMessages: Vue.ref({}), windowFocused: Vue.ref(true), windowHidden: Vue.ref(false),
    workers: Vue.ref([]),
    activeEntry: Vue.ref({ type: "room" }),
    selectedAccess: access,
    selectedRoomIdentifier: Vue.computed(() => access.value.status === "ready" ? "design-room" : null),
    syncSelectedRoomStream: async (room: string | null) => { syncs.push(room); },
    handleRoomStreamEvent: () => undefined,
  };
  let session!: ReturnType<typeof sessionModule.useAppSessionActions>;
  let accessChanged!: () => void;
  const refuse = () => session.handleDesktopRoomStreamEvent({ type: "access_refused", roomIdentifier: "design-room", code: "ROOM_MEMBERSHIP_REQUIRED", httpStatus: 403 });
  app.refresh = async () => {
    refreshes.push(1);
    loading.value = true;
    await nextTick();
    refuse();
    await nextTick();
    loading.value = false;
  };
  // The session provides the access-changed hook to the components below it, as App.vue does.
  const Consumer = defineComponent(() => { accessChanged = Vue.inject(roomAccessChangedKey as Vue.InjectionKey<() => void>)!; return () => h("div"); });
  const Provider = defineComponent(() => { session = sessionModule.useAppSessionActions(app); return () => h(Consumer); });
  const mounted = renderer.createApp(Provider);
  mounted.provide(ssrContextKey, { modules: new Set<string>() });
  mounted.mount(hostNode("root"));
  return { loading, refreshes, syncs, refuse, accessChanged: () => accessChanged(), unmount: () => mounted.unmount() };
}

test("a refusal checks an open room once, and the check's own refusal starts no loop", async () => {
  const session = mountSession("ready");
  try {
    session.refuse();
    await flush();
    assert.equal(session.refreshes.length, 1, "one check, though its own stream was refused during it");
    session.refuse();
    await flush();
    assert.equal(session.refreshes.length, 1, "a refusal within 10 s does not reload the room");
  } finally { session.unmount(); }
});

test("a refusal during a check that the app did not start waits for it, then checks once", async () => {
  const session = mountSession("ready");
  try {
    session.loading.value = true;
    await nextTick();
    session.refuse();
    await flush();
    assert.equal(session.refreshes.length, 0, "nothing starts while a check runs");
    session.loading.value = false;
    await flush();
    assert.equal(session.refreshes.length, 1, "the deferred refusal checks the room once");
  } finally { session.unmount(); }
});

test("a room already on the join card is not reloaded by a refusal; Leave asks for one check", async () => {
  const session = mountSession("membership_required");
  try {
    session.refuse();
    await flush();
    assert.equal(session.refreshes.length, 0);
    session.accessChanged();
    await flush();
    assert.equal(session.refreshes.length, 1, "Leave checks the room again");
  } finally { session.unmount(); }
});
