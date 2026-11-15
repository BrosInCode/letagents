import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const tempDir = mkdtempSync(join(tmpdir(), "letagents-room-invite-codes-"));
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_API_URL = "http://127.0.0.1:39997";
process.env.LETAGENTS_STATE_PATH = join(tempDir, "state.json");
process.env.LETAGENTS_CHAT_STORAGE = "cloud";
process.env.LETAGENTS_TOKEN = "owner-token";
delete process.env.LETAGENTS_AGENT_SESSION_BEARER;

const { roomMembershipRequiredBody } = await import("../../../shared/room-membership.mjs");
const { isRoomInviteCodeShape, normalizeRoomInviteCode, roomInviteJoinedText } = await import("../../../shared/room-invites.mjs");
const { registerTools } = await import("../server/register-tools.js");
const { getCurrentRoom, shutdownRuntime } = await import("../server/runtime/room-state.js");
const { clearPendingDeviceAuth } = await import("../local-state.js");

const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  shutdownRuntime();
  clearPendingDeviceAuth();
});

type Handler = (input: Record<string, unknown>, extra?: unknown) => Promise<{ content: Array<{ text: string }> }>;

async function call(name: string, input: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const found = new Map<string, Handler>();
  registerTools({
    tool(toolName: string, ...registration: unknown[]) {
      found.set(toolName, registration.at(-1) as Handler);
      return {};
    },
  } as unknown as McpServer, "autonomous_mcp_worker");
  const handler = found.get(name);
  assert.ok(handler, `${name} is registered`);
  const result = await handler(input, { requestId: `request_${name}` });
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

interface Seen {
  method: string;
  path: string;
  body: unknown;
}

/** A server that answers the redeem route as told, and lets every room join through. */
function server(redeem: (body: any) => Response) {
  const seen: Seen[] = [];
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    seen.push({ method: init?.method ?? "GET", path: parsed.pathname + parsed.search, body });
    if (parsed.pathname === "/invites/redeem") return redeem(body);
    const join = /^\/rooms\/(.+)\/join$/.exec(parsed.pathname);
    if (join) {
      const roomId = decodeURIComponent(join[1]!);
      return json({ room_id: roomId, display_name: "sky-owl", code: roomId });
    }
    if (parsed.pathname.endsWith("/presence")) return new Response(null, { status: 204 });
    return json({});
  };
  return seen;
}

test("the shared code rules forgive case, spaces and the dash, and refuse a room's own code", () => {
  assert.equal(normalizeRoomInviteCode("k7qm-4xpd"), "K7QM-4XPD");
  assert.equal(normalizeRoomInviteCode(" K7QM 4XPD "), "K7QM-4XPD");
  assert.equal(normalizeRoomInviteCode("K7QM4XPD"), "K7QM-4XPD");
  assert.equal(normalizeRoomInviteCode("K7QM–4XPD"), "K7QM-4XPD", "an en dash from a chat app");
  assert.equal(normalizeRoomInviteCode("K7QM-4XP0"), null, "0 is not in the alphabet");
  assert.equal(normalizeRoomInviteCode("PTGA-21RN-W0QP"), null, "a room's own code is not an invite code");
  assert.equal(normalizeRoomInviteCode("github.com/a/b"), null);
  assert.equal(normalizeRoomInviteCode(42), null);
  assert.equal(isRoomInviteCodeShape("ABCD-EFGH"), true);
  assert.equal(roomInviteJoinedText("grok", "EmmyMay"), "Grok Bot joined with EmmyMay's invite");
  assert.equal(roomInviteJoinedText("other", "EmmyMay"), "A bot joined with EmmyMay's invite");
});

test("join_code with an admin's invite code uses it, then joins the room it let the account into", async () => {
  const seen = server(() => json({ outcome: "admitted", room_id: "PTGA-21RN-W0QP", display_name: "sky-owl", joined: true }));
  const result = await call("join_code", { code: "k7qm-4xpd" });
  assert.equal(result.room_id, "PTGA-21RN-W0QP", JSON.stringify(result));
  assert.equal(result.joined_via, "join_code");
  assert.deepEqual(result.invite, { outcome: "admitted", joined_now: true });
  assert.match(result.invite_message, /one-use code; do not use it again/);
  assert.match(result.next_step, /register_agent_session/, "the next step stays: register, then say hi");
  const redeem = seen.find((request) => request.path === "/invites/redeem");
  assert.deepEqual(redeem?.body, { code: "K7QM-4XPD" }, "the code goes in the body, never in a path");
  assert.ok(seen.some((request) => request.method === "POST" && request.path === "/rooms/PTGA-21RN-W0QP/join?create=false"),
    "the join never creates a room");
  assert.equal(getCurrentRoom()?.room_id, "PTGA-21RN-W0QP");
});

test("join_room with an invite code takes the same path", async () => {
  server(() => json({ outcome: "admitted", room_id: "PTGA-21RN-W0QP", display_name: "sky-owl", joined: false }));
  const result = await call("join_room", { name: "K7QM-4XPD" });
  assert.equal(result.room_id, "PTGA-21RN-W0QP", JSON.stringify(result));
  assert.deepEqual(result.invite, { outcome: "admitted", joined_now: false });
});

test("a member's invite asks the admins and says to wait, then request_room_access knows the room", async () => {
  const pending = { id: "rjr_1", state: "pending", created_at: "2026-11-15T10:00:00.000Z", decided_at: null, retry_after: null };
  const seen = server(() => json({ outcome: "requested", room_id: "PTGA-21RN-W0QP", display_name: "sky-owl", join_request: pending }));
  const result = await call("join_code", { code: "K7QM-4XPD" });
  assert.equal(result.success, true);
  assert.equal(result.state, "pending");
  assert.equal(result.next_step, "wait_for_room_admin");
  assert.deepEqual(result.join_request, pending);
  assert.match(result.message, /a room admin must approve/);
  assert.equal(seen.some((request) => request.path.endsWith("/join")), false, "no join while the request waits");

  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/rooms/PTGA-21RN-W0QP/membership") {
      return json({
        room_id: "PTGA-21RN-W0QP",
        access_room_id: "PTGA-21RN-W0QP",
        display_name: "sky-owl",
        managed_by: "letagents",
        member: false,
        role: null,
        join_request: pending,
      });
    }
    return json({}, 404);
  };
  const access = await call("request_room_access", {});
  assert.equal(access.room_id, "PTGA-21RN-W0QP", "request_room_access defaults to the room the invite asked for");
  assert.equal(access.state, "pending");
});

test("join_room with a room name shaped like a code joins that room when no invite has it", async () => {
  const seen = server(() => json({ error: "This invite code is not valid.", code: "INVITE_NOT_FOUND" }, 404));
  const result = await call("join_room", { name: "test-team" });
  assert.equal(result.room_id, "test-team", JSON.stringify(result));
  assert.equal(result.joined_via, "join_room");
  assert.ok(seen.some((request) => request.method === "POST" && request.path === "/rooms/test-team/join"),
    "the name joins as it did before invites");
});

test("a used, cancelled, ended or Git Room invite is refused with one clear next step", async () => {
  const cases = [
    ["INVITE_USED", 410, "invite_used"],
    ["INVITE_CANCELLED", 410, "invite_cancelled"],
    ["INVITE_EXPIRED", 410, "invite_expired"],
    ["INVITE_MAKER_LEFT", 410, "invite_maker_left"],
    ["INVITE_REPO_ROOM", 409, "invite_repo_room"],
  ] as const;
  for (const [code, status, error] of cases) {
    const seen = server(() => json({ error: `server says ${code}`, code }, status));
    const result = await call("join_code", { code: "K7QM-4XPD" });
    assert.equal(result.success, false, code);
    assert.equal(result.error, error, code);
    assert.equal(result.next_step, "ask_for_new_invite", code);
    assert.match(result.message, new RegExp(`server says ${code}`), code);
    assert.match(result.message, /Do not retry this code/, code);
    assert.equal(seen.some((request) => request.path.includes("/join")), false, `${code}: no join`);
  }
});

test("a code no invite has falls back to a room's own old code, and says invalid when that is missing too", async () => {
  const notFound = () => json({ error: "This invite code is not valid. Check it, or ask for a new one.", code: "INVITE_NOT_FOUND" }, 404);
  let seen = server(notFound);
  const legacy = await call("join_code", { code: "ABCD-EFGH" });
  assert.equal(legacy.room_id, "ABCD-EFGH", "an old two-part room code still joins");
  assert.ok(seen.some((request) => request.path === "/rooms/ABCD-EFGH/join"), "the join it made before invites");

  seen = [];
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    seen.push({ method: init?.method ?? "GET", path: parsed.pathname + parsed.search, body: null });
    if (parsed.pathname === "/invites/redeem") return notFound();
    return json({ error: "Room not found", code: "ROOM_NOT_FOUND" }, 404);
  };
  const missing = await call("join_code", { code: "ABCD-EFGH" });
  assert.equal(missing.success, false);
  assert.equal(missing.error, "invite_not_found");
  assert.match(missing.message, /not valid/);
});

test("a declined account is told when it may ask again, and an old server without invites joins by code", async () => {
  server(() => json({
    error: "declined",
    code: "ROOM_JOIN_REQUEST_COOLDOWN",
    room_id: "PTGA-21RN-W0QP",
    join_request: { id: "rjr_2", state: "declined", created_at: "2026-11-14T10:00:00.000Z", decided_at: "2026-11-14T11:00:00.000Z", retry_after: "2026-11-15T11:00:00.000Z" },
    retry_after: "2026-11-15T11:00:00.000Z",
  }, 429));
  const declined = await call("join_code", { code: "K7QM-4XPD" });
  assert.equal(declined.state, "declined");
  assert.equal(declined.next_step, "wait_until_retry_after");
  assert.match(declined.message, /The invite was not used/);

  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/invites/redeem") return new Response("Cannot POST /invites/redeem", { status: 404 });
    if (/\/join$/.test(parsed.pathname)) return json({ room_id: "ABCD-EFGH", display_name: "old" });
    void init;
    return json({});
  };
  const old = await call("join_code", { code: "ABCD-EFGH" });
  assert.equal(old.room_id, "ABCD-EFGH");
});

test("a members-only refusal tells a bot with an invite code to use join_code", async () => {
  server(() => json({}));
  globalThis.fetch = async () => json(roomMembershipRequiredBody({ room_id: "room_secret", display_name: "Secret", join_request: null }), 403);
  const refused = await call("join_room", { name: "room_secret" });
  assert.equal(refused.error, "membership_required");
  assert.match(refused.message, /invite code \(XXXX-XXXX\), call join_code with it/);
});
