import assert from "node:assert/strict";
import test from "node:test";

import {
  REPO_COLLABORATOR_REQUIRED_MESSAGE,
  ROOM_MEMBERSHIP_REQUIRED_MESSAGE,
  repoCollaboratorRequiredBody,
  roomMembershipRequiredBody,
} from "../../../../shared/room-membership.mjs";
import type { DesktopApiError } from "../main/auth.js";
import { createApiErrorRoomSnapshot } from "../main/rooms/snapshot/snapshots.js";

// The real 403 bodies only arrive after the server turns the rule on, so these
// tests build them from the shared module, as the server will.
function apiError(status: number, body: object | null): DesktopApiError {
  const payload = body as { message?: string; error?: string } | null;
  const error = new Error(String(payload?.message || payload?.error || `API request failed: ${status}`)) as Error & {
    status: number;
    payload: unknown;
  };
  error.name = "DesktopApiError";
  error.status = status;
  error.payload = payload;
  return error as unknown as DesktopApiError;
}

const pending = {
  id: "rjr_1",
  state: "pending",
  created_at: "2026-11-04T08:00:00.000Z",
  decided_at: null,
  retry_after: null,
} as const;

test("a membership 403 opens the join card with the room name and the latest request", () => {
  const snapshot = createApiErrorRoomSnapshot("design-room", apiError(403, roomMembershipRequiredBody({
    room_id: "design-room",
    display_name: "Design room",
    join_request: pending,
  })));
  assert.equal(snapshot.room, null);
  assert.equal(snapshot.access.status, "membership_required");
  assert.equal(snapshot.access.title, "Ask to join this room");
  assert.equal(snapshot.access.message, ROOM_MEMBERSHIP_REQUIRED_MESSAGE);
  assert.equal(snapshot.access.code, "ROOM_MEMBERSHIP_REQUIRED");
  assert.equal(snapshot.access.httpStatus, 403);
  assert.equal(snapshot.access.displayName, "Design room");
  assert.deepEqual(snapshot.access.joinRequest, pending);
});

test("a membership 403 with no request, or a malformed one, offers a fresh request", () => {
  for (const joinRequest of [null, { id: "rjr_2", state: "unknown" }, { state: "pending" }, "rjr_3"]) {
    const snapshot = createApiErrorRoomSnapshot("design-room", apiError(403, {
      ...roomMembershipRequiredBody({ room_id: "design-room", display_name: null }),
      join_request: joinRequest,
    }));
    assert.equal(snapshot.access.status, "membership_required");
    assert.equal(snapshot.access.joinRequest, null);
    assert.equal(snapshot.access.displayName, null);
  }
});

test("a declined request keeps when the person can ask again", () => {
  const declined = { ...pending, state: "declined", decided_at: "2026-11-04T09:00:00.000Z", retry_after: "2026-11-05T09:00:00.000Z" } as const;
  const snapshot = createApiErrorRoomSnapshot("design-room", apiError(403, roomMembershipRequiredBody({
    room_id: "design-room",
    join_request: declined,
  })));
  assert.deepEqual(snapshot.access.joinRequest, declined);
});

test("a public-repo 403 for a person with no GitHub role has its own state", () => {
  const snapshot = createApiErrorRoomSnapshot("github.com/acme/app", apiError(403, repoCollaboratorRequiredBody({
    room_id: "github.com/acme/app",
  })));
  assert.equal(snapshot.access.status, "repo_collaborator_required");
  assert.equal(snapshot.access.message, REPO_COLLABORATOR_REQUIRED_MESSAGE);
  assert.equal(snapshot.access.code, "REPO_COLLABORATOR_REQUIRED");
  assert.equal(snapshot.access.joinRequest, null);
});

test("GitHub not answering is a retry, not a refusal", () => {
  const snapshot = createApiErrorRoomSnapshot("github.com/acme/app", apiError(503, {
    error: "repo_access_unavailable",
    code: "REPO_ACCESS_UNAVAILABLE",
    message: "GitHub did not answer the repository access check. Please retry.",
    room_id: "github.com/acme/app",
  }));
  assert.equal(snapshot.access.status, "unavailable");
  assert.equal(snapshot.access.title, "GitHub is not answering");
  assert.equal(snapshot.access.code, "REPO_ACCESS_UNAVAILABLE");
});

test("a focus room refused to a non-member names no main room and carries no request", () => {
  const snapshot = createApiErrorRoomSnapshot("focus_61", apiError(403, roomMembershipRequiredBody({ room_id: "focus_61" })));
  assert.equal(snapshot.access.status, "membership_required");
  assert.equal(snapshot.access.roomIdentifier, "focus_61");
  assert.equal(snapshot.access.displayName, null);
  assert.equal(snapshot.access.joinRequest, null);
});

test("the existing refusals keep their states", () => {
  assert.equal(createApiErrorRoomSnapshot("github.com/acme/secret", apiError(401, {
    error: "auth_required", code: "NOT_AUTHENTICATED", device_flow_url: "https://letagents.chat/device",
  })).access.status, "auth_required");
  assert.equal(createApiErrorRoomSnapshot("github.com/acme/secret", apiError(403, {
    error: "private_repo_no_access", code: "PRIVATE_REPO_NO_ACCESS",
  })).access.status, "forbidden");
  assert.equal(createApiErrorRoomSnapshot("gitlab.com/acme/app", apiError(403, {
    error: "unsupported_repo_provider", code: "UNSUPPORTED_REPO_PROVIDER",
  })).access.status, "unavailable");
  assert.equal(createApiErrorRoomSnapshot("room", apiError(500, null)).access.status, "unavailable");
});

class ApiError extends Error {
  constructor(readonly status: number, readonly payload: Record<string, unknown> | null) {
    super(String(payload?.message || payload?.error || `API request failed: ${status}`));
  }
}

async function loadMembers(
  t: test.TestContext,
  options: { local?: boolean; respond?: (path: string, init?: RequestInit) => unknown } = {},
) {
  const calls: Array<{ path: string; method: string; body: string | null }> = [];
  t.mock.module("../main/auth.js", { namedExports: {
    DesktopApiError: ApiError,
    readStoredAuth: async () => ({ account: { id: "acct_me" } }),
    apiFetch: async (path: string, init?: RequestInit) => {
      calls.push({ path, method: init?.method || "GET", body: typeof init?.body === "string" ? init.body : null });
      const answer = options.respond?.(path, init);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } });
  t.mock.module("../main/rooms/local-store.js", { namedExports: {
    resolveLocalAwareRoomStorageMode: async () => ({ effectiveMode: options.local ? "local" : "cloud" }),
    cloudRoomIdentifierForStorage: (_storage: unknown, identifier: string) => identifier,
  } });
  const forgotten: string[] = [];
  t.mock.module("../main/rooms/room-info.js", { namedExports: {
    forgetJoinedRoomInfo: (identifier: string) => { forgotten.push(identifier); },
  } });
  const subject = await import(new URL(`../main/rooms/members.js?${encodeURIComponent(t.name)}`, import.meta.url).href) as typeof import("../main/rooms/members.js");
  return { subject, calls, forgotten };
}

test("member calls reach the room's member routes and mark the signed-in account", async (t) => {
  const { subject, calls } = await loadMembers(t, {
    respond: (path) => path.endsWith("/members")
      ? { room_id: "focus_9", access_room_id: "design-room", managed_by: "letagents", can_manage: true, members: [] }
      : { member: { account_id: "acct_2", role: "admin" } },
  });
  const list = await subject.listDesktopRoomMembers("focus_9");
  assert.equal(list.ok, true);
  assert.equal(list.ok && list.accessRoomId, "design-room");
  assert.equal(list.ok && list.viewerAccountId, "acct_me");
  await subject.setDesktopRoomMemberRole("focus_9", "acct_2", "admin");
  assert.deepEqual(calls.at(-1), { path: "/rooms/focus_9/members/acct_2/role", method: "PUT", body: JSON.stringify({ role: "admin" }) });
});

test("a repo room never offers member changes", async (t) => {
  const { subject } = await loadMembers(t, {
    respond: () => ({ room_id: "github.com/acme/app", access_room_id: "github.com/acme/app", managed_by: "github", can_manage: true, members: [] }),
  });
  const list = await subject.listDesktopRoomMembers("github.com/acme/app");
  assert.equal(list.ok && list.managedBy, "github");
  assert.equal(list.ok && list.canManage, false);
});

test("a cooldown refusal carries the declined request and when it ends", async (t) => {
  const { subject, calls } = await loadMembers(t, {
    respond: () => new ApiError(429, {
      error: "room_join_request_cooldown",
      code: "ROOM_JOIN_REQUEST_COOLDOWN",
      message: "You can ask again later.",
      join_request: { id: "rjr_1", state: "declined", created_at: "2026-11-04T08:00:00.000Z", decided_at: "2026-11-04T09:00:00.000Z" },
      retry_after: "2026-11-05T09:00:00.000Z",
    }),
  });
  const result = await subject.requestDesktopRoomJoin("design room");
  assert.deepEqual(calls, [{ path: "/rooms/design%20room/join-requests", method: "POST", body: "{}" }]);
  assert.deepEqual(result, {
    ok: false,
    status: 429,
    code: "ROOM_JOIN_REQUEST_COOLDOWN",
    message: "You can ask again later.",
    joinRequest: {
      id: "rjr_1",
      state: "declined",
      created_at: "2026-11-04T08:00:00.000Z",
      decided_at: "2026-11-04T09:00:00.000Z",
      retry_after: "2026-11-05T09:00:00.000Z",
    },
  });
});

test("removing the last admin returns the server's code for the card", async (t) => {
  const { subject, calls } = await loadMembers(t, {
    respond: () => new ApiError(409, { error: "room_last_admin", code: "ROOM_LAST_ADMIN" }),
  });
  const result = await subject.removeDesktopRoomMember("design-room", "acct_me");
  assert.equal(calls[0]?.method, "DELETE");
  assert.equal(calls[0]?.path, "/rooms/design-room/members/acct_me");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, "ROOM_LAST_ADMIN");
});

test("decisions go to the request's own route, and unknown decisions never leave the app", async (t) => {
  const { subject, calls } = await loadMembers(t, {
    respond: () => ({ join_request: { ...pending, state: "approved" } }),
  });
  const approved = await subject.decideDesktopRoomJoinRequest("design-room", "rjr_1", "approve");
  assert.equal(approved.ok && approved.joinRequest.state, "approved");
  assert.equal(calls[0]?.path, "/rooms/design-room/join-requests/rjr_1/approve");
  const unknown = await subject.decideDesktopRoomJoinRequest("design-room", "rjr_1", "delete" as never);
  assert.equal(unknown.ok, false);
  assert.equal(calls.length, 1);
});

test("a room kept on this computer has no members and makes no request", async (t) => {
  const { subject, calls } = await loadMembers(t, { local: true });
  const result = await subject.listDesktopRoomMembers("local-room");
  assert.equal(!result.ok && result.code, "local_room");
  assert.equal((await subject.requestDesktopRoomJoin("local-room")).ok, false);
  assert.deepEqual(calls, []);
});

test("an older server without the account route reads as no requests", async (t) => {
  const { subject } = await loadMembers(t, { respond: () => new ApiError(404, { error: "Not found" }) });
  assert.deepEqual(await subject.listDesktopAccountRoomJoinRequests(), { ok: true, joinRequests: [] });
});

test("leaving forgets the remembered join; removing someone else does not", async (t) => {
  const { subject, forgotten } = await loadMembers(t, { respond: (path) => ({ removed: true, account_id: path.split("/").at(-1) }) });
  assert.equal((await subject.removeDesktopRoomMember("design-room", "acct_2")).ok, true);
  assert.deepEqual(forgotten, []);
  assert.equal((await subject.removeDesktopRoomMember("design-room", "acct_me")).ok, true);
  assert.deepEqual(forgotten, ["design-room"]);
});
