import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { resolveRequestAuth } = await import("../request-auth.js");

test("resolveRequestAuth returns null auth without session or bearer token", async () => {
  const auth = await resolveRequestAuth({
    headers: {
      cookie: "other=value",
    },
  } as never);

  assert.deepEqual(auth, {
    account: null,
    authKind: null,
  });
});

test("resolveRequestAuth ignores blank bearer tokens", async () => {
  const auth = await resolveRequestAuth({
    headers: {
      authorization: "Bearer   ",
    },
  } as never);

  assert.deepEqual(auth, {
    account: null,
    authKind: null,
  });
});
