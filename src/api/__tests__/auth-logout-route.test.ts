import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const { registerAuthLogoutRoute } = await import("../routes/auth/index.js");

// Page grants the sign-out revoked, by filter.
const revokedPageGrants: unknown[] = [];

function registerHandler(deps: {
  deleteOwnerTokenById: (tokenId: string) => Promise<void>;
  deleteSessionByToken: (token: string) => Promise<void>;
}) {
  let handler: ((req: Record<string, unknown>, res: Record<string, unknown>) => Promise<void>) | null = null;
  registerAuthLogoutRoute({
    post(path: string, candidate: typeof handler) {
      assert.equal(path, "/auth/logout");
      handler = candidate;
    },
  } as never, { ...deps, revokePageGrants: async (filter) => { revokedPageGrants.push(filter); return 0; } });
  assert.ok(handler);
  return handler;
}

test("owner-token logout revokes exactly the authenticated bearer", async () => {
  const revokedOwnerTokenIds: string[] = [];
  const deletedSessions: string[] = [];
  const response: { body?: unknown; cookie?: unknown } = {};
  const handler = registerHandler({
    deleteOwnerTokenById: async (tokenId) => { revokedOwnerTokenIds.push(tokenId); },
    deleteSessionByToken: async (token) => { deletedSessions.push(token); },
  });

  await handler({
    authKind: "owner_token",
    headers: { cookie: "other=value" },
    sessionAccount: { token_id: "owner-token-current", account_id: "acct_owner" },
  }, {
    setHeader(_name: string, value: unknown) { response.cookie = value; },
    json(body: unknown) { response.body = body; },
  });

  assert.deepEqual(revokedOwnerTokenIds, ["owner-token-current"]);
  assert.deepEqual(deletedSessions, []);
  assert.deepEqual(response.body, { success: true });
  assert.match(String(response.cookie), /Max-Age=0/);
});

test("cookie logout deletes only the presented browser session", async () => {
  const revokedOwnerTokenIds: string[] = [];
  const deletedSessions: string[] = [];
  const handler = registerHandler({
    deleteOwnerTokenById: async (tokenId) => { revokedOwnerTokenIds.push(tokenId); },
    deleteSessionByToken: async (token) => { deletedSessions.push(token); },
  });

  await handler({
    authKind: "session",
    headers: { cookie: "letagents_session=session-current; other=value" },
    sessionAccount: { id: "session-row", account_id: "acct_cookie" },
  }, {
    setHeader() {},
    json() {},
  });

  assert.deepEqual(deletedSessions, ["session-current"]);
  assert.deepEqual(revokedOwnerTokenIds, []);
});

test("logout revokes the page grants of the app session that signs out, and an owner token's logout revokes none", () => {
  assert.deepEqual(revokedPageGrants, [{ sessionId: "session-row" }]);
});
