import assert from "node:assert/strict";
import test from "node:test";
import { createMessageLinkPreviewStore } from "../../../shared/message-link-preview-store.mjs";
import { eligibleLinkPreviewReferences, linkPreviewState, parseGitHubLinkReference, parseLinkPreviewReferences } from "../../../shared/message-link-previews.mjs";

test("state precedence is merged, closed, draft, open; unknown snapshots stay absent", () => {
  for (const [state, metadata, expected] of [
    ["closed", { merged: true, draft: true }, "merged"], ["merged", null, "merged"],
    ["closed", { draft: true }, "closed"], ["open", { draft: true }, "draft"],
    ["draft", null, "draft"], ["open", null, "open"], [null, null, null], ["approved", null, null],
  ] as const) assert.equal(linkPreviewState(state, metadata), expected);
});
test("only bounded GitHub references qualify; repo matching, duplicates and the three-card cap are shared", () => {
  const url = "https://github.com/Org/Repo/pull/12?x=1#discussion";
  assert.deepEqual(parseGitHubLinkReference(url), { repository: "org/repo", kind: "pull", number: 12, url: "https://github.com/org/repo/pull/12" });
  for (const invalid of ["http://github.com/org/repo/pull/1", "https://github.com.evil/org/repo/pull/1", "https://x@github.com/org/repo/pull/1", "https://github.com:444/org/repo/pull/1", "https://github.com/org/repo/pull/0", "https://github.com/org/repo/issues/9007199254740992", "javascript:alert(1)"]) assert.equal(parseGitHubLinkReference(invalid), null);
  assert.deepEqual(eligibleLinkPreviewReferences([url, url.replace("?x=1#discussion", ""), "https://github.com/other/repo/pull/2", ...[1,2,3,4].map(n => `https://github.com/org/repo/issues/${n}`)], "github.com/ORG/repo"), [{ kind: "pull", number: 12 }, { kind: "issue", number: 1 }, { kind: "issue", number: 2 }]);
  assert.deepEqual(eligibleLinkPreviewReferences([url], null), []);
  assert.equal(parseLinkPreviewReferences(Array.from({ length: 51 }, () => ({ kind: "pull", number: 1 }))), null);
  for (const invalid of [[{ kind: "pull", number: "1" }], [{ kind: "issue", number: -1 }], [{ kind: "pull", number: 1, url }]]) assert.equal(parseLinkPreviewReferences(invalid), null);
});
const ref = (number: number) => ({ kind: "pull" as const, number });
const preview = (number: number, state: "open" | "merged" = "open") => ({ ...ref(number), repository: "org/repo", title: `PR ${number}`, state, url: `https://github.com/org/repo/pull/${number}` });
test("rendered registrations coalesce, split at 50, deduplicate, unregister, and refresh misses/state", async () => {
  const batches: number[][] = []; let state: "open" | "merged" = "open"; let changes = 0;
  const store = createMessageLinkPreviewStore({ load: async (refs) => {
    batches.push(refs.map(r => r.number));
    return { room_id: "room", previews: refs.filter(r => r.number !== 3).map(r => preview(r.number, state)) };
  }, onChange: () => { changes++; } });
  try {
    const stop = store.track({ id: "msg_1", references: [ref(1), ref(2), ref(3)] });
    const stopCopy = store.track({ id: "msg_1", references: [ref(1), ref(2), ref(3)] });
    for (let i = 4; i <= 55; i++) store.track({ id: `msg_${i}`, references: [ref(i)] });
    await store.refresh();
    assert.deepEqual(batches.map(b => b.length), [50, 5]);
    assert.equal(new Set(batches.flat()).size, 55);
    assert.deepEqual(store.get("msg_1").map(p => p.number), [1, 2]);
    stop(); assert.equal(store.get("msg_1").length, 2);
    state = "merged"; await store.refresh(); assert.equal(store.get("msg_1")[0]?.state, "merged");
    stopCopy(); await store.refresh(); assert.ok(!batches.at(-2)?.includes(1));
    assert.ok(changes > 0);
  } finally { store.reset(); }
});
test("old room/account reads cannot populate a new context or block its requests", async () => {
  let release!: (value: any) => void; let count = 0;
  const store = createMessageLinkPreviewStore({ load: async () => {
    if (++count === 1) return new Promise(resolve => { release = resolve; });
    return { room_id: "new", previews: [preview(1, "merged")] };
  } });
  store.track({ id: "msg_1", references: [ref(1)] });
  const old = store.refresh(); store.reset();
  store.track({ id: "msg_1", references: [ref(1)] }); await store.refresh();
  release({ room_id: "old", previews: [preview(1)] }); await old;
  assert.equal(store.get("msg_1")[0]?.state, "merged"); store.reset();
});
test("an invalidation during a read gets one follow-up, and background failure preserves cards", async () => {
  let release!: () => void; let count = 0;
  const store = createMessageLinkPreviewStore({ load: async () => {
    count++;
    if (count === 1) await new Promise<void>(resolve => { release = resolve; });
    if (count === 3) throw Error("offline");
    return { room_id: "room", previews: [preview(1, count === 1 ? "open" : "merged")] };
  } });
  store.track({ id: "msg_1", references: [ref(1)] });
  const reading = store.refresh(); void store.refresh(); void store.refresh(); release(); await reading;
  assert.equal(count, 2); assert.equal(store.get("msg_1")[0]?.state, "merged");
  await store.refresh(); assert.equal(store.get("msg_1")[0]?.state, "merged"); store.reset();
});

test("tracking cached hits and misses makes no read; unknown references and explicit refresh still read", async () => {
  let reads = 0;
  const store = createMessageLinkPreviewStore({ refreshDelayMs: 5, load: async () => {
    reads++;
    return { room_id: "room", previews: [preview(1)] };
  } });
  try {
    store.track({ id: "msg_1", references: [ref(1), ref(2)] });
    await store.refresh();
    assert.equal(reads, 1);
    store.track({ id: "msg_2", references: [ref(1)] });
    store.track({ id: "msg_3", references: [ref(2)] });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(reads, 1);
    store.track({ id: "msg_4", references: [ref(3)] });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(reads, 2);
    await store.refresh();
    assert.equal(reads, 3);
  } finally { store.reset(); }
});
