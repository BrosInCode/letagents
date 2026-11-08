import assert from "node:assert/strict";
import test from "node:test";
import { effectScope, ref } from "vue";
import { useDesktopOrganizations } from "../src/composables/useDesktopOrganizations.js";

const org = { github_org_id: "42", login: "herotel", avatar_url: null, role: "owner", setup: false, joined: false };
const status = (id: string) => ({ authenticated: true, account: { id }, apiUrl: "https://letagents.chat" });
const settle = () => new Promise((resolve) => setImmediate(resolve));
const listed = (organizations: any[], extra: Record<string, unknown> = {}) => ({ status: "ok", organizations, invitations: [], ssoRequired: [], ...extra });
const repoRoom = { kind: "repo", room_id: "github.com/herotel/app", display_name: "app", full_name: "herotel/app", github_repo_id: "7", organization_id: "42", visibility: "private" };

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

test("owners set up a company and load its rooms; all rooms stays available", async () => {
  const joins: any[] = [];
  await harness({
    list: async () => listed([{ ...org }]),
    join: async (...args: any[]) => { joins.push(args); return { status: "ok" }; },
    rooms: async () => ({ status: "ok", rooms: [repoRoom] }),
  }, async (state) => {
    assert.equal(state.status.value, "ready");
    assert.equal(await state.choose("42"), true);
    assert.deepEqual(joins, [["42", true]]);
    assert.equal(state.rooms.value[0].room_id, "github.com/herotel/app");
    assert.equal(state.roomsStatus.value, "ready");
    assert.equal(await state.choose(null), true);
    assert.equal(state.selectedId.value, null);
    assert.deepEqual(state.rooms.value, []);
  });
});

test("a joined company opens without joining again", async () => {
  await harness({
    list: async () => listed([{ ...org, setup: true, joined: true }]),
    join: async () => { throw new Error("must not join"); },
    rooms: async () => ({ status: "ok", rooms: [repoRoom] }),
  }, async (state) => {
    assert.equal(await state.choose("42"), true);
    assert.equal(state.selectedId.value, "42");
  });
});

test("members cannot set up unconfigured companies", async () => {
  await harness({ list: async () => listed([{ ...org, role: "member" }]), join: async () => { throw new Error("must not join"); } }, async (state) => {
    assert.equal(await state.choose("42"), false);
    assert.match(state.error.value!, /owner/);
    assert.equal(await state.choose(null), true);
  });
});

test("a refused join explains what to do and keeps the company unselected", async () => {
  await harness({ list: async () => listed([{ ...org, setup: true }]), join: async () => ({ status: "membership_required" }) }, async (state) => {
    assert.equal(await state.choose("42"), false);
    assert.match(state.error.value!, /isn’t a member of herotel/);
    assert.equal(state.selectedId.value, null);
  });
});

test("account switch discards an old account's in-flight company join", async () => {
  let resolveJoin!: (value: unknown) => void;
  await harness({ list: async () => listed([{ ...org }]), join: () => new Promise((resolve) => { resolveJoin = resolve; }), rooms: async () => ({ status: "ok", rooms: [] }) }, async (state, auth) => {
    const request = state.choose("42");
    auth.value = status("bob");
    resolveJoin({ status: "ok" });
    assert.equal(await request, false);
    await settle();
    assert.equal(state.selectedId.value, null);
    assert.deepEqual(state.rooms.value, []);
  });
});

test("losing the GitHub membership leaves the company; a GitHub outage keeps the rooms already shown", async () => {
  let rooms: any = { status: "ok", rooms: [repoRoom] };
  await harness({ list: async () => listed([{ ...org, setup: true, joined: true }]), rooms: async () => rooms }, async (state) => {
    await state.choose("42");
    rooms = { status: "unavailable" };
    await state.refresh();
    assert.equal(state.rooms.value.length, 1);
    assert.equal(state.roomsStatus.value, "unavailable");
    rooms = { status: "sso_required" };
    await state.refresh();
    assert.deepEqual(state.rooms.value, []);
    assert.equal(state.roomsStatus.value, "sso_required");
    rooms = { status: "membership_required" };
    await state.refresh();
    assert.equal(state.selectedId.value, null);
    assert.match(state.error.value!, /no longer a member/);
  });
});

test("a sign-in without organization access asks for it, and a focus check runs again at once", async () => {
  let calls = 0;
  let result: any = { status: "github_access_required", reason: "scope" };
  await harness({ list: async () => { calls += 1; return result; } }, async (state) => {
    assert.equal(state.status.value, "github_access_required");
    assert.equal(state.accessReason.value, "scope");
    result = listed([], { invitations: [{ github_org_id: "9", login: "studio", avatar_url: null }] });
    await state.refreshIfStale();
    assert.equal(calls, 2);
    assert.equal(state.status.value, "ready");
    assert.equal(state.hasChoices.value, true);
    await state.refreshIfStale();
    assert.equal(calls, 2, "a ready list is not checked again within a minute");
  });
});

test("a person with no organizations has nothing to choose", async () => {
  await harness({ list: async () => listed([]) }, async (state) => {
    assert.equal(state.status.value, "ready");
    assert.equal(state.hasChoices.value, false);
  });
});
