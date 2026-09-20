import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";

if (process.env.TEST_DB_URL) process.env.DB_URL = process.env.TEST_DB_URL;
const { migrate } = await import("drizzle-orm/node-postgres/migrator");
const { db } = await import("../db/client.js");
const { pool } = await import("../db/client.js");
const store = await import("../conversations/store.js");
const { closeConversationChanges } = await import(
  "../conversations/changes.js"
);
const { registerConversationRoutes } = await import(
  "../routes/conversations.js"
);
const { registerAppLoginRoutes } = await import("../routes/auth/app-login.js");
const { resolveRequestAuth } = await import("../request/auth.js");
const { requireAppSession } = await import("../request/app-session.js");
const ids = Array.from({ length: 4 }, () => `acct_${randomUUID()}`);
const [alice, bob, carol, outsider] = ids;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const appToken = randomUUID(),
  ownerToken = randomUUID(),
  browserToken = randomUUID();
let base = "";
const app = express();
app.use(express.json());
app.use(async (req, res, next) => {
  const auth = await resolveRequestAuth(req);
  Object.assign(req, { sessionAccount: auth.account, authKind: auth.authKind });
  next();
});
registerConversationRoutes(app);
registerAppLoginRoutes(app);
const server = createServer(app);
test.before(async () => {
  await migrate(db, { migrationsFolder: "drizzle" });
  for (const [index, id] of ids.entries())
    await pool.query(
      "INSERT INTO accounts(id,provider,provider_user_id,login,created_at,updated_at) VALUES ($1,'github',$1,$2,now(),now())",
      [id, `private-chat-test-${index}-${randomUUID()}`],
    );
  for (const token of [appToken, browserToken])
    await pool.query(
      "INSERT INTO auth_sessions(id,account_id,token_hash,expires_at,created_at) VALUES ($1,$2,$3,now()+interval '1 hour',now())",
      [randomUUID(), alice, hash(token)],
    );
  await pool.query(
    "INSERT INTO owner_tokens(token_id,account_id,github_user_id,token_hash,created_at,updated_at) VALUES($1,$2,$2,$3,now(),now())",
    [randomUUID(), alice, hash(ownerToken)],
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.LETAGENTS_BASE_URL = base;
});
test.after(async () => {
  await closeConversationChanges();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.query(
    "DELETE FROM conversations WHERE created_by=ANY($1::text[])",
    [ids],
  );
  await pool.query("DELETE FROM accounts WHERE id=ANY($1::text[])", [ids]);
  await pool.end();
});
function request(
  path: string,
  token = appToken,
  method = "GET",
  body?: unknown,
  extra: Record<string, string> = {},
) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
test("all machine credentials are denied even when they claim to be the desktop", async () => {
  for (const authKind of [
    "owner_token",
    "agent_session",
    "supervisor_grant",
    null,
  ]) {
    const response = {
      code: 0,
      status(code: number) {
        this.code = code;
        return this;
      },
      json() {},
    };
    assert.equal(
      requireAppSession(
        {
          authKind,
          sessionAccount: { account_id: alice },
          headers: { "x-letagents-desktop-client": "1" },
          method: "GET",
        } as never,
        response as never,
      ),
      null,
    );
    assert.equal(response.code, authKind ? 403 : 401);
  }
  assert.equal(
    (
      await request("/conversations", ownerToken, "GET", undefined, {
        "x-letagents-desktop-client": "1",
      })
    ).status,
    403,
  );
  assert.equal((await request("/conversations")).status, 200);
});
test("concurrent reordered participant sets create exactly one group", async () => {
  const chats = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      store.createConversation(
        index % 2 ? bob : alice,
        index % 2 ? [carol, alice, bob] : [bob, carol, bob],
      ),
    ),
  );
  assert.equal(new Set(chats).size, 1);
  const members = await pool.query(
    "SELECT * FROM conversation_members WHERE conversation_id=$1",
    [chats[0]],
  );
  assert.equal(members.rowCount, 3);
});
test("adding people isolates history and reopens the exact expanded group", async () => {
  const pair = await store.createConversation(alice, [bob]);
  await store.sendConversationMessage(
    alice,
    pair,
    "Only Alice and Bob",
    randomUUID(),
  );
  const group = await store.createConversation(alice, [carol], pair);
  assert.notEqual(pair, group);
  assert.equal(
    (await store.conversationMessages(carol, group)).messages.length,
    0,
  );
  await assert.rejects(store.conversationMessages(carol, pair), {
    status: 404,
  });
  assert.equal(
    (await store.conversationMessages(bob, pair)).messages[0].text,
    "Only Alice and Bob",
  );
  assert.equal(await store.createConversation(carol, [bob, alice]), group);
  await assert.rejects(store.createConversation(outsider, [carol], pair), {
    status: 404,
  });
});
test("requests permit one introduction, then require acceptance; retries are idempotent", async () => {
  const id = await store.createConversation(alice, [carol]);
  const clientId = randomUUID();
  const sent = await Promise.all([
    store.sendConversationMessage(alice, id, "Hello", clientId),
    store.sendConversationMessage(alice, id, "Hello", clientId),
  ]);
  assert.equal(sent[0].number, sent[1].number);
  await assert.rejects(
    store.sendConversationMessage(alice, id, "Second message", randomUUID()),
    { status: 403 },
  );
  await assert.rejects(
    store.sendConversationMessage(carol, id, "Not accepted", randomUUID()),
    { status: 403 },
  );
  await assert.rejects(
    store.sendConversationMessage(alice, id, "Changed retry", clientId),
    { status: 409 },
  );
  await store.updateConversation(carol, id, { accept: true });
  const reply = await store.sendConversationMessage(
    carol,
    id,
    "Hello back",
    randomUUID(),
  );
  assert.equal(reply.number, 2);
  let chat = (await store.listConversations(alice)).conversations.find(
    (chat) => chat.id === id,
  )!;
  assert.equal(chat.unread_count, 1);
  await store.updateConversation(alice, id, { last_read_number: 2 });
  await store.updateConversation(alice, id, { last_read_number: 1 });
  chat = (await store.listConversations(alice)).conversations.find(
    (chat) => chat.id === id,
  )!;
  assert.equal(chat.unread_count, 0);
});
test("outsiders cannot read, send, accept or modify another conversation", async () => {
  const id = await store.createConversation(bob, [carol]);
  await assert.rejects(store.conversationMessages(outsider, id), {
    status: 404,
  });
  await assert.rejects(
    store.sendConversationMessage(outsider, id, "Intrusion", randomUUID()),
    { status: 404 },
  );
  await assert.rejects(
    store.updateConversation(outsider, id, { accept: true, muted: true }),
    { status: 404 },
  );
  const token = randomUUID();
  await pool.query(
    "INSERT INTO auth_sessions(id,account_id,token_hash,expires_at,created_at) VALUES($1,$2,$3,now()+interval '1 hour',now())",
    [randomUUID(), outsider, hash(token)],
  );
  assert.equal(
    (await request(`/conversations/${id}/messages`, token)).status,
    404,
  );
});
test("blocking stops new groups and sends while preserving existing history", async () => {
  const id = await store.createConversation(alice, [carol]);
  const before = (await store.conversationMessages(carol, id)).messages.length;
  await store.blockAccount(carol, alice, true);
  await assert.rejects(store.createConversation(alice, [carol]), {
    status: 403,
  });
  await assert.rejects(
    store.sendConversationMessage(alice, id, "Blocked", randomUUID()),
    { status: 403 },
  );
  assert.equal(
    (await store.conversationMessages(carol, id)).messages.length,
    before,
  );
  assert.equal(
    (await store.listConversations(alice)).conversations.find(
      (chat) => chat.id === id,
    )!.can_send,
    false,
  );
  await store.blockAccount(carol, alice, false);
  await store.sendConversationMessage(alice, id, "Unblocked", randomUUID());
});
test("cookie writes require a same-origin request; a bearer cannot override a different session", async () => {
  const response = await fetch(`${base}/conversations`, {
    method: "POST",
    headers: {
      cookie: `letagents_session=${browserToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ account_ids: [bob] }),
  });
  assert.equal(response.status, 403);
  const claimedBearer = await fetch(`${base}/conversations`, {
    method: "POST",
    headers: {
      cookie: `letagents_session=${browserToken}`,
      Authorization: "Basic bogus",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ account_ids: [bob] }),
  });
  assert.equal(claimedBearer.status, 403);
  const confused = await request("/conversations", appToken, "GET", undefined, {
    cookie: `letagents_session=${browserToken}`,
  });
  assert.equal(confused.status, 401);
});
test("app login requires browser approval plus its original secret and exchanges only once", async () => {
  const verifier = randomUUID() + randomUUID();
  const started = await request("/auth/app/start", ownerToken, "POST", {
    code_challenge: hash(verifier),
  });
  assert.equal(started.status, 201);
  const pending = (await started.json()) as {
    request_id: string;
    verification_uri: string;
  };
  const exchange = () =>
    request("/auth/app/exchange", ownerToken, "POST", {
      request_id: pending.request_id,
      code_verifier: verifier,
    });
  assert.equal(
    ((await (await exchange()).json()) as { status: string }).status,
    "pending",
  );
  assert.equal(
    (await request(`/auth/app/authorize/${pending.request_id}`, ownerToken))
      .status,
    403,
  );
  const page = await fetch(pending.verification_uri, {
    headers: { cookie: `letagents_session=${browserToken}` },
  });
  const html = await page.text();
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
  assert.ok(csrf);
  const denied = await fetch(pending.verification_uri, {
    method: "POST",
    headers: {
      cookie: `letagents_session=${browserToken}`,
      Origin: base,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "csrf=wrong",
  });
  assert.equal(denied.status, 403);
  const approved = await fetch(pending.verification_uri, {
    method: "POST",
    headers: {
      cookie: `letagents_session=${browserToken}`,
      Origin: base,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `csrf=${csrf}`,
  });
  assert.equal(approved.status, 200);
  assert.equal(
    (
      await request("/auth/app/exchange", ownerToken, "POST", {
        request_id: pending.request_id,
        code_verifier: randomUUID(),
      })
    ).status,
    410,
  );
  const result = (await (await exchange()).json()) as {
    app_session: string;
    agent_token: string;
  };
  assert.ok(result.app_session);
  assert.ok(result.agent_token);
  assert.notEqual(result.app_session, result.agent_token);
  assert.equal(
    (await request("/conversations", result.app_session)).status,
    200,
  );
  assert.equal(
    (await request("/conversations", result.agent_token)).status,
    403,
  );
  assert.equal((await exchange()).status, 410);
});
test("live changes follow committed account versions", async () => {
  const snapshot = await store.listConversations(alice);
  const waiting = request(`/conversations/changes?after=${snapshot.version}`);
  const id = await store.createConversation(alice, [carol]);
  await store.updateConversation(alice, id, { muted: true });
  const response = await waiting;
  assert.equal(response.status, 200);
  const changed = (await response.json()) as { version: string };
  assert.ok(BigInt(changed.version) > BigInt(snapshot.version));
});

test("missed messages paginate forward without gaps and earlier history stays ordered", async () => {
  const id = await store.createConversation(bob, [outsider]);
  await store.updateConversation(outsider, id, { accept: true });
  for (let i = 1; i <= 205; i++)
    await store.sendConversationMessage(bob, id, `Message ${i}`, randomUUID());
  const latest = await store.conversationMessages(outsider, id);
  assert.deepEqual(
    latest.messages.map((m) => m.number),
    Array.from({ length: 100 }, (_, i) => i + 106),
  );
  assert.equal(latest.has_more, true);
  const first = await store.conversationMessages(outsider, id, { after: 0 });
  const second = await store.conversationMessages(outsider, id, { after: 100 });
  const third = await store.conversationMessages(outsider, id, { after: 200 });
  assert.deepEqual(
    [...first.messages, ...second.messages, ...third.messages].map(
      (m) => m.number,
    ),
    Array.from({ length: 205 }, (_, i) => i + 1),
  );
  assert.equal(third.has_more, false);
  const older = await store.conversationMessages(outsider, id, { before: 106 });
  assert.equal(older.messages.at(-1)?.number, 105);
});

test("private push follows the recipient session, mute and read cursor without cancelling other devices", async () => {
  const { registerDesktopPushRoutes } = await import(
    "../routes/desktop-push.js"
  );
  const { recordAuthorizationDenied } = await import(
    "../notifications/worker.js"
  );
  registerDesktopPushRoutes(app);
  const registration = (token: string, installation: string, hex: string) =>
    request("/desktop/push/devices", token, "POST", {
      installation_id: installation,
      device_token: hex.repeat(64),
      bundle_id: "chat.letagents.desktop",
      environment: "sandbox",
      app_version: "test",
    });
  assert.equal(
    (await registration(ownerToken, "invalid-agent-device", "a")).status,
    403,
  );
  const first = await registration(appToken, "private-device-one", "b");
  assert.equal(first.status, 200);
  const second = await registration(browserToken, "private-device-two", "c");
  assert.equal(second.status, 200);
  const d1 = ((await first.json()) as { device_id: string }).device_id;
  const d2 = ((await second.json()) as { device_id: string }).device_id;
  const id = await store.createConversation(alice, [carol]);
  await store.updateConversation(alice, id, { muted: false, archived: false });
  const message = await store.sendConversationMessage(
    carol,
    id,
    "Private contents must not be in push payloads",
    randomUUID(),
  );
  const queued = await pool.query(
    "SELECT * FROM desktop_push_notifications WHERE conversation_id=$1 AND message_number=$2",
    [id, message.number],
  );
  assert.equal(queued.rowCount, 2);
  assert.ok(
    queued.rows.every(
      (row) =>
        row.body === "Sent you a private message" && row.room_id === null,
    ),
  );
  assert.equal(
    await store.canNotifyConversation(alice, id, message.number, d1),
    true,
  );
  await pool.query(
    "UPDATE auth_sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=$1",
    [hash(appToken)],
  );
  assert.equal(
    await store.canNotifyConversation(alice, id, message.number, d1),
    false,
  );
  assert.equal(
    await store.canNotifyConversation(alice, id, message.number, d2),
    true,
  );
  const denied = queued.rows.find((row) => row.device_id === d1);
  await pool.query(
    "UPDATE desktop_push_notifications SET state='processing',claimed_by='test-worker' WHERE id=$1",
    [denied.id],
  );
  await recordAuthorizationDenied(
    { ...denied, account_id: alice } as never,
    "test-worker",
  );
  const remaining = await pool.query(
    "SELECT state FROM desktop_push_notifications WHERE conversation_id=$1 AND device_id=$2 AND message_number=$3",
    [id, d2, message.number],
  );
  assert.equal(remaining.rows[0].state, "queued");
  await store.updateConversation(alice, id, { muted: true });
  assert.equal(
    await store.canNotifyConversation(alice, id, message.number, d2),
    false,
  );
  await store.updateConversation(alice, id, {
    muted: false,
    last_read_number: message.number,
  });
  assert.equal(
    await store.canNotifyConversation(alice, id, message.number, d2),
    false,
  );
  await pool.query(
    "UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE token_hash=$1",
    [hash(appToken)],
  );
});
