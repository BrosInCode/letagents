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

test("a list check during a join never leaves the join marked busy", async () => {
  let resolveJoin!: (value: unknown) => void;
  let joined = false;
  await harness({
    list: async () => listed([{ ...org, setup: true, joined }]),
    join: () => new Promise((resolve) => { resolveJoin = resolve; }),
    rooms: async () => ({ status: "ok", rooms: [repoRoom] }),
  }, async (state) => {
    const request = state.choose("42");
    await state.refresh();
    joined = true;
    resolveJoin({ status: "ok" });
    assert.equal(await request, true);
    await settle();
    assert.equal(state.joiningId.value, null);
    assert.equal(state.busy.value, false);
    assert.equal(state.selectedId.value, "42");
  });
});

test("choosing All rooms while the list loads does not leave the list stuck checking", async () => {
  let resolveList!: (value: unknown) => void;
  let first = true;
  await harness({
    list: () => first ? new Promise((resolve) => { resolveList = resolve; }) : Promise.resolve(listed([{ ...org }])),
  }, async (state) => {
    assert.equal(state.status.value, "loading");
    assert.equal(await state.choose(null), true);
    first = false;
    resolveList(listed([{ ...org }]));
    await settle();
    await settle();
    assert.equal(state.status.value, "ready");
  });
});

test("a saved company filters the app only after GitHub confirms it", async () => {
  const previous = globalThis.window;
  let result: any = { status: "unavailable" };
  const values = new Map<string, string>([["letagents:company:https://letagents.chat:alice", "42"]]);
  globalThis.window = { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }, letagentsDesktop: { organizations: { list: async () => result, rooms: async () => ({ status: "ok", rooms: [repoRoom] }) } } } as any;
  const scope = effectScope();
  try {
    const state = scope.run(() => useDesktopOrganizations(ref(status("alice")) as any))!;
    await settle();
    assert.equal(state.selectedId.value, "42");
    assert.equal(state.activeId.value, null, "GitHub did not answer, so All rooms stays in view");
    result = listed([{ ...org, setup: true, joined: true }]);
    await state.refresh();
    assert.equal(state.activeId.value, "42");
  } finally { scope.stop(); globalThis.window = previous; }
});

test("a theme save preserves a list retry and wins over older theme data in that response", async () => {
  let answer: () => Promise<unknown> = async () => listed([{ ...org, setup: true, joined: true, theme_id: "mint", theme_revision: 1 }]);
  let finishRetry!: (result: unknown) => void;
  await harness({
    list: () => answer(),
    setTheme: async () => ({ theme: "violet", themeRevision: 2 }),
  }, async (state) => {
    answer = async () => ({ status: "unavailable" });
    await state.refresh();
    assert.equal(state.status.value, "unavailable");

    answer = () => new Promise(resolve => { finishRetry = resolve; });
    const retry = state.refreshIfStale(0);
    assert.equal(state.status.value, "loading");
    await state.changeTheme("42", "violet");
    finishRetry(listed([{ ...org, role: "member", setup: true, joined: true, theme_id: "mint", theme_revision: 1 }]));
    await retry;
    assert.equal(state.status.value, "ready");
    assert.equal(state.organizations.value[0].role, "member");
    assert.equal(state.organizations.value[0].theme_id, "violet");

    answer = async () => listed([{ ...org, theme_id: null, theme_revision: 3 }]);
    await state.refresh();
    assert.equal(state.organizations.value[0].theme_id, null);
  });
});

test("a fresh room theme survives reopening a cached company room for the same account", async () => {
  await harness({ list: async () => listed([]) }, async (state, auth) => {
    const oldRoom = { id: "42", name: "Herotel", theme: "mint" as const, themeRevision: 1 };
    const newRoom = { ...oldRoom, theme: "violet" as const, themeRevision: 2 };
    state.rememberRoomAppearance(oldRoom);
    assert.deepEqual(state.resolveRoomAppearance(oldRoom), oldRoom);
    state.rememberRoomAppearance(newRoom);
    assert.deepEqual(state.resolveRoomAppearance(newRoom), newRoom);
    state.rememberRoomAppearance(oldRoom);
    assert.deepEqual(state.resolveRoomAppearance(oldRoom), newRoom);
    assert.equal(state.resolveRoomAppearance({ ...oldRoom, id: "another" }).theme, "mint");

    const cleared = { ...newRoom, theme: null, themeRevision: 3 };
    state.rememberRoomAppearance(cleared);
    assert.deepEqual(state.resolveRoomAppearance(oldRoom), cleared);
    auth.value = status("bob");
    assert.deepEqual(state.resolveRoomAppearance(oldRoom), oldRoom);
  });
});
