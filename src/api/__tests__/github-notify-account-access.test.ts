import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgres://127.0.0.1:1/x";

const { filterAccountIdsWithRoomAccess } = await import("../server/events.js");

const ROOM_ID = "github.com/acme/private";

test("allow puts the account in both the notify and the recents lists", async () => {
  const result = await filterAccountIdsWithRoomAccess(ROOM_ID, ["acct_allow"], async () => "allow");
  assert.deepEqual(result, { notify: ["acct_allow"], recents: ["acct_allow"] });
});

test("retry puts the account in the notify list only", async () => {
  const result = await filterAccountIdsWithRoomAccess(ROOM_ID, ["acct_retry"], async () => "retry");
  assert.deepEqual(result, { notify: ["acct_retry"], recents: [] });
});

test("deny puts the account in neither list", async () => {
  const result = await filterAccountIdsWithRoomAccess(ROOM_ID, ["acct_deny"], async () => "deny");
  assert.deepEqual(result, { notify: [], recents: [] });
});

test("a thrown resolver error drops the account and does not throw", async () => {
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const result = await filterAccountIdsWithRoomAccess(ROOM_ID, ["acct_boom", "acct_allow"], async ({ accountId }) => {
      if (accountId === "acct_boom") throw new Error("github unavailable");
      return "allow";
    });
    assert.deepEqual(result, { notify: ["acct_allow"], recents: ["acct_allow"] });
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]), /account=acct_boom/);
    assert.ok(String(warnings[0]).includes(`room=${ROOM_ID}`));
  } finally {
    console.warn = originalWarn;
  }
});

test("the resolver receives the account and the room", async () => {
  const seen: Array<{ accountId: string; roomId: string }> = [];
  await filterAccountIdsWithRoomAccess(ROOM_ID, ["acct_1", "acct_2"], async (input) => {
    seen.push(input);
    return "deny";
  });
  assert.deepEqual(seen, [
    { accountId: "acct_1", roomId: ROOM_ID },
    { accountId: "acct_2", roomId: ROOM_ID },
  ]);
});
