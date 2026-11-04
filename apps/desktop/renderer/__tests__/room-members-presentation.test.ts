import assert from "node:assert/strict";
import { test } from "node:test";

import { REPO_ROOM_USES_GITHUB_ROLES_MESSAGE } from "../../../../shared/room-membership.mjs";
import { roomMembersSummary, roomMembershipErrorMessage, sortRoomMembers } from "../src/components/desktop/content/room-shell/room-members";
import { buildUniversalInbox, inboxCategoryLabel, inboxNavigationIntent } from "../src/components/desktop/content/room-inbox/universal";

const member = (account_id: string, login: string, role: "admin" | "member") => ({
  account_id, login, display_name: null, avatar_url: null, role, added_via: null, joined_at: "2026-10-01T00:00:00.000Z",
});

test("the rail summary says how many members and how many wait to join", () => {
  assert.equal(roomMembersSummary("hidden", 3, 1), null);
  assert.equal(roomMembersSummary("github", 0, 0), "GitHub");
  assert.equal(roomMembersSummary("members", 3, 0), "3");
  assert.equal(roomMembersSummary("members", 3, 2), "3 · 2 waiting");
});

test("admins come first, then you, then everyone by name", () => {
  const sorted = sortRoomMembers([member("a3", "zed", "member"), member("a2", "bo", "member"), member("a1", "cy", "admin"), member("me", "yu", "member")], "me");
  assert.deepEqual(sorted.map((entry) => entry.login), ["cy", "yu", "bo", "zed"]);
});

test("refused member changes read as sentences", () => {
  const failure = (status: number, code: string | null, message: string) => ({ ok: false as const, status, code, message, joinRequest: null });
  assert.equal(roomMembershipErrorMessage(failure(409, "ROOM_LAST_ADMIN", "room_last_admin")),
    "A room needs at least one admin. Make another member an admin first.");
  assert.equal(roomMembershipErrorMessage(failure(409, "ROOM_LAST_ADMIN", "This room needs an admin.")), "This room needs an admin.");
  assert.equal(roomMembershipErrorMessage(failure(409, "REPO_ROOM_USES_GITHUB_ROLES", "x")), REPO_ROOM_USES_GITHUB_ROLES_MESSAGE);
  assert.equal(roomMembershipErrorMessage(failure(403, null, "Admin privileges required")), "Only room admins can do this.");
  assert.equal(roomMembershipErrorMessage(failure(403, "PERSON_REQUIRED", "Only a person signed in to the LetAgents app can change room members.")),
    "Only a person signed in to the LetAgents app can change room members.");
});

test("a join request is a Needs you item that opens its room", () => {
  const [item] = buildUniversalInbox(null, [], [], [{
    id: "rjr_1", state: "pending", created_at: "2026-11-04T08:00:00.000Z", decided_at: null, retry_after: null,
    room_id: "design-room", account_id: "acct_2", login: "bo", display_name: "Bo", avatar_url: null, decided_by_login: null,
    room_display_name: "Design room",
  }]);
  assert.equal(item?.section, "needs-you");
  assert.equal(item?.category, "room_join_request");
  assert.equal(item?.title, "Bo asks to join");
  assert.equal(item?.roomName, "Design room");
  assert.equal(inboxCategoryLabel("room_join_request"), "Join request");
  assert.deepEqual(item && inboxNavigationIntent(item), { roomIdentifier: "design-room", taskId: undefined });
});
