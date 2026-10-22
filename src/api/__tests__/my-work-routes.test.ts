import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerMyWorkRoute } = await import("../routes/account/my-work.js");
const {
  decodeMyWorkCursor,
  encodeMyWorkCursor,
  MyWorkInputError,
  needsMeReasons,
  openReviewRequests,
  pullRequestUrl,
} = await import("../connectors/my-work.js");
import type { MyWorkQuery } from "../connectors/my-work.js";
import type { MyWorkPage } from "../../../shared/ticket-connectors.mjs";

async function serve(auth: string | null, listMyWork: (query: MyWorkQuery) => Promise<MyWorkPage>) {
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, {
      authKind: auth,
      sessionAccount: auth && auth !== "agent_session" ? { account_id: "acct-1", login: "Emmy" } : null,
    });
    next();
  });
  registerMyWorkRoute(app, { listMyWork });
  const http = app.listen(0);
  await new Promise((resolve) => http.once("listening", resolve));
  const port = (http.address() as { port: number }).port;
  return {
    get: (path: string) => fetch(`http://127.0.0.1:${port}${path}`),
    close: () => new Promise((resolve) => http.close(resolve)),
  };
}

const EMPTY: MyWorkPage = { cards: [], next_cursor: null, has_connections: false, providers: [] };

test("a desktop session or an owner token may read My work; other callers may not", async () => {
  for (const [auth, status] of [["session", 200], ["owner_token", 200], ["agent_session", 401], [null, 401]] as const) {
    const server = await serve(auth, async () => EMPTY);
    try {
      assert.equal((await server.get("/account/my-work")).status, status, String(auth));
    } finally {
      await server.close();
    }
  }
});

test("query parameters reach the reader as the account's own query", async () => {
  const seen: MyWorkQuery[] = [];
  const server = await serve("session", async (query) => { seen.push(query); return EMPTY; });
  try {
    const response = await server.get("/account/my-work?tracker=jira&room=room-1&needs_me=true&limit=20&cursor=abc");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), EMPTY);
    assert.deepEqual(seen[0], {
      accountId: "acct-1", login: "Emmy", cursor: "abc", limit: 20, tracker: "jira", roomId: "room-1", needsMe: true, includeCompleted: false,
    });
    assert.equal((await server.get("/account/my-work?tracker=github")).status, 400);
    assert.equal((await server.get("/account/my-work?limit=many")).status, 400);
  } finally {
    await server.close();
  }
});

test("completed work requires an explicit opt-in, with the same account query", async () => {
  const seen: MyWorkQuery[] = [];
  const server = await serve("session", async (query) => { seen.push(query); return EMPTY; });
  try {
    for (const [search, expected] of [["", false], ["?include_completed=false", false], ["?include_completed=true", true], ["?include_completed=1", false], ["?include_completed=true&include_completed=false", false]] as const) {
      assert.equal((await server.get(`/account/my-work${search}`)).status, 200);
      assert.equal(seen.at(-1)?.includeCompleted, expected, search || "default");
      assert.equal(seen.at(-1)?.accountId, "acct-1");
    }
  } finally {
    await server.close();
  }
});

test("a bad cursor is a 400, any other failure a 500", async () => {
  const bad = await serve("session", async () => { throw new MyWorkInputError("Invalid cursor."); });
  const broken = await serve("session", async () => { throw new Error("database unavailable"); });
  try {
    assert.equal((await bad.get("/account/my-work?cursor=x")).status, 400);
    const response = await broken.get("/account/my-work");
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /database unavailable/);
  } finally {
    await bad.close();
    await broken.close();
  }
});

test("a cursor round-trips at database precision and rejects anything else", () => {
  const cursor = { updated_at: "2026-10-21 10:00:00.123456+00", room_id: "room-1", number: 7 };
  assert.deepEqual(decodeMyWorkCursor(encodeMyWorkCursor(cursor)), cursor);
  for (const value of ["", "x", Buffer.from('["soon","r",1]').toString("base64url"), Buffer.from('["2026-10-21 10:00:00+00","r",0]').toString("base64url")]) {
    assert.throws(() => decodeMyWorkCursor(value), MyWorkInputError);
  }
});

const PR = "https://github.com/acme/app/pull/88";
const card = (overrides: Partial<Parameters<typeof needsMeReasons>[0]> = {}) => ({
  room_id: "room-1",
  task_id: "task_12",
  key: "HT-1234",
  ticket_state: "in_review",
  pull_requests: [{ url: PR, state: "open", merged: false }],
  mention_message_numbers: new Set<number>(),
  ...overrides,
});
const none = { reviewRequests: new Set<string>(), openRequests: [] };

test("needs me: a review requested of me on an open pull request", () => {
  const requested = openReviewRequests([
    { room_id: "room-1", event_type: "pull_request", action: "review_requested", github_object_url: PR, event_order_at: "2026-10-21T10:00:00Z" },
  ]);
  assert.deepEqual(needsMeReasons(card(), { ...none, reviewRequests: requested }), ["review_requested"]);
  // Another room's request for the same URL does not count.
  assert.deepEqual(needsMeReasons(card({ room_id: "room-2" }), { ...none, reviewRequests: requested }), []);
  // A merged pull request needs no review.
  assert.deepEqual(needsMeReasons(card({ pull_requests: [{ url: PR, state: "merged", merged: true }] }), { ...none, reviewRequests: requested }), []);
});

test("needs me: a newer review or removed request answers the request", () => {
  const newestFirst = (...events: Array<[string, string, string]>) => openReviewRequests(events.map(([type, action, url], index) => ({
    room_id: "room-1", event_type: type, action, github_object_url: url, event_order_at: `2026-10-21T10:0${9 - index}:00Z`,
  })));
  assert.equal(newestFirst(["pull_request_review", "submitted", `${PR}#pullrequestreview-1`], ["pull_request", "review_requested", PR]).size, 0);
  assert.equal(newestFirst(["pull_request", "review_request_removed", PR], ["pull_request", "review_requested", PR]).size, 0);
  assert.equal(newestFirst(["pull_request", "review_requested", PR], ["pull_request_review", "submitted", `${PR}#pullrequestreview-1`]).size, 1,
    "a re-request after my review counts again");
});

test("needs me: an open room request that names the card or was asked from its thread", () => {
  const request = (title: string, body = "", source: number | null = null) => ({ room_id: "room-1", title, body, source_message_number: source });
  assert.deepEqual(needsMeReasons(card(), { ...none, openRequests: [request("Approve HT-1234 rollout?")] }), ["human_request"]);
  assert.deepEqual(needsMeReasons(card(), { ...none, openRequests: [request("Decide", "see task_12")] }), ["human_request"]);
  assert.deepEqual(needsMeReasons(card({ mention_message_numbers: new Set([40]) }), { ...none, openRequests: [request("Which plan?", "", 40)] }), ["human_request"]);
  // A longer key, another card, or another room is not this card.
  assert.deepEqual(needsMeReasons(card(), { ...none, openRequests: [request("HT-12345 and task_123")] }), []);
  assert.deepEqual(needsMeReasons(card(), { ...none, openRequests: [{ ...request("HT-1234"), room_id: "room-2" }] }), []);
});

test("needs me: the ticket is done while a pull request is still open", () => {
  assert.deepEqual(needsMeReasons(card({ ticket_state: "done" }), none), ["ticket_done_pr_open"]);
  assert.deepEqual(needsMeReasons(card({ ticket_state: "done", pull_requests: [{ url: PR, state: "draft", merged: null }] }), none), ["ticket_done_pr_open"]);
  assert.deepEqual(needsMeReasons(card({ ticket_state: "done", pull_requests: [{ url: PR, state: "closed", merged: false }] }), none), []);
  assert.deepEqual(needsMeReasons(card({ ticket_state: "in_review" }), none), []);
});

test("pull request URLs compare in one spelling", () => {
  assert.equal(pullRequestUrl("https://github.com/Acme/App/pull/88/files"), PR);
  assert.equal(pullRequestUrl("https://github.com/acme/app/pull/88/"), PR);
  assert.equal(pullRequestUrl(`${PR}#pullrequestreview-1`), PR);
  const requested = openReviewRequests([
    { room_id: "room-1", event_type: "pull_request", action: "review_requested", github_object_url: "https://github.com/Acme/App/pull/88", event_order_at: "2026-10-21T10:00:00Z" },
  ]);
  assert.deepEqual(needsMeReasons(card({ pull_requests: [{ url: `${PR}/files`, state: "open", merged: false }] }), { ...none, reviewRequests: requested }), ["review_requested"]);
});

test("an open request names the card in any case", () => {
  const request = { room_id: "room-1", title: "is ht-1234 ready?", body: "", source_message_number: null };
  assert.deepEqual(needsMeReasons(card(), { ...none, openRequests: [request] }), ["human_request"]);
  // Keys with characters a regular expression treats specially match only themselves.
  assert.deepEqual(needsMeReasons(card({ key: "A.B-1" }), { ...none, openRequests: [{ ...request, title: "AxB-1" }] }), []);
});
