import assert from "node:assert/strict";
import test from "node:test";

async function load(t: test.TestContext, options: { local?: boolean; respond?: (path: string) => unknown } = {}) {
  const paths: string[] = [];
  t.mock.module("../main/auth.js", {
    namedExports: {
      apiFetch: async (path: string) => {
        paths.push(path);
        return options.respond?.(path) ?? {};
      },
    },
  });
  t.mock.module("../main/rooms/local-store.js", {
    namedExports: {
      resolveLocalAwareRoomStorageMode: async () => ({ effectiveMode: options.local ? "local" : "cloud", localRoom: null }),
      cloudRoomIdentifierForStorage: (_storage: unknown, identifier: string) => identifier.trim(),
    },
  });
  const subject = await import(new URL(`../main/rooms/search.js?${t.name}`, import.meta.url).href) as
    typeof import("../main/rooms/search.js");
  return { subject, paths };
}

const room = "github.com/org/repo";
const base = `/rooms/${encodeURIComponent(room)}/messages/search`;
const payload = (id: string, text: string) => ({ id, sender: "Emmy", text, timestamp: "2026-10-02T10:00:00.000Z" });

test("a search sends the query and cursor, and maps the page for the renderer", async (t) => {
  const { subject, paths } = await load(t, {
    respond: () => ({ terms: ["lock timeout", "mint"], messages: [payload("msg_9", "the mint lock timeout")], has_more: true, next_before: "msg_9" }),
  });
  const page = await subject.searchDesktopRoomMessages(room, '  "lock timeout" mint ', "msg_40");
  assert.deepEqual(paths, [`${base}?${new URLSearchParams({ q: '"lock timeout" mint', before: "msg_40" })}`]);
  assert.deepEqual([page.terms, page.has_more, page.next_before], [["lock timeout", "mint"], true, "msg_9"]);
  assert.equal(page.messages[0]!.id, "msg_9");
  assert.equal(page.messages[0]!.threadRootId, "msg_9", "results are mapped like any other room message");

  await subject.searchDesktopRoomMessages(room, "mint");
  assert.equal(paths[1], `${base}?q=mint`);
});

test("a malformed answer cannot produce a cursor that pages forever", async (t) => {
  const { subject } = await load(t, { respond: () => ({ messages: "nope", has_more: true, next_before: "../etc", terms: [7, "ok"] }) });
  assert.deepEqual(await subject.searchDesktopRoomMessages(room, "mint"), { terms: ["ok"], messages: [], has_more: false, next_before: null });
});

test("bad input never reaches the server", async (t) => {
  const { subject, paths } = await load(t);
  await assert.rejects(subject.searchDesktopRoomMessages("  ", "mint"), /Choose a room/);
  await assert.rejects(subject.searchDesktopRoomMessages(room, "a"), /longer or shorter/);
  await assert.rejects(subject.searchDesktopRoomMessages(room, "x".repeat(201)), /longer or shorter/);
  await assert.rejects(subject.searchDesktopRoomMessages(room, "mint", "latest"), /Choose a message/);
  assert.deepEqual(paths, []);
});

test("a room kept on this computer has no server history to search", async (t) => {
  const { subject, paths } = await load(t, { local: true });
  await assert.rejects(subject.searchDesktopRoomMessages(room, "mint"), /cloud room/);
  assert.deepEqual(paths, []);
});
