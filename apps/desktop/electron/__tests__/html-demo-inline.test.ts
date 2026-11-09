import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { mock } from "node:test";

import {
  HTML_DEMO_PARTITION,
  INLINE_HTML_DEMO_CACHE_ENTRIES,
  INLINE_HTML_DEMO_EVENT_BURST,
  INLINE_HTML_DEMO_EVENTS_PER_SECOND,
  INLINE_HTML_DEMO_LIVE_ROOT_CSS,
  INLINE_HTML_DEMO_LIVE_WIDTH_SCRIPT,
  INLINE_HTML_DEMO_LIVENESS_WORLD_ID,
} from "../main/attachments/html-demo-policy.js";

const app = new EventEmitter();
const documents = new Map<string, string>();
const contents = new Map<number, string>();
const lockedIds: number[] = [];
const loads: string[] = [];
const clearedOrigins: string[] = [];
let nextLoad: { byteLength: number } | null = null;
type Loaded = { html: string; byteLength: number };
/** Replaces the download for one test; the default finishes at once. */
let loadOverride: ((href: string, signal?: AbortSignal) => Promise<Loaded>) | null = null;

mock.module("electron", { defaultExport: { app } });
mock.module("../main/attachments/html-demo-session.js", { namedExports: {
  htmlDemoDocuments: documents,
  htmlDemoContents: contents,
  htmlDemoSession: async () => ({ clearStorageData: async ({ origin }: { origin: string }) => { clearedOrigins.push(origin); } }),
  loadHtmlDemoAttachment: async (href: string, signal?: AbortSignal) => {
    loads.push(href);
    if (loadOverride) return loadOverride(href, signal);
    return { html: `<p>${href}</p>`, byteLength: nextLoad?.byteLength ?? 100 };
  },
  lockHtmlDemoContents: (contents: { id: number }) => { lockedIds.push(contents.id); },
} });

const {
  clearInlineHtmlDemoCache,
  INLINE_HTML_DEMO_EVENT_CHANNEL,
  inlineHtmlDemoAnchorAt,
  installInlineHtmlDemoHost,
  prepareInlineHtmlDemo,
  releaseInlineHtmlDemo,
  setInlineHtmlDemoWidth,
  watchInlineHtmlDemoPointer,
} = await import("../main/attachments/html-demo-inline.js");

let nextGuestId = 100;

class FakeGuest extends EventEmitter {
  readonly id = nextGuestId++;
  destroyed = false;
  crashed = false;
  muted = false;
  crashCalls = 0;
  /** "now" answers each liveness check at once; "never" leaves it hanging like a looping page. */
  answers: "now" | "never" = "now";
  checks: Array<{ worldId: number; code: string; answer: () => void }> = [];
  getType() { return "webview"; }
  /** The page's layout width in CSS px as main's own world reads it: the frame's points over the zoom the page runs at. */
  framePoints = 380;
  renderedZoom: number | null = null;
  layoutChecks: Array<{ worldId: number; code: string }> = [];
  /** What the page's own world answers for the element under a pin; "never" hangs like a busy page. */
  anchorAnswer: unknown = null;
  anchorScripts: string[] = [];
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: Array<{ code: string }>) {
    const code = scripts.map((script) => script.code).join(";");
    if (code === INLINE_HTML_DEMO_LIVE_WIDTH_SCRIPT) {
      this.layoutChecks.push({ worldId, code });
      return Promise.resolve(this.framePoints / (this.renderedZoom ?? this.zoom));
    }
    if (code.includes("document.elementFromPoint")) {
      this.anchorScripts.push(code);
      return this.anchorAnswer === "never" ? new Promise<unknown>(() => {}) : Promise.resolve(this.anchorAnswer);
    }
    return new Promise<unknown>((resolve) => {
      const check = { worldId, code, answer: () => resolve(1) };
      this.checks.push(check);
      if (this.answers === "now") check.answer();
    });
  }
  css: Array<{ css: string; options: unknown }> = [];
  insertCSS(css: string, options: unknown) {
    this.css.push({ css, options });
    return Promise.resolve(`key${this.css.length}`);
  }
  isDestroyed() { return this.destroyed; }
  isCrashed() { return this.crashed; }
  muteCalls: boolean[] = [];
  zoom = 1;
  zoomCalls: number[] = [];
  getZoomFactor() { return this.zoom; }
  setZoomFactor(zoom: number) { this.zoom = zoom; this.zoomCalls.push(zoom); }
  setAudioMuted(muted: boolean) { this.muted = muted; this.muteCalls.push(muted); }
  forcefullyCrashRenderer() { this.crashCalls += 1; this.crashed = true; }
  // A guest's close deletes it at once, as Electron 42 does.
  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("destroyed");
  }
}

class FakeEmbedder extends EventEmitter {
  zoom = 1;
  sent: unknown[] = [];
  isDestroyed() { return false; }
  getZoomFactor() { return this.zoom; }
  send(channel: string, payload: unknown) {
    assert.equal(channel, INLINE_HTML_DEMO_EVENT_CHANNEL);
    this.sent.push(payload);
  }
}

const embedder = new FakeEmbedder();
/** The app window: tests set `focused` the way the OS would before emitting its events. */
const appWindow = Object.assign(new EventEmitter(), {
  webContents: embedder,
  focused: true,
  isFocused() { return this.focused; },
  isDestroyed() { return false; },
});
installInlineHtmlDemoHost(appWindow as never);

function willAttach(params: Record<string, unknown>) {
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  const webPreferences: Record<string, unknown> = { partition: params.partition, preload: "/tmp/preload.js", zoomFactor: 1 };
  embedder.emit("will-attach-webview", event, webPreferences, params);
  return { allowed: !event.defaultPrevented, webPreferences };
}

/** What Electron does for one `<webview>`: ask, create the guest in the same task, then attach it. */
function attach(src: unknown, partition: unknown = HTML_DEMO_PARTITION) {
  const params: Record<string, unknown> = { src, partition, allowpopups: "true" };
  const { allowed, webPreferences } = willAttach(params);
  if (!allowed) return null;
  const guest = new FakeGuest();
  app.emit("web-contents-created", {}, guest);
  embedder.emit("did-attach-webview", {}, guest);
  return { guest, params, webPreferences };
}

const flushImmediates = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The module's pending timeouts, to show that every way a demo ends clears them. */
function trackTimeouts() {
  const mockedSet = globalThis.setTimeout;
  const mockedClear = globalThis.clearTimeout;
  const pending = new Set<unknown>();
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = mockedSet(() => {
      pending.delete(handle);
      callback(...args);
    }, ms);
    pending.add(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    pending.delete(handle);
    mockedClear(handle);
  }) as typeof clearTimeout;
  // Restore before the test ends, so the mock timers then put the real ones back.
  return { pending, restore: () => { globalThis.setTimeout = mockedSet; globalThis.clearTimeout = mockedClear; } };
}

/** Move mocked time forward a second at a time, letting answered checks settle in between. */
async function advance(timers: { tick(ms: number): void }, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
    timers.tick(Math.min(1000, ms - elapsed));
    await flushImmediates();
  }
}

function releaseAll(urls: string[]) {
  for (const url of urls) releaseInlineHtmlDemo(url);
  embedder.sent = [];
  embedder.zoom = 1;
}

test("a lease admits one locked webview, once, and releasing it closes the demo", async () => {
  const lease = await prepareInlineHtmlDemo("letagents-attachment://download/L2RlbW8");
  try {
    assert.match(lease.url, /^letagents-demo:\/\/[0-9a-f]{32}\/$/);
    assert.equal(lease.partition, HTML_DEMO_PARTITION);
    const host = lease.url.slice("letagents-demo://".length, -1);
    assert.equal(documents.get(host), "<p>letagents-attachment://download/L2RlbW8</p>");

    assert.equal(attach("https://example.com/"), null);
    assert.equal(attach("letagents-demo://00000000000000000000000000000000/"), null);
    assert.equal(attach(lease.url, "persist:elsewhere"), null);
    const attached = attach(lease.url);
    assert.ok(attached);
    const { guest, params, webPreferences } = attached;
    assert.equal(params.src, lease.url);
    assert.equal("allowpopups" in params, false);
    assert.equal("preload" in webPreferences, false);
    assert.equal(webPreferences.enablePreferredSizeMode, true);
    assert.equal(webPreferences.disablePopups, true);
    assert.equal(guest.muted, true, "sound is off until the person clicks or types");
    assert.equal(contents.get(guest.id), host, "the request filter treats the guest as this demo's page");
    assert.ok(lockedIds.includes(guest.id));
    assert.equal(attach(lease.url), null, "a second webview cannot reuse the lease");

    releaseInlineHtmlDemo(lease.url);
    assert.equal(guest.destroyed, true);
    assert.equal(documents.has(host), false);
    assert.equal(contents.has(guest.id), false);
    await flushImmediates();
    assert.deepEqual(clearedOrigins.at(-1), `letagents-demo://${host}`);
    assert.doesNotThrow(() => releaseInlineHtmlDemo(lease.url));
    assert.doesNotThrow(() => releaseInlineHtmlDemo("not a lease"));
    assert.doesNotThrow(() => releaseInlineHtmlDemo(undefined));
    assert.equal(attach(lease.url), null, "a released lease cannot attach again");
  } finally {
    releaseAll([lease.url]);
  }
});

test("only room attachment links can be prepared", async () => {
  for (const href of ["https://example.com/demo.html", "file:///tmp/demo.html", "letagents-demo://0123/", null]) {
    await assert.rejects(prepareInlineHtmlDemo(href), String(href));
  }
});

test("main refuses more live leases than the cap and drops a lease no webview loads", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const urls: string[] = [];
  try {
    for (let index = 0; index < 4; index += 1) {
      urls.push((await prepareInlineHtmlDemo(`letagents-attachment://download/Y2Fw${index}`)).url);
    }
    await assert.rejects(prepareInlineHtmlDemo("letagents-attachment://download/b25lbW9yZQ"), /At most 4 demos can run/);
    const attached = attach(urls[0]);
    assert.ok(attached);

    await advance(t.mock.timers, 30_000);
    assert.equal(documents.size, 1, "only the attached lease outlives the attach timer");
    assert.equal(attach(urls[1]), null, "an expired lease cannot attach");
    const again = await prepareInlineHtmlDemo("letagents-attachment://download/YWdhaW4");
    urls.push(again.url);
    assert.equal(documents.size, 2);

    // The chat removing the webview frees its lease too.
    attached.guest.close();
    assert.equal(documents.size, 1);
  } finally {
    releaseAll(urls);
  }
});

test("a guest is bound only to the lease approved in its own attach", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = await prepareInlineHtmlDemo("letagents-attachment://download/Zmlyc3Q");
  const second = await prepareInlineHtmlDemo("letagents-attachment://download/c2Vjb25k");
  try {
    // The first webview passes the check but its guest never arrives in that task.
    assert.equal(willAttach({ src: first.url, partition: HTML_DEMO_PARTITION }).allowed, true);
    await Promise.resolve();
    const attached = attach(second.url);
    assert.ok(attached);
    attached.guest.emit("preferred-size-changed", {}, { width: 10, height: 240 });
    t.mock.timers.tick(0);
    assert.deepEqual(embedder.sent, [{ type: "height", url: second.url, height: 240 }]);

    // A webview no lease is bound to does not run, even when it appears while a claimed lease waits.
    const stray = new FakeGuest();
    app.emit("web-contents-created", {}, stray);
    embedder.emit("did-attach-webview", {}, stray);
    await flushImmediates();
    assert.equal(stray.destroyed, true);
    assert.equal(attached.guest.destroyed, false);

    assert.equal(attach(first.url), null, "the claimed lease stays used");
    await advance(t.mock.timers, 30_000);
    assert.equal(documents.has(first.url.slice("letagents-demo://".length, -1)), false, "and is dropped once no guest arrives");
    assert.equal(documents.has(second.url.slice("letagents-demo://".length, -1)), true);
  } finally {
    releaseAll([first.url, second.url]);
  }
});

test("height goes out at most every 100 ms, latest value, only when it changes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const lease = await prepareInlineHtmlDemo("letagents-attachment://download/aGVpZ2h0");
  try {
    const { guest } = attach(lease.url)!;
    const size = (height: number) => guest.emit("preferred-size-changed", {}, { width: 10, height });
    size(100);
    t.mock.timers.tick(0);
    assert.deepEqual(embedder.sent, [{ type: "height", url: lease.url, height: 100 }]);
    size(200);
    size(300);
    t.mock.timers.tick(50);
    assert.equal(embedder.sent.length, 1);
    t.mock.timers.tick(50);
    assert.deepEqual(embedder.sent.at(-1), { type: "height", url: lease.url, height: 300 });
    size(300);
    t.mock.timers.tick(200);
    assert.equal(embedder.sent.length, 2, "an unchanged height is not sent");
    size(99_999);
    t.mock.timers.tick(100);
    assert.deepEqual(embedder.sent.at(-1), { type: "height", url: lease.url, height: 4000 });
    embedder.zoom = 2;
    size(1000);
    t.mock.timers.tick(100);
    assert.deepEqual(embedder.sent.at(-1), { type: "height", url: lease.url, height: 500 });
    size(800);
    releaseInlineHtmlDemo(lease.url);
    t.mock.timers.tick(200);
    assert.equal(embedder.sent.length, 4, "a released demo sends nothing more");
  } finally {
    releaseAll([lease.url]);
  }
});

test("sound turns on at the first click or key press, not at a mouse move", async () => {
  const lease = await prepareInlineHtmlDemo("letagents-attachment://download/c291bmQ");
  try {
    const { guest } = attach(lease.url)!;
    guest.emit("input-event", {}, { type: "mouseMove" });
    guest.emit("input-event", {}, { type: "mouseWheel" });
    assert.equal(guest.muted, true);
    guest.emit("input-event", {}, { type: "rawKeyDown" });
    assert.equal(guest.muted, false);
    guest.emit("input-event", {}, { type: "mouseDown" });
    assert.deepEqual(guest.muteCalls, [true, false], "sound is turned on once");
  } finally {
    releaseAll([lease.url]);
  }
});

test("a frozen or crashed demo is reported once and cannot keep running", async () => {
  const frozen = await prepareInlineHtmlDemo("letagents-attachment://download/ZnJvemVu");
  const crashed = await prepareInlineHtmlDemo("letagents-attachment://download/Y3Jhc2hlZA");
  try {
    const hung = attach(frozen.url)!.guest;
    hung.emit("unresponsive");
    hung.emit("unresponsive");
    assert.deepEqual(embedder.sent, [{ type: "stopped", url: frozen.url, reason: "unresponsive" }]);
    assert.equal(documents.has(frozen.url.slice("letagents-demo://".length, -1)), false, "its slot is free at once");
    await flushImmediates();
    assert.equal(hung.crashCalls, 1, "a hung process is ended, not waited on");
    assert.equal(hung.destroyed, true);
    hung.emit("render-process-gone", {}, { reason: "killed", exitCode: 2 });
    assert.equal(embedder.sent.length, 1);

    const gone = attach(crashed.url)!.guest;
    gone.crashed = true;
    gone.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    assert.deepEqual(embedder.sent.at(-1), { type: "stopped", url: crashed.url, reason: "crashed" });
    await flushImmediates();
    assert.equal(gone.crashCalls, 0);
    assert.equal(gone.destroyed, true);
    assert.equal(embedder.sent.length, 2);
  } finally {
    releaseAll([frozen.url, crashed.url]);
  }
});

test("demo files are cached by link, a few at a time", async () => {
  const urls: string[] = [];
  const href = (index: number) => `letagents-attachment://local/Y2FjaGU${index}`;
  try {
    loads.length = 0;
    const [one, two] = await Promise.all([prepareInlineHtmlDemo(href(0)), prepareInlineHtmlDemo(href(0))]);
    urls.push(one.url, two.url);
    assert.notEqual(one.url, two.url, "each lease has its own origin");
    assert.deepEqual(loads, [href(0)], "two demos of one file download it once");
    releaseAll(urls.splice(0));

    for (let index = 1; index <= INLINE_HTML_DEMO_CACHE_ENTRIES; index += 1) {
      releaseInlineHtmlDemo((await prepareInlineHtmlDemo(href(index))).url);
    }
    releaseInlineHtmlDemo((await prepareInlineHtmlDemo(href(0))).url);
    assert.equal(loads.filter((load) => load === href(0)).length, 2, "the oldest file left the cache");
    releaseInlineHtmlDemo((await prepareInlineHtmlDemo(href(INLINE_HTML_DEMO_CACHE_ENTRIES))).url);
    assert.equal(loads.filter((load) => load === href(INLINE_HTML_DEMO_CACHE_ENTRIES)).length, 1, "a recent file stays");

    nextLoad = { byteLength: 9 * 1024 * 1024 };
    for (const index of [20, 21, 22]) releaseInlineHtmlDemo((await prepareInlineHtmlDemo(href(index))).url);
    nextLoad = null;
    releaseInlineHtmlDemo((await prepareInlineHtmlDemo(href(20))).url);
    assert.equal(loads.filter((load) => load === href(20)).length, 2, "the byte cap pushes out the oldest large file");
  } finally {
    nextLoad = null;
    releaseAll(urls);
  }
});

test("a demo that answers its liveness check keeps running, one check at a time", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lease = await prepareInlineHtmlDemo("letagents-attachment://download/YWxpdmU");
  try {
    const { guest } = attach(lease.url)!;
    guest.answers = "never";
    t.mock.timers.tick(4_999);
    assert.equal(guest.checks.length, 0, "the first check waits one interval");
    t.mock.timers.tick(1);
    assert.deepEqual(guest.checks.map(({ worldId, code }) => ({ worldId, code })), [{ worldId: INLINE_HTML_DEMO_LIVENESS_WORLD_ID, code: "1" }]);
    t.mock.timers.tick(4_000);
    assert.equal(guest.checks.length, 1, "no second check while one is in flight");
    guest.checks[0]!.answer();
    await flushImmediates();
    t.mock.timers.tick(4_999);
    assert.equal(guest.checks.length, 1, "the next check starts an interval after the answer");
    t.mock.timers.tick(1);
    assert.equal(guest.checks.length, 2);
    guest.answers = "now";
    guest.checks[1]!.answer();
    await flushImmediates();
    await advance(t.mock.timers, 60_000);
    assert.equal(guest.checks.length, 14, "one check every 5 s, never a tight loop");
    assert.deepEqual(embedder.sent.filter((event) => (event as { type: string }).type === "stopped"), []);
    assert.equal(guest.destroyed, false);
  } finally {
    releaseAll([lease.url]);
  }
});

test("a demo that never answers is stopped once, and a late answer does nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timeouts = trackTimeouts();
  const lease = await prepareInlineHtmlDemo("letagents-attachment://download/bG9vcA");
  try {
    const { guest } = attach(lease.url)!;
    guest.answers = "never";
    t.mock.timers.tick(5_000);
    t.mock.timers.tick(4_999);
    assert.deepEqual(embedder.sent, []);
    t.mock.timers.tick(1);
    assert.deepEqual(embedder.sent, [{ type: "stopped", url: lease.url, reason: "unresponsive" }]);
    assert.equal(documents.has(lease.url.slice("letagents-demo://".length, -1)), false, "its slot is free at once");
    await flushImmediates();
    assert.equal(guest.crashCalls, 1, "the looping process is ended first");
    assert.equal(guest.destroyed, true);
    assert.equal(timeouts.pending.size, 0, "no check is scheduled after the stop");

    guest.checks[0]!.answer();
    await flushImmediates();
    assert.equal(timeouts.pending.size, 0, "the late answer schedules nothing");
    await advance(t.mock.timers, 30_000);
    assert.equal(guest.checks.length, 1, "no check after the stop");
    assert.equal(embedder.sent.length, 1, "stopped is sent once");
  } finally {
    timeouts.restore();
    releaseAll([lease.url]);
  }
});

test("every way a demo ends stops its liveness check", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timeouts = trackTimeouts();
  const released = await prepareInlineHtmlDemo("letagents-attachment://download/cmVsZWFzZWQ");
  const removed = await prepareInlineHtmlDemo("letagents-attachment://download/cmVtb3ZlZA");
  const crashed = await prepareInlineHtmlDemo("letagents-attachment://download/Y3Jhc2g");
  const waiting = await prepareInlineHtmlDemo("letagents-attachment://download/d2FpdGluZw");
  try {
    const releasedGuest = attach(released.url)!.guest;
    const removedGuest = attach(removed.url)!.guest;
    const crashedGuest = attach(crashed.url)!.guest;
    const waitingGuest = attach(waiting.url)!.guest;
    waitingGuest.answers = "never";
    t.mock.timers.tick(5_000);
    assert.equal(waitingGuest.checks.length, 1);

    releaseInlineHtmlDemo(released.url);
    removedGuest.close();
    crashedGuest.crashed = true;
    crashedGuest.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    // A check in flight is dropped with its lease too.
    releaseInlineHtmlDemo(waiting.url);
    await flushImmediates();
    assert.equal(timeouts.pending.size, 0, "release, removal, crash and a pending check all clear their timers");
    const checksBefore = [releasedGuest, removedGuest, crashedGuest, waitingGuest].map((guest) => guest.checks.length);
    await advance(t.mock.timers, 60_000);
    assert.deepEqual([releasedGuest, removedGuest, crashedGuest, waitingGuest].map((guest) => guest.checks.length), checksBefore);
    assert.deepEqual(embedder.sent, [{ type: "stopped", url: crashed.url, reason: "crashed" }], "only the crash is reported");
  } finally {
    timeouts.restore();
    releaseAll([released.url, removed.url, crashed.url, waiting.url]);
  }
});

/** A download the test finishes, fails or leaves hanging. */
function heldDownload() {
  let finish!: (loaded: Loaded) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<Loaded>((resolve, reject) => { finish = resolve; fail = reject; });
  return { promise, finish, fail };
}

test("a demo is stopped once when it floods the app with events, but bursts and a steady trickle pass", async (t) => {
  let now = 50_000;
  t.mock.method(Date, "now", () => now);
  const burst = await prepareInlineHtmlDemo("letagents-attachment://download/YnVyc3Q");
  const spaced = await prepareInlineHtmlDemo("letagents-attachment://download/c3BhY2Vk");
  const steady = await prepareInlineHtmlDemo("letagents-attachment://download/c3RlYWR5");
  try {
    const bursting = attach(burst.url)!.guest;
    const spacing = attach(spaced.url)!.guest;
    const flooding = attach(steady.url)!.guest;
    const emit = (guest: FakeGuest, name: string, count: number) => {
      for (let index = 0; index < count; index += 1) guest.emit(name, {});
    };
    // One start-up burst that crosses a second boundary passes, and so does a full bucket at once.
    emit(bursting, "console-message", 1_001);
    now += 5;
    emit(bursting, "console-message", 1_001);
    emit(bursting, "page-title-updated", INLINE_HTML_DEMO_EVENT_BURST - 2_002);
    // Then the refill rate, kept up for a minute.
    for (let second = 0; second < 60; second += 1) {
      now += 1_000;
      emit(bursting, "console-message", INLINE_HTML_DEMO_EVENTS_PER_SECOND);
    }
    assert.deepEqual(embedder.sent, [], "a burst and the steady rate pass");

    // Two full bursts 2.5 s apart: the second one runs the bucket dry.
    emit(spacing, "console-message", INLINE_HTML_DEMO_EVENT_BURST);
    now += 2_500;
    emit(spacing, "did-navigate-in-page", 2_500);
    assert.deepEqual(embedder.sent, []);
    emit(spacing, "console-message", 1);
    assert.deepEqual(embedder.sent, [{ type: "stopped", url: spaced.url, reason: "overloaded" }]);
    assert.equal(spacing.crashCalls, 1, "the flooding process ends at once, before its queued events");
    emit(spacing, "console-message", 5_000);
    assert.equal(embedder.sent.length, 1, "stopped is sent once");

    // A steady 5,000 a second empties a full bucket in its fifth second.
    for (let second = 1; second <= 4; second += 1) {
      now += 1_000;
      emit(flooding, "console-message", 5_000);
      assert.equal(embedder.sent.length, 1, `still running after ${second} s`);
    }
    now += 1_000;
    emit(flooding, "console-message", 5_000);
    assert.deepEqual(embedder.sent.at(-1), { type: "stopped", url: steady.url, reason: "overloaded" });
    await flushImmediates();
    assert.equal(spacing.destroyed, true);
    assert.equal(flooding.destroyed, true);
    assert.equal(bursting.destroyed, false);
  } finally {
    releaseAll([burst.url, spaced.url, steady.url]);
  }
});

test("a demo that sends the app too much text is stopped, though a few big logs pass", async (t) => {
  let now = 70_000;
  t.mock.method(Date, "now", () => now);
  const big = await prepareInlineHtmlDemo("letagents-attachment://download/Ymln");
  const dump = await prepareInlineHtmlDemo("letagents-attachment://download/ZHVtcA");
  try {
    const flooding = attach(big.url)!.guest;
    const dumping = attach(dump.url)!.guest;
    const megabytes = (count: number) => "x".repeat(count * 1024 * 1024);
    const log = (guest: FakeGuest, message: string) => guest.emit("console-message", {}, 0, message, 1, "letagents-demo://source/");
    // One 8 MB dump, then a megabyte a second for a minute.
    log(dumping, megabytes(8));
    const oneMegabyte = megabytes(1);
    for (let second = 0; second < 60; second += 1) {
      now += 1_000;
      log(dumping, oneMegabyte);
    }
    dumping.emit("page-title-updated", {}, "x".repeat(4096), true);
    assert.deepEqual(embedder.sent, []);

    // 2 MB logs, far fewer than the event limit, run the text bucket dry within 32 MB.
    const twoMegabytes = megabytes(2);
    for (let index = 0; index < 15; index += 1) log(flooding, twoMegabytes);
    assert.deepEqual(embedder.sent, []);
    log(flooding, twoMegabytes);
    assert.deepEqual(embedder.sent, [{ type: "stopped", url: big.url, reason: "overloaded" }]);
    assert.equal(flooding.crashCalls, 1);
    log(flooding, twoMegabytes);
    assert.equal(embedder.sent.length, 1);
  } finally {
    releaseAll([big.url, dump.url]);
  }
});

test("a demo that the app page points at another URL stops; its own routes do not", async () => {
  const lease = await prepareInlineHtmlDemo("letagents-attachment://download/cm91dGVz");
  const other = await prepareInlineHtmlDemo("letagents-attachment://download/b3RoZXI");
  try {
    const { guest } = attach(lease.url)!;
    const start = (url: string, more: { isMainFrame?: boolean; isSameDocument?: boolean; initiator?: object } = {}) =>
      guest.emit("did-start-navigation", {
        url, isMainFrame: more.isMainFrame ?? true, isSameDocument: more.isSameDocument ?? false, initiator: more.initiator ?? null,
      });
    start(lease.url);
    start(`${lease.url}#settings`, { isSameDocument: true });
    start(`${lease.url}#settings`);
    start(`${lease.url}?level=2`);
    start("https://example.com/", { isMainFrame: false });
    start("about:blank", { isSameDocument: true });
    // A link the person clicks in the demo is refused by will-navigate; the demo keeps running.
    start("https://example.com/", { initiator: {} });
    assert.deepEqual(embedder.sent, []);
    start(other.url);
    assert.deepEqual(embedder.sent, [{ type: "stopped", url: lease.url, reason: "crashed" }]);
    start("file:///etc/hosts");
    await flushImmediates();
    assert.equal(guest.destroyed, true);
    assert.equal(embedder.sent.length, 1);
  } finally {
    releaseAll([lease.url, other.url]);
  }
});

test("a liveness timeout that fires late asks again instead of stopping the demo", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const lease = await prepareInlineHtmlDemo("letagents-attachment://download/bGF0ZQ");
  try {
    const { guest } = attach(lease.url)!;
    guest.answers = "never";
    now += 5_000;
    t.mock.timers.tick(5_000);
    assert.equal(guest.checks.length, 1);
    // Main was blocked for 3 s past the deadline: the answer may be queued behind the timer.
    now += 8_000;
    t.mock.timers.tick(5_000);
    assert.deepEqual(embedder.sent, []);
    assert.equal(guest.checks.length, 2, "a new check starts at once");
    guest.checks[0]!.answer();
    await flushImmediates();
    assert.equal(guest.checks.length, 2, "the old check's answer no longer counts");
    // On time this time, and still no answer: the demo is frozen.
    now += 5_000;
    t.mock.timers.tick(5_000);
    assert.deepEqual(embedder.sent, [{ type: "stopped", url: lease.url, reason: "unresponsive" }]);
  } finally {
    releaseAll([lease.url]);
  }
});

test("only live demos use run slots; downloads have their own cap and a time limit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const held = new Map<string, ReturnType<typeof heldDownload>>();
  const signals = new Map<string, AbortSignal>();
  loadOverride = (href, signal) => {
    const download = heldDownload();
    held.set(href, download);
    if (signal) signals.set(href, signal);
    signal?.addEventListener("abort", () => download.fail(signal.reason));
    return download.promise;
  };
  const urls: string[] = [];
  const href = (index: number) => `letagents-attachment://download/ZG93bmxvYWQ${index}`;
  try {
    for (let index = 0; index < 3; index += 1) {
      const pending = prepareInlineHtmlDemo(href(index));
      await flushImmediates();
      held.get(href(index))!.finish({ html: "<p>live</p>", byteLength: 10 });
      urls.push((await pending).url);
    }
    // Three demos run; two more files download at the same time, and neither holds a slot yet.
    const fourth = prepareInlineHtmlDemo(href(3));
    const fifth = prepareInlineHtmlDemo(href(4));
    const sameFile = prepareInlineHtmlDemo(href(3));
    await flushImmediates();
    assert.equal(loads.filter((load) => load === href(3)).length, 1, "a second demo of one file joins its download");
    held.get(href(3))!.finish({ html: "<p>four</p>", byteLength: 10 });
    urls.push((await fourth).url);
    await assert.rejects(sameFile, /At most 4 demos can run/, "the slot check runs again after the download");
    held.get(href(4))!.finish({ html: "<p>five</p>", byteLength: 10 });
    await assert.rejects(fifth, /At most 4 demos can run/);
    releaseAll(urls.splice(0));

    // At most 4 different files download at once.
    const downloads = [5, 6, 7, 8].map((index) => prepareInlineHtmlDemo(href(index)));
    for (const download of downloads) download.catch(() => undefined);
    await flushImmediates();
    await assert.rejects(prepareInlineHtmlDemo(href(9)), /At most 4 demo files can download at once/);
    // A download that hangs is cut off, and its signal stops the fetch.
    t.mock.timers.tick(20_000);
    for (const download of downloads) await assert.rejects(download, /took too long to download/);
    assert.equal(signals.get(href(5))?.aborted, true);
    const after = prepareInlineHtmlDemo(href(9));
    await flushImmediates();
    held.get(href(9))!.finish({ html: "<p>after</p>", byteLength: 10 });
    urls.push((await after).url);
  } finally {
    loadOverride = null;
    releaseAll(urls);
  }
});

test("cached demo files expire, and sign-out clears them", async (t) => {
  let now = 2_000_000;
  t.mock.method(Date, "now", () => now);
  const href = "letagents-attachment://download/dHRs";
  const count = () => loads.filter((load) => load === href).length;
  try {
    loads.length = 0;
    releaseInlineHtmlDemo((await prepareInlineHtmlDemo(href)).url);
    now += 9 * 60_000;
    releaseInlineHtmlDemo((await prepareInlineHtmlDemo(href)).url);
    assert.equal(count(), 1, "a recent file comes from the cache");
    now += 60_000;
    releaseInlineHtmlDemo((await prepareInlineHtmlDemo(href)).url);
    assert.equal(count(), 2, "a file cached 10 minutes ago downloads again");

    clearInlineHtmlDemoCache();
    releaseInlineHtmlDemo((await prepareInlineHtmlDemo(href)).url);
    assert.equal(count(), 3, "sign-out empties the cache");

    // A download that started before sign-out is not cached for the next account.
    const download = heldDownload();
    loadOverride = () => download.promise;
    clearInlineHtmlDemoCache();
    const other = "letagents-attachment://download/YmVmb3Jl";
    const pending = prepareInlineHtmlDemo(other);
    await flushImmediates();
    clearInlineHtmlDemoCache();
    download.finish({ html: "<p>old account</p>", byteLength: 10 });
    releaseInlineHtmlDemo((await pending).url);
    loadOverride = null;
    releaseInlineHtmlDemo((await prepareInlineHtmlDemo(other)).url);
    assert.equal(loads.filter((load) => load === other).length, 2);
  } finally {
    loadOverride = null;
  }
});

test("every focus signal from a demo is judged on its own, so a fake one cannot hide a real one", async (t) => {
  let now = 3_000_000;
  t.mock.method(Date, "now", () => now);
  const lease = await prepareInlineHtmlDemo("letagents-attachment://download/c3RlYWw");
  try {
    const { guest } = attach(lease.url)!;
    const refused = () => embedder.sent.filter((event) => (event as { type: string }).type === "focus-refused").length;
    // The person types in the composer.
    embedder.emit("input-event", {}, { type: "rawKeyDown" });
    now += 5_000;
    // The demo fires its own window "focus" event: Electron passes it on as if it were real.
    guest.emit("-focus-change", {}, true);
    assert.equal(refused(), 1, "a fake signal costs only a needless refusal");
    // A real focus() that follows, with no fake blur in between, is still refused.
    now += 50;
    guest.emit("-focus-change", {}, true);
    assert.equal(refused(), 2);
    guest.emit("-focus-change", {}, false);
    guest.emit("-focus-change", {}, false);
    now += 50;
    guest.emit("-focus-change", {}, true);
    assert.equal(refused(), 3, "fake blur signals change nothing either");
    // A later Electron that emits the documented event is judged the same way.
    guest.emit("focus");
    assert.equal(refused(), 4);
    assert.deepEqual(embedder.sent.at(-1), { type: "focus-refused", url: lease.url });
  } finally {
    releaseAll([lease.url]);
  }
});

test("a click, key or touch in the demo lets it take focus for a moment", async (t) => {
  let now = 4_000_000;
  t.mock.method(Date, "now", () => now);
  const lease = await prepareInlineHtmlDemo("letagents-attachment://download/Y2xpY2s");
  try {
    const { guest } = attach(lease.url)!;
    const focusAfter = (type: string, delay: number) => {
      guest.emit("input-event", {}, { type });
      now += delay;
      // Electron 42 reports a click's focus twice; both are judged, and both pass.
      guest.emit("-focus-change", {}, true);
      guest.emit("-focus-change", {}, true);
      return embedder.sent.length;
    };
    assert.equal(focusAfter("mouseDown", 8), 0);
    assert.equal(focusAfter("rawKeyDown", 5), 0);
    assert.equal(focusAfter("keyDown", 5), 0);
    assert.equal(focusAfter("touchStart", 1_000), 0);
    assert.equal(guest.muted, false);
    assert.equal(focusAfter("mouseMove", 1_001), 2, "moving the pointer over a demo is not a click");
    assert.equal(focusAfter("mouseDown", 1_001), 4, "a click longer ago does not count");
    assert.deepEqual(embedder.sent.at(-1), { type: "focus-refused", url: lease.url });
  } finally {
    releaseAll([lease.url]);
  }
});

test("Tab in the app lets focus move into the demo", async (t) => {
  let now = 5_000_000;
  t.mock.method(Date, "now", () => now);
  const lease = await prepareInlineHtmlDemo("letagents-attachment://download/dGFi");
  try {
    const { guest } = attach(lease.url)!;
    const press = (key: string, type = "keyDown") => embedder.emit("before-input-event", { preventDefault: () => assert.fail("the app page keeps its keys") }, { type, key });
    press("Tab");
    now += 4;
    guest.emit("-focus-change", {}, true);
    assert.deepEqual(embedder.sent, []);
    press("Tab", "rawKeyDown");
    now += 1_000;
    guest.emit("-focus-change", {}, true);
    assert.deepEqual(embedder.sent, []);
    press("Enter");
    press("Tab", "keyUp");
    now += 1_500;
    guest.emit("-focus-change", {}, true);
    assert.deepEqual(embedder.sent, [{ type: "focus-refused", url: lease.url }]);
  } finally {
    releaseAll([lease.url]);
  }
});

test("coming back to the window gives focus back only to the demo the person used last", async (t) => {
  let now = 6_000_000;
  t.mock.method(Date, "now", () => now);
  const first = await prepareInlineHtmlDemo("letagents-attachment://download/aGFk");
  const second = await prepareInlineHtmlDemo("letagents-attachment://download/b3RoZXJ3");
  try {
    const demoA = attach(first.url)!.guest;
    const demoB = attach(second.url)!.guest;
    const leave = () => {
      now += 10_000;
      appWindow.focused = false;
      demoA.emit("-focus-change", {}, false);
      appWindow.emit("blur");
      now += 60_000;
      appWindow.focused = true;
    };
    const refusals = () => embedder.sent.map((event) => (event as { url: string }).url);

    // The person clicks demo A, leaves, and comes back (macOS order: the demo before the window).
    demoA.emit("input-event", {}, { type: "mouseDown" });
    leave();
    demoA.emit("-focus-change", {}, true);
    appWindow.emit("focus");
    now += 900;
    demoA.emit("-focus-change", {}, true);
    assert.deepEqual(refusals(), [], "the demo gets focus back, for a moment after the return");
    now += 1_200;
    demoA.emit("-focus-change", {}, true);
    assert.deepEqual(refusals(), [first.url], "but not long after it");

    // The other order: the window first, then the demo.
    leave();
    appWindow.emit("focus");
    now += 20;
    demoA.emit("-focus-change", {}, true);
    assert.deepEqual(refusals(), [first.url]);

    // The person then used demo B: only B may take focus back.
    demoB.emit("input-event", {}, { type: "touchStart" });
    leave();
    demoA.emit("-focus-change", {}, true);
    demoB.emit("-focus-change", {}, true);
    appWindow.emit("focus");
    assert.deepEqual(refusals(), [first.url, first.url]);

    // The person typed in the app last: no demo gets focus on return, and the
    // demo's own fake focus and blur signals around the blur cannot change that.
    embedder.emit("input-event", {}, { type: "mouseDown" });
    now += 5_000;
    demoB.emit("-focus-change", {}, true);
    demoB.emit("-focus-change", {}, false);
    leave();
    demoB.emit("-focus-change", {}, false);
    demoB.emit("-focus-change", {}, true);
    appWindow.emit("focus");
    assert.deepEqual(refusals(), [first.url, first.url, second.url, second.url]);
  } finally {
    appWindow.focused = true;
    releaseAll([first.url, second.url]);
  }
});

test("a live demo is laid out 760 CSS px wide, scaled to its frame, and keeps that zoom when Electron resets it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const lease = await prepareInlineHtmlDemo("letagents-attachment://download/bGl2ZQ");
  try {
    assert.equal(setInlineHtmlDemoWidth(lease.url, 380), 0.5, "the scale is set before the webview attaches");
    const { guest } = attach(lease.url)!;
    const size = async (height: number) => {
      guest.emit("preferred-size-changed", {}, { width: 380, height });
      await flushImmediates();
      t.mock.timers.tick(100);
    };
    // Electron 42 drops a zoom set before the first load: the first size comes at zoom 1.
    await size(1500);
    assert.deepEqual(guest.zoomCalls, [0.5]);
    assert.deepEqual(embedder.sent, [], "a size at the wrong zoom is not reported");
    await size(750);
    assert.deepEqual(guest.layoutChecks, [{ worldId: INLINE_HTML_DEMO_LIVENESS_WORLD_ID, code: INLINE_HTML_DEMO_LIVE_WIDTH_SCRIPT }]);
    // One point more than the rounded preferred height, so the frame is never a fraction short of the page.
    assert.deepEqual(embedder.sent, [{ type: "height", url: lease.url, height: 751 }]);
    await size(800);
    assert.deepEqual(embedder.sent.at(-1), { type: "height", url: lease.url, height: 801 });
    assert.equal(guest.layoutChecks.length, 1, "checked once per zoom");

    // The app zooms to 125%: Electron puts the guest at the app's zoom, and main puts it back.
    embedder.zoom = 1.25;
    guest.zoom = 1.25;
    guest.framePoints = 475;
    await size(1875);
    assert.deepEqual(guest.zoomCalls, [0.5, 0.625], "380 CSS px at 125% are 475 points, so 760 CSS px need 0.625");
    assert.equal(embedder.sent.length, 2);
    await size(2000 * 0.625);
    assert.deepEqual(embedder.sent.at(-1), { type: "height", url: lease.url, height: 1001 }, "a 2000 px demo in a half-width frame");

    guest.framePoints = 950;
    assert.equal(setInlineHtmlDemoWidth(lease.url, 760), 1);
    assert.equal(guest.zoom, 1.25, "a running demo changes zoom at once");
    // A live demo may be as tall as LIVE_DEMO.maxHeight demo px, past the 4000 px of other demos.
    await size(30_000 * 1.25);
    assert.deepEqual(embedder.sent.at(-1), { type: "height", url: lease.url, height: 20_001 });

    assert.equal(setInlineHtmlDemoWidth(lease.url, 100), 0.2, "Chromium's smallest zoom, 0.25 at 125%, is the limit");
    assert.throws(() => setInlineHtmlDemoWidth(lease.url, 0), /positive/);
    assert.throws(() => setInlineHtmlDemoWidth(lease.url, Number.NaN), /positive/);
    assert.throws(() => setInlineHtmlDemoWidth(lease.url, "380"), /positive/);
    assert.throws(() => setInlineHtmlDemoWidth("letagents-demo://00000000000000000000000000000000/", 380), /closed/);
  } finally {
    releaseAll([lease.url]);
  }
});

test("a live demo's heights wait until the page lays out at the live zoom", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const lease = await prepareInlineHtmlDemo("letagents-attachment://download/c3RhbGU");
  try {
    const { guest } = attach(lease.url)!;
    const size = async (height: number) => {
      guest.emit("preferred-size-changed", {}, { width: 380, height });
      await flushImmediates();
      t.mock.timers.tick(100);
    };
    // Measured in Electron 42: with the zoom set at DOMContentLoaded, getZoomFactor
    // reports 0.33 at once, but the next size is the page laid out at zoom 1.
    guest.emit("dom-ready");
    setInlineHtmlDemoWidth(lease.url, 380);
    assert.equal(guest.zoom, 0.5);
    guest.renderedZoom = 1;
    await size(6000);
    assert.deepEqual(embedder.sent, [], "the page still lays out 380 CSS px wide");
    t.mock.timers.tick(1000);
    await flushImmediates();
    assert.deepEqual(embedder.sent, [], "a check on its own sends no height without a newer size");
    guest.renderedZoom = null;
    await size(1500);
    assert.deepEqual(embedder.sent, [{ type: "height", url: lease.url, height: 1501 }], "the first height is the scaled one");
  } finally {
    releaseAll([lease.url]);
  }
});

test("a live zoom is corrected until the frame's whole points hold exactly 760 CSS px", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const lease = await prepareInlineHtmlDemo("letagents-attachment://download/Y29ycmVjdA");
  try {
    const { guest } = attach(lease.url)!;
    // The frame is 607.6 px, and the chat sends 607: measured in Electron 42, the page laid out 761.25 px wide.
    guest.framePoints = 607.6;
    setInlineHtmlDemoWidth(lease.url, 607);
    assert.equal(guest.zoom, 607 / 760);
    guest.emit("preferred-size-changed", {}, { width: 607, height: 1776 });
    await flushImmediates();
    assert.equal(guest.zoomCalls.length, 2, "corrected once");
    assert.ok(Math.abs(guest.zoom - 607.6 / 760) < 1e-9, String(guest.zoom));
    assert.deepEqual(embedder.sent, []);
    // A zoom this close may bring no new size: main checks again on its own.
    t.mock.timers.tick(200);
    await flushImmediates();
    t.mock.timers.tick(100);
    assert.deepEqual(embedder.sent, [{ type: "height", url: lease.url, height: 1777 }]);
    assert.ok(Math.abs(guest.framePoints / guest.zoom - 760) < 1e-9, "the page lays out exactly 760 CSS px wide");
  } finally {
    releaseAll([lease.url]);
  }
});

test("a live demo's root cannot scroll: each document gets a user !important rule", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const plain = await prepareInlineHtmlDemo("letagents-attachment://download/cGxhaW4");
  const early = await prepareInlineHtmlDemo("letagents-attachment://download/ZWFybHk");
  const late = await prepareInlineHtmlDemo("letagents-attachment://download/bGF0ZQ");
  try {
    const plainGuest = attach(plain.url)!.guest;
    plainGuest.emit("dom-ready");
    assert.deepEqual(plainGuest.css, [], "a demo outside the live layout is left alone");

    setInlineHtmlDemoWidth(early.url, 380);
    const earlyGuest = attach(early.url)!.guest;
    assert.deepEqual(earlyGuest.css, [], "no document yet");
    earlyGuest.emit("dom-ready");
    assert.deepEqual(earlyGuest.css, [{ css: INLINE_HTML_DEMO_LIVE_ROOT_CSS, options: { cssOrigin: "user" } }]);
    assert.equal(INLINE_HTML_DEMO_LIVE_ROOT_CSS, "html, body { overflow: hidden !important; }");
    setInlineHtmlDemoWidth(early.url, 400);
    assert.equal(earlyGuest.css.length, 1, "once per document");
    earlyGuest.emit("dom-ready");
    assert.equal(earlyGuest.css.length, 2, "a reloaded document gets it again");

    const lateGuest = attach(late.url)!.guest;
    lateGuest.emit("dom-ready");
    setInlineHtmlDemoWidth(late.url, 380);
    assert.equal(lateGuest.css.length, 1, "a demo that goes live after loading gets it at once");
  } finally {
    releaseAll([plain.url, early.url, late.url]);
  }
});

test("going live drops a plain-layout height that has not gone out yet", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const lease = await prepareInlineHtmlDemo("letagents-attachment://download/ZHJvcA");
  try {
    const { guest } = attach(lease.url)!;
    guest.emit("preferred-size-changed", {}, { width: 380, height: 120 });
    setInlineHtmlDemoWidth(lease.url, 380);
    t.mock.timers.tick(100);
    await flushImmediates();
    assert.deepEqual(embedder.sent, []);
  } finally {
    releaseAll([lease.url]);
  }
});

test("main names the element under a pin of a live demo, in demo space, or nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const lease = await prepareInlineHtmlDemo("letagents-attachment://download/YW5jaG9y");
  try {
    const { guest } = attach(lease.url)!;
    guest.anchorAnswer = { parts: ["main", "button.pay"], dx: 3.04, dy: 2 };
    assert.equal(await inlineHtmlDemoAnchorAt(lease.url, 200, 100), null, "no demo space before the live layout");
    assert.deepEqual(guest.anchorScripts, []);

    setInlineHtmlDemoWidth(lease.url, 380);
    guest.emit("preferred-size-changed", {}, { width: 380, height: 750 });
    await flushImmediates();
    assert.deepEqual(await inlineHtmlDemoAnchorAt(lease.url, 200, 100), { path: "main > button.pay", dx: 3, dy: 2 });
    assert.match(guest.anchorScripts[0]!, /const x = 200, y = 100;/, "demo space is the page's own CSS px");

    for (const [x, y] of [[-1, 10], [761, 10], [10, 1501], [Number.NaN, 1], ["10", 1]] as const) {
      assert.equal(await inlineHtmlDemoAnchorAt(lease.url, x, y), null, `${x}, ${y} is not on the demo`);
    }
    assert.equal(guest.anchorScripts.length, 1, "a point off the demo asks the page nothing");
    assert.equal(await inlineHtmlDemoAnchorAt("letagents-demo://00000000000000000000000000000000/", 1, 1), null);

    guest.anchorAnswer = { parts: ["div[onclick=x]"], dx: 0, dy: 0 };
    assert.equal(await inlineHtmlDemoAnchorAt(lease.url, 1, 1), null, "an answer main did not ask for is dropped");

    guest.anchorAnswer = "never";
    const waiting = inlineHtmlDemoAnchorAt(lease.url, 1, 1);
    await flushImmediates();
    t.mock.timers.tick(500);
    assert.equal(await waiting, null, "a busy page does not hold the pin");

    guest.anchorAnswer = { parts: ["body"], dx: 1, dy: 1 };
    const released = inlineHtmlDemoAnchorAt(lease.url, 1, 1);
    releaseInlineHtmlDemo(lease.url);
    assert.equal(await released, null, "a demo released while it answered names nothing");
  } finally {
    releaseAll([lease.url]);
  }
});

test("the pointer over a live demo is reported in demo space, and goes when it leaves", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const lease = await prepareInlineHtmlDemo("letagents-attachment://download/cG9pbnRlcg");
  try {
    const seen: unknown[] = [];
    const stop = watchInlineHtmlDemoPointer(lease.url, (pointer) => seen.push(pointer));
    assert.ok(stop);
    assert.equal(watchInlineHtmlDemoPointer("letagents-demo://00000000000000000000000000000000/", () => {}), null);
    const { guest } = attach(lease.url)!;
    const move = (x: number, y: number, type = "mouseMove") => guest.emit("input-event", {}, { type, x, y });
    move(100, 50);
    assert.deepEqual(seen, [], "no demo space before the live layout");

    setInlineHtmlDemoWidth(lease.url, 380);
    guest.emit("preferred-size-changed", {}, { width: 380, height: 750 });
    await flushImmediates();
    // Measured in Electron 42: x 100 at guest zoom 0.5 is the page's clientX 200.
    move(100, 50);
    move(10, 10, "mouseWheel");
    assert.deepEqual(seen, [{ x: 200, y: 100 }, { x: 20, y: 20 }]);
    move(345.29, -7.65, "mouseLeave");
    move(345.29, -7.65, "mouseLeave");
    assert.deepEqual(seen.slice(2), [null], "a leave is reported once");

    seen.length = 0;
    move(100, 50);
    move(-5, 50);
    move(100, 760);
    assert.deepEqual(seen, [{ x: 200, y: 100 }, null], "a drag held outside the demo, or below its 1500 px, is not over it");

    // The app page gets the first move into a demo just before the demo does.
    seen.length = 0;
    embedder.emit("input-event", {}, { type: "mouseMove", x: 140, y: 80 });
    move(100, 50);
    t.mock.timers.tick(100);
    assert.deepEqual(seen, [{ x: 200, y: 100 }], "a demo that reports a newer move keeps the pointer");
    embedder.emit("input-event", {}, { type: "mouseMove", x: 10, y: 10 });
    assert.deepEqual(seen.length, 1);
    t.mock.timers.tick(60);
    embedder.emit("input-event", {}, { type: "mouseMove", x: 12, y: 10 });
    t.mock.timers.tick(40);
    assert.deepEqual(seen, [{ x: 200, y: 100 }, null], "moves over the app page alone mean the pointer left, without waiting for them to stop");

    seen.length = 0;
    move(100, 50);
    appWindow.emit("hide");
    assert.deepEqual(seen, [{ x: 200, y: 100 }, null], "a hidden window has no pointer");

    stop!();
    move(100, 50);
    assert.equal(seen.length, 2, "a watcher that stopped hears nothing");

    const again: unknown[] = [];
    watchInlineHtmlDemoPointer(lease.url, (pointer) => again.push(pointer));
    move(10, 10);
    releaseInlineHtmlDemo(lease.url);
    assert.deepEqual(again, [{ x: 20, y: 20 }, null], "a demo that goes away takes its pointer with it");
  } finally {
    releaseAll([lease.url]);
  }
});
