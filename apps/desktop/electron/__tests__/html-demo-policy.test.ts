import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import {
  assertHtmlDemoAttachmentHref,
  HTML_DEMO_CONTENT_SECURITY_POLICY,
  HTML_DEMO_PARTITION,
  HTML_DEMO_RESPONSE_HEADERS,
  htmlDemoWindowTitle,
  INLINE_HTML_DEMO_CACHE_BYTES,
  INLINE_HTML_DEMO_CACHE_ENTRIES,
  INLINE_HTML_DEMO_CACHE_MS,
  INLINE_HTML_DEMO_DOWNLOAD_MS,
  INLINE_HTML_DEMO_EVENT_BURST,
  INLINE_HTML_DEMO_EVENTS_PER_SECOND,
  INLINE_HTML_DEMO_TEXT_BURST,
  INLINE_HTML_DEMO_TEXT_PER_SECOND,
  INLINE_HTML_DEMO_FOCUS_GRACE_MS,
  INLINE_HTML_DEMO_HEIGHT_INTERVAL_MS,
  INLINE_HTML_DEMO_LEASE_MS,
  INLINE_HTML_DEMO_LIVENESS_INTERVAL_MS,
  INLINE_HTML_DEMO_LIVENESS_LATE_MS,
  INLINE_HTML_DEMO_LIVENESS_TIMEOUT_MS,
  INLINE_HTML_DEMO_LIVENESS_WORLD_ID,
  inlineHtmlDemoAttachLease,
  inlineHtmlDemoBucket,
  inlineHtmlDemoEventText,
  inlineHtmlDemoFocusAllowed,
  inlineHtmlDemoHeight,
  inlineHtmlDemoLeaseHost,
  inlineHtmlDemoLeaseUrl,
  inlineHtmlDemoWebPreferences,
  isAllowedHtmlDemoRequest,
  lockInlineHtmlDemoWebPreferences,
  MAX_HTML_DEMO_BYTES,
  MAX_INLINE_HTML_DEMO_DOWNLOADS,
  MAX_INLINE_HTML_DEMO_HEIGHT,
  MAX_INLINE_HTML_DEMOS,
  readHtmlDemoBytes,
  takeInlineHtmlDemoTokens,
} from "../main/attachments/html-demo-policy.js";

const HOST = "0123456789abcdef0123456789abcdef";
const LEASE_URL = `letagents-demo://${HOST}/`;

describe("HTML demo policy", () => {
  it("lets a demo load only its own document and in-page data", () => {
    assert.equal(isAllowedHtmlDemoRequest("letagents-demo://0123abcd/"), true);
    assert.equal(isAllowedHtmlDemoRequest("data:image/png;base64,AAAA"), true);
    assert.equal(isAllowedHtmlDemoRequest("blob:letagents-demo://0123abcd/5f1c"), true);
    for (const url of [
      "https://example.com/beacon.gif",
      "http://127.0.0.1:4000/",
      "wss://example.com/socket",
      "file:///etc/passwd",
      "letagents-attachment://download/L3Jvb21z",
      "devtools://devtools/bundled/inspector.html",
      "not a url",
    ]) {
      assert.equal(isAllowedHtmlDemoRequest(url), false, url);
    }
    // DevTools opened on a demo loads its own UI; the demo page itself cannot.
    assert.equal(isAllowedHtmlDemoRequest("devtools://devtools/bundled/devtools_app.html", { fromDemo: false }), true);
    assert.equal(isAllowedHtmlDemoRequest("devtools://devtools/bundled/devtools_app.html", { fromDemo: true }), false);
    assert.equal(isAllowedHtmlDemoRequest("https://example.com/", { fromDemo: false }), false);
    // A demo page that main knows loads only its own document, never another demo's.
    assert.equal(isAllowedHtmlDemoRequest("letagents-demo://0123abcd/", { fromDemo: true, host: "0123abcd" }), true);
    assert.equal(isAllowedHtmlDemoRequest("letagents-demo://0123abcd/x?y#z", { fromDemo: true, host: "0123abcd" }), true);
    assert.equal(isAllowedHtmlDemoRequest("letagents-demo://fedc9876/", { fromDemo: true, host: "0123abcd" }), false);
    assert.equal(isAllowedHtmlDemoRequest("data:text/plain,x", { fromDemo: true, host: "0123abcd" }), true);
    assert.equal(isAllowedHtmlDemoRequest("file:///etc/hosts", { fromDemo: true, host: "0123abcd" }), false);
  });

  it("blocks every network connection, frame, form and plugin in the page policy", () => {
    const directives = new Map(HTML_DEMO_CONTENT_SECURITY_POLICY.split("; ").map((part) => {
      const [name, ...sources] = part.split(" ");
      return [name, sources.join(" ")] as const;
    }));
    assert.equal(directives.get("default-src"), "'none'");
    assert.equal(directives.get("connect-src"), "data: blob:");
    assert.equal(directives.get("frame-src"), "'none'");
    assert.equal(directives.get("object-src"), "'none'");
    assert.equal(directives.get("form-action"), "'none'");
    assert.equal(directives.get("base-uri"), "'none'");
    assert.equal(directives.get("sandbox"), "allow-scripts allow-same-origin");
    for (const sources of directives.values()) {
      assert.doesNotMatch(sources, /https?:|\*|'self'/);
    }
    assert.equal(HTML_DEMO_RESPONSE_HEADERS["Content-Security-Policy"], HTML_DEMO_CONTENT_SECURITY_POLICY);
    assert.equal(HTML_DEMO_RESPONSE_HEADERS["X-Content-Type-Options"], "nosniff");
    const permissions = HTML_DEMO_RESPONSE_HEADERS["Permissions-Policy"]!.split(", ");
    for (const feature of ["camera", "microphone", "geolocation", "display-capture", "fullscreen", "picture-in-picture"]) {
      assert.ok(permissions.includes(`${feature}=()`), feature);
    }
  });

  it("keeps demo storage in memory", () => {
    assert.doesNotMatch(HTML_DEMO_PARTITION, /^persist:/);
  });

  it("opens only attachment links the app made", () => {
    assert.equal(
      assertHtmlDemoAttachmentHref("letagents-attachment://download/L3Jvb21zL3gvbWVzc2FnZXM"),
      "letagents-attachment://download/L3Jvb21zL3gvbWVzc2FnZXM",
    );
    assert.equal(
      assertHtmlDemoAttachmentHref("letagents-attachment://local/ZGVtby5odG1s"),
      "letagents-attachment://local/ZGVtby5odG1s",
    );
    for (const href of [
      "https://example.com/demo.html",
      "file:///Users/me/demo.html",
      "letagents-attachment://elsewhere/ZGVtbw",
      "letagents-demo://0123abcd/",
      "",
      null,
      42,
    ]) {
      assert.throws(() => assertHtmlDemoAttachmentHref(href), String(href));
    }
  });

  it("names the window after the file and the sender, without control characters", () => {
    assert.equal(htmlDemoWindowTitle("checkout.html", "Ada"), "Demo · checkout.html · from Ada");
    assert.equal(htmlDemoWindowTitle("x\u0007.html", null), "Demo · x.html");
    assert.equal(htmlDemoWindowTitle("a\u202Elmth.exe", "Ada\u2066\u0085"), "Demo · almth.exe · from Ada");
    assert.equal(htmlDemoWindowTitle("", undefined), "Demo · demo.html");
    assert.equal(htmlDemoWindowTitle("a".repeat(400), "b").length < 280, true);
  });

  it("reads a demo up to the size limit and refuses a larger one", async () => {
    const small = await readHtmlDemoBytes(new Response("<p>hi</p>"), 64);
    assert.equal(new TextDecoder().decode(small), "<p>hi</p>");

    await assert.rejects(
      readHtmlDemoBytes(new Response("x".repeat(65), { headers: { "content-length": "65" } }), 64),
      /larger than/,
    );

    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(32));
      },
    });
    await assert.rejects(readHtmlDemoBytes(new Response(endless), 64), /larger than/);
    assert.equal(pulls <= 4, true, "stops reading soon after the limit");
  });

  it("accepts only a lease URL written exactly as main makes it", () => {
    assert.equal(inlineHtmlDemoLeaseUrl(HOST), LEASE_URL);
    assert.equal(inlineHtmlDemoLeaseHost(LEASE_URL), HOST);
    for (const url of [
      `letagents-demo://${HOST.toUpperCase()}/`,
      `letagents-demo://${HOST.slice(1)}/`,
      `letagents-demo://${HOST}0/`,
      `letagents-demo://${HOST.slice(1)}g/`,
      `letagents-demo://${HOST}`,
      `letagents-demo://${HOST}//`,
      `letagents-demo://${HOST}/index.html`,
      `letagents-demo://${HOST}/?x=1`,
      `letagents-demo://${HOST}/#top`,
      `letagents-demo://${HOST}:80/`,
      `letagents-demo://user@${HOST}/`,
      `LETAGENTS-DEMO://${HOST}/`,
      ` ${LEASE_URL}`,
      `${LEASE_URL} `,
      `${LEASE_URL}\n`,
      `https://${HOST}/`,
      `letagents-attachment://${HOST}/`,
      "letagents-demo:///",
      "",
      null,
      42,
      { toString: () => LEASE_URL },
    ]) {
      assert.equal(inlineHtmlDemoLeaseHost(url), null, String(url));
    }
  });

  it("lets a webview attach only with an unused lease in the demo partition", () => {
    const leases = new Map([[HOST, { attached: false }], ["fedcba9876543210fedcba9876543210", { attached: true }]]);
    const params = { src: LEASE_URL, partition: HTML_DEMO_PARTITION };
    const preferences = { partition: HTML_DEMO_PARTITION };
    assert.equal(inlineHtmlDemoAttachLease(params, preferences, leases), HOST);
    // One webview per lease: a second one with the same URL is refused.
    assert.equal(
      inlineHtmlDemoAttachLease({ ...params, src: "letagents-demo://fedcba9876543210fedcba9876543210/" }, preferences, leases),
      null,
    );
    assert.equal(inlineHtmlDemoAttachLease({ ...params, src: "letagents-demo://00000000000000000000000000000000/" }, preferences, leases), null);
    assert.equal(inlineHtmlDemoAttachLease({ ...params, src: `${LEASE_URL}?again` }, preferences, leases), null);
    assert.equal(inlineHtmlDemoAttachLease({ ...params, src: "https://example.com/" }, preferences, leases), null);
    assert.equal(inlineHtmlDemoAttachLease({ ...params, partition: "persist:letagents-html-demos" }, preferences, leases), null);
    assert.equal(inlineHtmlDemoAttachLease({ ...params, partition: "" }, preferences, leases), null);
    assert.equal(inlineHtmlDemoAttachLease({ src: LEASE_URL }, preferences, leases), null);
    // A `webpreferences` attribute cannot move the guest to another session.
    assert.equal(inlineHtmlDemoAttachLease(params, { partition: "elsewhere" }, leases), null);
    assert.equal(inlineHtmlDemoAttachLease(params, preferences, new Map()), null);
  });

  it("replaces whatever a webview asked for with the locked demo preferences", () => {
    const requested: Record<string, unknown> = {
      preload: "/Users/me/evil.js",
      preloadURL: "file:///Users/me/evil.js",
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      plugins: true,
      webviewTag: true,
      disablePopups: false,
      enableBlinkFeatures: "SomethingRisky",
      experimentalFeatures: true,
      partition: "elsewhere",
      zoomFactor: 1.25,
    };
    const locked = lockInlineHtmlDemoWebPreferences(requested);
    assert.equal(locked, requested, "the event's own object is changed in place");
    assert.equal("preload" in locked, false);
    assert.equal("preloadURL" in locked, false);
    assert.equal("enableBlinkFeatures" in locked, false);
    assert.equal("experimentalFeatures" in locked, false);
    assert.deepEqual(locked, { ...inlineHtmlDemoWebPreferences(), zoomFactor: 1.25 });
    assert.deepEqual(inlineHtmlDemoWebPreferences(), {
      partition: HTML_DEMO_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      plugins: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      disableDialogs: true,
      autoplayPolicy: "user-gesture-required",
      enablePreferredSizeMode: true,
      disablePopups: true,
    });
    assert.equal("zoomFactor" in lockInlineHtmlDemoWebPreferences({ zoomFactor: Number.NaN }), false);
    assert.equal("zoomFactor" in lockInlineHtmlDemoWebPreferences({ zoomFactor: 0 }), false);
  });

  it("reports a demo's height as whole app pixels from 0 to the cap", () => {
    assert.equal(inlineHtmlDemoHeight(1234), 1234);
    // Electron reports screen points; at 150% zoom the app needs a third fewer CSS pixels.
    assert.equal(inlineHtmlDemoHeight(1851, 1.5), 1234);
    assert.equal(inlineHtmlDemoHeight(320.2), 321);
    assert.equal(inlineHtmlDemoHeight(0), 0);
    assert.equal(inlineHtmlDemoHeight(-20), 0);
    assert.equal(inlineHtmlDemoHeight(MAX_INLINE_HTML_DEMO_HEIGHT + 1), MAX_INLINE_HTML_DEMO_HEIGHT);
    assert.equal(inlineHtmlDemoHeight(Number.POSITIVE_INFINITY), MAX_INLINE_HTML_DEMO_HEIGHT);
    assert.equal(inlineHtmlDemoHeight(Number.NEGATIVE_INFINITY), 0);
    assert.equal(inlineHtmlDemoHeight(Number.NaN), 0);
    assert.equal(inlineHtmlDemoHeight("500"), 0);
    assert.equal(inlineHtmlDemoHeight(undefined), 0);
    for (const zoom of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "2"]) {
      assert.equal(inlineHtmlDemoHeight(600, zoom), 600, String(zoom));
    }
    assert.equal(MAX_INLINE_HTML_DEMO_HEIGHT, 4000);
  });

  it("keeps inline demos and their cache small", () => {
    assert.equal(MAX_INLINE_HTML_DEMOS, 4);
    assert.equal(INLINE_HTML_DEMO_LEASE_MS, 30_000);
    assert.equal(INLINE_HTML_DEMO_HEIGHT_INTERVAL_MS, 100);
    assert.ok(INLINE_HTML_DEMO_CACHE_ENTRIES > 0 && INLINE_HTML_DEMO_CACHE_ENTRIES <= 8);
    // The largest file a demo can be always fits, and the cap holds only a few of them.
    assert.ok(INLINE_HTML_DEMO_CACHE_BYTES >= MAX_HTML_DEMO_BYTES);
    assert.ok(INLINE_HTML_DEMO_CACHE_BYTES <= 4 * MAX_HTML_DEMO_BYTES);
    assert.equal(INLINE_HTML_DEMO_LIVENESS_INTERVAL_MS, 5_000);
    assert.equal(INLINE_HTML_DEMO_LIVENESS_TIMEOUT_MS, 5_000);
    // Not the page's own world (0) and not Electron's preload world (999).
    assert.ok(Number.isInteger(INLINE_HTML_DEMO_LIVENESS_WORLD_ID) && ![0, 999].includes(INLINE_HTML_DEMO_LIVENESS_WORLD_ID));
  });

  it("stops reading a demo when its download is aborted", async () => {
    const reason = new Error("The demo file took too long to download.");
    await assert.rejects(readHtmlDemoBytes(new Response("<p>x</p>"), 64, AbortSignal.abort(reason)), reason);

    // A body that never sends anything is woken up by the abort.
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel: () => { cancelled = true; } });
    const download = new AbortController();
    const reading = readHtmlDemoBytes(new Response(stalled), 64, download.signal);
    setTimeout(() => download.abort(reason), 5);
    await assert.rejects(reading, reason);
    assert.equal(cancelled, true, "the stream is cancelled, so the fetch behind it stops");
  });

  it("names the timeout, not the attachment proxy's error page, when a download is aborted", async () => {
    const mocks = [
      mock.module("electron", { defaultExport: { session: {} } }),
      mock.module("../main/attachments/protocol.js", { namedExports: {
        // The proxy turns an aborted fetch into an error page.
        attachmentResponse: async () => new Response("aborted", { status: 502 }),
      } }),
    ];
    try {
      const { loadHtmlDemoAttachment } = await import("../main/attachments/html-demo-session.js");
      const reason = new Error("The demo file took too long to download.");
      await assert.rejects(loadHtmlDemoAttachment("letagents-attachment://download/eA", AbortSignal.abort(reason)), reason);
      await assert.rejects(loadHtmlDemoAttachment("letagents-attachment://download/eA"), /HTTP 502/);
    } finally {
      for (const stub of mocks.reverse()) stub.restore();
    }
  });

  it("runs a bucket dry only when a demo takes more than its burst plus the refill", () => {
    const bucket = inlineHtmlDemoBucket(10, 2, 0);
    const take = (amount: number, at: number) => takeInlineHtmlDemoTokens(bucket, amount, at);
    assert.equal(take(10, 0), true, "a full burst at once");
    assert.equal(take(1, 0), false, "one more runs it dry");
    const refill = inlineHtmlDemoBucket(10, 2, 0);
    assert.equal(takeInlineHtmlDemoTokens(refill, 10, 0), true);
    assert.equal(takeInlineHtmlDemoTokens(refill, 2, 1_000), true, "two a second come back");
    assert.equal(takeInlineHtmlDemoTokens(refill, 1, 1_000), false);
    // It never holds more than its burst, and a clock that goes back does not refill it.
    const capped = inlineHtmlDemoBucket(10, 2, 0);
    assert.equal(takeInlineHtmlDemoTokens(capped, 10, 60_000), true);
    assert.equal(takeInlineHtmlDemoTokens(capped, 1, 60_000), false);
    const backwards = inlineHtmlDemoBucket(10, 2, 5_000);
    assert.equal(takeInlineHtmlDemoTokens(backwards, 10, 1_000), true);
    assert.equal(takeInlineHtmlDemoTokens(backwards, 1, 4_000), false);
  });

  it("chooses event and text buckets between normal demos and what main can carry", () => {
    // Measured in Electron 42: normal demos make 29 to 100 events a second, main passes about 65,000.
    assert.equal(INLINE_HTML_DEMO_EVENTS_PER_SECOND, 1_000);
    assert.equal(INLINE_HTML_DEMO_EVENT_BURST, 20_000);
    assert.equal(INLINE_HTML_DEMO_TEXT_PER_SECOND, 2 * 1024 * 1024);
    assert.equal(INLINE_HTML_DEMO_TEXT_BURST, 32 * 1024 * 1024);
    // One burst over a second boundary (1,001 + 1,001) passes; the old one-second windows refused it.
    const boundary = inlineHtmlDemoBucket(INLINE_HTML_DEMO_EVENT_BURST, INLINE_HTML_DEMO_EVENTS_PER_SECOND, 0);
    let passed = true;
    for (let index = 0; index < 1_001; index += 1) passed &&= takeInlineHtmlDemoTokens(boundary, 1, 999);
    for (let index = 0; index < 1_001; index += 1) passed &&= takeInlineHtmlDemoTokens(boundary, 1, 1_001);
    assert.equal(passed, true);
    // Full bursts 2.5 s apart are stopped; the old windows reset between them.
    const spaced = inlineHtmlDemoBucket(INLINE_HTML_DEMO_EVENT_BURST, INLINE_HTML_DEMO_EVENTS_PER_SECOND, 0);
    assert.equal(takeInlineHtmlDemoTokens(spaced, INLINE_HTML_DEMO_EVENT_BURST, 0), true);
    assert.equal(takeInlineHtmlDemoTokens(spaced, INLINE_HTML_DEMO_EVENT_BURST, 2_500), false);
  });

  it("counts the text an event carries, once", () => {
    assert.equal(inlineHtmlDemoEventText([{ message: "hello" }, 0, "hello", 12, "letagents-demo://a/"]), 5 + 19);
    assert.equal(inlineHtmlDemoEventText([{}, "A title", true]), 7);
    assert.equal(inlineHtmlDemoEventText([{}, ["data:a", "data:bb"]]), 13);
    assert.equal(inlineHtmlDemoEventText([{ url: "x".repeat(100) }, { selectionText: "y" }, 3]), 0);
    assert.equal(inlineHtmlDemoEventText([]), 0);
  });

  it("keeps downloads, the cache and the liveness check bounded", () => {
    assert.equal(MAX_INLINE_HTML_DEMO_DOWNLOADS, 4);
    assert.equal(INLINE_HTML_DEMO_DOWNLOAD_MS, 20_000);
    assert.equal(INLINE_HTML_DEMO_CACHE_MS, 10 * 60_000);
    assert.equal(INLINE_HTML_DEMO_LIVENESS_LATE_MS, 1_000);
  });

  it("lets a demo keep focus only after the person's own click, key, Tab or return to the window", () => {
    const never = Number.NEGATIVE_INFINITY;
    const base = { now: 100_000, lastInputAt: never, lastTabAt: never, hadLastInputAtWindowBlur: false, windowBlurredAt: never, windowFocusedAt: never };
    assert.equal(INLINE_HTML_DEMO_FOCUS_GRACE_MS, 1_000);
    assert.equal(inlineHtmlDemoFocusAllowed(base), false, "a demo that focuses itself");
    assert.equal(inlineHtmlDemoFocusAllowed({ ...base, lastInputAt: 99_000 }), true);
    assert.equal(inlineHtmlDemoFocusAllowed({ ...base, lastInputAt: 98_999 }), false);
    assert.equal(inlineHtmlDemoFocusAllowed({ ...base, lastTabAt: 99_500 }), true);
    assert.equal(inlineHtmlDemoFocusAllowed({ ...base, lastTabAt: 90_000 }), false);
    // Back to a window that is still marked blurred (the macOS order), or that was focused a moment ago.
    assert.equal(inlineHtmlDemoFocusAllowed({ ...base, hadLastInputAtWindowBlur: true, windowBlurredAt: 40_000, windowFocusedAt: 10_000 }), true);
    assert.equal(inlineHtmlDemoFocusAllowed({ ...base, hadLastInputAtWindowBlur: true, windowBlurredAt: 40_000, windowFocusedAt: 99_990 }), true);
    assert.equal(inlineHtmlDemoFocusAllowed({ ...base, hadLastInputAtWindowBlur: true, windowBlurredAt: 40_000, windowFocusedAt: 90_000 }), false);
    assert.equal(inlineHtmlDemoFocusAllowed({ ...base, hadLastInputAtWindowBlur: false, windowBlurredAt: 40_000, windowFocusedAt: 99_990 }), false);
  });
});
