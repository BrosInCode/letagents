import assert from "node:assert/strict";
import test from "node:test";

import type { Response } from "express";
import type { Project } from "../db.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const {
  getProjectAccessRoomId,
  isRepoBackedProject,
  isRepoBackedRoomId,
  replyRepoRoomAccessDecision,
  requireAdmin,
  requireParticipant,
  resolveGitHubRoomEntryDecision,
  resolveRepoRoomAccessDecision,
} = await import("../room-access.js");

function project(id: string, parentRoomId: string | null = null): Project {
  return {
    id,
    parent_room_id: parentRoomId,
  } as Project;
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
