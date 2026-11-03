import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { mock } from "node:test";

import {
  HTML_DEMO_PARTITION,
  INLINE_HTML_DEMO_CACHE_ENTRIES,
  INLINE_HTML_DEMO_LIVENESS_WORLD_ID,
} from "../main/attachments/html-demo-policy.js";

const app = new EventEmitter();
const documents = new Map<string, string>();
const contentsIds = new Set<number>();
const lockedIds: number[] = [];
const loads: string[] = [];
const clearedOrigins: string[] = [];
let nextLoad: { byteLength: number } | null = null;

mock.module("electron", { defaultExport: { app } });
mock.module("../main/attachments/html-demo-session.js", { namedExports: {
  htmlDemoDocuments: documents,
  htmlDemoContentsIds: contentsIds,
  htmlDemoSession: async () => ({ clearStorageData: async ({ origin }: { origin: string }) => { clearedOrigins.push(origin); } }),
  loadHtmlDemoAttachment: async (href: string) => {
    loads.push(href);
    return { html: `<p>${href}</p>`, byteLength: nextLoad?.byteLength ?? 100 };
  },
  lockHtmlDemoContents: (contents: { id: number }) => { lockedIds.push(contents.id); },
} });

const {
  INLINE_HTML_DEMO_EVENT_CHANNEL,
  installInlineHtmlDemoHost,
  prepareInlineHtmlDemo,
  releaseInlineHtmlDemo,
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
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: Array<{ code: string }>) {
    return new Promise<unknown>((resolve) => {
      const check = { worldId, code: scripts.map((script) => script.code).join(";"), answer: () => resolve(1) };
      this.checks.push(check);
      if (this.answers === "now") check.answer();
    });
  }
  isDestroyed() { return this.destroyed; }
  isCrashed() { return this.crashed; }
  setAudioMuted(muted: boolean) { this.muted = muted; }
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
installInlineHtmlDemoHost({ webContents: embedder } as never);

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
    assert.ok(contentsIds.has(guest.id), "the request filter treats the guest as a demo page");
    assert.ok(lockedIds.includes(guest.id));
    assert.equal(attach(lease.url), null, "a second webview cannot reuse the lease");

    releaseInlineHtmlDemo(lease.url);
    assert.equal(guest.destroyed, true);
    assert.equal(documents.has(host), false);
    assert.equal(contentsIds.has(guest.id), false);
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
    assert.equal(guest.listenerCount("input-event"), 0);
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
