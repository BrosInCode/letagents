import assert from "node:assert/strict";
import test from "node:test";

import { chooseAnsweringSession, chooseSessionForReply } from "../rooms/answering-session.js";

const nowMs = Date.parse("2026-01-01T12:00:00.000Z");
const at = (msAgo: number) => new Date(nowMs - msAgo).toISOString();
const session = (id: string, createdMsAgo: number, seenMsAgo: number) => ({
  session_id: id, created_at: at(createdMsAgo), last_seen_at: at(seenMsAgo),
});
const minutes = (n: number) => n * 60_000;

test("the session that is there answers, not the oldest", () => {
  const left = session("left-behind", minutes(120), minutes(60));
  const restarted = session("restarted", minutes(1), 5_000);
  assert.equal(chooseAnsweringSession([left, restarted])?.session_id, "restarted");
  assert.equal(chooseAnsweringSession([restarted, left])?.session_id, "restarted", "input order does not decide");
  assert.equal(chooseAnsweringSession([left])?.session_id, "left-behind");
  assert.equal(chooseAnsweringSession([]), undefined);
});

test("a session holding a connection open answers before one that was merely seen later", () => {
  const connected = session("connected", minutes(120), minutes(5));
  const spokeLater = session("spoke-later", minutes(1), 5_000);
  assert.equal(chooseAnsweringSession([connected, spokeLater], new Set(["connected"]))?.session_id, "connected");
});

test("a process that has just died does not outrank the one that replaced it", () => {
  // A closing connection marks its session seen. So the old process, dying
  // now, is seen later than its replacement, which registered a moment ago
  // and has not polled yet.
  const died = session("died", minutes(120), 2_000);
  const replaced = session("replaced", 20_000, 20_000);
  assert.equal(chooseAnsweringSession([died, replaced])?.session_id, "replaced");
  assert.equal(chooseAnsweringSession([replaced, died])?.session_id, "replaced");
});

test("equal sessions are ordered the same way every time", () => {
  const a = session("agent_session_9", minutes(1), 5_000);
  const b = session("agent_session_10", minutes(1), 5_000);
  assert.equal(chooseAnsweringSession([a, b])?.session_id, chooseAnsweringSession([b, a])?.session_id);
});

test("a reply stays with the session that spoke unless the answering session is its restart", () => {
  const choose = (said: ReturnType<typeof session>, answering: ReturnType<typeof session>, connected: string[] = []) =>
    chooseSessionForReply({ said, answering, connectedSessionIds: new Set(connected) }).session_id;

  // Restart: the old process was last seen, and then the new one started.
  const left = session("left", minutes(120), minutes(5));
  const restarted = session("restarted", minutes(4), 5_000);
  assert.equal(choose(left, restarted), "restarted");

  // Another chat, already running while this one was active. However long
  // this one has been quiet since, its replies are its own.
  const quiet = session("quiet", minutes(120), minutes(45));
  const sibling = session("sibling", minutes(90), 5_000);
  assert.equal(choose(quiet, sibling, ["sibling"]), "quiet");

  // A session holding a connection open is there, whatever else is true.
  assert.equal(choose(left, restarted, ["left"]), "left");
  // Started within moments of the last sighting: too close to call a restart.
  assert.equal(choose(session("left", minutes(120), minutes(5)), session("close", minutes(5) - 10_000, 5_000)), "left");
  assert.equal(choose(restarted, restarted), "restarted");
});
