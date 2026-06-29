import assert from "node:assert/strict";
import test from "node:test";

import {
  toPublicRoomState,
  toPublicStoredRoomSession,
  toRoomState,
} from "../server/runtime/room-state.js";

const gitRoom = {
  room_id: "github-refroom_github.com_owner_repo_branch_codex-git-rooms",
  provider: "github",
  host: "github.com",
  repository: {
    id: "repo_1",
    owner: "owner",
    name: "repo",
    full_name: "owner/repo",
  },
  ref: {
    type: "branch",
    name: "codex/git-rooms",
    default_branch: "main",
    base_ref: "main",
    head_ref: "codex/git-rooms",
    head_repository: null,
    is_default: false,
  },
  visibility: "private",
  access_mode: "private",
  source: "webhook",
  updated_at: "2026-06-28T00:00:00.000Z",
};

test("public room state keeps Git Room metadata for agent inspection", () => {
  const state = toRoomState({
    room_id: gitRoom.room_id,
    display_name: "Branch: codex/git-rooms",
    git_room: gitRoom,
    joined_via: "git-remote",
  });

  const publicState = toPublicRoomState(state);

  assert.equal(publicState?.room_id, gitRoom.room_id);
  assert.equal(publicState?.display_name, "Branch: codex/git-rooms");
  assert.deepEqual(publicState?.git_room, gitRoom);
  assert.equal(publicState?.joined_via, "git-remote");
});

test("stored room session payload keeps Git Room metadata across resume", () => {
  const publicSession = toPublicStoredRoomSession({
    room_id: gitRoom.room_id,
    display_name: "Branch: codex/git-rooms",
    git_room: gitRoom,
    joined_via: "git-remote",
    joined_at: "2026-06-28T00:00:00.000Z",
    last_seen_at: "2026-06-28T00:05:00.000Z",
    last_message_id: "msg_1",
  });

  assert.equal(publicSession?.room_id, gitRoom.room_id);
  assert.deepEqual(publicSession?.git_room, gitRoom);
  assert.equal(publicSession?.last_message_id, "msg_1");
});
