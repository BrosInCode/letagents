import assert from "node:assert/strict";
import test from "node:test";

import { extractPageManifest } from "../../../shared/api/pages.mjs";

// The version rules and manifest extraction, without a database.
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { decideVersionStatus, isWriteLikeCapability, preparePageHtml } = await import("../v1/pages.js");

test("the version rules from the plan's \"Who can do what\" table", () => {
  const rule = (trust: "trusted" | "agent" | "participant", granted: string[], requested: string[], draft = false) =>
    decideVersionStatus({ draft, trust, granted, requested });
  // Same or fewer capabilities: an admin or any agent goes live; a participant waits.
  assert.equal(rule("trusted", ["tasks.read"], ["tasks.read"]), "live");
  assert.equal(rule("agent", ["tasks.read", "git.read"], ["tasks.read"]), "live");
  assert.equal(rule("participant", ["tasks.read"], ["tasks.read"]), "pending_approval");
  // More capabilities wait for everyone; with nothing granted yet, any capability is more.
  assert.equal(rule("trusted", ["tasks.read"], ["tasks.read", "git.read"]), "pending_approval");
  assert.equal(rule("trusted", [], ["tasks.read"]), "pending_approval");
  assert.equal(rule("agent", [], []), "live");
  // A page that holds a write-like capability, now or in the new version.
  for (const writeLike of ["jobs.start", "messages.post", "tasks.propose", "tickets.propose"]) {
    assert.equal(isWriteLikeCapability(writeLike), true);
    assert.equal(rule("agent", [writeLike], [writeLike]), "pending_approval");
    assert.equal(rule("agent", [writeLike], []), "pending_approval");
    assert.equal(rule("trusted", [writeLike], [writeLike]), "live");
  }
  assert.equal(isWriteLikeCapability("data.room"), false);
  assert.equal(rule("trusted", [], ["jobs.start"], true), "draft");
});

test("the manifest is the one letagents-page+json script in the HTML", () => {
  const script = (json: string, attrs = 'type="application/letagents-page+json"') => `<script ${attrs}>${json}</script>`;
  assert.deepEqual(extractPageManifest(`<p>a</p>${script('{"api":1}')}`), { ok: true, json: '{"api":1}' });
  assert.deepEqual(extractPageManifest(script("{}", "id=m TYPE='application/letagents-page+json'")), { ok: true, json: "{}" });
  assert.equal(extractPageManifest("<script>{}</script>").ok, false);
  assert.equal(extractPageManifest(script("{}") + script("{}")).ok, false);
  assert.equal(extractPageManifest(script("{}", 'type="application/letagents-pageXjson"')).ok, false);

  const html = `${script(JSON.stringify({ api: 1, title: "Sprint", surfaces: ["room.tab"], owner: "org" }))}`;
  assert.throws(() => preparePageHtml(html), { code: "invalid_input", message: /owner/ });
  const ok = preparePageHtml(html.replace('"org"', '"room"'));
  assert.equal(ok.manifest.title, "Sprint");
  assert.equal(ok.sha256.length, 64);
});
