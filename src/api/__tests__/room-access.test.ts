import assert from "node:assert/strict";
import test from "node:test";

import type { Response } from "express";
import type { GitRoomBinding, Project } from "../db.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const {
  getProjectAccessRoomId,
  isRepoBackedProject,
  isRepoBackedRoomId,
  replyRepoRoomAccessDecision,
  requireAdmin,
  requireParticipant,
  resolveGitHubRoomEntryDecision,
  resolveProjectRepoRoomAccessDecision,
  resolveRepoRoomAccessDecision,
} = await import("../rooms/access.js");

function project(id: string, parentRoomId: string | null = null): Project {
  return {
    id,
    parent_room_id: parentRoomId,
  } as Project;
}

function gitRoomBinding(roomId: string): GitRoomBinding {
  return {
    room_id: roomId,
    provider: "github",
    host: "github.com",
    repository_id: "repo_1",
    repository_full_name: "BrosInCode/letagents",
    repository_owner: "BrosInCode",
    repository_name: "letagents",
    ref_type: "branch",
    ref_name: "git-rooms",
    default_branch: "main",
    base_ref: null,
    head_ref: "git-rooms",
    head_repository_id: null,
    head_repository_full_name: null,
    head_repository_owner: null,
    head_repository_name: null,
    visibility: "private",
    is_default: false,
    source: "manual",
    created_at: "2026-06-28T00:00:00.000Z",
    updated_at: "2026-06-28T00:00:00.000Z",
  };
}

function jsonResponse() {
  const state: { statusCode: number | null; body: unknown } = {
    statusCode: null,
    body: null,
  };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  } as Response;

  return { res, state };
}

test("room access helpers identify repo-backed room ids and access room ids", () => {
  assert.equal(isRepoBackedRoomId("github.com/BrosInCode/letagents"), true);
  assert.equal(isRepoBackedRoomId("focus_5"), false);
  assert.equal(isRepoBackedRoomId("ABCX-7291"), false);

  assert.equal(
    getProjectAccessRoomId(project("focus-child", "github.com/BrosInCode/letagents")),
    "github.com/BrosInCode/letagents"
  );
  assert.equal(isRepoBackedProject(project("focus-child", "github.com/BrosInCode/letagents")), true);
  assert.equal(isRepoBackedProject(project("invite-room")), false);
});

test("resolveRepoRoomAccessDecision allows non-repo rooms without auth", async () => {
  assert.deepEqual(
    await resolveRepoRoomAccessDecision({
      roomName: "focus_5",
      sessionAccount: null,
    }),
    { kind: "allow" }
  );
});

test("project repo access uses locator rooms without binding lookup", async () => {
  let bindingLookups = 0;
  const decision = await resolveProjectRepoRoomAccessDecision(
    {
      project: project("github.com/BrosInCode/letagents"),
      sessionAccount: null,
    },
    {
      getGitRoomBindingForRoom: async () => {
        bindingLookups += 1;
        throw new Error("binding lookup should not run for locator rooms");
      },
      resolveRepoRoomAccessDecision: async ({ roomName }) => {
        assert.equal(roomName, "github.com/BrosInCode/letagents");
        return { kind: "allow" };
      },
    }
  );

  assert.equal(bindingLookups, 0);
  assert.equal(decision.isRepoBacked, true);
  assert.equal(decision.roomName, "github.com/BrosInCode/letagents");
  assert.equal(decision.repoRoomName, "github.com/BrosInCode/letagents");
  assert.equal(decision.binding, null);
  assert.deepEqual(decision.decision, { kind: "allow" });
});

test("project repo access resolves binding-backed rooms to their GitHub repo", async () => {
  const checkedRepoRooms: string[] = [];
  const binding = gitRoomBinding("focus_27");

  const decision = await resolveProjectRepoRoomAccessDecision(
    {
      project: project("focus_27"),
      sessionAccount: null,
    },
    {
      getGitRoomBindingForRoom: async (roomId) => (roomId === "focus_27" ? binding : null),
      resolveRepoRoomAccessDecision: async ({ roomName }) => {
        checkedRepoRooms.push(roomName);
        return { kind: "auth_required" };
      },
    }
  );

  assert.deepEqual(checkedRepoRooms, ["github.com/BrosInCode/letagents"]);
  assert.equal(decision.isRepoBacked, true);
  assert.equal(decision.roomName, "focus_27");
  assert.equal(decision.repoRoomName, "github.com/BrosInCode/letagents");
  assert.equal(decision.binding, binding);
  assert.deepEqual(decision.decision, { kind: "auth_required" });
});

test("replyRepoRoomAccessDecision preserves auth-required response shape", () => {
  const previousBaseUrl = process.env.LETAGENTS_BASE_URL;
  process.env.LETAGENTS_BASE_URL = "https://letagents.test/";
  try {
    const { res, state } = jsonResponse();

    assert.equal(
      replyRepoRoomAccessDecision(res, "github.com/BrosInCode/letagents", {
        kind: "auth_required",
      }),
      false
    );

    assert.equal(state.statusCode, 401);
    assert.deepEqual(state.body, {
      error: "auth_required",
      code: "NOT_AUTHENTICATED",
      message: "Authentication is required for repo-backed rooms",
      room_id: "github.com/BrosInCode/letagents",
      device_flow_url:
        "https://letagents.test/auth/device/start?room_id=github.com%2FBrosInCode%2Fletagents",
    });
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.LETAGENTS_BASE_URL;
    } else {
      process.env.LETAGENTS_BASE_URL = previousBaseUrl;
    }
  }
});

test("requireAdmin rejects unauthenticated requests before role lookup", async () => {
  const { res, state } = jsonResponse();

  assert.equal(
    await requireAdmin({ sessionAccount: null } as never, res, project("invite-room")),
    false
  );
  assert.equal(state.statusCode, 401);
  assert.deepEqual(state.body, { error: "Authentication required" });
});

test("requireParticipant allows non-repo rooms without auth", async () => {
  const { res } = jsonResponse();

  assert.equal(
    await requireParticipant({ sessionAccount: null } as never, res, project("invite-room")),
    true
  );
});

test("resolveGitHubRoomEntryDecision allows non-repo room entries", async () => {
  assert.deepEqual(
    await resolveGitHubRoomEntryDecision({
      roomName: "focus_5",
      sessionAccount: null,
      redirectTo: "/in/focus_5",
    }),
    { kind: "allow" }
  );
});
