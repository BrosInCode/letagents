import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveExternalWebHref } from "../src/components/desktop/content/desktop-chat-message/message-links";

const BASE = "http://localhost:5174/room/abc";

describe("resolveExternalWebHref", () => {
  it("returns absolute http/https links unchanged (normalized)", () => {
    assert.equal(resolveExternalWebHref("https://example.com/x", BASE), "https://example.com/x");
    assert.equal(resolveExternalWebHref("http://example.com", BASE), "http://example.com/");
  });

  it("rejects non-web schemes on absolute hrefs", () => {
    assert.equal(resolveExternalWebHref("mailto:a@b.com", BASE), null);
    assert.equal(resolveExternalWebHref("javascript:alert(1)", BASE), null);
    assert.equal(resolveExternalWebHref("file:///etc/passwd", BASE), null);
    assert.equal(resolveExternalWebHref("custom-scheme://do-thing", BASE), null);
  });

  it("treats missing/empty hrefs as no link", () => {
    assert.equal(resolveExternalWebHref(null, BASE), null);
    assert.equal(resolveExternalWebHref(undefined, BASE), null);
    assert.equal(resolveExternalWebHref("", BASE), null);
  });

  it("preserves query and fragment", () => {
    assert.equal(
      resolveExternalWebHref("https://example.com/p?q=1#frag", BASE),
      "https://example.com/p?q=1#frag",
    );
  });
});
