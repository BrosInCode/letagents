import assert from "node:assert/strict";
import test from "node:test";

const {
  FOCUS_PARENT_BOARD_WRITE_ISOLATION_ERROR,
  createFocusParentBoardWriteIsolationEnforcer,
  getOriginRoomIdFromRequest,
  shouldIsolateFocusRoomParentBoardWrites,
} = await import("../focus-room-task-write-isolation.js");
const { LETAGENTS_ORIGIN_ROOM_ID_HEADER } = await import("../../shared/request-headers.js");

function makeFocusRoom(overrides: Record<string, unknown> = {}) {
  return {
    id: "focus_14",
    kind: "focus",
    parent_room_id: "github.com/brosincode/letagents",
    focus_parent_visibility: "summary_only",
    focus_activity_scope: "room",
    focus_github_event_routing: "task_and_branch",
    ...overrides,
  };
}

test("getOriginRoomIdFromRequest reads the originating room header", () => {
  const originRoomId = getOriginRoomIdFromRequest({
    headers: {
      [LETAGENTS_ORIGIN_ROOM_ID_HEADER.toLowerCase()]: "focus_14",
    },
  } as never);

  assert.equal(originRoomId, "focus_14");
});

test("shouldIsolateFocusRoomParentBoardWrites only isolates room-scoped focus rooms against their parent", () => {
  assert.equal(
    shouldIsolateFocusRoomParentBoardWrites({
      originRoom: makeFocusRoom(),
      targetProjectId: "github.com/brosincode/letagents",
    }),
    true
  );

  assert.equal(
    shouldIsolateFocusRoomParentBoardWrites({
      originRoom: makeFocusRoom({ focus_activity_scope: "task_and_branch" }),
      targetProjectId: "github.com/brosincode/letagents",
    }),
    false
  );

  assert.equal(
    shouldIsolateFocusRoomParentBoardWrites({
      originRoom: makeFocusRoom({ parent_room_id: "github.com/brosincode/other" }),
      targetProjectId: "github.com/brosincode/letagents",
    }),
    false
  );
});

test("createFocusParentBoardWriteIsolationEnforcer denies parent board writes from room-scoped Focus Rooms", async () => {
  const enforceFocusParentBoardWriteIsolation =
    createFocusParentBoardWriteIsolationEnforcer({
      getProjectById: async (projectId: string) =>
        projectId === "focus_14" ? makeFocusRoom() : undefined,
    });

  const result = await enforceFocusParentBoardWriteIsolation({
    req: {
      authKind: "owner_token",
      headers: {
        [LETAGENTS_ORIGIN_ROOM_ID_HEADER.toLowerCase()]: "focus_14",
      },
    } as never,
    targetProjectId: "github.com/brosincode/letagents",
  });

  assert.deepEqual(result, {
    kind: "deny",
    code: "focus_parent_board_read_only",
    error: FOCUS_PARENT_BOARD_WRITE_ISOLATION_ERROR,
  });
});

test("createFocusParentBoardWriteIsolationEnforcer allows same-room writes and non-agent callers", async () => {
  const enforceFocusParentBoardWriteIsolation =
    createFocusParentBoardWriteIsolationEnforcer({
      getProjectById: async () => makeFocusRoom(),
    });

  const sameRoomResult = await enforceFocusParentBoardWriteIsolation({
    req: {
      authKind: "owner_token",
      headers: {
        [LETAGENTS_ORIGIN_ROOM_ID_HEADER.toLowerCase()]:
          "github.com/brosincode/letagents",
      },
    } as never,
    targetProjectId: "github.com/brosincode/letagents",
  });
  assert.deepEqual(sameRoomResult, { kind: "allow" });

  const humanResult = await enforceFocusParentBoardWriteIsolation({
    req: {
      authKind: "session",
      headers: {
        [LETAGENTS_ORIGIN_ROOM_ID_HEADER.toLowerCase()]: "focus_14",
      },
    } as never,
    targetProjectId: "github.com/brosincode/letagents",
  });
  assert.deepEqual(humanResult, { kind: "allow" });
});
