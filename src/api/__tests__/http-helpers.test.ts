import assert from "node:assert/strict";
import test from "node:test";

import {
  clearSessionCookie,
  parseCookies,
  parseLimit,
  parsePollTimeout,
  setSessionCookie,
} from "../http-helpers.js";

test("parseLimit accepts positive integers only", () => {
  assert.equal(parseLimit(undefined), undefined);
  assert.equal(parseLimit(""), undefined);
  assert.equal(parseLimit("25"), 25);
  assert.equal(parseLimit("0"), undefined);
  assert.equal(parseLimit("-4"), undefined);
  assert.equal(parseLimit("abc"), undefined);
});

test("parseCookies decodes simple cookie headers", () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies("letagents_session=abc123; theme=dark%20mode"), {
    letagents_session: "abc123",
    theme: "dark mode",
  });
});

test("parsePollTimeout defaults invalid values and caps valid values", () => {
  const previousCap = process.env.LETAGENTS_POLL_MAX_MS;
  process.env.LETAGENTS_POLL_MAX_MS = "60000";

  try {
    assert.equal(parsePollTimeout(undefined), 30000);
    assert.equal(parsePollTimeout(""), 30000);
    assert.equal(parsePollTimeout("-1"), 30000);
    assert.equal(parsePollTimeout("abc"), 30000);
    assert.equal(parsePollTimeout("45000"), 45000);
    assert.equal(parsePollTimeout("120000"), 60000);
  } finally {
    if (previousCap === undefined) {
      delete process.env.LETAGENTS_POLL_MAX_MS;
    } else {
      process.env.LETAGENTS_POLL_MAX_MS = previousCap;
    }
  }
});

test("session cookie helpers write the expected Set-Cookie header", () => {
  const headers = new Map<string, string>();
  const response = {
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
  };

  setSessionCookie(response as never, "token value");
  assert.equal(
    headers.get("Set-Cookie"),
    "letagents_session=token%20value; Path=/; HttpOnly; SameSite=Lax"
  );

  clearSessionCookie(response as never);
  assert.equal(
    headers.get("Set-Cookie"),
    "letagents_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  );
});
