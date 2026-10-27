import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertHtmlDemoAttachmentHref,
  HTML_DEMO_CONTENT_SECURITY_POLICY,
  HTML_DEMO_PARTITION,
  HTML_DEMO_RESPONSE_HEADERS,
  htmlDemoWindowTitle,
  isAllowedHtmlDemoRequest,
  readHtmlDemoBytes,
} from "../main/attachments/html-demo-policy.js";

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
    for (const sources of directives.values()) {
      assert.doesNotMatch(sources, /https?:|\*|'self'/);
    }
    assert.equal(HTML_DEMO_RESPONSE_HEADERS["Content-Security-Policy"], HTML_DEMO_CONTENT_SECURITY_POLICY);
    assert.equal(HTML_DEMO_RESPONSE_HEADERS["X-Content-Type-Options"], "nosniff");
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
});
