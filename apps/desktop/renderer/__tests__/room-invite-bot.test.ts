import assert from "node:assert/strict";
import { test } from "node:test";
import { nextTick, ref } from "vue";

import {
  INVITE_CODE_PLACEHOLDER,
  buildInviteBotCodeMessage,
  inviteBotCodeSummary,
  useInviteBotCode,
  type InviteBotCreated,
  type InviteBotPlatform,
} from "../../../../shared/ui/invite-bot";
import type { RoomInvite } from "../../../../shared/room-invites.mjs";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  },
});

const calls: Array<{ method: string; args: unknown[] }> = [];
let listed: RoomInvite[] = [];
let created: RoomInvite | null = null;
Object.defineProperty(globalThis, "window", {
  configurable: true,
  writable: true,
  value: {
    letagentsDesktop: {
      roomInvites: {
        create: async (...args: unknown[]) => {
          calls.push({ method: "create", args });
          return created ? { ok: true, invite: created, code: "K7QM-4XPD" } : { ok: false, code: "INVITE_LIMIT", message: "You have 10 invites waiting in this room. Cancel one first." };
        },
        list: async (...args: unknown[]) => { calls.push({ method: "list", args }); return { ok: true, invites: listed }; },
        cancel: async (...args: unknown[]) => {
          calls.push({ method: "cancel", args });
          return { ok: true, invite: { ...listed[0]!, state: "cancelled" } };
        },
        listRooms: async () => ({ ok: true, rooms: [] }),
      },
    },
  },
});

const { createRoomInvites, roomInvitePillText } = await import("../src/composables/useRoomInvites");

function invite(overrides: Partial<RoomInvite> = {}): RoomInvite {
  return {
    id: "inv_1",
    room_id: "PTGA-21RN-W0QP",
    room_display_name: "sky-owl",
    origin_room_id: "PTGA-21RN-W0QP",
    platform: "grok",
    kind: "admit",
    state: "open",
    outcome: null,
    created_at: "2026-11-15T10:00:00.000Z",
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    used_at: null,
    used_by_login: null,
    ...overrides,
  };
}

test("the Grok Bot message is the one decided for this build, and names no room", () => {
  const message = buildInviteBotCodeMessage("grok", { code: "K7QM-4XPD", connectorUrl: "https://letagents.chat/mcp" });
  assert.equal(message.text,
    "Paste this to your Grok Bot:\nConnect to LetAgents at https://letagents.chat/mcp and sign me in. "
    + "Then join LetAgents with the invite code K7QM-4XPD and say hi in the room.");
  assert.deepEqual(message.parts.filter((part) => part.kind !== "text").map((part) => part.kind), ["connector", "code"]);
});

test("each bot gets the connector address and the code; before Copy the code is a placeholder", () => {
  for (const platform of ["grok", "chatgpt", "claude", "other"] as InviteBotPlatform[]) {
    const ready = buildInviteBotCodeMessage(platform, { code: "K7QM-4XPD", connectorUrl: "https://chat.example/mcp" });
    assert.match(ready.text, /https:\/\/chat\.example\/mcp/, platform);
    assert.match(ready.text, /join LetAgents with the invite code K7QM-4XPD and say hi in the room\./i, platform);
    const waiting = buildInviteBotCodeMessage(platform, { code: null });
    assert.match(waiting.text, /https:\/\/letagents\.chat\/mcp/, `${platform}: the public server by default`);
    assert.ok(waiting.text.includes(INVITE_CODE_PLACEHOLDER), platform);
    assert.equal(waiting.parts.find((part) => part.kind === "code")?.kind === "code"
      && (waiting.parts.find((part) => part.kind === "code") as { placeholder: boolean }).placeholder, true);
  }
});

test("the summary says what the invite does, by role, and keeps a name to one quoted line", () => {
  assert.equal(inviteBotCodeSummary("sky-owl", true), 'The bot joins "sky-owl" at once, with no approval. The invite works one time.');
  assert.equal(inviteBotCodeSummary("sky-owl", false), 'An admin of "sky-owl" lets the bot in. The invite works one time.');
  assert.equal(inviteBotCodeSummary('Team "A"\nnext', true), "The bot joins \"Team 'A' next\" at once, with no approval. The invite works one time.");
});

test("Copy makes the code once for this room and bot, copies the same code again, and a new bot gets a new code", async () => {
  const copied: string[] = [];
  const made: InviteBotPlatform[] = [];
  let next = 0;
  const room = ref<{ roomId: string; roomName: string; connectorUrl: string } | null>({ roomId: "PTGA-21RN-W0QP", roomName: "sky-owl", connectorUrl: "https://letagents.chat/mcp" });
  const controller = useInviteBotCode({
    room,
    createInvite: async (platform): Promise<InviteBotCreated> => {
      made.push(platform);
      next += 1;
      return { invite: { id: `inv_${next}`, platform, kind: "admit", room_id: room.value!.roomId }, code: `AAAA-BBB${next + 1}` };
    },
    writeClipboard: async (text) => { copied.push(text); },
    copiedMs: 1,
  });
  assert.equal(controller.platform.value, "grok", "Grok Bot is picked first");
  assert.ok(controller.message.value.text.includes(INVITE_CODE_PLACEHOLDER));
  assert.ok(await controller.copy());
  assert.equal(controller.copied.value, true);
  assert.match(copied.at(-1)!, /invite code AAAA-BBB2 /);
  assert.ok(await controller.copy());
  assert.deepEqual(made, ["grok"], "copying again copies the same code");
  controller.pick("chatgpt");
  assert.ok(controller.message.value.text.includes(INVITE_CODE_PLACEHOLDER), "another bot shows the placeholder again");
  await controller.copy();
  assert.deepEqual(made, ["grok", "chatgpt"]);
  assert.match(copied.at(-1)!, /^In ChatGPT/);
  room.value = { roomId: "OTHER-ROOM-0001", roomName: "fern-river", connectorUrl: "https://letagents.chat/mcp" };
  await nextTick();
  assert.ok(controller.message.value.text.includes(INVITE_CODE_PLACEHOLDER), "another room starts over");
});

test("a refused invite shows the server's sentence and copies nothing", async () => {
  const copied: string[] = [];
  const controller = useInviteBotCode({
    room: ref({ roomId: "PTGA-21RN-W0QP", roomName: "sky-owl" }),
    createInvite: async () => { throw new Error("You have 10 invites waiting in this room. Cancel one first."); },
    writeClipboard: async (text) => { copied.push(text); },
  });
  assert.equal(await controller.copy(), null);
  assert.equal(controller.error.value, "You have 10 invites waiting in this room. Cancel one first.");
  assert.deepEqual(copied, []);
});

test("a new invite's pill waits for its panel to close, keeps its code on this computer, and Cancel ends it", async () => {
  storage.clear();
  calls.length = 0;
  const store = createRoomInvites();
  created = invite();
  const pills = store.pills(() => "PTGA-21RN-W0QP");
  const made = await store.create("PTGA-21RN-W0QP", "grok", null);
  assert.equal(made.code, "K7QM-4XPD");
  assert.deepEqual(calls.at(-1), { method: "create", args: ["PTGA-21RN-W0QP", "grok", null] });
  assert.deepEqual(pills.value, [], "no pill while the panel shows Copied");
  store.receive({ invite: created });
  assert.deepEqual(pills.value, [], "the stream's echo of the new invite waits too");
  store.reveal([created.id]);
  assert.equal(pills.value.length, 1);
  assert.equal(pills.value[0]!.state, "waiting");
  assert.equal(pills.value[0]!.code, "K7QM-4XPD");
  assert.deepEqual(roomInvitePillText(pills.value[0]!), { main: "Invite for Grok Bot", muted: " · waiting for it to join" });
  assert.match(storage.get("letagents.roomInviteCodes.v1") ?? "", /K7QM-4XPD/, "the code survives a restart");

  // After a restart the list from the server brings the pill back with its code.
  const restarted = createRoomInvites();
  listed = [created];
  await restarted.load("PTGA-21RN-W0QP");
  const again = restarted.pills(() => "PTGA-21RN-W0QP");
  assert.equal(again.value[0]?.code, "K7QM-4XPD");
  assert.equal(await restarted.cancel(again.value[0]!.invite), null);
  assert.deepEqual(again.value, [], "a cancelled invite has no pill");
  assert.equal(storage.get("letagents.roomInviteCodes.v1")?.includes("K7QM-4XPD"), false, "and its code is forgotten");
});

test("a bot that joins clears the pill in its room; from a Git Room the pill says it joined, until Done", () => {
  const store = createRoomInvites();
  const here = invite({ id: "inv_here" });
  const fromGit = invite({ id: "inv_git", origin_room_id: "github.com/acme/app" });
  store.receive({ invite: here });
  store.receive({ invite: fromGit });
  const inRoom = store.pills(() => "PTGA-21RN-W0QP");
  const inGit = store.pills(() => "github.com/acme/app");
  assert.deepEqual(inRoom.value.map((pill) => pill.invite.id), ["inv_here"]);
  assert.deepEqual(inGit.value.map((pill) => [pill.invite.id, pill.elsewhere]), [["inv_git", true]]);
  assert.deepEqual(roomInvitePillText(inGit.value[0]!).main, "Invite for Grok Bot to sky-owl");

  const used = { state: "used" as const, outcome: "admitted" as const, used_at: "2026-11-15T10:05:00.000Z", used_by_login: "botowner" };
  store.receive({ invite: { ...here, ...used } });
  store.receive({ invite: { ...fromGit, ...used } });
  assert.deepEqual(inRoom.value, [], "the room shows its own join line instead");
  assert.equal(inGit.value[0]?.state, "joined");
  assert.deepEqual(roomInvitePillText(inGit.value[0]!), { main: "Grok Bot joined sky-owl", muted: "" });
  store.close("inv_git");
  assert.deepEqual(inGit.value, []);
});

test("a member's invite that was used says an admin decides; an ended or expired invite has no pill", () => {
  const store = createRoomInvites();
  store.receive({ invite: invite({ id: "inv_member", kind: "request", platform: "other", state: "used", outcome: "requested" }) });
  store.receive({ invite: invite({ id: "inv_old", expires_at: "2026-01-01T00:00:00.000Z" }) });
  store.receive({ invite: invite({ id: "inv_cancelled", state: "cancelled" }) });
  const pills = store.pills(() => "PTGA-21RN-W0QP");
  assert.deepEqual(pills.value.map((pill) => [pill.invite.id, pill.state]), [["inv_member", "asked"]]);
  assert.deepEqual(roomInvitePillText(pills.value[0]!), { main: "Your bot asked to join", muted: " · an admin decides" });
});

test("a used invite seen only in a list after a restart shows no pill", async () => {
  const store = createRoomInvites();
  listed = [invite({ id: "inv_seen_later", state: "used", outcome: "admitted", origin_room_id: "github.com/acme/app" })];
  await store.load("github.com/acme/app");
  assert.deepEqual(store.pills(() => "github.com/acme/app").value, []);
});
