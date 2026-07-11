import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyLinkNavigation } from "../main/link-routing.js";
import { assertExternalWebUrl } from "../main/external-url.js";

const DEV_BASE = "http://localhost:5174/";
const FILE_BASE = "file:///Applications/LetAgents.app/Contents/renderer/index.html";

describe("classifyLinkNavigation", () => {
  it("routes external https and http links to the system browser", () => {
    assert.equal(classifyLinkNavigation("https://example.com/x", DEV_BASE), "external-web");
    assert.equal(classifyLinkNavigation("http://example.com/x", DEV_BASE), "external-web");
  });

  it("treats same-origin dev navigations as internal", () => {
    assert.equal(classifyLinkNavigation("http://localhost:5174/room/abc", DEV_BASE), "internal");
  });

  it("treats a different port or host as external, not internal", () => {
    assert.equal(classifyLinkNavigation("http://localhost:4000/x", DEV_BASE), "external-web");
    assert.equal(classifyLinkNavigation("https://localhost:5174/x", DEV_BASE), "external-web");
  });

  it("treats packaged file navigations under the renderer dir as internal", () => {
    assert.equal(
      classifyLinkNavigation("file:///Applications/LetAgents.app/Contents/renderer/index.html", FILE_BASE),
      "internal",
    );
    assert.equal(
      classifyLinkNavigation("file:///Applications/LetAgents.app/Contents/renderer/assets/x.js", FILE_BASE),
      "internal",
    );
  });

  it("blocks file links outside the renderer dir even in packaged builds", () => {
    assert.equal(classifyLinkNavigation("file:///etc/passwd", FILE_BASE), "block");
    assert.equal(classifyLinkNavigation("file:///etc/passwd", DEV_BASE), "block");
  });

  it("blocks dangerous or unknown schemes", () => {
    assert.equal(classifyLinkNavigation("javascript:alert(1)", DEV_BASE), "block");
    assert.equal(classifyLinkNavigation("data:text/html,<h1>x", DEV_BASE), "block");
    assert.equal(classifyLinkNavigation("mailto:a@b.com", DEV_BASE), "block");
    assert.equal(classifyLinkNavigation("custom-scheme://do-thing", DEV_BASE), "block");
  });

  it("blocks unparseable targets", () => {
    assert.equal(classifyLinkNavigation("not a url", DEV_BASE), "block");
  });

  it("still routes web links when the app base URL is unknown", () => {
    assert.equal(classifyLinkNavigation("https://example.com", null), "external-web");
    assert.equal(classifyLinkNavigation("file:///etc/passwd", null), "block");
  });
});

describe("assertExternalWebUrl", () => {
  it("accepts http and https", () => {
    assert.equal(assertExternalWebUrl("https://example.com/a"), "https://example.com/a");
    assert.equal(assertExternalWebUrl("http://example.com/a"), "http://example.com/a");
  });

  it("rejects non-web schemes and invalid URLs", () => {
    assert.throws(() => assertExternalWebUrl("file:///etc/passwd"), /http or https/);
    assert.throws(() => assertExternalWebUrl("mailto:a@b.com"), /http or https/);
    assert.throws(() => assertExternalWebUrl("javascript:alert(1)"), /http or https/);
    assert.throws(() => assertExternalWebUrl("nonsense"), /invalid/);
  });
});
