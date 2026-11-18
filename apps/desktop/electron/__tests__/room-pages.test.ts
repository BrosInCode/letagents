import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";

import { HTML_DEMO_PARTITION } from "../main/attachments/html-demo-policy.js";
import {
  MAX_ROOM_PAGES,
  PAGE_CALL_BURST,
  PAGE_CALL_CHANNEL,
  PAGE_PARTITION,
  pageOpenTarget,
} from "../main/pages/page-policy.js";

const app = new EventEmitter();
const demoDocuments = new Map<string, string>();
const demoContents = new Map<number, string>();
const lockedIds: number[] = [];

class FakeApiError extends Error {
  constructor(readonly status: number, readonly payload: Record<string, unknown> | null) {
    super(String(payload?.message ?? `API request failed: ${status}`));
  }
}

mock.module("electron", { defaultExport: { app } });
mock.module("../main/auth.js", { namedExports: {
  apiFetch: async () => { throw new Error("no network in tests"); },
  DesktopApiError: FakeApiError,
} });
mock.module("../main/attachments/html-demo-session.js", { namedExports: {
  htmlDemoDocuments: demoDocuments,
  htmlDemoContents: demoContents,
  htmlDemoSession: async () => ({ clearStorageData: async () => {} }),
  loadHtmlDemoAttachment: async (href: string) => ({ html: `<p>${href}</p>`, byteLength: 10 }),
  lockHtmlDemoContents: (contents: { id: number }) => { lockedIds.push(contents.id); },
} });
const pageDocuments = new Map<string, string>();
const pageContents = new Map<number, string>();
mock.module("../main/pages/page-session.js", { namedExports: {
  roomPageDocuments: pageDocuments,
  roomPageContents: pageContents,
  roomPageSession: async () => ({ clearStorageData: async () => {} }),
} });

const { installInlineHtmlDemoHost, prepareInlineHtmlDemo, releaseInlineHtmlDemo } = await import("../main/attachments/html-demo-inline.js");
const {
  configureRoomPages,
  installRoomPageHost,
  listRoomPages,
  prepareRoomPage,
  releaseRoomPage,
  ROOM_PAGE_EVENT_CHANNEL,
  ROOM_PAGE_PRELOAD_PATH,
  roomPageLeaseForSender,
  setRoomPageTheme,
  setRoomPageVisible,
} = await import("../main/pages/page-host.js");
const { createPageGrantKeeper, parsePageGrant, PAGE_GRANT_REFRESH_BEFORE_MS, PAGE_GRANT_RETRY_MS } = await import("../main/pages/page-grants.js");
const { isRefusedWebviewSender, refuseWebviewSenders } = await import("../main/ipc-sender-guard.js");
const { createPageCallHandler } = await import("../main/pages/page-bridge.js");
const { createMemoryPageChoiceStore, createPageConfirmBroker, pageChoiceKey } = await import("../main/pages/page-confirm.js");
const { createMemoryPageBackend, createHttpPageApiAdapter, createHttpRoomPageSource, pageApiRequest, pageCallFailureFromApi } = await import("../main/pages/page-adapter.js");
const { clearPageDiagnosticsForTest, readPageDiagnostics, recordPageDiagnostic, takePageDiagnostics, restorePageDiagnostics, PAGE_DIAGNOSTICS_ENTRIES, PAGE_DIAGNOSTIC_WRITE_BURST } = await import("../main/pages/page-diagnostics.js");
const { PageCallFailure } = await import("../main/pages/page-policy.js");

let nextGuestId = 500;

class FakeGuest extends EventEmitter {
  readonly id = nextGuestId++;
  readonly mainFrame = { name: "main" };
  destroyed = false;
  crashed = false;
  sent: Array<{ channel: string; payload: unknown }> = [];
  scripts = 0;
  getType() { return "webview"; }
  isDestroyed() { return this.destroyed; }
  isCrashed() { return this.crashed; }
  forcefullyCrashRenderer() { this.crashed = true; }
  executeJavaScriptInIsolatedWorld() { this.scripts += 1; return Promise.resolve(1); }
  setAudioMuted() {}
  send(channel: string, payload: unknown) { this.sent.push({ channel, payload }); }
  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("destroyed");
  }
}

class FakeEmbedder extends EventEmitter {
  readonly id = 1;
  readonly mainFrame = { name: "app" };
  sent: Array<{ channel: string; payload: unknown }> = [];
  isDestroyed() { return false; }
  getZoomFactor() { return 1; }
  send(channel: string, payload: unknown) { this.sent.push({ channel, payload }); }
}

const embedder = new FakeEmbedder();
const appWindow = Object.assign(new EventEmitter(), { webContents: embedder, isDestroyed: () => false, isFocused: () => true });
installInlineHtmlDemoHost(appWindow as never);
installRoomPageHost(appWindow as never);

let grantFails = false;
const grants = createPageGrantKeeper();
const backend = createMemoryPageBackend({
  grants,
  grantFails: () => grantFails,
  pages: {
    "room-a": [
      { id: "sprint", title: "Sprint view", version: 3, html: "<h1>Sprint</h1>" },
      { id: "big", title: "Big", version: 1, html: "x".repeat(2 * 1024 * 1024 + 1) },
    ],
  },
  handlers: {
    "rooms.get": (lease) => ({ id: lease.roomId, name: "Room A" }),
  },
});
const lastEnded: unknown[] = [];
grants.configure((roomId, pageId) => backend.source.grant(roomId, pageId));
configureRoomPages({
  source: backend.source,
  grants,
  onLeaseEnd: (lease) => { lastEnded.push(lease); confirm.declineFor(lease); },
  onLeaseHidden: (lease) => confirm.declineFor(lease),
});

const shown: Array<{ id: string; kind: string; text: string; target: string; rememberable: boolean }> = [];
let showSheets = true;
const choices = createMemoryPageChoiceStore();
const confirm = createPageConfirmBroker({
  show: (request) => {
    if (!showSheets) return false;
    shown.push(request);
    return true;
  },
  choices,
});
const opened: string[] = [];
const clipboardWrites: string[] = [];
let clock = Date.now();
const handlePageCall = createPageCallHandler({
  leaseFor: roomPageLeaseForSender,
  adapter: backend.adapter,
  methods: new Set(["rooms.get"]),
  confirm,
  viewer: async () => ({ id: "acct-1", login: "ada", displayName: "Ada" }),
  theme: () => ({ mode: "dark", tokens: { "--la-bg": "#0a0a0a" } }),
  openExternal: async (url) => { opened.push(url); },
  writeClipboard: (text) => { clipboardWrites.push(text); },
  record: recordPageDiagnostic,
  now: () => clock,
});

function willAttach(params: Record<string, unknown>) {
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  const webPreferences: Record<string, unknown> = { partition: params.partition, preload: "/tmp/app-preload.js", zoomFactor: 1, nodeIntegration: true };
  embedder.emit("will-attach-webview", event, webPreferences, params);
  return { allowed: !event.defaultPrevented, webPreferences };
}

function attach(src: unknown, partition: unknown) {
  const params: Record<string, unknown> = { src, partition, allowpopups: "true" };
  const { allowed, webPreferences } = willAttach(params);
  if (!allowed) return null;
  const guest = new FakeGuest();
  app.emit("web-contents-created", {}, guest);
  embedder.emit("did-attach-webview", {}, guest);
  return { guest, params, webPreferences };
}

async function openPage(pageId = "sprint") {
  const lease = await prepareRoomPage("room-a", pageId);
  const attached = attach(lease.url, PAGE_PARTITION);
  assert.ok(attached, "the page lease attaches");
  return { lease, guest: attached.guest, webPreferences: attached.webPreferences };
}

/** The page is in the active tab and the person just clicked in it. */
function present(guest: FakeGuest, url: string) {
  setRoomPageVisible(url, true);
  guest.emit("input-event", {}, { type: "mouseDown" });
  clock = Date.now();
}

function callFrom(sender: { mainFrame: unknown }, method: unknown, input?: unknown, frame: unknown = sender.mainFrame) {
  return handlePageCall({ sender, senderFrame: frame } as never, { method, input });
}

const flushImmediates = () => new Promise<void>((resolve) => setImmediate(resolve));

test("one router: a demo still attaches without a preload, a page attaches with the bridge preload, anything else is refused", async () => {
  assert.equal(embedder.listenerCount("will-attach-webview"), 1, "demos and pages share one attach listener");
  assert.equal(embedder.listenerCount("did-attach-webview"), 1);

  const demo = await prepareInlineHtmlDemo("letagents-attachment://download/ZGVtbw");
  const page = await prepareRoomPage("room-a", "sprint");
  try {
    assert.equal(attach("https://example.com/", PAGE_PARTITION), null);
    assert.equal(attach(page.url, HTML_DEMO_PARTITION), null, "a page lease in the demo partition is refused");
    assert.equal(attach(demo.url, PAGE_PARTITION), null, "a demo lease in the page partition is refused");
    assert.equal(attach("letagents-page://00000000000000000000000000000000/", PAGE_PARTITION), null);

    const demoGuest = attach(demo.url, HTML_DEMO_PARTITION);
    assert.ok(demoGuest);
    assert.equal("preload" in demoGuest.webPreferences, false, "a demo never gets a preload");
    assert.equal(demoGuest.webPreferences.partition, HTML_DEMO_PARTITION);

    const pageGuest = attach(page.url, PAGE_PARTITION);
    assert.ok(pageGuest);
    assert.equal(pageGuest.webPreferences.preload, ROOM_PAGE_PRELOAD_PATH);
    assert.match(String(pageGuest.webPreferences.preload), /page-preload\.cjs$/);
    assert.equal(pageGuest.webPreferences.partition, PAGE_PARTITION);
    assert.equal(pageGuest.webPreferences.sandbox, true);
    assert.equal(pageGuest.webPreferences.contextIsolation, true);
    assert.equal(pageGuest.webPreferences.nodeIntegration, false);
    assert.equal(pageGuest.webPreferences.enablePreferredSizeMode, false);
    assert.equal("allowpopups" in pageGuest.params, false);
    assert.equal(pageContents.get(pageGuest.guest.id), page.url.slice("letagents-page://".length, -1));
    assert.ok(lockedIds.includes(pageGuest.guest.id), "the page gets the demo navigation locks");
    assert.equal(attach(page.url, PAGE_PARTITION), null, "a second webview cannot reuse the page lease");

    const stray = new FakeGuest();
    app.emit("web-contents-created", {}, stray);
    embedder.emit("did-attach-webview", {}, stray);
    await flushImmediates();
    assert.equal(stray.destroyed, true, "a guest no route owns is closed");
    assert.equal(pageGuest.guest.destroyed, false);
    assert.equal(demoGuest.guest.destroyed, false);
  } finally {
    releaseInlineHtmlDemo(demo.url);
    releaseRoomPage(page.url);
  }
});

test("pages have their own lease budget and no liveness kill", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const urls: string[] = [];
  try {
    for (let index = 0; index < MAX_ROOM_PAGES; index += 1) urls.push((await prepareRoomPage("room-a", "sprint")).url);
    await assert.rejects(prepareRoomPage("room-a", "sprint"), /At most 6 room pages/);
    // Demos keep their own budget while every page lease is taken.
    const demo = await prepareInlineHtmlDemo("letagents-attachment://download/YnVkZ2V0");
    releaseInlineHtmlDemo(demo.url);

    const attached = attach(urls[0], PAGE_PARTITION);
    assert.ok(attached);
    t.mock.timers.tick(60_000);
    await flushImmediates();
    assert.equal(attached.guest.scripts, 0, "main never runs a liveness script in a page");
    assert.equal(attached.guest.destroyed, false, "a quiet page stays open while its room is");
    assert.equal(pageDocuments.size, 1, "only unattached leases expire");

    attached.guest.emit("unresponsive");
    assert.deepEqual(embedder.sent.at(-1), { channel: ROOM_PAGE_EVENT_CHANNEL, payload: { type: "stopped", url: urls[0], reason: "unresponsive" } });
    await flushImmediates();
    assert.equal(attached.guest.destroyed, true);
  } finally {
    for (const url of urls) releaseRoomPage(url);
    embedder.sent = [];
  }
});

test("a page larger than 2 MB does not open, and an unknown page fails", async () => {
  await assert.rejects(prepareRoomPage("room-a", "big"), /larger than 2 MB/);
  await assert.rejects(prepareRoomPage("room-a", "missing"), /could not be loaded/);
  await assert.rejects(prepareRoomPage("", "sprint"), /room is missing/);
  assert.deepEqual(await listRoomPages("room-a"), [
    { id: "sprint", title: "Sprint view", version: 3 },
    { id: "big", title: "Big", version: 1 },
  ]);
  assert.deepEqual(await listRoomPages("room-without-pages"), []);
});

test("page:call from the main window, a demo, a subframe or a closed page is refused", async () => {
  const demo = await prepareInlineHtmlDemo("letagents-attachment://download/Y2FsbA");
  const { lease, guest } = await openPage();
  try {
    const demoGuest = attach(demo.url, HTML_DEMO_PARTITION);
    assert.ok(demoGuest);
    for (const sender of [embedder, demoGuest.guest]) {
      assert.deepEqual(await callFrom(sender, "page.get"), {
        ok: false, error: { code: "not_granted", message: "Only a room page can use this bridge." },
      });
    }
    assert.equal((await callFrom(guest, "page.get", null, { name: "subframe" })).ok, false, "only the page's main frame");
    assert.equal((await callFrom(guest, "page.get", null, null)).ok, false);
    assert.deepEqual(await callFrom(guest, "page.get"), { ok: true, value: { id: "sprint", title: "Sprint view", version: 3 } });

    releaseRoomPage(lease.url);
    assert.equal((await callFrom(guest, "page.get")).ok, false, "a released page has no grant");
  } finally {
    releaseInlineHtmlDemo(demo.url);
    releaseRoomPage(lease.url);
  }
});

test("an unknown or malformed method is refused before the adapter, and a known one reaches it with the page's grant", async () => {
  const { lease, guest } = await openPage();
  try {
    const before = backend.calls.length;
    for (const method of ["tasks.delete_everything", "ui", "UI.OPEN", "", 42, "rooms.get.x.y"]) {
      const result = await callFrom(guest, method);
      assert.equal(result.ok, false, String(method));
      assert.equal(!result.ok && result.error.code, "not_found", String(method));
    }
    assert.equal(backend.calls.length, before, "nothing reached the adapter");

    assert.deepEqual(await callFrom(guest, "rooms.get", { fields: ["name"] }), { ok: true, value: { id: "room-a", name: "Room A" } });
    const host = lease.url.slice("letagents-page://".length, -1);
    const call = backend.calls.at(-1)!;
    assert.deepEqual({ ...call, token: "" }, {
      lease: { leaseId: host, roomId: "room-a", pageId: "sprint", version: 3 }, method: "rooms.get", input: { fields: ["name"] }, token: "",
    });
    assert.match(call.token, /^grant-\d+$/, "the call carries the lease's own page grant");
    const tooLarge = await callFrom(guest, "rooms.get", { text: "x".repeat(300 * 1024) });
    assert.equal(!tooLarge.ok && tooLarge.error.code, "too_large");
  } finally {
    releaseRoomPage(lease.url);
  }
});

test("a page without a grant gets not_granted and never the person's session", async () => {
  grantFails = true;
  const first = await openPage();
  try {
    const refused = await callFrom(first.guest, "rooms.get");
    assert.deepEqual(refused, { ok: false, error: { code: "not_granted", message: "This page has no grant in this room." } });
    assert.equal((await callFrom(first.guest, "page.get")).ok, true, "main's own answers need no grant");
  } finally {
    grantFails = false;
    releaseRoomPage(first.lease.url);
  }
  const second = await openPage();
  try {
    assert.equal((await callFrom(second.guest, "rooms.get")).ok, true);
    grants.dropAll();
    const afterSignOut = await callFrom(second.guest, "rooms.get");
    assert.equal(!afterSignOut.ok && afterSignOut.error.code, "not_granted", "sign-out drops every page token for good");
    const host = second.lease.url.slice("letagents-page://".length, -1);
    assert.equal(await grants.token(host), null);
  } finally {
    releaseRoomPage(second.lease.url);
  }
  const third = await openPage();
  const host = third.lease.url.slice("letagents-page://".length, -1);
  assert.ok(await grants.token(host));
  releaseRoomPage(third.lease.url);
  assert.equal(await grants.token(host), null, "a released lease drops its token");
});

test("grant keeper: one mint at a time, a new token a minute before expiry, a pause after a failure", async () => {
  let time = 1_000_000;
  let fail = false;
  const mints: string[] = [];
  const keeper = createPageGrantKeeper({
    now: () => time,
    mint: async (roomId, pageId) => {
      mints.push(`${roomId}/${pageId}`);
      if (fail) throw new Error("refused");
      return { token: `t${mints.length}`, expiresAt: time + 15 * 60_000, capabilities: ["rooms.read"] };
    },
  });
  keeper.start("L", "r", "p");
  assert.deepEqual(await Promise.all([keeper.token("L"), keeper.token("L")]), ["t1", "t1"]);
  assert.equal(mints.length, 1, "the lease's first mint is shared");
  assert.deepEqual(keeper.capabilities("L"), ["rooms.read"]);
  time += 15 * 60_000 - PAGE_GRANT_REFRESH_BEFORE_MS - 1;
  assert.equal(await keeper.token("L"), "t1");
  time += 2;
  assert.equal(await keeper.token("L"), "t2", "refreshed in the last minute");
  fail = true;
  time += 15 * 60_000 - 30_000;
  assert.equal(await keeper.token("L"), "t2", "a failed refresh keeps the token while it is still valid");
  time += 31_000;
  assert.equal(await keeper.token("L"), null, "an expired token is never sent");
  const tries = mints.length;
  assert.equal(await keeper.token("L"), null);
  assert.equal(mints.length, tries, "no new mint until the pause ends");
  fail = false;
  time += PAGE_GRANT_RETRY_MS;
  const retried = await keeper.token("L");
  assert.equal(retried, `t${mints.length}`, "a mint after the pause");
  assert.equal(mints.length, tries + 1);
  assert.equal(await keeper.token("unknown"), null);
  assert.deepEqual(parsePageGrant({ token: "x", expiresAt: "2026-11-18T10:00:00Z", capabilities: ["a", 1] }),
    { token: "x", expiresAt: Date.parse("2026-11-18T10:00:00Z"), capabilities: ["a"] });
  assert.equal(parsePageGrant({ token: "", expiresAt: 1 }), null);
  assert.equal(parsePageGrant({ token: "x", expiresAt: "soon" }), null);
});

test("the rate comes first: malformed and refused calls cost the page a token too", async () => {
  const { lease, guest } = await openPage();
  const start = clock;
  try {
    for (let index = 0; index < PAGE_CALL_BURST; index += 1) {
      const result = await callFrom(guest, index % 2 ? "no such method" : "ui.copy", index % 2 ? undefined : { text: "x" });
      assert.equal(result.ok, false);
    }
    const refused = await callFrom(guest, "page.get");
    assert.equal(!refused.ok && refused.error.code, "rate_limited");
    assert.ok(!refused.ok && refused.error.retryAfterMs! > 0);
    const malformed = await handlePageCall({ sender: guest, senderFrame: guest.mainFrame } as never, { method: "page.get", input: { big: "x".repeat(1_000_000) } });
    assert.equal(!malformed.ok && malformed.error.code, "rate_limited", "refused before the input is measured");
    clock += 1_000;
    assert.equal((await callFrom(guest, "page.get")).ok, true, "the bucket refills");
  } finally {
    clock = start;
    releaseRoomPage(lease.url);
  }
});

test("ui.open: https only, from the open tab right after a click, one per 2 s, and a new domain asks once per open page", async () => {
  const { lease, guest } = await openPage();
  shown.length = 0;
  opened.length = 0;
  try {
    present(guest, lease.url);
    for (const url of ["http://example.com/", "javascript:alert(1)", "file:///etc/passwd", "https://user:pw@example.com/", 7]) {
      const result = await callFrom(guest, "ui.open", { url });
      assert.equal(!result.ok && result.error.code, "not_granted", String(url));
    }
    assert.equal(shown.length, 0);

    setRoomPageVisible(lease.url, false);
    const hidden = await callFrom(guest, "ui.open", { url: "https://example.com/" });
    assert.equal(!hidden.ok && hidden.error.message, "ui.open works only from the page in the open tab.");
    setRoomPageVisible(lease.url, true);
    clock = Date.now() + 5_001;
    const late = await callFrom(guest, "ui.open", { url: "https://example.com/" });
    assert.equal(!late.ok && late.error.message, "ui.open works only right after a click or key press in the page.");
    assert.equal(shown.length, 0, "no sheet without the person");

    present(guest, lease.url);
    const declined = callFrom(guest, "ui.open", { url: "https://Example.com/a?b=1" });
    await flushImmediates();
    assert.equal(shown.length, 1);
    assert.deepEqual({ ...shown[0], id: "" }, {
      id: "", kind: "open", pageTitle: "Sprint view", pageVersion: 3, text: "https://example.com/a?b=1", target: "example.com", rememberable: false,
    });
    const tooSoon = await callFrom(guest, "ui.open", { url: "https://example.com/other" });
    assert.equal(!tooSoon.ok && tooSoon.error.code, "rate_limited", "one open per 2 seconds");
    assert.ok(!tooSoon.ok && tooSoon.error.retryAfterMs! > 0 && tooSoon.error.retryAfterMs! <= 2_000);
    clock += 2_000;
    const busy = await callFrom(guest, "ui.open", { url: "https://example.com/other" });
    assert.equal(!busy.ok && busy.error.message, "Answer the open question first.", "one sheet per page at a time");
    confirm.answer(shown[0].id, "declined", false);
    const declinedResult = await declined;
    assert.equal(!declinedResult.ok && declinedResult.error.code, "declined");
    assert.deepEqual(opened, []);

    present(guest, lease.url);
    clock += 2_000;
    const confirmed = callFrom(guest, "ui.open", { url: "https://example.com/a" });
    await flushImmediates();
    confirm.answer(shown[1].id, "confirmed", false);
    assert.deepEqual(await confirmed, { ok: true, value: null });
    clock += 2_000;
    assert.deepEqual(await callFrom(guest, "ui.open", { url: "https://example.com/b" }), { ok: true, value: null });
    assert.equal(shown.length, 2, "a confirmed domain opens without asking again while this page is open");
    clock += 2_000;
    const noClick = await callFrom(guest, "ui.open", { url: "https://example.com/c" });
    assert.equal(!noClick.ok && noClick.error.code, "not_granted", "every open needs a fresh click, even to a known domain");
    assert.deepEqual(opened, ["https://example.com/a", "https://example.com/b"]);
  } finally {
    releaseRoomPage(lease.url);
  }

  const again = await openPage();
  try {
    present(again.guest, again.lease.url);
    const asked = callFrom(again.guest, "ui.open", { url: "https://example.com/a" });
    await flushImmediates();
    assert.equal(shown.length, 3, "a new lease of the same page asks again");
    setRoomPageVisible(again.lease.url, false);
    const result = await asked;
    assert.equal(!result.ok && result.error.code, "declined", "leaving the tab declines the page's open sheet");
  } finally {
    releaseRoomPage(again.lease.url);
  }
});

test("ui.copy works only from the open tab, right after the person's own input in that page", async () => {
  const { lease, guest } = await openPage();
  clipboardWrites.length = 0;
  const start = clock;
  try {
    setRoomPageVisible(lease.url, true);
    const before = await callFrom(guest, "ui.copy", { text: "hello" });
    assert.equal(!before.ok && before.error.code, "not_granted");
    guest.emit("input-event", {}, { type: "mouseMove" });
    clock = Date.now();
    assert.equal((await callFrom(guest, "ui.copy", { text: "hello" })).ok, false, "a pointer move is not a click");

    guest.emit("input-event", {}, { type: "mouseDown" });
    clock = Date.now();
    assert.deepEqual(await callFrom(guest, "ui.copy", { text: "hello" }), { ok: true, value: null });
    const notText = await callFrom(guest, "ui.copy", { text: { html: "<b>x</b>" } });
    assert.equal(!notText.ok && notText.error.code, "invalid_input", "plain text only");
    setRoomPageVisible(lease.url, false);
    assert.equal((await callFrom(guest, "ui.copy", { text: "hidden" })).ok, false, "a page in another tab cannot copy");
    setRoomPageVisible(lease.url, true);
    clock = Date.now() + 5_001;
    assert.equal((await callFrom(guest, "ui.copy", { text: "late" })).ok, false, "the window is 5 seconds");
    assert.deepEqual(clipboardWrites, ["hello"]);
  } finally {
    clock = start;
    releaseRoomPage(lease.url);
  }
});

test("only one page is visible at a time in a window", async () => {
  const a = await openPage();
  const b = await openPage();
  try {
    setRoomPageVisible(a.lease.url, true);
    setRoomPageVisible(b.lease.url, true);
    a.guest.emit("input-event", {}, { type: "mouseDown" });
    clock = Date.now();
    assert.equal((await callFrom(a.guest, "ui.copy", { text: "a" })).ok, false, "showing b hid a");
    b.guest.emit("input-event", {}, { type: "mouseDown" });
    assert.equal((await callFrom(b.guest, "ui.copy", { text: "b" })).ok, true);
  } finally {
    releaseRoomPage(a.lease.url);
    releaseRoomPage(b.lease.url);
  }
});

test("ui.theme, ui.context and viewer.get answer from main, and a theme change reaches open pages", async () => {
  const { lease, guest } = await openPage();
  try {
    assert.deepEqual(await callFrom(guest, "ui.theme"), { ok: true, value: { mode: "dark", tokens: { "--la-bg": "#0a0a0a" } } });
    assert.deepEqual(await callFrom(guest, "viewer.get"), { ok: true, value: { id: "acct-1", login: "ada", displayName: "Ada" } });
    assert.deepEqual(await callFrom(guest, "ui.context"), { ok: true, value: {
      surface: "room.tab", room: { id: "room-a" }, page: { id: "sprint", title: "Sprint view", version: 3 },
      viewer: { id: "acct-1", login: "ada", displayName: "Ada" },
    } });
    setRoomPageTheme("light");
    setRoomPageTheme("purple");
    assert.equal(guest.sent.length, 1);
    assert.equal(guest.sent[0].channel, PAGE_CALL_CHANNEL, "events reach the page on its one channel");
    const pushed = guest.sent[0].payload as { event: string; value: { mode: string; tokens: Record<string, string> } };
    assert.equal(pushed.event, "theme");
    assert.equal(pushed.value.mode, "light");
    assert.equal(pushed.value.tokens["--la-bg"], "#ffffff");
  } finally {
    setRoomPageTheme("dark");
    releaseRoomPage(lease.url);
  }
});

test("confirm sheet: a decline returns declined and runs nothing; Don't ask again holds for one page version", async () => {
  const owner = {};
  const scope = { viewerId: "acct-1", roomId: "room-a", pageId: "sprint", version: 3 };
  const ask = { kind: "post" as const, pageTitle: "Sprint view", text: "Ship it", target: "#room-a", rememberable: true, choice: "post" };
  shown.length = 0;
  let posted = 0;
  const post = async () => { if (await confirm.ask(owner, scope, ask) === "confirmed") posted += 1; };

  const first = post();
  await flushImmediates();
  confirm.answer(shown[0].id, "declined", true);
  await first;
  assert.equal(posted, 0, "a declined sheet posts nothing");
  assert.equal(await choices.has(pageChoiceKey(scope, "post")), false, "a no is never remembered");

  const second = post();
  await flushImmediates();
  confirm.answer(shown[1].id, "confirmed", true);
  await second;
  assert.equal(posted, 1);
  await post();
  assert.equal(shown.length, 2, "the remembered yes skips the sheet");
  assert.equal(posted, 2);
  const nextVersion = confirm.ask(owner, { ...scope, version: 4 }, ask);
  await flushImmediates();
  assert.equal(shown.length, 3, "a new page version asks again");
  confirm.answer("not-a-sheet", "confirmed", true);
  confirm.declineFor(owner);
  assert.equal(await nextVersion, "declined", "closing the page declines its open sheets");

  showSheets = false;
  try {
    assert.equal(await confirm.ask({}, { ...scope, version: 9 }, ask), "declined", "no window to draw in means no");
  } finally {
    showSheets = true;
  }
});

test("a sheet still open when its page closes ends declined", async () => {
  const { lease, guest } = await openPage();
  shown.length = 0;
  present(guest, lease.url);
  const pending = callFrom(guest, "ui.open", { url: "https://closing.example/" });
  await flushImmediates();
  assert.equal(shown.length, 1);
  guest.close();
  const result = await pending;
  assert.equal(!result.ok && result.error.code, "declined");
  assert.ok(lastEnded.length > 0);
  releaseRoomPage(lease.url);
});

test("diagnostics keep console warnings and errors, crashes and failed calls per page version", async () => {
  clearPageDiagnosticsForTest();
  const { lease, guest } = await openPage();
  try {
    guest.emit("console-message", { level: "info", message: "hello", sourceId: "x", lineNumber: 1 });
    guest.emit("console-message", { level: "error", message: "boom", sourceId: "letagents-page://h/", lineNumber: 7 });
    await callFrom(guest, "nope.nothing");
    guest.emit("render-process-gone", {}, { reason: "oom" });
    const key = { roomId: "room-a", pageId: "sprint", version: 3 };
    const entries = readPageDiagnostics(key).map(({ at: _at, ...entry }) => entry);
    assert.deepEqual(entries, [
      { kind: "console", level: "error", message: "boom", source: "letagents-page://h/", line: 7 },
      { kind: "call", method: "nope.nothing", code: "not_found", message: "There is no method \"nope.nothing\"." },
      { kind: "crash", reason: "oom" },
    ]);
    const taken = takePageDiagnostics(key);
    assert.equal(readPageDiagnostics(key).length, 0);
    restorePageDiagnostics(key, taken);
    assert.equal(readPageDiagnostics(key).length, 3, "a failed upload gives the entries back");
    let time = Date.now() + 60_000;
    for (let index = 0; index < PAGE_DIAGNOSTICS_ENTRIES + 10; index += 1) {
      time += 1_000;
      recordPageDiagnostic(key, { kind: "call", method: "m", code: "x", message: "y".repeat(5_000) }, time);
    }
    const bounded = readPageDiagnostics(key);
    assert.equal(bounded.length, PAGE_DIAGNOSTICS_ENTRIES);
    assert.ok(bounded[0].kind === "call" && bounded[0].message.length <= 2_001);

    // A page that fails in a loop: main keeps a burst, then counts the rest in one entry.
    const flood = { roomId: "room-a", pageId: "flood", version: 1 };
    for (let index = 0; index < 1_000; index += 1) recordPageDiagnostic(flood, { kind: "call", method: "m", code: "x", message: "y" }, time);
    assert.equal(readPageDiagnostics(flood).length, PAGE_DIAGNOSTIC_WRITE_BURST);
    recordPageDiagnostic(flood, { kind: "crash", reason: "oom" }, time + 1_000);
    assert.deepEqual(readPageDiagnostics(flood).slice(-2).map(({ at: _at, ...entry }) => entry), [
      { kind: "dropped", count: 1_000 - PAGE_DIAGNOSTIC_WRITE_BURST },
      { kind: "crash", reason: "oom" },
    ]);
  } finally {
    await flushImmediates();
    releaseRoomPage(lease.url);
    clearPageDiagnosticsForTest();
  }
});

test("the page preload talks only over page:call and exposes window.letagents", () => {
  const source = readFileSync(fileURLToPath(new URL("../page-preload.cts", import.meta.url)), "utf8");
  assert.match(source, /const CHANNEL = "page:call";/);
  const ipcUses = Array.from(source.matchAll(/ipcRenderer\.(\w+)\(([^,)]*)/g), (match) => [match[1], match[2].trim()]);
  assert.deepEqual(ipcUses, [["invoke", "CHANNEL"], ["on", "CHANNEL"]], "one channel, nothing else");
  assert.match(source, /exposeInMainWorld\("letagents"/);
  for (const name of ["api:", "page:", "viewer:", "use:", "open:", "copy:", "theme:", "context:"]) assert.ok(source.includes(name), name);
  assert.doesNotMatch(source, /require\(|process\.|ipcRenderer\.send/);
});

test("http adapter: routes from the mapping table, the page's own grant token, and the server's error shape", async () => {
  const requests: Array<{ path: string; init?: RequestInit; options?: unknown }> = [];
  const fetchApi = (async (path: string, init?: RequestInit, options?: unknown) => {
    requests.push({ path, init, options });
    if (path.includes("/missing")) throw new FakeApiError(403, { code: "not_granted", message: "No." });
    return { ok: path };
  }) as never;
  const tokens: Record<string, string> = { L1: "page-token-1" };
  const adapter = createHttpPageApiAdapter({
    grants: { token: async (leaseId: string) => tokens[leaseId] ?? null },
    routes: {
      "rooms.get": { method: "GET", path: "/rooms/:room" },
      "tasks.get": { method: "GET", path: "/rooms/:room/tasks/:taskId" },
      "tasks.propose": { method: "POST", path: "/rooms/:room/intents" },
      "docs.missing": { method: "GET", path: "/rooms/:room/missing" },
    },
    fetchApi,
  });
  const lease = { leaseId: "L1", roomId: "github.com/a/b", pageId: "p1", version: 2 };
  assert.deepEqual(await adapter.call(lease, "rooms.get", null), { ok: "/api/v1/rooms/github.com%2Fa%2Fb" });
  await adapter.call(lease, "tasks.get", { taskId: "task 1", include: ["prs"], room: "github.com/other/room" });
  assert.equal(requests.at(-1)?.path, "/api/v1/rooms/github.com%2Fa%2Fb/tasks/task%201?include=%5B%22prs%22%5D");
  assert.deepEqual(requests.at(-1)?.options, { credential: "none" }, "never the person's session");
  assert.equal(new Headers(requests.at(-1)?.init?.headers).get("Authorization"), "Bearer page-token-1");
  const sent = requests.length;
  await assert.rejects(adapter.call({ ...lease, leaseId: "L2" }, "rooms.get", null),
    (error: unknown) => error instanceof PageCallFailure && error.code === "not_granted");
  assert.equal(requests.length, sent, "no token, no request");
  for (const taskId of ["", ".", "..", "a/b", "a\\b", "../../admin"]) {
    await assert.rejects(adapter.call(lease, "tasks.get", { taskId }),
      (error: unknown) => error instanceof PageCallFailure && error.code === "invalid_input", JSON.stringify(taskId));
  }
  assert.equal(requests.length, sent, "a bad path value sends nothing");
  await adapter.call(lease, "tasks.propose", { kind: "task.update", payload: { status: "done" } });
  assert.equal(requests.at(-1)?.init?.method, "POST");
  assert.equal(requests.at(-1)?.init?.body, JSON.stringify({ kind: "task.update", payload: { status: "done" } }));
  await assert.rejects(adapter.call(lease, "tasks.get", {}), (error: unknown) => error instanceof PageCallFailure && error.code === "invalid_input");
  await assert.rejects(adapter.call(lease, "docs.missing", {}), (error: unknown) => error instanceof PageCallFailure && error.code === "not_granted" && error.message === "No.");
  await assert.rejects(adapter.call(lease, "toString", {}), (error: unknown) => error instanceof PageCallFailure && error.code === "not_found");

  assert.equal(pageCallFailureFromApi(new FakeApiError(429, { retryAfterMs: 2000 })).retryAfterMs, 2000);
  assert.equal(pageCallFailureFromApi(new FakeApiError(429, null)).code, "rate_limited");
  assert.equal(pageCallFailureFromApi(new FakeApiError(400, { code: "invalid_input", message: "taskId: Required" })).message, "taskId: Required");
  assert.equal(pageCallFailureFromApi(new FakeApiError(502, null)).code, "source_unavailable");
  assert.equal(pageCallFailureFromApi(new Error("ECONNRESET")).code, "source_unavailable");
  assert.deepEqual(pageApiRequest({ method: "DELETE", path: "/rooms/:room/docs/:id" }, "r", { id: "d" }).path, "/api/v1/rooms/r/docs/d");
});

test("every page route is the contract's own route for that method", async () => {
  const { getApiMethod } = await import("../../../../shared/api/index.mjs");
  const { PAGE_API_ROUTES } = await import("../main/pages/page-adapter.js");
  assert.ok(Object.keys(PAGE_API_ROUTES).length > 0);
  for (const [name, route] of Object.entries(PAGE_API_ROUTES)) {
    const method = getApiMethod(name);
    assert.ok(method, `${name} is a contract method`);
    assert.deepEqual(route, { method: method.httpMethod, path: method.path }, name);
  }
});

test("http page source: a server without page routes is a room with no pages, and grants are minted with the app session", async () => {
  const requests: Array<{ path: string; init?: RequestInit; options?: unknown }> = [];
  const source = createHttpRoomPageSource((async (path: string, init?: RequestInit, options?: unknown) => {
    requests.push({ path, init, options });
    if (path.startsWith("/api/v1/rooms/none/")) throw new FakeApiError(404, null);
    if (path.endsWith("/grant")) return path.includes("/bad/") ? { token: "" } : { token: "pg", expiresAt: "2030-01-01T00:00:00Z", capabilities: ["rooms.read"] };
    if (path.endsWith("/document")) return { page: { id: "p1", title: "  Release ", version: 2 }, html: "<p>ok</p>" };
    return { pages: [{ id: "p1", title: "Release", version: 2 }, { id: "", version: 1 }, { id: "p2", version: 0 }] };
  }) as never);
  assert.deepEqual(await source.list("none"), []);
  assert.deepEqual(await source.list("room"), [{ id: "p1", title: "Release", version: 2 }]);
  assert.deepEqual(await source.load("room", "p1"), { page: { id: "p1", title: "Release", version: 2 }, html: "<p>ok</p>" });
  await assert.rejects(source.load("room", "other"), /could not be loaded/);
  assert.deepEqual(await source.grant("github.com/a/b", "p1"), { token: "pg", expiresAt: Date.parse("2030-01-01T00:00:00Z"), capabilities: ["rooms.read"] });
  assert.equal(requests.at(-1)?.path, "/api/v1/rooms/github.com%2Fa%2Fb/pages/p1/grant");
  assert.equal(requests.at(-1)?.init?.method, "POST");
  assert.deepEqual(requests.at(-1)?.options, { credential: "app" });
  await assert.rejects(source.grant("room", "bad"), /no page grant/);
});

test("IPC from a webview guest reaches only page:call", async () => {
  const registered = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const messages = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  const target = {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => { registered.set(channel, listener); },
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => { messages.set(channel, listener); },
    removeHandler: (channel: string) => { registered.delete(channel); },
  };
  const guarded = refuseWebviewSenders(target as never);
  const seen: string[] = [];
  guarded.handle("desktop:auth:sign-out", async () => { seen.push("sign-out"); return "done"; });
  guarded.handle(PAGE_CALL_CHANNEL, async () => { seen.push("page"); return "ok"; });
  guarded.on("desktop:ping", () => { seen.push("ping"); });
  const page = { sender: { getType: () => "webview" } };
  const app = { sender: { getType: () => "window" } };
  assert.throws(() => registered.get("desktop:auth:sign-out")!(page), /Embedded pages cannot use desktop:auth:sign-out/);
  assert.equal(await registered.get(PAGE_CALL_CHANNEL)!(page), "ok");
  assert.equal(await registered.get("desktop:auth:sign-out")!(app), "done");
  messages.get("desktop:ping")!(page);
  messages.get("desktop:ping")!(app);
  assert.deepEqual(seen, ["page", "sign-out", "ping"]);
  guarded.removeHandler("desktop:auth:sign-out");
  assert.equal(registered.has("desktop:auth:sign-out"), false, "other IpcMain calls pass through");
  assert.equal(isRefusedWebviewSender("desktop:x", undefined), false);

  // The composition root registers every app channel through the guard.
  const ipcSource = readFileSync(fileURLToPath(new URL("../main/ipc.ts", import.meta.url)), "utf8");
  const body = ipcSource.slice(ipcSource.indexOf("export function registerDesktopIpcHandlers"));
  assert.ok(body.indexOf("targetIpcMain = refuseWebviewSenders(targetIpcMain);") < body.indexOf("registerDesktopAuthAndSetupIpcHandlers(targetIpcMain)"));
});

test("page open targets are https with no user name", () => {
  assert.deepEqual(pageOpenTarget("https://Docs.Example.com/x"), { url: "https://docs.example.com/x", domain: "docs.example.com" });
  assert.equal(pageOpenTarget("https://example.com/" + "a".repeat(3000)), null);
  assert.equal(pageOpenTarget("letagents://room"), null);
});
