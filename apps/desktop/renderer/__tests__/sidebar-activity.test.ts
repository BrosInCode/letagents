import assert from "node:assert/strict";
import test from "node:test";
import {
  indexAccountActivity,
  newerLatestMessage,
  sidebarActivityFor,
  streamedLatestMessage,
} from "../src/domain/account-activity";
import {
  describeSidebarRoomActivity,
  sidebarGroupActivity,
  sidebarProjectDetails,
  sidebarRoomTitle,
} from "../src/domain/sidebar-room-display";
import type { ProjectGroup, RoomEntry } from "../src/components/desktop/types";

const state = {
  connected: true,
  rooms: {
    "github.com/BrosInCode/letagents": {
      roomId: "github.com/BrosInCode/letagents", latestMessageId: "msg_12", latestMessageAt: "2026-10-01T09:00:00.000Z",
      working: [{ displayName: "MapleRidge" }],
    },
    focus_4: { roomId: "focus_4", latestMessageId: null, latestMessageAt: null, working: [] },
  },
};

test("rooms are matched however the sidebar spells the room's name", () => {
  const index = indexAccountActivity(state);
  assert.deepEqual(sidebarActivityFor(index, "github.com/brosincode/letagents"), { working: [{ displayName: "MapleRidge" }] });
  assert.equal(sidebarActivityFor(index, "focus_4"), null, "nobody working is no indicator at all");
  assert.equal(sidebarActivityFor(index, "unknown-room"), null);
  assert.equal(sidebarActivityFor(index, null), null);
});

test("the newer latest message wins, whichever source reported it", () => {
  const streamed = streamedLatestMessage(indexAccountActivity(state), "github.com/brosincode/letagents");
  const listed = { roomIdentifier: "github.com/BrosInCode/letagents", latestMessageId: "msg_9", latestMessageAt: "2026-10-01T08:00:00.000Z" };
  assert.equal(newerLatestMessage(listed, streamed)?.latestMessageId, "msg_12");
  assert.equal(newerLatestMessage({ ...listed, latestMessageId: "msg_20" }, streamed)?.latestMessageId, "msg_20");
  assert.equal(newerLatestMessage(null, streamed)?.latestMessageId, "msg_12");
  assert.equal(newerLatestMessage(listed, null)?.latestMessageId, "msg_9");
  assert.equal(streamedLatestMessage(indexAccountActivity(state), "focus_4"), null, "a room with no messages reports none");
});

test("who is working is said in words, for the tooltip and screen readers", () => {
  const agents = (...names: string[]) => ({ working: names.map((displayName) => ({ displayName })) });
  assert.equal(describeSidebarRoomActivity(null), null);
  assert.equal(describeSidebarRoomActivity(agents()), null);
  assert.equal(describeSidebarRoomActivity(agents("Maple")), "Maple is working");
  assert.equal(describeSidebarRoomActivity(agents("Maple", "Cedar")), "Maple and Cedar are working");
  assert.equal(describeSidebarRoomActivity(agents("Maple", "Cedar", "Oak", "Pine")), "Maple, Cedar and 2 more are working");
});

function room(id: string, extra: Partial<RoomEntry> = {}): RoomEntry {
  return { id, type: "room", kind: "parent", roomIdentifier: id, title: id, meta: "", sectionLabel: "", headline: id,
    description: "", latestMessageId: null, latestMessageAt: null, hasUnread: false, pinned: false, source: "account", ...extra };
}

test("a collapsed room group shows the work going on inside it", () => {
  const project: ProjectGroup = {
    id: "group", roomName: "sky-lake",
    parent: room("parent", { meta: "BrosInCode/letagents" }),
    focusRooms: [room("focus_1", { kind: "focus", activity: { working: [{ displayName: "Maple" }] } })],
    branchRooms: [room("branch", { kind: "branch", activity: { working: [{ displayName: "Cedar" }] } })],
  };
  assert.equal(sidebarGroupActivity(project, false), null, "expanded, each room shows its own");
  assert.deepEqual(sidebarGroupActivity(project, true)?.working.map((agent) => agent.displayName), ["Maple", "Cedar"]);
  assert.equal(sidebarProjectDetails(project), "BrosInCode/letagents · 1 branch · 1 focus room");
});

test("nested focus rooms drop the prefix their parent already implies", () => {
  assert.equal(sidebarRoomTitle({ kind: "focus", title: "Focus: Agents QA" }), "Agents QA");
  assert.equal(sidebarRoomTitle({ kind: "focus", title: "focus:   Agents QA" }), "Agents QA");
  assert.equal(sidebarRoomTitle({ kind: "focus", title: "Focus:" }), "Focus:", "a title that is only the prefix is kept");
  assert.equal(sidebarRoomTitle({ kind: "parent", title: "Focus: a room literally named this" }), "Focus: a room literally named this");
});
