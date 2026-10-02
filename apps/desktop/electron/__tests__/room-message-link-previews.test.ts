import assert from "node:assert/strict";
import test from "node:test";

async function load(t: test.TestContext, local = false) {
  const calls: unknown[] = [];
  t.mock.module("../main/auth.js", { namedExports: { apiFetch: async (path: string, init: RequestInit) => {
    calls.push([path, init.method, JSON.parse(String(init.body))]); return { room_id: "room", previews: [] };
  } } });
  t.mock.module("../main/rooms/local-store.js", { namedExports: {
    resolveLocalAwareRoomStorageMode: async () => ({ effectiveMode: local ? "local" : "cloud" }),
    cloudRoomIdentifierForStorage: () => "github.com/org/repo",
  } });
  const subject = await import(new URL(`../main/rooms/link-previews.js?${t.name}`, import.meta.url).href) as typeof import("../main/rooms/link-previews.js");
  return { subject, calls };
}
test("preview IPC builds only a room-scoped number batch and resolves storage first", async (t) => {
  const { subject, calls } = await load(t);
  await subject.getDesktopMessageLinkPreviews("alias", [{ kind: "pull", number: 42 }]);
  assert.deepEqual(calls, [["/rooms/github.com%2Forg%2Frepo/messages/link-previews", "POST", { references: [{ kind: "pull", number: 42 }] }]]);
});
test("local previews and invalid requests never reach HTTP", async (t) => {
  const { subject, calls } = await load(t, true);
  assert.deepEqual(await subject.getDesktopMessageLinkPreviews("local", [{ kind: "issue", number: 1 }]), { room_id: "local", previews: [], available: false });
  await assert.rejects(subject.getDesktopMessageLinkPreviews("local", [{ kind: "pull", number: 1, url: "https://evil" }] as any));
  assert.deepEqual(calls, []);
});
