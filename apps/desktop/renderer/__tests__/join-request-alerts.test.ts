import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderToString } from "@vue/server-renderer";
import { createSSRApp, effectScope, h, nextTick, reactive, ref, type Component } from "vue";
import { createServer, type ViteDevServer } from "vite";
import type { DesktopAccountRoomJoinRequest } from "../../electron/ipc-types";
import type { RoomJoinRequestEvent } from "../../../../shared/room-join-requests.mjs";

// The desktop learns of a request to join one of the account's rooms from the
// server's streams. These tests cover what the app does with it: the Inbox
// list, the banner's room filter, one sound, one notification, and the click.

const NOW = Date.parse("2026-11-07T12:00:00Z");
function request(id: string, login: string, extra: Partial<DesktopAccountRoomJoinRequest> = {}): DesktopAccountRoomJoinRequest {
  return {
    id, room_id: "design-lounge", account_id: `acct_${login}`, login, display_name: null, avatar_url: null,
    state: "pending", created_at: new Date(NOW - 5 * 60_000).toISOString(), decided_at: null, retry_after: null,
    decided_by_login: null, room_display_name: "Design lounge", ...extra,
  };
}
const event = (req: DesktopAccountRoomJoinRequest): RoomJoinRequestEvent => ({
  room_id: req.room_id, access_room_id: req.room_id, request: { ...req, room_display_name: req.room_display_name ?? "" },
});
const flush = async () => { for (let tick = 0; tick < 4; tick += 1) { await new Promise((resolve) => setImmediate(resolve)); await nextTick(); } };

let vite: ViteDevServer;
let JoinRequestBanner: Component;
let joinRequests: typeof import("../src/composables/useRoomJoinRequests");
let roomFilter: typeof import("../src/components/desktop/content/room-shell/join-requests");
let alerts: typeof import("../src/composables/app/useAppJoinRequestAlerts");
let shellJoinRequests: typeof import("../src/composables/room-shell/useRoomShellJoinRequests");
let preferences: typeof import("../src/composables/useRoomNotificationPreferences");
const bridgeCalls: unknown[][] = [];
let pendingOnServer: DesktopAccountRoomJoinRequest[] = [];
const storage = new Map<string, string>();
const notifications: Array<{ title: string; options: Record<string, unknown>; onclick: (() => void) | null }> = [];
let notificationPermission = "granted";
let notificationStatus = { enabled: true, nativeSupported: false, nativeRegistered: false, lastError: null };
let documentHasFocus = true;

before(async () => {
  Object.assign(globalThis, {
    document: { addEventListener: () => undefined, removeEventListener: () => undefined, hidden: false, visibilityState: "visible", hasFocus: () => documentHasFocus },
    window: {
      matchMedia: () => ({ matches: false }),
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
      letagentsDesktop: {
        roomMembers: {
          listAccountJoinRequests: async () => { bridgeCalls.push(["listAccountJoinRequests"]); return { ok: true, joinRequests: pendingOnServer }; },
          decideJoinRequest: async (...args: unknown[]) => { bridgeCalls.push(["decideJoinRequest", ...args]); return { ok: true, joinRequest: { id: args[1], state: args[2] === "approve" ? "approved" : "declined" } }; },
        },
        notifications: {
          getStatus: async () => notificationStatus,
          onStatusChanged: () => () => undefined,
        },
        room: {
          getNotificationPreference: async (id: string) => ({ room_id: id, level: id === "quiet-room" ? "muted" : "all", snoozed_until: null }),
          listNotificationPreferences: async () => ({ preferences: [], truncated: false }),
        },
      },
    },
    Notification: class {
      static get permission() { return notificationPermission; }
      onclick: (() => void) | null = null;
      constructor(public title: string, public options: Record<string, unknown>) { notifications.push(this); }
    },
  });
  vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  JoinRequestBanner = (await vite.ssrLoadModule(fileURLToPath(new URL("../../../../shared/ui/JoinRequestBanner.vue", import.meta.url)))).default;
  joinRequests = await vite.ssrLoadModule("/renderer/src/composables/useRoomJoinRequests.ts") as typeof joinRequests;
  roomFilter = await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-shell/join-requests.ts") as typeof roomFilter;
  alerts = await vite.ssrLoadModule("/renderer/src/composables/app/useAppJoinRequestAlerts.ts") as typeof alerts;
  preferences = await vite.ssrLoadModule("/renderer/src/composables/useRoomNotificationPreferences.ts") as typeof preferences;
  shellJoinRequests = await vite.ssrLoadModule("/renderer/src/composables/room-shell/useRoomShellJoinRequests.ts") as typeof shellJoinRequests;
});
after(async () => { await vite?.close(); });

const room = (overrides: Partial<Parameters<typeof roomFilter.joinRequestsForRoom>[1]> = {}) => ({
  identifier: "Design-Lounge", kind: "main" as const, parentRoomId: null, role: "admin", ...overrides,
});

test("the banner shows the pending requests of the room's access room to its admins only", () => {
  const items = [request("rjr_1", "ada"), request("rjr_2", "bob", { room_id: "other-room" }), request("rjr_3", "cy", { state: "approved" })];
  const dismissed = new Set<string>();
  assert.deepEqual(roomFilter.joinRequestsForRoom(items, room(), { localRoom: false, dismissed }).map((item) => item.id), ["rjr_1"]);
  assert.deepEqual(roomFilter.joinRequestsForRoom(items, room({ role: "participant" }), { localRoom: false, dismissed }), [], "a member sees no banner");
  assert.deepEqual(roomFilter.joinRequestsForRoom(items, room(), { localRoom: true, dismissed }), [], "a room kept on this computer has no requests");
  assert.deepEqual(roomFilter.joinRequestsForRoom(items, room({ identifier: "focus_4", kind: "focus", parentRoomId: "design-lounge" }), { localRoom: false, dismissed }).map((item) => item.id), ["rjr_1"], "a focus room shows its parent's requests");
  assert.deepEqual(roomFilter.joinRequestsForRoom(items, room(), { localRoom: false, dismissed: new Set(["rjr_1"]) }), [], "a closed banner stays closed");
});

test("a streamed request joins the Inbox list once and is announced; a baseline read and an answer are silent", async () => {
  const { roomJoinRequests } = joinRequests;
  const arrivals: Array<{ id: string; playSound: boolean }> = [];
  const stop = roomJoinRequests.onArrival(({ request: item, playSound }) => arrivals.push({ id: item.id, playSound }));
  try {
    pendingOnServer = [request("rjr_old", "olga")];
    await roomJoinRequests.refresh();
    assert.deepEqual(roomJoinRequests.items.value.map((item) => item.id), ["rjr_old"]);
    assert.deepEqual(arrivals, [], "what was already waiting is not news");

    roomJoinRequests.receive(event(request("rjr_new", "nina")));
    roomJoinRequests.receive(event(request("rjr_new", "nina")));
    assert.deepEqual(roomJoinRequests.items.value.map((item) => item.id), ["rjr_old", "rjr_new"]);
    assert.deepEqual(arrivals, [{ id: "rjr_new", playSound: true }], "one arrival for a repeated frame");

    (globalThis as { document: { hidden: boolean } }).document.hidden = true;
    roomJoinRequests.receive(event(request("rjr_h1", "h1")));
    roomJoinRequests.receive(event(request("rjr_h2", "h2")));
    assert.deepEqual(arrivals.slice(1), [{ id: "rjr_h1", playSound: true }, { id: "rjr_h2", playSound: false }], "hidden: the second sound within a minute is held");
    (globalThis as { document: { hidden: boolean } }).document.hidden = false;

    roomJoinRequests.receive(event(request("rjr_old", "olga", { state: "declined" })));
    assert.equal(roomJoinRequests.items.value.some((item) => item.id === "rjr_old"), false, "another admin's answer drops it");

    bridgeCalls.length = 0;
    pendingOnServer = [];
    const result = await roomJoinRequests.decide(request("rjr_new", "nina"), "approve");
    assert.equal(result.ok, true);
    assert.deepEqual(bridgeCalls[0], ["decideJoinRequest", "design-lounge", "rjr_new", "approve"]);
    assert.equal(roomJoinRequests.items.value.some((item) => item.id === "rjr_new"), false);

    roomJoinRequests.dismiss(["rjr_h1"]);
    assert.deepEqual([...roomJoinRequests.dismissed.value], ["rjr_h1"]);
    roomJoinRequests.reset();
    assert.deepEqual(roomJoinRequests.items.value, []);
    assert.equal(roomJoinRequests.dismissed.value.size, 0);
  } finally { stop(); }
});

test("an arrival plays the room sound and raises one notification, except for the room in front or a native alert", async () => {
  const { roomJoinRequests } = joinRequests;
  const opened: string[] = [];
  const activeEntry = ref<{ type: string }>({ type: "inbox" });
  const selectedRoomInfo = ref({ identifier: "design-lounge", kind: "main", parentRoomId: null });
  const roomSettingsSectionRequest = ref<{ roomIdentifier: string; section: string; nonce: number } | null>(null);
  const context = {
    authStatus: ref({ authenticated: true, account: { id: "acct_me", login: "me" } }),
    activeEntry, selectedRoomInfo, roomSettingsSectionRequest,
    openRoomFromAppAgent: async (roomIdentifier: string) => { opened.push(roomIdentifier); },
  };
  storage.set("letagents-desktop:sound", "on");
  storage.set("letagents-desktop:notifications", "on");
  const scope = effectScope();
  const api = scope.run(() => alerts.useAppJoinRequestAlerts(context))!;
  await flush();
  try {
    notifications.length = 0;
    // Another room is open: a notification, and a click opens the room's settings at Members.
    api.alertForArrival({ request: request("rjr_1", "ada", { display_name: "Ada" }), playSound: true });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]!.title, "Join request in Design lounge");
    assert.equal(notifications[0]!.options.body, "Ada wants to join");
    assert.equal(notifications[0]!.options.silent, true, "the room sound is the sound; the alert itself is silent");
    notifications[0]!.onclick?.();
    await flush();
    assert.deepEqual(opened, ["design-lounge"]);
    assert.deepEqual(roomSettingsSectionRequest.value, { roomIdentifier: "design-lounge", section: "members", nonce: 1 });

    // The room itself is in front: the banner is enough.
    activeEntry.value = { type: "room" };
    api.alertForArrival({ request: request("rjr_2", "bob"), playSound: false });
    assert.equal(notifications.length, 1, "no notification over the banner");
    documentHasFocus = false;
    api.alertForArrival({ request: request("rjr_3", "cy"), playSound: false });
    assert.equal(notifications.length, 2, "the window lost focus: the notification shows");
    documentHasFocus = true;

    // A focus room of the same access room counts as the room in front.
    selectedRoomInfo.value = { identifier: "focus_9", kind: "focus", parentRoomId: "Design-Lounge" };
    api.alertForArrival({ request: request("rjr_4", "dee"), playSound: false });
    assert.equal(notifications.length, 2);

    // A muted room (its setting is in the personal cache, read on sign-in and focus): no notification.
    activeEntry.value = { type: "inbox" };
    preferences.roomNotificationPreferences.setViewer({ id: "acct_me", login: "me" });
    await preferences.roomNotificationPreferences.refresh("quiet-room");
    await flush();
    assert.equal(preferences.roomNotificationsMuted("quiet-room"), true);
    api.alertForArrival({ request: request("rjr_5", "eve", { room_id: "quiet-room" }), playSound: true });
    assert.equal(notifications.length, 2, "a muted room raises nothing");

    // The native APNs alert covers it.
    notificationStatus = { enabled: true, nativeSupported: true, nativeRegistered: true, lastError: null };
    const nativeScope = effectScope();
    const nativeApi = nativeScope.run(() => alerts.useAppJoinRequestAlerts(context))!;
    await flush();
    nativeApi.alertForArrival({ request: request("rjr_6", "fay"), playSound: false });
    assert.equal(notifications.length, 2, "macOS shows the native alert instead");
    nativeScope.stop();
    notificationStatus = { enabled: true, nativeSupported: false, nativeRegistered: false, lastError: null };

    // Permission withdrawn: nothing, and no error.
    notificationPermission = "denied";
    api.alertForArrival({ request: request("rjr_7", "gus"), playSound: false });
    assert.equal(notifications.length, 2);
    notificationPermission = "granted";

    // Signed out: nothing.
    context.authStatus.value = { authenticated: false, account: null as never };
    api.alertForArrival({ request: request("rjr_8", "hal"), playSound: true });
    assert.equal(notifications.length, 2);
  } finally {
    scope.stop();
    roomJoinRequests.reset();
  }
});

async function render(props: Record<string, unknown>): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(JoinRequestBanner, props) }));
}

test("the shared banner renders one request with its actions, and several as a count that opens the list", async () => {
  const one = await render({ requests: [request("rjr_1", "ada", { display_name: "Ada Lovelace" })], now: NOW });
  assert.match(one, /Ada Lovelace wants to join this room/);
  assert.match(one, /asked 5 min ago/);
  assert.match(one, /data-testid="join-request-banner-approve"/);
  assert.match(one, /data-testid="join-request-banner-decline"/);
  assert.match(one, /data-testid="join-request-banner-close"/);
  const two = await render({ requests: [request("rjr_1", "ada"), request("rjr_2", "bob")], now: NOW });
  assert.match(two, /2 people want to join this room/);
  assert.match(two, /data-testid="join-request-banner-review"/);
  assert.doesNotMatch(two, /join-request-banner-approve/);
});

test("a notification click opens the room settings at Members once; the app clears the request so a later visit does not", async () => {
  const { roomJoinRequests } = joinRequests;
  const opened: string[] = [];
  const emitted: string[] = [];
  const props = reactive({
    room: { identifier: "design-lounge", kind: "main", parentRoomId: null, role: "admin" },
    roomLoading: true,
    settingsSectionRequest: { roomIdentifier: "design-lounge", section: "members", nonce: 1 } as { roomIdentifier: string; section: string; nonce: number } | null,
  });
  const context = { props, emit: (name: string) => emitted.push(name), isLocalRoom: ref(false), openActionPanelAt: (section: string) => opened.push(section) };
  const scope = effectScope();
  const shell = scope.run(() => shellJoinRequests.useRoomShellJoinRequests(context))!;
  try {
    await flush();
    assert.deepEqual(opened, [], "nothing opens while the room still loads");
    props.roomLoading = false;
    await flush();
    assert.deepEqual(opened, ["members"]);
    assert.deepEqual(emitted, ["settings-section-opened"], "the shell tells the app, and the app clears the request");
    props.settingsSectionRequest = null;
    props.roomLoading = true;
    props.roomLoading = false;
    await flush();
    assert.deepEqual(opened, ["members"], "a reload of the room without a request opens nothing");
    props.settingsSectionRequest = { roomIdentifier: "design-lounge", section: "members", nonce: 2 };
    await flush();
    assert.deepEqual(opened, ["members", "members"], "a second click opens it again");
    roomJoinRequests.receive(event(request("rjr_shell", "sam")));
    await flush();
    assert.deepEqual(shell.joinRequestBanner.value.map((item) => item.id), ["rjr_shell"]);
    shell.openJoinRequests();
    assert.deepEqual(opened.at(-1), "members", "Review requests opens the Members section");
  } finally {
    scope.stop();
    roomJoinRequests.reset();
  }
});
