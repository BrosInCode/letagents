import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRenderer, effectScope, h, nextTick, ref, ssrContextKey } from "vue";
import { createServer, type ViteDevServer } from "vite";

import {
  INVITE_ROOM_SEARCH_AFTER,
  inviteRoomListFades,
  inviteRoomMeta,
  inviteRoomNameParts,
  useInviteRoomPicker,
} from "../src/components/desktop/content/room-chat/invite-room-picker";
import type { DesktopBotInviteRoom } from "../../electron/ipc-types";

const NAMES = [
  "sky-owl", "willow-fox", "fern-river", "pearl-shore", "indigo-anchor", "willow-creek", "plains-spring", "brisk-falcon",
  "tidal-dune", "kind-creek", "verdant-forest", "amber-owl", "rapid-stone", "winter-sparrow", "frost-spring", "shore-delta",
  "Room 10:31", "hollow-glade", "fern-wind", "cedar-vista", "willow-comet", "misty-harbor", "quiet-meadow", "silver-brook",
  "copper-ridge", "lunar-bay", "north-pine", "ember-field", "coral-peak", "sage-hollow", "Herotel pilot",
];

function room(name: string, index: number, overrides: Partial<DesktopBotInviteRoom> = {}): DesktopBotInviteRoom {
  return { id: `ROOM-${String(index).padStart(4, "0")}`, displayName: name, role: "admin", memberCount: 1, ...overrides };
}

const MANY = NAMES.map((name, index) => room(name, index));
const FEW = MANY.slice(0, 3);

function key(name: string, extra: Record<string, unknown> = {}) {
  const event = {
    key: name, isComposing: false, defaultPrevented: false, propagationStopped: false,
    preventDefault() { event.defaultPrevented = true; },
    stopPropagation() { event.propagationStopped = true; },
    ...extra,
  };
  return event;
}

function picker(rooms: DesktopBotInviteRoom[]) {
  const picked: string[] = [];
  const list = ref<readonly DesktopBotInviteRoom[]>(rooms);
  const scope = effectScope();
  const made = scope.run(() => useInviteRoomPicker(list, (chosen) => picked.push(chosen.displayName)))!;
  return { ...made, list, picked, scope };
}

/* ---------- the row text ---------- */

test("a row shows a count only when two or more people are in the room; a member's row says it asks an admin", () => {
  assert.equal(inviteRoomMeta({ role: "admin", memberCount: 1 }), "", "a room of one is you alone");
  assert.equal(inviteRoomMeta({ role: "admin", memberCount: null }), "");
  assert.equal(inviteRoomMeta({ role: "admin", memberCount: 2 }), "2 people");
  assert.equal(inviteRoomMeta({ role: "admin", memberCount: 6 }), "6 people");
  assert.equal(inviteRoomMeta({ role: "member", memberCount: 1 }), "asks admin");
  assert.equal(inviteRoomMeta({ role: "member", memberCount: null }), "asks admin");
  assert.equal(inviteRoomMeta({ role: "member", memberCount: 4 }), "4 people · asks admin");
  for (const listed of MANY) assert.doesNotMatch(inviteRoomMeta(listed), /1 person/);
});

/* ---------- the filter ---------- */

test("the matching part of a name is cut out, case-insensitive, at its first place", () => {
  assert.deepEqual(inviteRoomNameParts("amber-owl", "OWL"), [{ text: "amber-", match: false }, { text: "owl", match: true }]);
  assert.deepEqual(inviteRoomNameParts("Willow-fox", "wil"), [{ text: "Wil", match: true }, { text: "low-fox", match: false }]);
  assert.deepEqual(inviteRoomNameParts("owl-owl", "owl"), [{ text: "owl", match: true }, { text: "-owl", match: false }]);
  assert.deepEqual(inviteRoomNameParts("Room 10:31", " 10:3 "), [
    { text: "Room ", match: false }, { text: "10:3", match: true }, { text: "1", match: false },
  ], "the text is trimmed");
  assert.deepEqual(inviteRoomNameParts("sky-owl", ""), [{ text: "sky-owl", match: false }]);
  assert.deepEqual(inviteRoomNameParts("sky-owl", "fox"), [{ text: "sky-owl", match: false }]);
  // Characters that mean something in a pattern are plain text here.
  assert.deepEqual(inviteRoomNameParts("a (b) c", "(b)"), [{ text: "a ", match: false }, { text: "(b)", match: true }, { text: " c", match: false }]);
  assert.deepEqual(inviteRoomNameParts("plain", ".*"), [{ text: "plain", match: false }]);
});

test(`with ${INVITE_ROOM_SEARCH_AFTER} rooms or fewer there is no search; with more, the text filters by name`, async () => {
  const few = picker(FEW);
  assert.equal(few.searchable.value, false);
  few.setQuery("owl");
  assert.deepEqual(few.shown.value.map((listed) => listed.displayName), ["sky-owl", "willow-fox", "fern-river"], "no field, no filter");
  assert.deepEqual(few.nameParts("sky-owl"), [{ text: "sky-owl", match: false }]);

  const six = picker(MANY.slice(0, INVITE_ROOM_SEARCH_AFTER));
  assert.equal(six.searchable.value, false);
  const seven = picker(MANY.slice(0, INVITE_ROOM_SEARCH_AFTER + 1));
  assert.equal(seven.searchable.value, true);

  const many = picker(MANY);
  assert.equal(many.searchable.value, true);
  many.setQuery("OWL");
  await nextTick();
  assert.deepEqual(many.shown.value.map((listed) => listed.displayName), ["sky-owl", "amber-owl"]);
  assert.deepEqual(many.nameParts("amber-owl"), [{ text: "amber-", match: false }, { text: "owl", match: true }]);
  many.setQuery("  willow ");
  assert.deepEqual(many.shown.value.map((listed) => listed.displayName), ["willow-fox", "willow-creek", "willow-comet"]);
  many.setQuery("nothing-like-this");
  assert.equal(many.shown.value.length, 0);
  many.setQuery("");
  assert.equal(many.shown.value.length, MANY.length, "an empty field shows every room, in the server's order");
  for (const made of [few, six, seven, many]) made.scope.stop();
});

/* ---------- the keys ---------- */

test("↑ and ↓ move the active row and wrap; ↵ picks it; a new search starts at its first row", async () => {
  const many = picker(MANY);
  assert.equal(many.active.value, 0);
  const down = key("ArrowDown");
  assert.equal(many.handleKey(down as never), true);
  assert.equal(down.defaultPrevented, true, "the caret does not move");
  assert.equal(many.active.value, 1);
  many.handleKey(key("ArrowUp") as never);
  many.handleKey(key("ArrowUp") as never);
  assert.equal(many.active.value, MANY.length - 1, "up from the first row wraps to the last");
  many.handleKey(key("ArrowDown") as never);
  assert.equal(many.active.value, 0, "down from the last row wraps to the first");

  many.setQuery("willow");
  await nextTick();
  assert.equal(many.active.value, 0);
  many.handleKey(key("ArrowDown") as never);
  many.handleKey(key("ArrowDown") as never);
  const enter = key("Enter");
  assert.equal(many.handleKey(enter as never), true);
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(many.picked, ["willow-comet"]);

  // The pointer moves the same active row.
  many.setActive(0);
  many.handleKey(key("Enter") as never);
  assert.deepEqual(many.picked, ["willow-comet", "willow-fox"]);
  many.scope.stop();
});

test("↵ with no match picks nothing; keys while an input method composes are left alone", async () => {
  const many = picker(MANY);
  many.setQuery("zzz");
  await nextTick();
  const enter = key("Enter");
  assert.equal(many.handleKey(enter as never), true);
  assert.deepEqual(many.picked, []);
  many.setQuery("owl");
  await nextTick();
  const composing = key("Enter", { isComposing: true });
  assert.equal(many.handleKey(composing as never), false);
  assert.equal(composing.defaultPrevented, false);
  assert.deepEqual(many.picked, []);
  many.scope.stop();
});

test("Escape clears the text first; with no text it is left to the panel, which closes", async () => {
  const many = picker(MANY);
  many.setQuery("owl");
  await nextTick();
  const first = key("Escape");
  assert.equal(many.handleKey(first as never), true);
  assert.equal(first.defaultPrevented, true);
  assert.equal(first.propagationStopped, true, "the panel does not also close");
  assert.equal(many.query.value, "");
  const second = key("Escape");
  assert.equal(many.handleKey(second as never), false);
  assert.equal(second.defaultPrevented, false, "the flyout's own Escape closes the panel");
  assert.equal(second.propagationStopped, false);
  many.scope.stop();
});

test("the active row stays inside a list that gets shorter", async () => {
  const many = picker(MANY);
  many.setActive(30);
  many.list.value = MANY.slice(0, 10);
  await nextTick();
  assert.equal(many.active.value, 9);
  many.list.value = [];
  await nextTick();
  assert.equal(many.active.value, 0);
  many.setActive(3);
  assert.equal(many.active.value, 0, "no rows, no active row to move");
  many.scope.stop();
});

/* ---------- the fades ---------- */

test("an edge of the list fades only while more rows are past it", () => {
  assert.deepEqual(inviteRoomListFades({ scrollTop: 0, scrollHeight: 200, clientHeight: 200 }), { above: false, below: false });
  assert.deepEqual(inviteRoomListFades({ scrollTop: 0, scrollHeight: 1100, clientHeight: 236 }), { above: false, below: true });
  assert.deepEqual(inviteRoomListFades({ scrollTop: 300, scrollHeight: 1100, clientHeight: 236 }), { above: true, below: true });
  assert.deepEqual(inviteRoomListFades({ scrollTop: 864, scrollHeight: 1100, clientHeight: 236 }), { above: true, below: false });
  // Sub-pixel scroll positions at an end count as the end.
  assert.deepEqual(inviteRoomListFades({ scrollTop: 863.5, scrollHeight: 1100, clientHeight: 236 }), { above: true, below: false });
});

/* ---------- the styles and the template ---------- */

const css = readFileSync(new URL("../src/styles/composer-agent-reasoning/composer-invite-panel.css", import.meta.url), "utf8");
const flyoutCss = readFileSync(new URL("../src/styles/composer-agent-reasoning/composer-gif-panel.css", import.meta.url), "utf8");
const panelSource = readFileSync(new URL("../src/components/desktop/content/room-chat/RoomInviteBotPanel.vue", import.meta.url), "utf8");

function rule(source: string, selector: string): string {
  const at = source.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `missing rule ${selector}`);
  return source.slice(at, source.indexOf("}", at));
}

test("the room list scrolls inside the GIF grid's height, with no scrollbar, and keeps that height while you search", () => {
  const list = rule(css, ".desktop-invite-bot-list");
  for (const declaration of ["max-height: 236px", "overflow-y: auto", "overscroll-behavior: contain", "scrollbar-width: none", "min-height: 0"]) {
    assert.match(list, new RegExp(declaration.replace(/[()]/g, "\\$&")), declaration);
  }
  assert.match(rule(flyoutCss, ".desktop-composer-gif-grid"), /max-height: 236px/, "the same height as the GIF grid");
  assert.match(rule(css, ".desktop-invite-bot-list::-webkit-scrollbar"), /display: none/);
  assert.match(rule(css, ".desktop-invite-bot-rooms[data-searchable] .desktop-invite-bot-list"), /height: 236px/);
  assert.match(rule(css, ".desktop-invite-bot-list[data-more-below]"), /mask-image: linear-gradient\(to bottom, #000 calc\(100% - 22px\), transparent\)/);
  assert.match(rule(css, ".desktop-invite-bot-list[data-more-above]"), /mask-image: linear-gradient\(to bottom, transparent, #000 22px\)/);
  assert.match(rule(css, ".desktop-invite-bot-list[data-more-above][data-more-below]"), /transparent, #000 22px, #000 calc\(100% - 22px\), transparent/);
  assert.match(rule(css, ".desktop-invite-bot-list[data-typed] .desktop-invite-bot-room"), /animation: none/, "no row motion while typing");
});

test("the flyout is never taller than its measured cap, and the invite panel shrinks its list first", () => {
  const flyout = rule(flyoutCss, ".desktop-composer-add-flyout");
  assert.match(flyout, /max-height: var\(--desktop-composer-flyout-max, none\)/);
  assert.match(flyout, /overflow-y: auto/);
  assert.match(rule(flyoutCss, '.desktop-composer-add-flyout[data-flyout="invite"]'), /flex-direction: column/);
  assert.match(rule(css, ".desktop-invite-bot"), /flex-direction: column;[\s\S]*min-height: 0/);
  assert.match(rule(css, ".desktop-invite-bot-rooms > :not(.desktop-invite-bot-list)"), /flex: none/, "the title, search and New invite room keep their height");
});

test("the search field is the GIF panel's, takes the focus, and New invite room stays below the scrolling list", () => {
  assert.match(panelSource, /class="desktop-composer-gif-search desktop-invite-bot-search"/);
  const search = panelSource.slice(panelSource.indexOf("<input"), panelSource.indexOf("/>", panelSource.indexOf("<input")));
  assert.match(search, /placeholder="Find a room"/);
  assert.match(search, /data-invite-autofocus/);
  assert.match(search, /role="combobox"/);
  assert.match(search, /:aria-activedescendant="activeRoomId"/);
  const listStart = panelSource.indexOf('class="desktop-invite-bot-list"');
  const listEnd = panelSource.indexOf('<div v-if="roomsState !== \'loading\'" class="desktop-invite-bot-foot-rooms">');
  const newRoom = panelSource.indexOf('data-testid="desktop-invite-bot-new-room"');
  assert.ok(listStart > 0 && listEnd > listStart && newRoom > listEnd, "New invite room is outside the scrolling list");
  assert.match(panelSource, /No room called "\{\{ picker\.query\.value\.trim\(\) \}\}"\. Make a new one below\./);
  assert.match(panelSource, /<mark\s+v-if="part\.match" class="desktop-invite-bot-match">/);
  // Rows slide in and stretch the scroll height until they land: the fades measure again then.
  assert.match(panelSource, /@scroll\.passive="updateFades"\s+@animationend="updateFades"/);
  assert.doesNotMatch(panelSource, /1 person/);
});

/* ---------- the panel, mounted ---------- */

let vite: ViteDevServer;
let Panel: any;
let listed: DesktopBotInviteRoom[] = [];
const originals = { window: Object.getOwnPropertyDescriptor(globalThis, "window"), document: Object.getOwnPropertyDescriptor(globalThis, "document") };
before(async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: Object.assign(new EventTarget(), {
    letagentsDesktop: {
      roomInvites: { listRooms: async () => ({ ok: true, rooms: listed }) },
      room: { createInviteRoom: async () => ({ roomIdentifier: "NEW-ROOM", code: "NEW-ROOM", snapshot: { room: { displayName: "fresh-pine" } } }) },
    },
    setTimeout, clearTimeout,
    matchMedia: () => ({ matches: false }),
  }) });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: Object.assign(new EventTarget(), { activeElement: null, body: {} }) });
  vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true, hmr: false } });
  Panel = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-chat/RoomInviteBotPanel.vue")).default;
});
after(async () => {
  await vite?.close();
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
const flush = async () => { await nextTick(); await new Promise((resolve) => setImmediate(resolve)); await nextTick(); };

function mountPanel(t: { after: (fn: () => void) => void }) {
  let vm: any;
  const events: unknown[][] = [];
  const props = { context: { roomId: "GITROOM", roomName: "Focus: The Board", gitRoom: true, admin: true, connectorUrl: "https://letagents.chat/mcp" } };
  const child = { setup() { vm = Panel.setup(props, { expose() {}, emit: (...args: unknown[]) => events.push(args) }); return () => h("div"); } };
  const app = renderer.createApp({ render: () => h(child) });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount({});
  t.after(() => app.unmount());
  return { vm, events };
}

test("in a Git Room with 31 rooms the panel searches; ↓ ↵ opens the invite for that room, and Back keeps the search", async (t) => {
  listed = MANY.map((listedRoom, index) => index === 0 ? { ...listedRoom, memberCount: 3 } : listedRoom);
  const { vm } = mountPanel(t);
  await flush();
  assert.equal(vm.roomsState.value, "ready");
  assert.equal(vm.picker.searchable.value, true);
  assert.equal(vm.inviteRoomMeta(vm.picker.shown.value[0]), "3 people");
  assert.equal(vm.inviteRoomMeta(vm.picker.shown.value[1]), "");

  vm.findRoom("creek");
  await flush();
  assert.equal(vm.typed.value, true, "rows that come back while typing do not animate");
  assert.deepEqual(vm.picker.shown.value.map((shown: DesktopBotInviteRoom) => shown.displayName), ["willow-creek", "kind-creek"]);
  assert.equal(vm.activeRoomId.value, `${vm.listId}-0`);
  vm.picker.handleKey(key("ArrowDown"));
  await flush();
  assert.equal(vm.activeRoomId.value, `${vm.listId}-1`);
  vm.picker.handleKey(key("Enter"));
  await flush();
  assert.equal(vm.view.value, "invite");
  assert.equal(vm.target.value.name, "kind-creek");

  vm.backToRooms();
  await flush();
  assert.equal(vm.view.value, "rooms");
  assert.equal(vm.picker.query.value, "creek", "Back shows the same search");
  assert.equal(vm.typed.value, false);

  vm.findRoom("zzz");
  await flush();
  assert.equal(vm.activeRoomId.value, undefined, "no row, no active row for a screen reader");
  await vm.newRoom();
  await flush();
  assert.equal(vm.target.value.name, "fresh-pine");
  assert.equal(vm.picker.query.value, "", "a new room is not hidden by an old search");
  assert.equal(vm.picker.shown.value[0].displayName, "fresh-pine");
  assert.equal(vm.inviteRoomMeta(vm.picker.shown.value[0]), "", "a new room of one shows no count");
});

test("in a Git Room with 3 rooms the panel lists them as before, with no search", async (t) => {
  listed = FEW;
  const { vm } = mountPanel(t);
  await flush();
  assert.equal(vm.picker.searchable.value, false);
  assert.equal(vm.picker.shown.value.length, 3);
  vm.picker.setQuery("owl");
  assert.equal(vm.picker.shown.value.length, 3, "no field, so nothing filters");
});
