import assert from "node:assert/strict";
import test from "node:test";
import { effectScope, ref } from "vue";
import { useDesktopOrganizations } from "../src/composables/useDesktopOrganizations.js";

const org = { github_org_id: "42", login: "acme", avatar_url: null, role: "owner", setup: false, joined: false };
const status = (id: string) => ({ authenticated: true, account: { id }, apiUrl: "https://letagents.chat" });
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function harness(api: any, run: (state: ReturnType<typeof useDesktopOrganizations>, auth: any) => Promise<void>) {
  const previous = globalThis.window;
  const values = new Map<string, string>();
  globalThis.window = { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }, letagentsDesktop: { organizations: api } } as any;
  const scope = effectScope();
  const auth = ref(status("alice")) as any;
  try {
    const state = scope.run(() => useDesktopOrganizations(auth))!;
    await settle();
    await run(state, auth);
  } finally { scope.stop(); globalThis.window = previous; }
}

test("owners set up a company and load its repo rooms; personal remains available", async () => {
  const joins: any[] = [];
  await harness({ list: async () => [{ ...org }], join: async (...args: any[]) => { joins.push(args); }, rooms: async () => [{ room_id: "github.com/acme/app" }] }, async (state) => {
    assert.equal(await state.choose("42"), true);
    assert.deepEqual(joins, [["42", true]]);
    assert.equal(state.rooms.value[0].room_id, "github.com/acme/app");
    assert.equal(await state.choose(null), true);
    assert.equal(state.selectedId.value, null);
    assert.deepEqual(state.rooms.value, []);
  });
});

test("members cannot set up unconfigured companies", async () => {
  await harness({ list: async () => [{ ...org, role: "member" }], join: async () => { throw new Error("must not join"); } }, async (state) => {
    assert.equal(await state.choose("42"), false);
    assert.match(state.error.value!, /owner/);
    assert.equal(await state.choose(null), true);
  });
});

test("account switch discards an old account's in-flight company join", async () => {
  let resolveJoin!: () => void;
  await harness({ list: async () => [{ ...org }], join: () => new Promise<void>((resolve) => { resolveJoin = resolve; }), rooms: async () => [] }, async (state, auth) => {
    const request = state.choose("42");
    auth.value = status("bob");
    resolveJoin();
    assert.equal(await request, false);
    await settle();
    assert.equal(state.selectedId.value, null);
    assert.deepEqual(state.rooms.value, []);
  });
});

test("provider failure clears company rooms and personal cancels a pending refresh", async () => {
  let fail = false;
  let resolveList!: (value: any[]) => void;
  let pending = false;
  await harness({ list: async () => pending ? new Promise<any[]>((resolve) => { resolveList = resolve; }) : [{ ...org, setup: true, joined: true }], join: async () => {}, rooms: async () => { if (fail) throw new Error("revoked"); return [{ room_id: "private" }]; } }, async (state) => {
    await state.choose("42");
    fail = true;
    await state.refresh();
    assert.deepEqual(state.rooms.value, []);
    assert.ok(state.error.value);
    pending = true;
    const request = state.refresh();
    await state.choose(null);
    resolveList([{ ...org }]);
    await request;
    assert.equal(state.selectedId.value, null);
    assert.equal(state.busy.value, false);
  });
});
