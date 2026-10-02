import assert from "node:assert/strict";
import test from "node:test";

type Call = { path: string; method: string };

async function load(t: test.TestContext, options: { local?: boolean; respond?: (call: Call) => unknown } = {}) {
  const calls: Call[] = [];
  t.mock.module("../main/auth.js", {
    namedExports: {
      apiFetch: async (path: string, init?: RequestInit) => {
        const call = { path, method: init?.method ?? "GET" };
        calls.push(call);
        return options.respond?.(call) ?? {};
      },
    },
  });
  t.mock.module("../main/rooms/local-store.js", {
    namedExports: {
      resolveLocalAwareRoomStorageMode: async () => ({ effectiveMode: options.local ? "local" : "cloud", localRoom: null }),
      cloudRoomIdentifierForStorage: (_storage: unknown, identifier: string) => identifier.trim(),
    },
  });
  const subject = await import(new URL(`../main/rooms/reactions.js?${t.name}`, import.meta.url).href) as
    typeof import("../main/rooms/reactions.js");
  return { subject, calls };
}

const room = "github.com/org/repo";
const roomPath = `/rooms/${encodeURIComponent(room)}/messages`;

test("adding and removing a reaction use the idempotent verbs and an encoded emoji", async (t) => {
  const { subject, calls } = await load(t, {
    respond: () => ({ changed: true, reactions: [{ emoji: "👍", count: 1, reactors: [{ login: "emmy" }] }, { emoji: "nope", count: 1 }] }),
  });
  const added = await subject.setDesktopMessageReaction(room, "msg_12", " 👍 ", true);
  assert.deepEqual(calls.at(-1), { path: `${roomPath}/msg_12/reactions/${encodeURIComponent("👍")}`, method: "PUT" });
  assert.deepEqual(added, { changed: true, reactions: [{ emoji: "👍", count: 1, reactors: [{ login: "emmy", name: "emmy", avatar_url: null }] }] },
    "the answer is validated before it reaches the renderer");
  await subject.setDesktopMessageReaction(room, "msg_12", "❤", false);
  assert.deepEqual(calls.at(-1), { path: `${roomPath}/msg_12/reactions/${encodeURIComponent("❤️")}`, method: "DELETE" });
});

test("a range read asks for the loaded span and keeps only well-formed message ids", async (t) => {
  const { subject, calls } = await load(t, {
    respond: () => ({
      next_first_message_id: "msg_5",
      viewer_reactions: { msg_3: ["✅", "not emoji", "❤"], msg_4: [], "../etc": ["✅"], msg_6: "✅" },
      reactions: {
        msg_3: [{ emoji: "✅", count: 2, reactors: [] }],
        msg_4: [],
        "../etc": [{ emoji: "✅", count: 1 }],
      },
    }),
  });
  const read = await subject.getDesktopMessageReactions(room, "msg_1", "msg_9");
  assert.deepEqual(calls, [{ path: `${roomPath}/reactions?first=msg_1&last=msg_9`, method: "GET" }]);
  assert.deepEqual(read, {
    next_first_message_id: "msg_5",
    viewer_reactions: { msg_3: ["✅", "❤️"], msg_4: [] },
    reactions: { msg_3: [{ emoji: "✅", count: 2, reactors: [] }] },
  });
});

test("bad input never reaches the server", async (t) => {
  const { subject, calls } = await load(t);
  await assert.rejects(subject.setDesktopMessageReaction(room, "msg_1", "two words", true), /single emoji/);
  await assert.rejects(subject.setDesktopMessageReaction(room, "msg_1/../x", "👍", true), /Choose a message/);
  await assert.rejects(subject.setDesktopMessageReaction(room, "desktop-send:abc", "👍", true), /Choose a message/);
  await assert.rejects(subject.setDesktopMessageReaction(room, "msg_1", "👍", "yes" as unknown as boolean), /add or remove/);
  await assert.rejects(subject.setDesktopMessageReaction("  ", "msg_1", "👍", true), /Choose a room/);
  await assert.rejects(subject.getDesktopMessageReactions(room, "msg_0", "msg_2"), /Choose a message/);
  assert.deepEqual(calls, []);
});

test("a room kept on this computer has no reactions", async (t) => {
  const { subject, calls } = await load(t, { local: true });
  await assert.rejects(subject.setDesktopMessageReaction(room, "msg_1", "👍", true), /cloud room/);
  await assert.rejects(subject.getDesktopMessageReactions(room, "msg_1", "msg_2"), /cloud room/);
  assert.deepEqual(calls, []);
});


test("an older server's absent viewer state stays absent and invalid continuation is ignored", async (t) => {
  const { subject } = await load(t, { respond: () => ({ reactions: {}, next_first_message_id: "../msg_2" }) });
  assert.deepEqual(await subject.getDesktopMessageReactions(room, "msg_1", "msg_9"), {
    reactions: {}, next_first_message_id: null,
  });
});
